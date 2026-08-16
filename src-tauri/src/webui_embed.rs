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
/// `console_url` 是导航前的控制台地址,随查询参数带给 WebUI——前端侧的
/// 「控制台」导航入口据此 location.replace 回壳内页面,无需 Tauri IPC
/// (远程页面调应用命令需要 app ACL manifest,成本高且难以离线验证)。
pub fn webui_url(
    port: u16,
    console_url: Option<&tauri::Url>,
    theme_mode: &str,
    theme_color: &str,
) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|e| format!("invalid webui url: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("desktop", "1");
        pairs.append_pair("theme", theme_mode);
        pairs.append_pair("theme_color", theme_color);
        pairs.append_pair("transition", "1");
        if let Some(console) = console_url {
            pairs.append_pair("console", console.as_str());
        }
    }
    Ok(url)
}

/// 主窗口导航进 WebUI。仅在未嵌入时保存当前 URL(并把该地址透传给
/// WebUI 作为返回入口);失败时由调用方决定是否回退系统浏览器。
pub fn embed(app: &AppHandle, port: u16) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let state = app.state::<WebuiEmbedState>();
    let console_url = if !state.is_embedded() {
        let current = win
            .url()
            .map_err(|e| format!("read webview url: {e}"))?;
        // 规范化为 origin+path:控制台是 hash 路由,从 #/settings 等页面
        // 嵌入时须剥掉旧 hash,WebUI 侧才能按目标页(账户/环境/设置)
        // 重新拼接返回地址。
        let base = normalize_base(&current);
        state.begin_embed(base.clone());
        Some(base)
    } else {
        None
    };
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
    let target = webui_url(port, console_url.as_ref(), theme_mode, theme_color)?;
    win.navigate(target)
        .map_err(|e| format!("navigate to webui: {e}"))
}

/// 去掉 URL 的 query 与 fragment,仅保留 scheme://host[:port]/path。
pub fn normalize_base(url: &tauri::Url) -> tauri::Url {
    let mut base = url.clone();
    base.set_query(None);
    base.set_fragment(None);
    base
}

/// Add the current shell preferences to a native return navigation so the
/// console pre-paint rail starts with the same theme as the WebUI.
pub fn console_url_with_theme(
    mut url: tauri::Url,
    theme_mode: &str,
    theme_color: &str,
) -> tauri::Url {
    let mode = match theme_mode {
        "light" | "dark" | "system" => theme_mode,
        _ => "system",
    };
    let color = match theme_color {
        "teal" | "blue" | "purple" | "pink" | "orange" | "green" => theme_color,
        _ => "teal",
    };
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("theme", mode);
        pairs.append_pair("theme_color", color);
        pairs.append_pair("transition", "1");
    }
    url
}

/// 从 WebUI 返回控制台;未嵌入时是幂等 no-op。
pub fn return_to_console(app: &AppHandle) {
    let state = app.state::<WebuiEmbedState>();
    if let Some(console_url) = state.end_embed() {
        if let Some(win) = app.get_webview_window("main") {
            let (theme_mode, theme_color) = crate::runtime_dir::Layout::from_home()
                .map(|layout| {
                    let settings = crate::settings::load(&layout.root);
                    (settings.theme_mode, settings.theme_color)
                })
                .unwrap_or_else(|_| ("system".to_string(), "teal".to_string()));
            let target = console_url_with_theme(console_url, &theme_mode, &theme_color);
            if let Err(e) = win.navigate(target) {
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
        let url = webui_url(8899, None, "system", "teal").expect("parse");
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8899));
        assert_eq!(url.path(), "/");
        // desktop 标记始终携带:WebUI 侧据此显示「控制台」入口。
        assert_eq!(url.query(), Some("desktop=1&theme=system&theme_color=teal&transition=1"));
    }

    #[test]
    fn normalize_base_strips_query_and_fragment() {
        let url = tauri::Url::parse("tauri://localhost/index.html#/settings?x=1").unwrap();
        let base = normalize_base(&url);
        assert_eq!(base.as_str(), "tauri://localhost/index.html");
    }

    #[test]
    fn console_url_carries_theme_for_native_return() {
        let console = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        let themed = console_url_with_theme(console, "dark", "blue");
        let query: Vec<(String, String)> = themed.query_pairs().into_owned().collect();
        assert!(query.contains(&("theme".to_string(), "dark".to_string())));
        assert!(query.contains(&("theme_color".to_string(), "blue".to_string())));
        assert!(query.contains(&("transition".to_string(), "1".to_string())));
    }

    #[test]
    fn webui_url_carries_encoded_console_url() {
        let console = tauri::Url::parse("tauri://localhost/index.html?x=1&y=2").unwrap();
        let url = webui_url(9000, Some(&console), "dark", "blue").expect("parse");
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(query.contains(&("desktop".to_string(), "1".to_string())));
        assert!(query.contains(&("theme".to_string(), "dark".to_string())));
        assert!(query.contains(&("theme_color".to_string(), "blue".to_string())));
        assert!(query.contains(&("transition".to_string(), "1".to_string())));
        // 控制台地址(含自身的查询串)必须完整往返,前端才能导航回壳内页面。
        assert!(query.contains(&("console".to_string(), console.to_string())));
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
