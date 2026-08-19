#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod auth;
mod console;
mod port;
mod resources;
mod runtime_dir;
mod settings;
mod sidecar;
mod tray;
mod updater;
mod version;
mod webui_embed;
mod window_style;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

type SharedChild = console::SharedChild;
type SharedPort = console::SharedPort;

fn main() {
    let shared: SharedChild = Arc::new(Mutex::new(None));
    let shared_setup = shared.clone();
    let service_port: SharedPort = Arc::new(Mutex::new(None));
    let service_port_setup = service_port.clone();
    let auth_state = auth::AuthState(std::sync::Arc::new(std::sync::Mutex::new(None)));
    let runtime_operation = console::RuntimeOperationLock::new();
    let runtime_operation_setup = runtime_operation.clone();

    // bootstrap 进行中标志(console::console_bootstrap 维护)。托盘「退出」据此判断
    // 是否需要二次确认;窗口关闭按钮 X 不再触发确认——它一律静默收纳到后台。
    let installing = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        // Persistent shell state: WebUI is a retained child frame, not a main-webview navigation.
        .manage(webui_embed::WebuiEmbedState::default())
        // 单实例保护：第二个进程实例启动时，唤回第一个实例的主窗口并退出自身。
        // Windows 用命名 Mutex 实现锁；macOS/Linux 用 Unix domain socket。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二实例的启动参数传入此回调，当前无需处理；仅唤回主窗口即可。
            tray::show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            console::console_status,
            console::console_bootstrap,
            console::console_start_service,
            console::console_stop_service,
            console::console_open_webui,
            console::console_take_pending_webui,
            console::console_close_webui,
            console::console_open_webui_external,
            console::console_start_channels,
            console::console_channels_status,
            console::console_stop_channels,
            console::console_run_pairing_command,
            console::console_weixin_login_start,
            console::console_weixin_login_status,
            console::console_get_llm_settings,
            console::console_set_llm_settings,
            console::console_get_data_source_settings,
            console::console_set_data_source_settings,
            console::console_install_channel_dep,
            console::console_quit,
            console::console_open_logs,
            console::console_clear_logs,
            console::console_clear_venv,
            console::console_uninstall_legacy_app,
            console::console_check_environment,
            console::console_repair_environment,
            console::console_get_settings,
            console::console_set_autostart,
            console::console_set_theme_mode,
            console::console_set_theme_color,
            console::console_set_api_auth_key,
            console::console_login_captcha,
            console::console_login_send_sms,
            console::console_login_by_phone,
            console::console_login_by_password,
            console::console_login_register,
            console::console_login_set_password,
            console::console_auth_status,
            console::console_member_usage,
            console::console_member_benefits,
            console::console_logout,
            console::console_custom_llm_readiness,
            console::console_logout_to_custom,
            console::console_fetch_ads,
            console::console_get_public_config,
            console::console_check_update,
            console::console_download_update,
            console::console_install_update,
        ])
        .manage(console::InstallingFlag(installing))
        .manage(auth_state.clone())
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 后台挂载:点关闭按钮 X 一律静默隐藏窗口(收纳后台),不退出应用。
                // sidecar / 安装任务继续在后台运行;唤回与真正退出都走系统托盘(见 tray.rs)。
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let res =
                resources::Resources::resolve(&handle).map_err(|e| format!("resources: {e}"))?;
            // 安装系统托盘:后台挂载态下唤回窗口 / 退出应用的唯一入口。
            tray::build(&handle).map_err(|e| format!("tray: {e}"))?;
            let win = app
                .get_webview_window("main")
                .expect("main window (defined in tauri.conf.json)");
            #[cfg(target_os = "windows")]
            if let Err(error) = win
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| window_style::apply_windows_titlebar_color(hwnd.0 as isize))
            {
                eprintln!("failed to set Windows title bar color: {error}");
            }

            let shared = shared_setup.clone();
            let service_port = service_port_setup.clone();
            let auth_state = auth_state.clone();
            let runtime_operation = runtime_operation_setup.clone();
            std::thread::spawn(move || {
                if let Err(msg) = boot(
                    &handle,
                    &win,
                    &res,
                    &shared,
                    &service_port,
                    &auth_state,
                    &runtime_operation,
                ) {
                    let safe_json = serde_json::to_string(&msg)
                        .unwrap_or_else(|_| "\"unknown error\"".to_string());
                    let _ = win.eval(&format!(
                        "var e=document.getElementById('err');if(e)e.textContent={safe_json};"
                    ));
                }
            });
            Ok(())
        })
        .manage(shared.clone())
        .manage(service_port)
        .manage(runtime_operation)
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = shared.lock().unwrap().take() {
                    sidecar::terminate(&mut child);
                }
            }
        });
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    open_url_with_system(&url)
}

