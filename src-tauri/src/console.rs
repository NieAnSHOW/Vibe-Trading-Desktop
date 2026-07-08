//! 桌面控制台 IPC —— 环境/服务状态、启停服务、bootstrap 转发、打开 WebUI/日志。
//! 逻辑尽量做成纯函数(可 cargo 测);Tauri command 是薄壳(设计 D3)。

use std::io::{BufRead, BufReader};
use std::fs;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::auth::{
    self, AuthError, AuthState, Captcha, LoginRaw, UserInfo, UserSession,
};
use crate::runtime_dir::Layout;

pub type SharedChild = Arc<Mutex<Option<Child>>>;

/// 依赖安装(bootstrap)进行中标志。关闭拦截据此判断是否需要二次确认。
pub struct InstallingFlag(pub Arc<AtomicBool>);
/// 关闭已确认标志:用户在二次确认框点「确认关闭」后置真,放行下一次 CloseRequested。
pub struct CloseConfirmed(pub Arc<AtomicBool>);

/// 窗口关闭需要拦截时,发给前端(触发二次确认框)的事件名。
pub const CLOSE_REQUESTED_EVENT: &str = "app://close-requested";

// ── 纯函数(状态判定、命令构造) ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvStatus {
    NotInstalled,
    Incomplete,
    Ready,
}

/// bootstrap 进度事件:由 `--sse` 帧解析而来,发给前端驱动进度条 + 日志。
/// `stage` 取值 venv | installing | smoke | done | failed;`message` 是该阶段的
/// 人类可读行(installing 阶段即 pip 的原始 stdout 行)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProgressEvent {
    pub stage: String,
    pub message: String,
    pub ok: bool,
}

/// 解析 `--sse` 输出的一个 data 行的 JSON,提取 stage/message/ok。
///
/// bootstrap 的 SSE 帧形如:
/// ```text
/// event: progress
/// data: {"stage": "installing", "message": "Collecting pandas"}
///
/// event: done
/// data: {"ok": true, "message": "environment ready"}
/// ```
/// 我们只关心 `data:` 行的 JSON;`event:` 名与 data 里的 stage 语义重复,
/// 且 done/failed 的 data 不含 stage,故解析时用 `event_name` 兜底 stage。
/// 返回 None 表示该 data 行不是合法 JSON(理论上不会发生,防御性跳过)。
pub fn parse_sse_data(event_name: &str, data_json: &str) -> Option<ProgressEvent> {
    let v: serde_json::Value = serde_json::from_str(data_json).ok()?;
    // progress 帧 data 内带 stage;done/failed 帧不带,退回 event 名。
    let stage = v
        .get("stage")
        .and_then(|s| s.as_str())
        .unwrap_or(event_name)
        .to_string();
    let message = v
        .get("message")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    // 缺省 ok=true;仅 failed 帧显式带 ok=false。
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(true);
    Some(ProgressEvent { stage, message, ok })
}

/// 依据磁盘上的 venv 解释器与 bootstrap hash marker 判定环境状态。
pub fn compute_env_status(layout: &Layout) -> EnvStatus {
    if !layout.venv_python.exists() {
        return EnvStatus::NotInstalled;
    }
    let marker = layout.venv_dir.join(".requirements_hash");
    if marker.exists() {
        EnvStatus::Ready
    } else {
        EnvStatus::Incomplete
    }
}

/// 构造 `vibe-trading bootstrap --sse` 子进程命令。
/// bootstrap 用 bundle 的 Tier 0 python 执行(此时 venv 尚不存在),它内部再建 venv。
pub fn build_bootstrap_cmd(tier0_python: &Path, runtime_agent: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(tier0_python);
    cmd.arg("-c")
        .arg("import cli,sys; raise SystemExit(cli.main(sys.argv[1:]))")
        .arg("bootstrap")
        .arg("--sse")
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 从 GUI 应用 spawn 控制台子进程时,Windows 会为其分配新控制台,
    // 表现为弹出空白命令窗口。CREATE_NO_WINDOW 抑制该行为(与 sidecar 一致)。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

/// 渠道名只允许小写字母/数字/连字符/下划线。channel 来自前端并拼进 pip extras,
/// 是信任边界输入,必须校验以防构造怪异 extras 名(如空串、空格、路径片段)。
pub fn validate_channel(channel: &str) -> Result<(), String> {
    let ok = !channel.is_empty()
        && channel
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法渠道名: {channel}"))
    }
}

