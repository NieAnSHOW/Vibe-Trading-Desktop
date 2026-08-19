//! Persistent desktop-shell WebUI visibility and URL helpers.
//!
//! The main webview always keeps the console document alive. WebUI renders in
//! a retained iframe managed by that document, so entering research never
//! unloads the shell rail or the console's in-memory state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 内嵌导航状态。命令线程/监视线程/托盘回调并发访问,全部走原子与锁。
#[derive(Default)]
pub struct WebuiEmbedState {
    embedded: AtomicBool,
    pending_frame_url: Mutex<Option<String>>,
}

impl WebuiEmbedState {
    pub fn is_embedded(&self) -> bool {
        self.embedded.load(Ordering::SeqCst)
    }

    /// Mark the retained frame as visible.
    pub fn begin_embed(&self) {
        self.embedded.store(true, Ordering::SeqCst);
    }

    /// Hide the retained frame. Returns whether it was visible.
    pub fn end_embed(&self) -> bool {
        let was_embedded = self.embedded.swap(false, Ordering::SeqCst);
        self.pending_frame_url.lock().unwrap().take();
        was_embedded
    }

    /// Retain an auto-start URL until the Vue shell finishes registering event listeners.
    pub fn queue_frame_url(&self, url: String) {
        *self.pending_frame_url.lock().unwrap() = Some(url);
    }

    pub fn take_frame_url(&self) -> Option<String> {
        self.pending_frame_url.lock().unwrap().take()
    }
}

/// Construct the local WebUI frame URL. It is always loopback-only.
pub fn webui_url(
    port: u16,
    theme_mode: &str,
    theme_color: &str,
    api_key: &str,
) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|e| format!("invalid webui url: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("desktop", "1");
        pairs.append_pair("shell", "frame");
        pairs.append_pair("theme", theme_mode);
        pairs.append_pair("theme_color", theme_color);
        pairs.append_pair("transition", "1");
        // API 密钥始终随桌面 URL 传入(空=清除),WebUI 首载同步进 localStorage;
        // 桌面控制台是该密钥的唯一管理者(自 WebUI 设置页迁移而来)。
        pairs.append_pair("api_key", api_key);
    }
    Ok(url)
}

/// Prepare a retained iframe navigation without replacing the main webview.
pub fn prepare_frame(app: &AppHandle, port: u16) -> Result<String, String> {
    let state = app.state::<WebuiEmbedState>();
    let layout = crate::runtime_dir::Layout::from_home()?;
    let settings = crate::settings::load(&layout.root);
    let theme_mode = match settings.theme_mode.as_str() {
        "light" | "dark" | "system" => settings.theme_mode.as_str(),
        _ => "system",
    };
    let theme_color = match settings.theme_color.as_str() {
        "teal" | "blue" | "purple" | "pink" | "orange" | "green" => {
            settings.theme_color.as_str()
        }
        _ => "teal",
    };
    let target = webui_url(port, theme_mode, theme_color, settings.api_auth_key.trim())?;
    let target = target.to_string();
    state.begin_embed();
    state.queue_frame_url(target.clone());
    Ok(target)
}

/// Return to the console surface without reloading the shell document.
pub fn return_to_console(app: &AppHandle) {
    let state = app.state::<WebuiEmbedState>();
    if state.end_embed() {
        let _ = app.emit("webui://close", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webui_url_points_to_loopback_root() {
        let url = webui_url(8899, "system", "teal", "").expect("parse");
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8899));
        assert_eq!(url.path(), "/");
        assert!(url.query_pairs().any(|(key, value)| key == "shell" && value == "frame"));
        assert_eq!(
            url.query(),
            Some("desktop=1&shell=frame&theme=system&theme_color=teal&transition=1&api_key=")
        );
    }

    #[test]
    fn webui_url_always_carries_api_key_pair() {
        let url = webui_url(8899, "system", "teal", "sk-test").expect("parse");
        assert!(url.query_pairs().any(|(key, value)| key == "api_key" && value == "sk-test"));
        let url = webui_url(8899, "system", "teal", "").expect("parse");
        assert!(url.query_pairs().any(|(key, value)| key == "api_key" && value == ""));
    }

    #[test]
    fn frame_state_retains_latest_url_until_console_mounts() {
        let state = WebuiEmbedState::default();
        state.queue_frame_url("http://127.0.0.1:8899/?desktop=1&shell=frame".to_string());

        assert_eq!(
            state.take_frame_url(),
            Some("http://127.0.0.1:8899/?desktop=1&shell=frame".to_string())
        );
        assert_eq!(state.take_frame_url(), None);
    }

    #[test]
    fn webui_url_never_carries_a_console_return_url() {
        let url = webui_url(9000, "dark", "blue", "").expect("parse");
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(query.contains(&("desktop".to_string(), "1".to_string())));
        assert!(query.contains(&("shell".to_string(), "frame".to_string())));
        assert!(query.contains(&("theme".to_string(), "dark".to_string())));
        assert!(query.contains(&("theme_color".to_string(), "blue".to_string())));
        assert!(query.contains(&("transition".to_string(), "1".to_string())));
        assert!(!query.iter().any(|(key, _)| key == "console"));
    }

    #[test]
    fn end_embed_clears_visibility() {
        let state = WebuiEmbedState::default();
        state.begin_embed();
        state.queue_frame_url("http://127.0.0.1:8899/".to_string());
        assert!(state.end_embed());
        assert!(!state.is_embedded());
        assert_eq!(state.take_frame_url(), None);
    }

    #[test]
    fn end_embed_is_noop_when_not_embedded() {
        let state = WebuiEmbedState::default();
        assert!(!state.end_embed());
        assert!(!state.is_embedded());
    }

}
