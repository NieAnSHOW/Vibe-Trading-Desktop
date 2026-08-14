//! 主窗口内嵌 WebUI 的状态与导航辅助。
//!
//! 主窗口默认承载控制台(console-dist);服务就绪后由 `console_open_webui`
//! 把 webview 直接导航到本地 backend(`http://127.0.0.1:<port>/`),产品以
//! 完整桌面应用形态呈现,而"在浏览器打开"降级为次要入口。
//!
//! 这里集中管理嵌入态:
//! - 记录导航前的控制台 URL,托盘「返回控制台」/服务停止时可随时回去;
//! - 托盘「退出」在嵌入态下先把窗口带回控制台并挂起确认标记,待页面
//!   加载完成后由 main.rs 的 on_page_load 补发 QUIT_REQUESTED_EVENT——
//!   控制台页被替换期间,原有的事件直达确认框不再可用。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// 内嵌导航状态。命令线程/监视线程/托盘回调并发访问,全部走原子与锁。
#[derive(Default)]
pub struct WebuiEmbedState {
    embedded: AtomicBool,
    console_url: Mutex<Option<tauri::Url>>,
    quit_pending: AtomicBool,
}

impl WebuiEmbedState {
    pub fn is_embedded(&self) -> bool {
        self.embedded.load(Ordering::SeqCst)
    }

    /// 进入嵌入态,记录当前控制台 URL。仅首次嵌入时保存,避免重复嵌入时
    /// 把 WebUI 自身误存为控制台地址,导致「返回控制台」原地打转。
    pub fn begin_embed(&self, console_url: tauri::Url) {
        let mut saved = self.console_url.lock().unwrap();
        if saved.is_none() {
            *saved = Some(console_url);
        }
        self.embedded.store(true, Ordering::SeqCst);
    }

    /// 退出嵌入态,返回应导航回去的控制台 URL;未嵌入时为 no-op 返回 None。
    pub fn end_embed(&self) -> Option<tauri::Url> {
        if !self.embedded.swap(false, Ordering::SeqCst) {
            return None;
        }
        self.console_url.lock().unwrap().take()
    }

    pub fn set_quit_pending(&self) {
        self.quit_pending.store(true, Ordering::SeqCst);
    }

    pub fn take_quit_pending(&self) -> bool {
        self.quit_pending.swap(false, Ordering::SeqCst)
    }
}

/// 构造 WebUI 地址。纯函数便于单测;仅指向回环。
pub fn webui_url(port: u16) -> Result<tauri::Url, String> {
    tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|e| format!("invalid webui url: {e}"))
}

/// 主窗口导航进 WebUI。仅在未嵌入时保存当前 URL;失败时由调用方决定
/// 是否回退系统浏览器。
pub fn embed(app: &AppHandle, port: u16) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let target = webui_url(port)?;
    let state = app.state::<WebuiEmbedState>();
    if !state.is_embedded() {
        let current = win.url().map_err(|e| format!("read webview url: {e}"))?;
        state.begin_embed(current);
    }
    win.navigate(target)
        .map_err(|e| format!("navigate to webui: {e}"))
}

/// 从 WebUI 返回控制台;未嵌入时是幂等 no-op。
pub fn return_to_console(app: &AppHandle) {
    let state = app.state::<WebuiEmbedState>();
    if let Some(console_url) = state.end_embed() {
        if let Some(win) = app.get_webview_window("main") {
            if let Err(e) = win.navigate(console_url) {
                eprintln!("warn: navigate back to console: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webui_url_points_to_loopback_root() {
        let url = webui_url(8899).expect("parse");
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8899));
        assert_eq!(url.path(), "/");
    }

    #[test]
    fn begin_embed_saves_console_url_only_once() {
        let state = WebuiEmbedState::default();
        let console = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        state.begin_embed(console.clone());
        // 重复嵌入(例如按钮连点)不得把 WebUI 地址覆盖成控制台地址。
        state.begin_embed(tauri::Url::parse("http://127.0.0.1:8899/").unwrap());
        assert_eq!(state.end_embed(), Some(console));
    }

    #[test]
    fn end_embed_is_noop_when_not_embedded() {
        let state = WebuiEmbedState::default();
        assert_eq!(state.end_embed(), None);
        assert!(!state.is_embedded());
    }

    #[test]
    fn quit_pending_flag_round_trips() {
        let state = WebuiEmbedState::default();
        assert!(!state.take_quit_pending());
        state.set_quit_pending();
        assert!(state.take_quit_pending());
        // 取走即清零:控制台页加载完成后补发一次,不重复弹确认框。
        assert!(!state.take_quit_pending());
    }
}
