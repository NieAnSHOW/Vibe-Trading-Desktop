use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview,
    WebviewUrl, Window,
};

const SHELL_PROTOCOL: &str = "vibe-shell";
const SHELL_PROTOCOL_ORIGIN: &str = "vibe-shell://localhost";
const TITLE_BAR_OFFSET: f64 = if cfg!(target_os = "macos") { 42.0 } else { 0.0 };
const SHELL_HEIGHT: f64 = 42.0;
const SHELL_LABEL: &str = "shell";
const CONTENT_LABEL: &str = "content-home";
const LOADING_LABEL: &str = "loading";
const HOME_TAB_ID: &str = "home";
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BrowserTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
    pub closable: bool,
    pub webview_label: String,
}

#[derive(Debug)]
pub struct DesktopShellState {
    tabs: Mutex<Vec<BrowserTab>>,
    active_tab_id: Mutex<String>,
}

impl Default for DesktopShellState {
    fn default() -> Self {
        Self {
            tabs: Mutex::new(vec![home_tab()]),
            active_tab_id: Mutex::new(HOME_TAB_ID.to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct OpenTabRequest {
    pub title: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
struct TabsPayload {
    tabs: Vec<BrowserTab>,
    active_tab_id: String,
}

pub fn home_tab() -> BrowserTab {
    BrowserTab {
        id: HOME_TAB_ID.to_string(),
        title: "首页".to_string(),
        url: "/".to_string(),
        active: true,
        closable: false,
        webview_label: CONTENT_LABEL.to_string(),
    }
}

fn app_asset_url(path: &str) -> Result<WebviewUrl, String> {
    let path = path.trim_start_matches('/');
    tauri::Url::parse(&format!("{SHELL_PROTOCOL_ORIGIN}/{path}"))
        .map(WebviewUrl::CustomProtocol)
        .map_err(|e| format!("parse shell asset url {path}: {e}"))
}

pub fn register_shell_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("placeholder-dist");
    builder.register_uri_scheme_protocol(SHELL_PROTOCOL, move |_ctx, request| {
        shell_protocol_response(&dist, request.uri().path())
    })
}

fn shell_protocol_response(
    dist: &Path,
    request_path: &str,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    match resolve_shell_asset(dist, request_path).and_then(|asset| {
        fs::read(&asset).map(|bytes| {
            let content_type = shell_content_type(&asset);
            (bytes, content_type)
        })
    }) {
        Ok((bytes, content_type)) => tauri::http::Response::builder()
            .header("content-type", content_type)
            .body(Cow::Owned(bytes))
            .expect("valid shell protocol response"),
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .header("content-type", "text/plain; charset=utf-8")
            .body(Cow::Borrowed(&b"not found"[..]))
            .expect("valid shell protocol 404 response"),
    }
}

fn resolve_shell_asset(dist: &Path, request_path: &str) -> Result<PathBuf, std::io::Error> {
    let asset = request_path.trim_start_matches('/');
    let asset = if asset.is_empty() { "index.html" } else { asset };
    if !matches!(asset, "index.html" | "shell.html" | "shell.css" | "shell.js") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "shell asset is not allowed",
        ));
    }

    Ok(dist.join(asset))
}

fn shell_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn build_shell_window(handle: &AppHandle) -> Result<Window, String> {
    let window = Window::builder(handle, "main")
        .title("Vibe Trading")
        .inner_size(1280.0, 832.0)
        .build()
        .map_err(|e| format!("build shell window: {e}"))?;

    window
        .add_child(
            WebviewBuilder::new(LOADING_LABEL, app_asset_url("index.html")?),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1280.0, 832.0),
        )
        .map_err(|e| format!("add loading webview: {e}"))?;

    Ok(window)
}

