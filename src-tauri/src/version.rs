// src-tauri/src/version.rs

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    FirstRun,
    Reuse,
    Upgrade,
}

/// installed: .installed_version 文件内容(无文件 -> None); bundle: 当前 bundle VERSION。
pub fn decide(installed: Option<&str>, bundle: &str) -> Action {
    match installed {
        None => Action::FirstRun,
        Some(v) if v.trim() == bundle.trim() => Action::Reuse,
        Some(_) => Action::Upgrade,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_when_marker_absent() {
        assert_eq!(decide(None, "1.0.0"), Action::FirstRun);
    }

    #[test]
    fn reuse_when_versions_equal() {
        assert_eq!(decide(Some("1.0.0"), "1.0.0"), Action::Reuse);
    }

    #[test]
    fn upgrade_when_versions_differ() {
        assert_eq!(decide(Some("1.0.0"), "1.1.0"), Action::Upgrade);
    }

    #[test]
    fn trims_whitespace_in_marker() {
        assert_eq!(decide(Some(" 1.0.0\n"), "1.0.0"), Action::Reuse);
    }
}
