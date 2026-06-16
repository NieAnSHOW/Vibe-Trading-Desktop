// ── 壳高度常量 ──────────────────────────────────────────────────────────
pub const H_SHELL: f64 = 40.0;

// ── 标签元数据 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct Tab {
    pub label: String,
    pub site_id: String,
    pub title: String,
    pub closable: bool,
}

// ── 标签注册表（纯逻辑，可单测）──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TabRegistry {
    tabs: Vec<Tab>,
    counter: u64,
}

impl TabRegistry {
    /// 创建空注册表，计数器为 0
    pub fn new() -> Self {
        Self {
            tabs: Vec::new(),
            counter: 0,
        }
    }

    /// 按 site_id 查找已存在标签，返回其 label
    pub fn find_by_site(&self, site_id: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|t| t.site_id == site_id)
            .map(|t| t.label.clone())
    }

    /// 注册标签：label 必须唯一，site_id 不能冲突
    pub fn register(&mut self, tab: Tab) -> Result<(), String> {
        if self.tabs.iter().any(|t| t.label == tab.label) {
            return Err(format!("duplicate label: {}", tab.label));
        }
        if self.tabs.iter().any(|t| t.site_id == tab.site_id) {
            return Err(format!("duplicate site_id: {}", tab.site_id));
        }
        self.tabs.push(tab);
        Ok(())
    }

    /// 移除标签：closable=false 时拒绝
    pub fn remove(&mut self, label: &str) -> Result<Tab, String> {
        let pos = self
            .tabs
            .iter()
            .position(|t| t.label == label)
            .ok_or_else(|| format!("label not found: {}", label))?;
        if !self.tabs[pos].closable {
            return Err("not closable".to_string());
        }
        Ok(self.tabs.remove(pos))
    }

    /// 生成下一个标签名 "tab-0", "tab-1", ...
    pub fn next_label(&mut self) -> String {
        let l = format!("tab-{}", self.counter);
        self.counter += 1;
        l
    }

    /// 按 label 查找
    pub fn get(&self, label: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.label == label)
    }

    /// 按 site_id 查找
    pub fn get_by_site(&self, site_id: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.site_id == site_id)
    }

    /// 返回所有标签的切片
    pub fn all(&self) -> &[Tab] {
        &self.tabs
    }
}

// ── 命令实现 ────────────────────────────────────────────────────────────

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

/// shell webview 的固定 label
const SHELL_LABEL: &str = "shell";

/// 主窗口的 label
const MAIN_WINDOW: &str = "main";

/// 保持当前活跃标签状态（纯状态跟踪，不参与 registry 逻辑）
pub struct ActiveState {
    pub current: Mutex<String>,
}

impl ActiveState {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(String::new()),
        }
    }
}

/// 事件 payload —— 通知 shell 标签变化
#[derive(Debug, Clone, serde::Serialize)]
pub struct TabEvent {
    pub label: String,
    pub site_id: String,
    pub title: String,
    pub closable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<Tab>>,
}

/// 内部函数（非 #[command]）：注册主页标签并导航。
/// 由 boot() 线程调用，不在 generate_handler! 中注册。
pub fn register_app_tab(app: &AppHandle, url: &str) -> Result<(), String> {
    let registry = app.state::<Mutex<TabRegistry>>();
    let mut r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;

    let tab = Tab {
        label: "app".into(),
        site_id: "__app__".into(),
        title: "Vibe Trading".into(),
        closable: false,
    };
    r.register(tab)?;
    drop(r);

    // 导航已存在的 "app" webview
    let target_url =
        tauri::Url::parse(url).map_err(|e| format!("parse app url: {e}"))?;
    if let Some(wv) = app.get_webview("app") {
        wv.navigate(target_url)
            .map_err(|e| format!("navigate app: {e}"))?;
    }

    // 发送 opened 事件通知 shell
    let all = {
        let r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;
        r.all().to_vec()
    };
    if let Some(sh) = app.get_webview(SHELL_LABEL) {
        let _ = sh.emit("tab://opened", TabEvent {
            label: "app".into(),
            site_id: "__app__".into(),
            title: "Vibe Trading".into(),
            closable: false,
            all: Some(all),
        });
    }

    // 设置活跃标签
    if let Some(state) = app.try_state::<ActiveState>() {
        let mut cur = state.current.lock().map_err(|e| format!("lock active: {e}"))?;
        *cur = "app".to_string();
    }

    Ok(())
}