/// 构造 `pip install 'vibe-trading-ai[<channel>]'` 子进程命令(用 venv 解释器)。
/// --no-input 防止 pip 在非交互环境下因依赖冲突提示而卡死。
pub fn build_channel_dep_cmd(venv_python: &Path, channel: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(venv_python);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .arg(format!("vibe-trading-ai[{channel}]"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 从 GUI 应用 spawn 控制台子进程时,Windows 会为其分配新控制台,
    // 表现为弹出空白命令窗口。CREATE_NO_WINDOW 抑制该行为(与 sidecar 一致)。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

fn prepare_runtime_from_bundle(app: &AppHandle, layout: &Layout) -> Result<(), String> {
    let res = crate::resources::Resources::resolve(app).map_err(|e| format!("resources: {e}"))?;
    crate::runtime_dir::prepare(
        &res.agent_template,
        &res.env_seed,
        &res.version_file,
        Some(&res.frontend_dist),
        layout,
    )
}

// ── Tauri IPC 命令 ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct StatusReport {
    pub env: EnvStatus,
    pub service_running: bool,
    pub port: Option<u16>,
}

/// 登录命令返回给前端的结构（不含 token）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResultView {
    pub user_info: UserInfo,
    pub has_password: bool,
    pub expire_at: i64, // epoch 秒
}

/// console_auth_status 返回。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusView {
    pub authenticated: bool,
    pub user_info: Option<UserInfo>,
    pub expire_at: Option<i64>,
}

/// console_start_service 的错误（LoginExpired 让前端跳登录页）。
#[derive(Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum ServiceStartError {
    EnvNotReady,
    AlreadyRunning,
    LoginExpired,
    SpawnFailed { message: String },
    HealthTimeout,
    ProcessExited { code: Option<i32> },
    Other { message: String },
}

impl std::fmt::Display for ServiceStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EnvNotReady => write!(f, "环境未就绪，请先完成依赖安装"),
            Self::AlreadyRunning => write!(f, "服务已在运行"),
            Self::LoginExpired => write!(f, "登录已过期，请重新登录"),
            Self::SpawnFailed { message } => write!(f, "启动失败: {message}"),
            Self::HealthTimeout => write!(f, "后端 120 秒内未就绪"),
            Self::ProcessExited { code } => write!(f, "后端提前退出（退出码 {code:?}）"),
            Self::Other { message } => write!(f, "{message}"),
        }
    }
}

/// 环境 + 服务状态快照,供控制台首屏与轮询。
#[tauri::command]
pub fn console_status(state: State<'_, SharedChild>) -> Result<StatusReport, String> {
    let layout = Layout::from_home()?;
    let running = state.lock().unwrap().is_some();
    Ok(StatusReport {
        env: compute_env_status(&layout),
        service_running: running,
        port: None,
    })
}

