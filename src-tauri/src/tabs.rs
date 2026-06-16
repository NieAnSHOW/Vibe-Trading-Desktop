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
