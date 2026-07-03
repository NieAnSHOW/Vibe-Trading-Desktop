//! 桌面控制台 IPC —— 环境/服务状态、启停服务、bootstrap 转发、打开 WebUI/日志。
//! 逻辑尽量做成纯函数(可 cargo 测);Tauri command 是薄壳(设计 D3)。

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::runtime_dir::Layout;

pub type SharedChild = Arc<Mutex<Option<Child>>>;

// ── 纯函数(状态判定、命令构造) ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvStatus {
    NotInstalled,
    Incomplete,
    Ready,
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

// ── Tauri IPC 命令 ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct StatusReport {
    pub env: EnvStatus,
    pub service_running: bool,
    pub port: Option<u16>,
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

/// 触发依赖 bootstrap:spawn `vibe-trading bootstrap --sse`,逐行 emit "bootstrap://progress"。
#[tauri::command]
pub async fn console_bootstrap(app: AppHandle) -> Result<(), String> {
    let layout = Layout::from_home()?;
    let res = crate::resources::Resources::resolve(&app)
        .map_err(|e| format!("resources: {e}"))?;
    let mut child = build_bootstrap_cmd(&res.runtime_python, &layout.runtime_agent)
        .spawn()
        .map_err(|e| format!("spawn bootstrap: {e}"))?;
    let stdout = child.stdout.take().ok_or("no bootstrap stdout")?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app2.emit("bootstrap://progress", line);
        }
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app2.emit("bootstrap://exit", code);
    });
    Ok(())
}

/// 启动服务:环境未就绪时拒绝;否则用 venv 解释器 spawn serve + 健康门控。
#[tauri::command]
pub fn console_start_service(
    app: AppHandle,
    state: State<'_, SharedChild>,
) -> Result<u16, String> {
    let layout = Layout::from_home()?;
    if compute_env_status(&layout) != EnvStatus::Ready {
        return Err("环境未就绪,请先完成依赖安装".into());
    }
    if state.lock().unwrap().is_some() {
        return Err("服务已在运行".into());
    }
    let port = crate::port::pick_free_port()?;
    let mut child = crate::sidecar::spawn(
        &layout.venv_python,
        &layout.runtime_agent,
        port,
        &layout.runtime_libs,
        &layout.sessions_dir,
    )?;
    match crate::sidecar::await_health(&mut child, port) {
        crate::sidecar::Ready::Ok => {
            state.lock().unwrap().replace(child);
            let _ = app.emit("service://started", port);
            Ok(port)
        }
        crate::sidecar::Ready::ProcessExited(c) => {
            Err(format!("后端提前退出(退出码 {c:?})"))
        }
        crate::sidecar::Ready::Timeout => Err("后端 120 秒内未就绪".into()),
    }
}

/// 停止服务:干净回收 sidecar 进程组。
#[tauri::command]
pub fn console_stop_service(state: State<'_, SharedChild>) -> Result<(), String> {
    if let Some(mut child) = state.lock().unwrap().take() {
        crate::sidecar::terminate(&mut child);
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
}