/// 触发依赖 bootstrap:spawn `vibe-trading bootstrap --sse`,把 SSE 帧解析为
/// 结构化进度事件 emit 到 "bootstrap://event"(前端据 stage 驱动进度条 + 日志)。
///
/// bootstrap 的 stdout 是标准 SSE 流(`event:`/`data:` 两行 + 空行分隔一帧)。
/// 逐行累积,遇空行组帧解析:比逐行透传干净(前端拿不到 `event:`/`data:` 噪声),
/// 也让进度条能按 stage 推进。
#[tauri::command]
pub async fn console_bootstrap(
    app: AppHandle,
    installing: State<'_, InstallingFlag>,
) -> Result<(), String> {
    let layout = Layout::from_home()?;
    prepare_runtime_from_bundle(&app, &layout)?;
    let res = crate::resources::Resources::resolve(&app).map_err(|e| format!("resources: {e}"))?;
    let mut child = build_bootstrap_cmd(&res.runtime_python, &layout.runtime_agent)
        .spawn()
        .map_err(|e| format!("spawn bootstrap: {e}"))?;
    let stdout = child.stdout.take().ok_or("no bootstrap stdout")?;
    // 安装期间置位:关闭窗口时据此弹「安装未完成」确认。
    let flag = installing.0.clone();
    flag.store(true, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        // 累积一帧的 event 名与 data JSON,遇空行(帧边界)组装并 emit。
        let mut event_name = String::new();
        let mut data_json = String::new();
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_json = rest.trim().to_string();
            } else if line.is_empty() {
                // 帧结束:解析并派发,随后重置累积器。
                if !data_json.is_empty() {
                    if let Some(ev) = parse_sse_data(&event_name, &data_json) {
                        let _ = app2.emit("bootstrap://event", ev);
                    }
                }
                event_name.clear();
                data_json.clear();
            }
        }
        // 末帧无尾随空行时的兜底派发。
        if !data_json.is_empty() {
            if let Some(ev) = parse_sse_data(&event_name, &data_json) {
                let _ = app2.emit("bootstrap://event", ev);
            }
        }
        let code = child.wait().ok().and_then(|s| s.code());
        flag.store(false, Ordering::SeqCst);
        let _ = app2.emit("bootstrap://exit", code);
    });
    Ok(())
}

/// 启动服务：先校验登录态（过期则尝试 refresh，失败返 LoginExpired），
/// 再 spawn serve + 健康门控。
#[tauri::command]
pub async fn console_start_service(
    app: AppHandle,
    state: State<'_, SharedChild>,
    auth_state: State<'_, AuthState>,
) -> Result<u16, ServiceStartError> {
    let layout = Layout::from_home().map_err(|e| ServiceStartError::Other { message: e })?;
    if compute_env_status(&layout) != EnvStatus::Ready {
        return Err(ServiceStartError::EnvNotReady);
    }
    if state.lock().unwrap().is_some() {
        return Err(ServiceStartError::AlreadyRunning);
    }
    // 启动前尝试刷新登录态（静默；未登录不阻塞———用户可自行配 .env）
    let _ = auth::ensure_session_valid(&auth_state, &layout);

    let port = crate::port::pick_free_port()
        .map_err(|e| ServiceStartError::Other { message: e })?;
    let mut child = crate::sidecar::spawn(
        &layout.venv_python,
        &layout.runtime_agent,
        port,
        &layout.runtime_libs,
        &layout.sessions_dir,
    )
    .map_err(|e| ServiceStartError::SpawnFailed { message: e })?;

    // await_health 是同步阻塞(reqwest::blocking + thread::sleep,最长 120s)。
    // 甩到阻塞线程池执行——否则会卡死 Tauri main thread,整个窗口假死、
    // 前端 spinner 也转不动(对照 console_bootstrap 用 async + 后台线程,从不卡)。
    let shared = state.inner().clone();
    let (ready, child) = tauri::async_runtime::spawn_blocking(move || {
        let ready = crate::sidecar::await_health(&mut child, port);
        (ready, child)
    })
    .await
    .map_err(|e| ServiceStartError::Other { message: e.to_string() })?;
    match ready {
        crate::sidecar::Ready::Ok => {
            shared.lock().unwrap().replace(child);
            let _ = app.emit("service://started", port);
            Ok(port)
        }
        crate::sidecar::Ready::ProcessExited(c) => Err(ServiceStartError::ProcessExited { code: c }),
        crate::sidecar::Ready::Timeout => Err(ServiceStartError::HealthTimeout),
    }
}

fn into_view(sess: UserSession) -> LoginResultView {
    LoginResultView {
        user_info: sess.user_info.expect("登录后必有 userInfo"),
        has_password: true, // 占位；真实 hasPassword 见下方命令
        expire_at: sess.expire_at,
    }
}