/// 打开/激活格速拨页（幂等）
#[tauri::command]
pub async fn open_grid_tab(app: AppHandle) -> Result<(), String> {
    let registry = app.state::<Mutex<TabRegistry>>();
    let mut r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;

    // 幂等：已存在则直接激活
    if let Some(label) = r.find_by_site("__grid__") {
        drop(r);
        return activate_tab_inner(&app, &label).await;
    }

    let label = r.next_label();
    let site_id = "__grid__".to_string();
    let title = "Grid".to_string();

    r.register(Tab {
        label: label.clone(),
        site_id: site_id.clone(),
        title: title.clone(),
        closable: true,
    })?;
    drop(r);

    // 获取 main 窗口尺寸
    let win = app
        .get_window(MAIN_WINDOW)
        .ok_or("main window not found")?;
    let physical = win.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    let scale = win.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    let logical: LogicalSize<f64> = physical.to_logical(scale);

    // 创建子 webview
    win.add_child(
        WebviewBuilder::new(&label, WebviewUrl::App("grid.html".into())),
        LogicalPosition::new(0.0, H_SHELL),
        LogicalSize::new(logical.width, logical.height - H_SHELL),
    )
    .map_err(|e| format!("add_child grid: {e}"))?;

    // 发送 opened 事件
    let reg = app.state::<Mutex<TabRegistry>>();
    let all = reg.lock().map_err(|e| format!("lock registry: {e}"))?.all().to_vec();
    if let Some(sh) = app.get_webview(SHELL_LABEL) {
        let _ = sh.emit("tab://opened", TabEvent {
            label: label.clone(),
            site_id: site_id.clone(),
            title: title.clone(),
            closable: true,
            all: Some(all),
        });
    }

    // 激活
    activate_tab_inner(&app, &label).await
}

/// 打开/激活资讯标签（幂等，按 site_id）
#[tauri::command]
pub async fn open_news_tab(
    app: AppHandle,
    url: String,
    title: String,
    site_id: String,
) -> Result<(), String> {
    let registry = app.state::<Mutex<TabRegistry>>();
    let mut r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;

    // 幂等：已存在则直接激活
    if let Some(label) = r.find_by_site(&site_id) {
        drop(r);
        return activate_tab_inner(&app, &label).await;
    }

    let label = r.next_label();

    r.register(Tab {
        label: label.clone(),
        site_id: site_id.clone(),
        title: title.clone(),
        closable: true,
    })?;
    drop(r);

    // 获取主窗口尺寸
    let win = app
        .get_window(MAIN_WINDOW)
        .ok_or("main window not found")?;
    let physical = win.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    let scale = win.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    let logical: LogicalSize<f64> = physical.to_logical(scale);

    // 外部 URL
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("parse external url: {e}"))?;
    win.add_child(
        WebviewBuilder::new(&label, WebviewUrl::External(parsed)),
        LogicalPosition::new(0.0, H_SHELL),
        LogicalSize::new(logical.width, logical.height - H_SHELL),
    )
    .map_err(|e| format!("add_child news: {e}"))?;

    // 发送 opened 事件
    let reg = app.state::<Mutex<TabRegistry>>();
    let all = reg.lock().map_err(|e| format!("lock registry: {e}"))?.all().to_vec();
    if let Some(sh) = app.get_webview(SHELL_LABEL) {
        let _ = sh.emit("tab://opened", TabEvent {
            label: label.clone(),
            site_id: site_id.clone(),
            title: title.clone(),
            closable: true,
            all: Some(all),
        });
    }

    // 激活
    activate_tab_inner(&app, &label).await
}

/// 激活指定标签
#[tauri::command]
pub async fn activate_tab(app: AppHandle, label: String) -> Result<(), String> {
    activate_tab_inner(&app, &label).await
}

/// 激活标签的内部实现
async fn activate_tab_inner(app: &AppHandle, label: &str) -> Result<(), String> {
    // 验证 label 存在于 registry
    {
        let registry = app.state::<Mutex<TabRegistry>>();
        let r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;
        r.get(label).ok_or_else(|| format!("tab not found: {label}"))?;
    }

    let tabs = app.webviews();
    let exclude: HashSet<&str> = [SHELL_LABEL, label].iter().copied().collect();

    // 隐藏其他内容 webview
    for (wl, wv) in &tabs {
        if !exclude.contains(wl.as_str()) {
            let _ = wv.hide();
        }
    }

    // 显示并聚焦目标 webview
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.show();
        let _ = wv.set_focus();
    }

    // 更新活跃状态
    if let Some(state) = app.try_state::<ActiveState>() {
        let mut cur = state.current.lock().map_err(|e| format!("lock active: {e}"))?;
        *cur = label.to_string();
    }

    // 获取 tab 元数据发送事件
    let registry = app.state::<Mutex<TabRegistry>>();
    let r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;
    let tab = r.get(label).cloned();

    if let (Some(t), Some(sh)) = (tab, app.get_webview(SHELL_LABEL)) {
        let _ = sh.emit("tab://activated", TabEvent {
            label: t.label.clone(),
            site_id: t.site_id.clone(),
            title: t.title.clone(),
            closable: t.closable,
            all: None,
        });
    }

    Ok(())
}