pub fn mount_shell_webviews(window: &Window, content_target: &str) -> Result<Webview, String> {
    let content_url = tauri::Url::parse(content_target)
        .map(WebviewUrl::External)
        .map_err(|e| format!("parse content url: {e}"))?;

    let content = WebviewBuilder::new(CONTENT_LABEL, content_url);
    let shell = WebviewBuilder::new(SHELL_LABEL, app_asset_url("shell.html")?);
    if let Some(loading) = window.get_webview(LOADING_LABEL) {
        let _ = loading.close();
    }

    let content_webview = window
        .add_child(
            content,
            LogicalPosition::new(0.0, TITLE_BAR_OFFSET + SHELL_HEIGHT),
            LogicalSize::new(1280.0, 832.0 - TITLE_BAR_OFFSET - SHELL_HEIGHT),
        )
        .map_err(|e| format!("add content webview: {e}"))?;

    window
        .add_child(
            shell,
            LogicalPosition::new(0.0, TITLE_BAR_OFFSET),
            LogicalSize::new(1280.0, SHELL_HEIGHT),
        )
        .map_err(|e| format!("add shell webview: {e}"))?;

    emit_tabs(window.app_handle())?;
    Ok(content_webview)
}

pub fn resize_shell_webviews(window: &Window) -> Result<(), String> {
    let size = window
        .inner_size()
        .map_err(|e| format!("read window size: {e}"))?
        .to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    let width = size.width.max(1.0);
    let height = size.height.max(TITLE_BAR_OFFSET + SHELL_HEIGHT + 1.0);

    if let Some(content) = window.get_webview(CONTENT_LABEL) {
        content
            .set_bounds(tauri::Rect {
                position: tauri::Position::Logical(LogicalPosition::new(
                    0.0,
                    TITLE_BAR_OFFSET + SHELL_HEIGHT,
                )),
                size: tauri::Size::Logical(LogicalSize::new(
                    width,
                    height - TITLE_BAR_OFFSET - SHELL_HEIGHT,
                )),
            })
            .map_err(|e| format!("resize content webview: {e}"))?;
    }

    if let Some(shell) = window.get_webview(SHELL_LABEL) {
        shell
            .set_bounds(tauri::Rect {
                position: tauri::Position::Logical(LogicalPosition::new(0.0, TITLE_BAR_OFFSET)),
                size: tauri::Size::Logical(LogicalSize::new(width, SHELL_HEIGHT)),
            })
            .map_err(|e| format!("resize shell webview: {e}"))?;
    }

    if let Some(loading) = window.get_webview(LOADING_LABEL) {
        loading
            .set_bounds(tauri::Rect {
                position: tauri::Position::Logical(LogicalPosition::new(0.0, 0.0)),
                size: tauri::Size::Logical(LogicalSize::new(width, height)),
            })
            .map_err(|e| format!("resize loading webview: {e}"))?;
    }

    Ok(())
}

pub fn show_boot_error(window: &Window, message_json: &str) {
    if let Some(loading) = window.get_webview(LOADING_LABEL) {
        let _ = loading.eval(format!(
            "document.getElementById('spin').style.display='none';\
             document.getElementById('msg').textContent='启动失败';\
             var e=document.getElementById('err');e.style.display='block';\
             e.textContent={message_json};\
             var q=document.getElementById('quit');q.style.display='block';\
             q.onclick=function(){{window.__TAURI__.process.exit(1)}};"
        ));
    }
}

#[tauri::command]
pub async fn get_tabs(
    state: tauri::State<'_, DesktopShellState>,
) -> Result<Vec<BrowserTab>, String> {
    Ok(state.tabs.lock().map_err(|_| "tabs lock poisoned")?.clone())
}

#[tauri::command]
pub async fn open_desktop_tab(
    app: AppHandle,
    state: tauri::State<'_, DesktopShellState>,
    request: OpenTabRequest,
) -> Result<BrowserTab, String> {
    let tab = state.open_tab(request)?;
    navigate_content_to_active_tab(&app)?;
    emit_tabs(&app)?;
    Ok(tab)
}