#[tauri::command]
pub fn console_login_captcha() -> Result<Captcha, AuthError> {
    auth::fetch_captcha()
}

#[tauri::command]
pub fn console_login_send_sms(phone: String, captcha_id: String, code: String) -> Result<(), AuthError> {
    auth::send_sms(&phone, &captcha_id, &code)
}

/// 登录通用收尾：调 cool-admin 拿 raw → 写 .env → fetch userInfo → 缓存 → 返 view。
fn finalize_login(
    raw: LoginRaw,
    has_password: bool,
    layout: &Layout,
    auth_state: &AuthState,
) -> Result<LoginResultView, AuthError> {
    let info = fetch_user_info_or_default(&raw.token);
    let mut sess = auth::session_from_login(raw, Some(info.clone()));
    auth::write_env_token_section(layout, &sess)?;
    sess.user_info = Some(info.clone());
    *auth_state.0.lock().unwrap() = Some(sess.clone());
    Ok(LoginResultView {
        user_info: info,
        has_password,
        expire_at: sess.expire_at,
    })
}

/// userInfo 拉取失败时用占位（不阻塞登录主流程，与原 Login.tsx 容错一致）。
fn fetch_user_info_or_default(token: &str) -> UserInfo {
    auth::fetch_user_info(token).unwrap_or(UserInfo {
        id: 0,
        unionid: None,
        avatar_url: None,
        nick_name: None,
        phone: None,
        gender: 0,
        status: 1,
        login_type: 2,
        description: None,
    })
}

#[tauri::command]
pub fn console_login_by_phone(
    phone: String,
    sms_code: String,
    auth_state: State<'_, AuthState>,
) -> Result<LoginResultView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    let raw = auth::login_by_phone(&phone, &sms_code)?;
    let has_password = raw.has_password;
    finalize_login(raw, has_password, &layout, &auth_state)
}

#[tauri::command]
pub fn console_login_by_password(
    phone: String,
    password: String,
    auth_state: State<'_, AuthState>,
) -> Result<LoginResultView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    let raw = auth::login_by_password(&phone, &password)?;
    let has_password = raw.has_password;
    finalize_login(raw, has_password, &layout, &auth_state)
}

#[tauri::command]
pub fn console_login_set_password(
    password: String,
    auth_state: State<'_, AuthState>,
) -> Result<(), AuthError> {
    let token = auth_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.token.clone())
        .ok_or(AuthError::NotAuthenticated)?;
    auth::set_password(&token, &password)
}

#[tauri::command]
pub fn console_logout(
    auth_state: State<'_, AuthState>,
) -> Result<(), AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    auth::clear_env_token_section(&layout)?;
    *auth_state.0.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub fn console_auth_status(
    auth_state: State<'_, AuthState>,
) -> Result<AuthStatusView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    // 内存空则从 .env 恢复（不调网络）
    let mut guard = auth_state.0.lock().unwrap();
    if guard.is_none() {
        *guard = auth::read_env_token_section(&layout);
    }
    match guard.clone() {
        Some(sess) => Ok(AuthStatusView {
            authenticated: true,
            user_info: sess.user_info,
            expire_at: Some(sess.expire_at),
        }),
        None => Ok(AuthStatusView {
            authenticated: false,
            user_info: None,
            expire_at: None,
        }),
    }
}

/// 停止服务:干净回收 sidecar 进程组。
#[tauri::command]
pub async fn console_stop_service(state: State<'_, SharedChild>) -> Result<(), String> {
    // 单独语句取走 child,确保 MutexGuard 不跨 await(Future 须 Send)。
    let child = state.lock().unwrap().take();
    if let Some(mut child) = child {
        // terminate 内部 child.wait() 同步等子进程退出;甩到阻塞线程池避免卡 main thread。
        let _ = tauri::async_runtime::spawn_blocking(move || crate::sidecar::terminate(&mut child))
            .await;
    }
    Ok(())
}