/// 关闭指定标签
#[tauri::command]
pub async fn close_tab(app: AppHandle, label: String) -> Result<(), String> {
    // 检查 closable 并移除
    let tab = {
        let registry = app.state::<Mutex<TabRegistry>>();
        let mut r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;
        r.remove(&label)?
    };

    // 关闭 webview
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }

    // 发送 closed 事件
    let registry = app.state::<Mutex<TabRegistry>>();
    let r = registry.lock().map_err(|e| format!("lock registry: {e}"))?;
    let all = r.all().to_vec();
    if let Some(sh) = app.get_webview(SHELL_LABEL) {
        let _ = sh.emit("tab://closed", TabEvent {
            label: tab.label.clone(),
            site_id: tab.site_id.clone(),
            title: tab.title.clone(),
            closable: tab.closable,
            all: Some(all),
        });
    }

    Ok(())
}

/// resize 同步：窗口大小变化时更新 shell 和内容 webview 的位置/大小
pub fn sync_resize(app: &AppHandle, physical: tauri::PhysicalSize<u32>) {
    if let Some(win) = app.get_window(MAIN_WINDOW) {
        let scale = match win.scale_factor() {
            Ok(s) => s,
            Err(_) => return,
        };
        let logical: LogicalSize<f64> = physical.to_logical(scale);

        // 更新 shell webview 大小
        if let Some(sh) = app.get_webview(SHELL_LABEL) {
            let _ = sh.set_size(LogicalSize::new(logical.width, H_SHELL));
        }

        // 更新所有内容 webview（非 shell）的位置和大小
        let tabs = app.webviews();
        let content_h = (logical.height - H_SHELL).max(0.0);
        for (wl, wv) in &tabs {
            if wl.as_str() != SHELL_LABEL {
                let _ = wv.set_position(LogicalPosition::new(0.0, H_SHELL));
                let _ = wv.set_size(LogicalSize::new(logical.width, content_h));
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// TDD：先写测试，确认全部失败后，再补实现
// ══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_registry_empty() {
        let mut r = TabRegistry::new();
        assert!(r.all().is_empty());
        // counter 不从 api 暴露，但 next_label 第一调等于 "tab-0" 即验证 counter=0
        assert_eq!(r.next_label(), "tab-0");
    }

    #[test]
    fn test_register_and_find() {
        let mut r = TabRegistry::new();
        let tab = Tab {
            label: "news-0".into(),
            site_id: "bloomberg".into(),
            title: "Bloomberg".into(),
            closable: true,
        };
        r.register(tab).unwrap();
        assert_eq!(
            r.find_by_site("bloomberg").as_deref(),
            Some("news-0")
        );
    }

    #[test]
    fn test_register_duplicate_label_rejected() {
        let mut r = TabRegistry::new();
        r.register(make_tab("a", "site-a", true)).unwrap();
        let err = r.register(make_tab("a", "site-b", true)).unwrap_err();
        assert!(err.contains("label"), "期望提到 label，得到: {err}");
    }

    #[test]
    fn test_register_duplicate_site_id_rejected() {
        let mut r = TabRegistry::new();
        r.register(make_tab("a", "site-x", true)).unwrap();
        let err = r.register(make_tab("b", "site-x", true)).unwrap_err();
        assert!(err.contains("site"), "期望提到 site，得到: {err}");
    }

    #[test]
    fn test_remove_normal_tab() {
        let mut r = TabRegistry::new();
        r.register(make_tab("a", "site-a", true)).unwrap();
        let removed = r.remove("a").unwrap();
        assert_eq!(removed.label, "a");
        assert!(r.get("a").is_none());
    }

    #[test]
    fn test_remove_app_tab_rejected() {
        let mut r = TabRegistry::new();
        r.register(make_tab("app", "__app__", false)).unwrap();
        let err = r.remove("app").unwrap_err();
        assert!(err.contains("not closable"), "期望 not closable，得到: {err}");
    }

    #[test]
    fn test_remove_then_re_register() {
        let mut r = TabRegistry::new();
        r.register(make_tab("a", "site-a", true)).unwrap();
        r.remove("a").unwrap();
        // 重新注册相同的 label 和 site_id 应成功
        r.register(make_tab("a", "site-a", true)).unwrap();
        assert!(r.get("a").is_some());
    }

    #[test]
    fn test_next_label_generates_sequential() {
        let mut r = TabRegistry::new();
        assert_eq!(r.next_label(), "tab-0");
        assert_eq!(r.next_label(), "tab-1");
        assert_eq!(r.next_label(), "tab-2");
    }

    #[test]
    fn test_get_and_get_by_site() {
        let mut r = TabRegistry::new();
        r.register(make_tab("app", "__app__", false)).unwrap();
        r.register(make_tab("tab-0", "cnn", true)).unwrap();

        assert_eq!(r.get("app").unwrap().site_id, "__app__");
        assert_eq!(r.get_by_site("cnn").unwrap().label, "tab-0");
        assert!(r.get("nobody").is_none());
        assert!(r.get_by_site("fox").is_none());
    }

    // helper
    fn make_tab(label: &str, site_id: &str, closable: bool) -> Tab {
        Tab {
            label: label.into(),
            site_id: site_id.into(),
            title: format!("Title-{site_id}"),
            closable,
        }
    }
}