#[tauri::command]
pub async fn activate_tab(
    app: AppHandle,
    state: tauri::State<'_, DesktopShellState>,
    id: String,
) -> Result<(), String> {
    state.activate_tab(&id)?;
    navigate_content_to_active_tab(&app)?;
    emit_tabs(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn close_tab(
    app: AppHandle,
    state: tauri::State<'_, DesktopShellState>,
    id: String,
) -> Result<(), String> {
    state.close_tab(&id)?;
    navigate_content_to_active_tab(&app)?;
    emit_tabs(&app)?;
    Ok(())
}

impl DesktopShellState {
    fn open_tab(&self, request: OpenTabRequest) -> Result<BrowserTab, String> {
        let mut tabs = self.tabs.lock().map_err(|_| "tabs lock poisoned")?;
        let id = format!("tab-{}", tabs.len());
        let tab = BrowserTab {
            id: id.clone(),
            title: request.title,
            url: request.url,
            active: true,
            closable: true,
            webview_label: format!("content-{id}"),
        };

        for item in tabs.iter_mut() {
            item.active = false;
        }
        tabs.push(tab.clone());
        *self
            .active_tab_id
            .lock()
            .map_err(|_| "active tab lock poisoned")? = id;
        Ok(tab)
    }

    fn activate_tab(&self, id: &str) -> Result<(), String> {
        let mut tabs = self.tabs.lock().map_err(|_| "tabs lock poisoned")?;
        if !tabs.iter().any(|tab| tab.id == id) {
            return Err(format!("unknown tab id: {id}"));
        }
        for tab in tabs.iter_mut() {
            tab.active = tab.id == id;
        }
        *self
            .active_tab_id
            .lock()
            .map_err(|_| "active tab lock poisoned")? = id.to_string();
        Ok(())
    }

    fn close_tab(&self, id: &str) -> Result<(), String> {
        if id == HOME_TAB_ID {
            return Ok(());
        }

        let mut tabs = self.tabs.lock().map_err(|_| "tabs lock poisoned")?;
        let index = tabs
            .iter()
            .position(|tab| tab.id == id)
            .ok_or_else(|| format!("unknown tab id: {id}"))?;
        let was_active = tabs[index].active;
        tabs.remove(index);

        if was_active {
            let next_index = index.saturating_sub(1).min(tabs.len().saturating_sub(1));
            let next_id = tabs
                .get(next_index)
                .map(|tab| tab.id.clone())
                .unwrap_or_else(|| HOME_TAB_ID.to_string());
            for tab in tabs.iter_mut() {
                tab.active = tab.id == next_id;
            }
            *self
                .active_tab_id
                .lock()
                .map_err(|_| "active tab lock poisoned")? = next_id;
        }

        Ok(())
    }
}

fn emit_tabs(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopShellState>();
    let tabs = state.tabs.lock().map_err(|_| "tabs lock poisoned")?.clone();
    let active_tab_id = state
        .active_tab_id
        .lock()
        .map_err(|_| "active tab lock poisoned")?
        .clone();
    app.emit(
        "desktop-tabs://changed",
        TabsPayload {
            tabs,
            active_tab_id,
        },
    )
    .map_err(|e| format!("emit tabs: {e}"))
}

fn navigate_content_to_active_tab(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let content = window
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "content webview not found".to_string())?;
    let state = app.state::<DesktopShellState>();
    let active_tab_id = state
        .active_tab_id
        .lock()
        .map_err(|_| "active tab lock poisoned")?
        .clone();
    let target = state
        .tabs
        .lock()
        .map_err(|_| "tabs lock poisoned")?
        .iter()
        .find(|tab| tab.id == active_tab_id)
        .map(|tab| tab.url.clone())
        .ok_or_else(|| format!("unknown active tab id: {active_tab_id}"))?;
    let current = content
        .url()
        .map_err(|e| format!("read content webview url: {e}"))?;
    let target = resolve_tab_navigation_url(&current, &target)
        .map_err(|e| format!("parse tab url {target}: {e}"))?;

    content
        .navigate(target)
        .map_err(|e| format!("navigate content webview: {e}"))
}

fn resolve_tab_navigation_url(current: &tauri::Url, target: &str) -> Result<tauri::Url, String> {
    current.join(target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_has_active_home_tab() {
        let state = DesktopShellState::default();
        let tabs = state.tabs.lock().unwrap();

        assert_eq!(*tabs, vec![home_tab()]);
        assert_eq!(*state.active_tab_id.lock().unwrap(), HOME_TAB_ID);
    }

    #[test]
    fn app_asset_url_uses_shell_protocol_instead_of_dev_url() {
        match app_asset_url("/shell.html").unwrap() {
            WebviewUrl::CustomProtocol(url) => {
                assert_eq!(url.as_str(), "vibe-shell://localhost/shell.html")
            }
            WebviewUrl::External(url) => panic!("expected shell protocol url, got {url}"),
            _ => panic!("unexpected webview url variant"),
        }
    }

    #[test]
    fn shell_and_loading_assets_live_under_shell_protocol() {
        let shell = app_asset_url("shell.html").unwrap();
        let loading = app_asset_url("index.html").unwrap();

        match shell {
            WebviewUrl::CustomProtocol(url) => {
                assert_eq!(url.as_str(), "vibe-shell://localhost/shell.html")
            }
            _ => panic!("shell asset must use shell protocol"),
        }
        match loading {
            WebviewUrl::CustomProtocol(url) => {
                assert_eq!(url.as_str(), "vibe-shell://localhost/index.html")
            }
            _ => panic!("loading asset must use shell protocol"),
        }
    }

    #[test]
    fn placeholder_dist_contains_shell_and_loading_assets() {
        let dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("placeholder-dist");

        for asset in ["index.html", "shell.html", "shell.css", "shell.js"] {
            assert!(
                dist.join(asset).is_file(),
                "placeholder-dist must include {asset} for Tauri app asset loading"
            );
        }
    }

    #[test]
    fn resolve_tab_navigation_url_handles_relative_and_absolute_paths() {
        let base = tauri::Url::parse("http://127.0.0.1:5899/").unwrap();

        assert_eq!(
            resolve_tab_navigation_url(&base, "/agent")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:5899/agent"
        );
        assert_eq!(
            resolve_tab_navigation_url(&base, "about:blank")
                .unwrap()
                .as_str(),
            "about:blank"
        );
    }

    #[test]
    fn shell_protocol_resolves_only_placeholder_assets() {
        let dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("placeholder-dist");

        assert_eq!(
            resolve_shell_asset(&dist, "/shell.html").unwrap(),
            dist.join("shell.html")
        );
        assert_eq!(
            resolve_shell_asset(&dist, "/").unwrap(),
            dist.join("index.html")
        );
        assert!(resolve_shell_asset(&dist, "/../tauri.conf.json").is_err());
        assert!(resolve_shell_asset(&dist, "/agent").is_err());
    }

    #[test]
    fn shell_content_type_matches_static_assets() {
        assert_eq!(
            shell_content_type(std::path::Path::new("shell.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            shell_content_type(std::path::Path::new("shell.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            shell_content_type(std::path::Path::new("shell.js")),
            "text/javascript; charset=utf-8"
        );
    }

    #[test]
    fn open_tab_appends_and_activates() {
        let state = DesktopShellState::default();
        let tab = state
            .open_tab(OpenTabRequest {
                title: "Agent".to_string(),
                url: "/agent".to_string(),
            })
            .unwrap();

        let tabs = state.tabs.lock().unwrap();
        assert_eq!(tab.id, "tab-1");
        assert_eq!(*state.active_tab_id.lock().unwrap(), "tab-1");
        assert!(!tabs[0].active);
        assert!(tabs[1].active);
    }

    #[test]
    fn home_tab_cannot_be_closed() {
        let state = DesktopShellState::default();

        state.close_tab(HOME_TAB_ID).unwrap();

        let tabs = state.tabs.lock().unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, HOME_TAB_ID);
    }

    #[test]
    fn closing_active_tab_activates_left_neighbor() {
        let state = DesktopShellState::default();
        let first = state
            .open_tab(OpenTabRequest {
                title: "Agent".to_string(),
                url: "/agent".to_string(),
            })
            .unwrap();
        let second = state
            .open_tab(OpenTabRequest {
                title: "Runtime".to_string(),
                url: "/runtime".to_string(),
            })
            .unwrap();

        state.close_tab(&second.id).unwrap();

        let tabs = state.tabs.lock().unwrap();
        assert_eq!(*state.active_tab_id.lock().unwrap(), first.id);
        assert!(tabs.iter().any(|tab| tab.id == first.id && tab.active));
    }
}