/// 在系统默认浏览器打开 WebUI。
#[tauri::command]
pub fn console_open_webui(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/");
    crate::validate_external_url(&url)?;
    crate::open_url_with_system(&url)
}

/// 构造本地 backend 的消息渠道启动 URL。
pub fn channels_start_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/channels/start")
}

/// 启动消息渠道:转发 POST /channels/start 到正在运行的 backend。
/// 等价于 `vibe-trading channels start`。backend 对 loopback 免 auth,无需鉴权头。
#[tauri::command]
pub fn console_start_channels(port: u16) -> Result<String, String> {
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端: {e}"))?
        .post(channels_start_url(port))
        .send()
        .map_err(|e| format!("调用 /channels/start 失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().map_err(|e| format!("读取响应: {e}"))?;
    if !status.is_success() {
        return Err(format!("后端返回 {status}: {body}"));
    }
    Ok(body)
}

/// 构造本地 backend 的消息渠道状态 URL。
pub fn channels_status_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/channels/status")
}

/// 消息渠道状态:转发 GET /channels/status,供控制台展示运行/未登录/失效。
/// backend 对 loopback 免 auth,无需鉴权头。服务未运行时由调用方决定不触发。
#[tauri::command]
pub fn console_channels_status(port: u16) -> Result<String, String> {
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端: {e}"))?
        .get(channels_status_url(port))
        .send()
        .map_err(|e| format!("调用 /channels/status 失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().map_err(|e| format!("读取响应: {e}"))?;
    if !status.is_success() {
        return Err(format!("后端返回 {status}: {body}"));
    }
    Ok(body)
}

/// 安装单个消息渠道的可选依赖:用 venv 解释器 spawn
/// `pip install --no-input 'vibe-trading-ai[<channel>]'`,逐行 emit "channeldep://progress"。
/// pip 进度几乎全走 stderr,故 stdout/stderr 各开一线程转发,避免日志空白。
#[tauri::command]
pub async fn console_install_channel_dep(
    app: AppHandle,
    channel: String,
) -> Result<(), String> {
    validate_channel(&channel)?;
    let layout = Layout::from_home()?;
    if !layout.venv_python.exists() {
        return Err("环境未就绪,请先完成依赖安装".into());
    }
    let mut child = build_channel_dep_cmd(&layout.venv_python, &channel)
        .spawn()
        .map_err(|e| format!("spawn pip: {e}"))?;
    let stdout = child.stdout.take().ok_or("no pip stdout")?;
    let stderr = child.stderr.take().ok_or("no pip stderr")?;
    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app_out.emit("channeldep://progress", line);
        }
    });
    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("channeldep://progress", line);
        }
    });
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app.emit("channeldep://exit", code);
    });
    Ok(())
}

/// 关闭窗口时是否需要二次确认:服务运行中或依赖安装中都需要提醒用户。
/// 纯函数,便于单测覆盖「运行中/安装中/空闲」三态。
pub fn needs_close_confirmation(service_running: bool, installing: bool) -> bool {
    service_running || installing
}

/// 用户在二次确认框点「确认关闭」后调用:置位放行标志,随后前端再触发关闭。
#[tauri::command]
pub fn console_confirm_close(confirmed: State<'_, CloseConfirmed>) {
    confirmed.0.store(true, Ordering::SeqCst);
}

/// 强制清理虚拟环境:删除 ~/.vibe-trading/venv,便于用户从零重新安装依赖。
///
/// 仅删除 venv 目录本身(包含解释器与已装依赖);不动 runtime/、.env、
/// sessions/ 等用户数据。删除前应停止服务,否则正在运行的 sidecar 进程
/// 会持有该目录(Windows 下会删除失败)。纯函数便于单测覆盖「存在/不存在」。
pub fn clear_venv_dir(layout: &Layout) -> Result<(), String> {
    if !layout.venv_dir.exists() {
        return Ok(()); // 幂等:目录本就不存在,视为已清理。
    }
    fs::remove_dir_all(&layout.venv_dir)
        .map_err(|e| format!("清理 venv 失败 {}: {e}", layout.venv_dir.display()))
}

