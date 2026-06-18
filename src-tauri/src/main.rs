#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod resources; mod version; mod runtime_dir; mod port; mod sidecar;

use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

type SharedChild = Arc<Mutex<Option<Child>>>;

fn main() {
    let shared: SharedChild = Arc::new(Mutex::new(None));
    let shared_setup = shared.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![open_external_url])
        .setup(move |app| {
            let handle = app.handle().clone();
            // D3: 窗口先开,加载本地加载页(frontendDist 的 index.html,带 logo + spinner)
            let res = resources::Resources::resolve(&handle)
                .map_err(|e| format!("resources: {e}"))?;
            let win = WebviewWindowBuilder::new(
                &handle, "main",
                WebviewUrl::App("index.html".into()))
                .title("Vibe Trading").inner_size(1280.0, 832.0).build()?;

            let shared = shared_setup.clone();
            std::thread::spawn(move || {
                if let Err(msg) = boot(&handle, &win, &res, &shared) {
                    // JSON 编码错误消息，安全注入到 JS 侧（避免 XSS）
                    let safe_json = serde_json::to_string(&msg)
                        .unwrap_or_else(|_| "\"unknown error\"".to_string());
                    let _ = win.eval(&format!(
                        "document.getElementById('spin').style.display='none';\
                         document.getElementById('msg').textContent='启动失败';\
                         var e=document.getElementById('err');e.style.display='block';\
                         e.textContent={safe_json};\
                         var q=document.getElementById('quit');q.style.display='block';\
                         q.onclick=function(){{window.__TAURI__.process.exit(1)}};"));
                }
            });
            Ok(())
        })
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

fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("only http and https URLs can be opened externally".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

#[cfg(target_os = "windows")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

#[cfg(target_os = "linux")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open external url: {e}"))
}

fn boot(
    _handle: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    res: &resources::Resources,
    shared: &SharedChild,
) -> Result<(), String> {
    // D4/D5: 准备可写运行目录
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(&res.agent_template, &res.env_seed, &res.version_file, Some(&res.frontend_dist), &layout)?;
    // D6: 选端口
    // dev 模式固定 8899（与 Vite proxy 默认 target 对齐），release 由系统分配。
    let is_dev = cfg!(debug_assertions);
    let p = sidecar_port_dev_aware(is_dev)?;
    // D6.5 (dev): 清理上次 session 可能遗留的 sidecar 进程，避免 await_health
    // 误连旧进程（旧进程已监听同一端口，新进程 start-up 缓慢时竞态会发生）。
    if is_dev {
        port::kill_listener_on_port(p);
    }
    // D7: 启动 sidecar(PYTHONPATH 指向可写副本)
    let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p, &layout.runtime_libs)?;
    // D8: 门控
    match sidecar::await_health(&mut child, p) {
        sidecar::Ready::Ok => {
            shared.lock().unwrap().replace(child);
            // Tauri 2 navigate 接受 Url 类型
            // dev：导航到 Vite dev server（HMR）；release：sidecar 静态 SPA。
            let target = nav_target_dev_aware(is_dev, p);
            win.navigate(tauri::Url::parse(&target).map_err(|e| format!("parse url: {e}"))?)
                .map_err(|e| format!("navigate: {e}"))?;
            Ok(())
        }
        sidecar::Ready::ProcessExited(code) =>
            Err(format!("后端进程提前退出(退出码 {code:?})。请检查依赖与配置。")),
        sidecar::Ready::Timeout =>
            Err("后端在 120 秒内未就绪(健康检查超时)。".into()),
    }
}

/// 选择 sidecar 监听端口。
///
/// - dev（`cargo tauri dev`）：固定 `8899`，与 `frontend/vite.config.ts` 中 Vite
///   proxy 的默认 target 对齐——webview 走 Vite 时，`/sessions` 等 API 请求才能被
///   正确转发到 sidecar。
/// - release：由系统分配空闲端口，避免与用户环境冲突。
fn sidecar_port_dev_aware(is_dev: bool) -> Result<u16, String> {
    if is_dev {
        Ok(8899)
    } else {
        port::pick_free_port()
    }
}

/// webview 最终导航目标。
///
/// - dev：Vite dev server，保留 HMR；sidecar 仅作为 API 后端，由 Vite proxy 转发。
/// - release：sidecar 自身静态托管 SPA（`~/.vibe-trading/runtime/frontend/dist`）。
fn nav_target_dev_aware(is_dev: bool, sidecar_port: u16) -> String {
    if is_dev {
        "http://127.0.0.1:5899/".to_string()
    } else {
        format!("http://127.0.0.1:{sidecar_port}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_pins_sidecar_port_to_vite_proxy_target() {
        // dev 固定 8899，确保与 Vite proxy 默认 target 一致
        assert_eq!(sidecar_port_dev_aware(true).unwrap(), 8899);
    }

    #[test]
    fn release_uses_system_allocated_port() {
        let p = sidecar_port_dev_aware(false).unwrap();
        assert!(p >= 1024, "期望临时端口，得到 {p}");
    }

    #[test]
    fn dev_navigates_to_vite_dev_server() {
        assert_eq!(nav_target_dev_aware(true, 8899), "http://127.0.0.1:5899/");
    }

    #[test]
    fn release_navigates_to_sidecar() {
        assert_eq!(nav_target_dev_aware(false, 7070), "http://127.0.0.1:7070/");
    }

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
}