pub fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("only http and https URLs can be opened externally".to_string()),
    }
}

#[cfg(target_os = "macos")]
pub fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

#[cfg(target_os = "windows")]
pub fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

#[cfg(target_os = "linux")]
pub fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

/// 准备可写运行目录(会话/日志/venv 父目录就绪;runtime/ 代码刷新)。
/// 服务启动必须等待 Vue onboarding 完成环境与登录门控，避免原生 boot
/// 绕过登录直接打开研究页。
fn should_auto_start(_env: console::EnvStatus, _service_running: bool) -> bool {
    false
}

fn boot(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    res: &resources::Resources,
    shared: &SharedChild,
    service_port: &SharedPort,
    auth_state: &auth::AuthState,
    runtime_operation: &console::RuntimeOperationLock,
) -> Result<(), String> {
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(
        &res.agent_template,
        &res.env_seed,
        &res.version_file,
        Some(&res.frontend_dist),
        &layout,
    )?;
    if should_auto_start(
        console::compute_env_status(&layout),
        shared.lock().unwrap().is_some(),
    ) {
        let app = app.clone();
        let win = win.clone();
        let shared = shared.clone();
        let service_port = service_port.clone();
        let auth_state = auth_state.clone();
        let runtime_operation = runtime_operation.clone();
        tauri::async_runtime::spawn(async move {
            let _ = win.eval(
                "var e=document.getElementById('err');if(e)e.textContent='正在自动启动服务...';",
            );
            match console::start_service_inner(
                &app,
                &shared,
                &service_port,
                &auth_state,
                &runtime_operation,
            )
            .await
            {
                Ok(port) => {
                    let _ = app.emit("service://started", port);
                    // The Vue shell consumes this request from its retained frame.
                    if let Err(e) = console::console_open_webui(app.clone(), port) {
                        eprintln!("warn: auto open webui failed: {e}");
                    }
                    let _ = win.eval("var e=document.getElementById('err');if(e)e.textContent='';");
                }
                Err(error) => {
                    // 失败不阻塞控制台:保留错误信息在 err 栏,用户仍可手动启动。
                    let safe_json = serde_json::to_string(&format!("自动启动服务失败: {error}"))
                        .unwrap_or_else(|_| "\"自动启动服务失败\"".to_string());
                    let _ = win.eval(&format!(
                        "var e=document.getElementById('err');if(e)e.textContent={safe_json};"
                    ));
                }
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_allows_http_and_https() {
        assert!(validate_external_url("https://www.10jqka.com.cn/").is_ok());
        assert!(validate_external_url("http://example.com/path?q=1").is_ok());
    }

    #[test]
    fn external_url_rejects_non_web_protocols() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("not a url").is_err());
    }

    #[test]
    fn ready_environment_waits_for_the_frontend_start_gate() {
        assert!(!should_auto_start(console::EnvStatus::Ready, false));
        assert!(!should_auto_start(console::EnvStatus::Incomplete, false));
        assert!(!should_auto_start(console::EnvStatus::NotInstalled, false));
        assert!(!should_auto_start(console::EnvStatus::Ready, true));
    }

    // console-dist/index.html 顶层执行 `window.__TAURI__.core`;Tauri v2 仅在
    // app.withGlobalTauri=true 时注入 window.__TAURI__(默认 false)。缺此项时
    // module script 抛 TypeError 中断 —— 环境徽标卡在"检测中...",按钮不绑定。
    #[test]
    fn tauri_conf_enables_global_tauri_for_console() {
        let cfg: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("parse tauri.conf.json");
        assert_eq!(
            cfg["app"]["withGlobalTauri"],
            serde_json::Value::Bool(true),
            "app.withGlobalTauri 须为 true,否则控制台 HTML 拿不到 window.__TAURI__"
        );
    }

    #[test]
    fn tauri_conf_uses_resizable_wide_console_window() {
        let cfg: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("parse tauri.conf.json");
        let window = &cfg["app"]["windows"][0];

        assert_eq!(window["width"], 1380);
        assert_eq!(window["height"], 940);
        assert_eq!(window["minWidth"], 900);
        assert_eq!(window["minHeight"], 780);
        assert_eq!(window["resizable"], true);
        assert_eq!(window["maximizable"], true);
    }

    #[test]
    fn tauri_conf_bundles_runtime_version_marker() {
        let cfg: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("parse tauri.conf.json");
        assert_eq!(
            cfg["bundle"]["resources"]["../.desktop-build/VERSION"],
            serde_json::Value::String("VERSION".into()),
            "bundle.resources 必须打包 VERSION,否则 release 下 runtime prepare 读不到版本标记"
        );
    }
}