/// 强制清理虚拟环境:删除 ~/.vibe-trading/venv,便于用户从零重新安装依赖。
#[tauri::command]
pub fn console_clear_venv() -> Result<(), String> {
    let layout = Layout::from_home()?;
    clear_venv_dir(&layout)
}

/// 在文件管理器打开 ~/.vibe-trading/logs/。
#[tauri::command]
pub fn console_open_logs() -> Result<(), String> {
    let layout = Layout::from_home()?;
    std::fs::create_dir_all(&layout.logs_dir)
        .map_err(|e| format!("mkdir logs: {e}"))?;
    open_path_in_file_manager(&layout.logs_dir)
}

#[cfg(target_os = "macos")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open logs: {e}"))
}

#[cfg(target_os = "windows")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open logs: {e}"))
}

#[cfg(target_os = "linux")]
fn open_path_in_file_manager(p: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open logs: {e}"))
}

// ── 广告 ──

/// 广告项（镜像 cool-admin MarketingAdEntity select 字段）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdItem {
    pub id: i64,
    pub title: String,
    /// 1=纯图片 2=纯文本
    #[serde(rename = "type")]
    pub ad_type: i64,
    pub position: String,
    #[serde(default)]
    pub images: Option<Vec<AdImage>>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    pub sort: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdImage {
    pub url: String,
    #[serde(default)]
    pub link: Option<String>,
}

