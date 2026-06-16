#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod resources; mod version; mod runtime_dir; mod port; mod sidecar; mod tabs;

use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

type SharedChild = Arc<Mutex<Option<Child>>>;

fn main() {
    let shared: SharedChild = Arc::new(Mutex::new(None));
    let shared_setup = shared.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
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

// ══════════════════════════════════════════════════════════════════════════
// Task 1 spike: Tauri 2.11.2 unstable 多 webview API 编译可用性验证
//
// 本模块验证设计文档依赖的所有 unstable API 在 features=["unstable"]
// 下是否存在 + 方法签名是否匹配预期。测试不运行实际逻辑，仅通过编译
// 确认类型与符号存在。任何编译失败都意味着 spike 不通过。
//
// 实际 Tauri 2.11.2 源码签名（通过 cargo registry 源码核实）：
//  - add_child<P: Into<Position>, S: Into<Size>>(&self, WebviewBuilder, P, S) -> Result<Webview>
//  - webview.show / hide / set_focus / close -> Result<()>
//  - webview.set_size<S: Into<Size>>(&self, S) -> Result<()>
//  - webview.set_position<Pos: Into<Position>>(&self, Pos) -> Result<()>
//  - webview.navigate(&self, Url) -> Result<()>
//  - Window::webviews(&self) -> Vec<Webview<R>>
//  - Manager::webviews(&self) -> HashMap<String, Webview<R>>
//  - Manager::get_webview(&self, &str) -> Option<Webview<R>>
// ══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod spike_api_verify {
    // Manager trait 必须在作用域内才能调用 get_webview/webviews/get_window
    use tauri::Manager;

    // ── Step 2: 关键类型可 import ──────────────────────────────────────

    #[test]
    fn api_window_builder() {
        // WindowBuilder<'a, R, M>: 仅在 #[cfg(feature = "unstable")] 下 re-export
        // 验证类型和 new 方法存在即可（linter 会去掉未使用的 type alias）
        fn _new(m: &tauri::AppHandle, label: &str) {
            let _ = tauri::WindowBuilder::new(m, label);
        }
    }

    #[test]
    fn api_webview_builder() {
        // WebviewBuilder<R>: 仅在 #[cfg(feature = "unstable")] 下 re-export
        type _Wb = tauri::WebviewBuilder<tauri::Wry>;
        // 确认 new(label, url) 存在
        fn _new(label: &str, url: tauri::WebviewUrl) -> tauri::WebviewBuilder<tauri::Wry> {
            tauri::WebviewBuilder::new(label, url)
        }
    }

    #[test]
    fn api_webview_type() {
        // tauri::Webview (即 tauri::webview::Webview) — add_child 的返回值
        let _: Option<tauri::Webview> = None;
    }

    #[test]
    fn api_logical_position() {
        let _pos: tauri::LogicalPosition<f64> = tauri::LogicalPosition::new(0.0, 0.0);
    }

    #[test]
    fn api_logical_size() {
        let _size: tauri::LogicalSize<f64> = tauri::LogicalSize::new(1280.0, 800.0);
    }

    #[test]
    fn api_position_and_size_enums() {
        // Position 与 Size enum 变体（LogicalPosition/Size 可 Into 它们）
        let _p: tauri::Position = tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0));
        let _s: tauri::Size = tauri::Size::Logical(tauri::LogicalSize::new(1280.0, 800.0));
    }

    // ── Step 3: Webview 方法签名 ───────────────────────────────────────

    #[test]
    fn sig_webview_show() {
        // show(&self) -> Result<()>
        let _: fn(&tauri::Webview) -> Result<(), tauri::Error> = |w| w.show();
    }

    #[test]
    fn sig_webview_hide() {
        // hide(&self) -> Result<()>
        let _: fn(&tauri::Webview) -> Result<(), tauri::Error> = |w| w.hide();
    }

    #[test]
    fn sig_webview_set_size() {
        // set_size<S: Into<Size>>(&self, S) -> Result<()>
        let _: fn(&tauri::Webview, tauri::LogicalSize<f64>) -> Result<(), tauri::Error> =
            |w, sz| w.set_size(sz);
    }

    #[test]
    fn sig_webview_set_position() {
        // set_position<Pos: Into<Position>>(&self, Pos) -> Result<()>
        let _: fn(&tauri::Webview, tauri::LogicalPosition<f64>) -> Result<(), tauri::Error> =
            |w, pos| w.set_position(pos);
    }

    #[test]
    fn sig_webview_close() {
        // close(&self) -> Result<()>
        let _: fn(&tauri::Webview) -> Result<(), tauri::Error> = |w| w.close();
    }

    #[test]
    fn sig_webview_navigate() {
        // navigate(&self, Url) -> Result<()>  (Url = tauri::Url = url::Url)
        let _: fn(&tauri::Webview, tauri::Url) -> Result<(), tauri::Error> =
            |w, u| w.navigate(u);
    }

    #[test]
    fn sig_webview_set_focus() {
        // set_focus(&self) -> Result<()>
        let _: fn(&tauri::Webview) -> Result<(), tauri::Error> = |w| w.set_focus();
    }

    // ── Window 方法签名 ────────────────────────────────────────────────

    #[test]
    fn sig_window_add_child() {
        // 实际签名：add_child<P: Into<Position>, S: Into<Size>>(
        //     &self, WebviewBuilder<R>, position: P, size: S) -> Result<Webview<R>>
        //
        // 调用时传入 LogicalPosition<f64> / LogicalSize<f64>，各自满足 Into 边界。
        let _: fn(
            &tauri::Window,
            tauri::WebviewBuilder<tauri::Wry>,
            tauri::LogicalPosition<f64>,
            tauri::LogicalSize<f64>,
        ) -> Result<tauri::Webview, tauri::Error> =
            |win, bld, pos, sz| win.add_child(bld, pos, sz);
    }

    #[test]
    fn sig_window_webviews() {
        // Window::webviews(&self) -> Vec<Webview<R>>
        // 返回值是 Vec（不是 iterator），不需要 .collect()
        fn check(win: &tauri::Window) -> Vec<tauri::Webview> {
            win.webviews()
        }
        let _ = check;
    }

    #[test]
    fn sig_window_inner_size() {
        // inner_size() -> Result<PhysicalSize<u32>>
        let _: fn(&tauri::Window) -> Result<tauri::PhysicalSize<u32>, tauri::Error> =
            |w| w.inner_size();
    }

    #[test]
    fn sig_window_scale_factor() {
        // scale_factor() -> Result<f64>
        let _: fn(&tauri::Window) -> Result<f64, tauri::Error> = |w| w.scale_factor();
    }

    // ── Manager trait（AppHandle 上的 get_window / get_webview）─────────

    #[test]
    fn sig_manager_get_window() {
        // Manager::get_window(&self, &str) -> Option<Window>
        let _: fn(&tauri::AppHandle, &str) -> Option<tauri::Window> =
            |h, label| h.get_window(label);
    }

    #[test]
    fn sig_manager_get_webview() {
        // Manager::get_webview(&self, &str) -> Option<Webview>
        let _: fn(&tauri::AppHandle, &str) -> Option<tauri::Webview> =
            |h, label| h.get_webview(label);
    }

    #[test]
    fn sig_manager_webviews() {
        // Manager::webviews(&self) -> HashMap<String, Webview<R>>
        use std::collections::HashMap;
        fn check(h: &tauri::AppHandle) -> HashMap<String, tauri::Webview> {
            h.webviews()
        }
        let _ = check;
    }

    // ── 事件 API ───────────────────────────────────────────────────────

    #[test]
    fn api_window_event_resized() {
        // WindowEvent::Resized(PhysicalSize<u32>) 变体存在
        fn on_event(ev: tauri::WindowEvent) -> tauri::PhysicalSize<u32> {
            match ev {
                tauri::WindowEvent::Resized(size) => size,
                _ => unreachable!(),
            }
        }
        let _ = on_event;
    }

    #[test]
    fn api_physical_to_logical() {
        // PhysicalSize::to_logical(scale: f64) -> LogicalSize<f64>
        let physical = tauri::PhysicalSize::<u32>::new(1280, 832);
        let _logical: tauri::LogicalSize<f64> = physical.to_logical(2.0);
    }

    // ── WebviewUrl 变体 ────────────────────────────────────────────────

    #[test]
    fn api_webview_url_app() {
        let _: tauri::WebviewUrl = tauri::WebviewUrl::App("index.html".into());
    }

    #[test]
    fn api_webview_url_external() {
        let _: tauri::WebviewUrl =
            tauri::WebviewUrl::External("https://example.com/".parse::<tauri::Url>().unwrap());
    }
}

// ── 原有业务测试（非 spike）───────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_pins_sidecar_port_to_vite_proxy_target() {
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
}
