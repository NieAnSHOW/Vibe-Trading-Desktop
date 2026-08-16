// src-tauri/src/settings.rs —— 桌面端用户偏好(`~/.vibe-trading/settings.json`)。
// 与 .env 的界限:.env 是后端运行时配置;这里只存桌面壳自己的开关。
// 写文件走「写 .tmp 再 rename」的原子替换,避免中途崩溃留下半截 JSON。

use std::fs;
use std::path::Path;

/// 桌面端用户设置。新增字段时必须给默认值,保证旧文件缺字段也能加载。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    /// 启动应用时是否自动拉起后端服务。
    #[serde(default)]
    pub autostart_service: bool,
    /// 应用主题模式: system / light / dark。
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    /// 应用主题色: teal / blue / purple / pink / orange / green。
    #[serde(default = "default_theme_color")]
    pub theme_color: String,
}

fn default_theme_mode() -> String {
    "system".to_string()
}

fn default_theme_color() -> String {
    "teal".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            autostart_service: false,
            theme_mode: default_theme_mode(),
            theme_color: default_theme_color(),
        }
    }
}

pub fn settings_path(home_vibe: &Path) -> std::path::PathBuf {
    home_vibe.join("settings.json")
}

pub fn load(home_vibe: &Path) -> Settings {
    fs::read_to_string(settings_path(home_vibe))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save(home_vibe: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(home_vibe);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&tmp, content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_returns_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = load(tmp.path());
        assert!(!settings.autostart_service);
        assert_eq!(settings.theme_mode, "system");
        assert_eq!(settings.theme_color, "teal");
    }

    #[test]
    fn load_ignores_unknown_and_missing_fields() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            settings_path(tmp.path()),
            r#"{"autostart_service": true, "future_field": 42}"#,
        )
        .unwrap();
        let settings = load(tmp.path());
        assert!(settings.autostart_service);
    }

    #[test]
    fn save_roundtrips_through_disk() {
        let tmp = tempfile::tempdir().unwrap();
        save(
            tmp.path(),
            &Settings {
                autostart_service: true,
                theme_mode: "dark".to_string(),
                theme_color: "blue".to_string(),
            },
        )
        .unwrap();
        assert!(load(tmp.path()).autostart_service);
        assert_eq!(load(tmp.path()).theme_mode, "dark");
        assert_eq!(load(tmp.path()).theme_color, "blue");
        // 再次保存会覆盖,且目录已存在。
        save(tmp.path(), &Settings::default()).unwrap();
        assert!(!load(tmp.path()).autostart_service);
    }
}