/// 调用 cool-admin 公开接口拉取广告列表。
/// POST /app/marketing/ad/list → { type?, position? } → { code, data: AdItem[], message }
/// 无鉴权（IGNORE_TOKEN），静默失败：接口挂了或没广告时返回空数组。
///
/// 注意：reqwest::blocking 会阻塞调用线程。若在 #[tauri::command] 同步函数中调用，
/// 会占住 Tauri 异步运行时线程，导致 webview 整体假死（与 start/stop 服务同类问题）。
/// 解法与 console_start_service 一致：改为 async fn + spawn_blocking 甩到线程池。
#[tauri::command]
pub async fn console_fetch_ads(position: String) -> Result<Vec<AdItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("{}/app/marketing/ad/list", auth::user_api_url());
        let body = serde_json::json!({ "position": position });
        let text = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("build client: {e}"))?
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| format!("ad list request: {e}"))?
            .text()
            .map_err(|e| format!("ad list body: {e}"))?;
        auth::parse_cool_response::<Vec<AdItem>>(&text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

// ── 测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn env_status_not_installed_when_no_venv() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        assert_eq!(compute_env_status(&layout), EnvStatus::NotInstalled);
    }

    #[test]
    fn env_status_incomplete_when_venv_without_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        fs::create_dir_all(layout.venv_python.parent().unwrap()).unwrap();
        fs::write(&layout.venv_python, "#!/bin/sh\n").unwrap();
        assert_eq!(compute_env_status(&layout), EnvStatus::Incomplete);
    }

    #[test]
    fn env_status_ready_when_venv_and_marker_present() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        fs::create_dir_all(layout.venv_python.parent().unwrap()).unwrap();
        fs::write(&layout.venv_python, "#!/bin/sh\n").unwrap();
        fs::write(layout.venv_dir.join(".requirements_hash"), "deadbeef").unwrap();
        assert_eq!(compute_env_status(&layout), EnvStatus::Ready);
    }

    #[test]
    fn channels_start_url_targets_local_backend() {
        assert_eq!(
            channels_start_url(8899),
            "http://127.0.0.1:8899/channels/start"
        );
    }

    #[test]
    fn bootstrap_cmd_runs_cli_bootstrap_sse() {
        let cmd = build_bootstrap_cmd(Path::new("/rt/bin/python3"), Path::new("/rt/agent"));
        let args: Vec<&str> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        let joined = args.join(" ");
        assert!(joined.contains("bootstrap"), "args: {joined}");
        assert!(joined.contains("--sse"), "args: {joined}");
        let mut has_pythonpath = false;
        for (k, v) in cmd.get_envs() {
            if k.to_str() == Some("PYTHONPATH")
                && v.and_then(|x| x.to_str()) == Some("/rt/agent")
            {
                has_pythonpath = true;
            }
        }
        assert!(
            has_pythonpath,
            "bootstrap 子进程须设 PYTHONPATH 指向 runtime agent"
        );
    }

    #[test]
    fn validate_channel_accepts_known_channels() {
        for ok in ["telegram", "slack", "discord", "weixin", "wecom", "qq", "napcat", "feishu", "dingtalk"] {
            assert!(validate_channel(ok).is_ok(), "{ok} 应合法");
        }
    }

    #[test]
    fn validate_channel_rejects_injection_and_garbage() {
        for bad in ["", "tel egram", "tel;egram", "../etc", "Telegram", "a$b", "with space"] {
            assert!(validate_channel(bad).is_err(), "{bad:?} 应被拒");
        }
    }

    #[test]
    fn channel_dep_cmd_installs_extra_with_no_input() {
        let cmd = build_channel_dep_cmd(Path::new("/v/bin/python3"), "telegram");
        let args: Vec<&str> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        let joined = args.join(" ");
        assert!(joined.contains("--no-input"), "args: {joined}");
        assert!(
            joined.contains("vibe-trading-ai[telegram]"),
            "args: {joined}"
        );
    }

    #[test]
    fn parse_sse_progress_frame_extracts_stage_and_message() {
        let ev = parse_sse_data("progress", r#"{"stage": "installing", "message": "Collecting pandas"}"#)
            .expect("progress 帧应解析成功");
        assert_eq!(ev.stage, "installing");
        assert_eq!(ev.message, "Collecting pandas");
        assert!(ev.ok, "progress 帧默认 ok=true");
    }

    #[test]
    fn parse_sse_done_frame_falls_back_to_event_name_for_stage() {
        // done/failed 帧的 data 不带 stage,应退回 event 名。
        let ev = parse_sse_data("done", r#"{"ok": true, "message": "environment ready"}"#)
            .expect("done 帧应解析成功");
        assert_eq!(ev.stage, "done");
        assert_eq!(ev.message, "environment ready");
        assert!(ev.ok);
    }

    #[test]
    fn parse_sse_failed_frame_preserves_ok_false() {
        let ev = parse_sse_data("failed", r#"{"ok": false, "message": "deps incomplete: numpy"}"#)
            .expect("failed 帧应解析成功");
        assert_eq!(ev.stage, "failed");
        assert!(!ev.ok, "failed 帧须保留 ok=false 供前端标红");
    }

    #[test]
    fn parse_sse_rejects_non_json_data() {
        assert!(parse_sse_data("progress", "not json").is_none());
    }

    #[test]
    fn clear_venv_dir_removes_existing_venv() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        fs::create_dir_all(layout.venv_dir.join("lib")).unwrap();
        fs::write(layout.venv_dir.join("marker"), "x").unwrap();
        assert!(layout.venv_dir.exists());
        clear_venv_dir(&layout).expect("清理应成功");
        assert!(!layout.venv_dir.exists(), "venv 应被删除");
    }

    #[test]
    fn clear_venv_dir_idempotent_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        let layout = crate::runtime_dir::Layout::new(&home);
        assert!(!layout.venv_dir.exists());
        clear_venv_dir(&layout).expect("缺失时应幂等成功");
        assert!(!layout.venv_dir.exists());
    }

    #[test]
    fn close_confirmation_required_when_running_or_installing() {
        assert!(needs_close_confirmation(true, false), "运行中应确认");
        assert!(needs_close_confirmation(false, true), "安装中应确认");
        assert!(needs_close_confirmation(true, true), "同时进行更应确认");
        assert!(!needs_close_confirmation(false, false), "空闲直接关闭");
    }
}
