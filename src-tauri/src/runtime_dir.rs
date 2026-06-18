// src-tauri/src/runtime_dir.rs
use std::fs;
use std::path::{Path, PathBuf};

pub struct Layout {
    pub root: PathBuf,          // ~/.vibe-trading
    pub runtime_agent: PathBuf, // ~/.vibe-trading/runtime/agent
    pub runtime_libs: PathBuf,  // ~/.vibe-trading/runtime/libs (按需安装的可选依赖)
    pub marker: PathBuf,        // ~/.vibe-trading/runtime/.installed_version
    pub user_env: PathBuf,      // ~/.vibe-trading/.env
}

impl Layout {
    pub fn new(home_vibe: &Path) -> Self {
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
            runtime_libs: home_vibe.join("runtime").join("libs"),
            marker: home_vibe.join("runtime").join(".installed_version"),
            user_env: home_vibe.join(".env"),
        }
    }

    /// 生产用: 解析 ~/.vibe-trading
    pub fn from_home() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("home dir unavailable")?;
        Ok(Self::new(&home.join(".vibe-trading")))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {from:?}: {e}"))?;
        }
    }
    Ok(())
}

fn replace_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        fs::remove_dir_all(dst).map_err(|e| format!("remove_dir_all {dst:?}: {e}"))?;
    }
    copy_dir_recursive(src, dst)
}

pub fn prepare(
    bundle_agent: &Path,
    bundle_env_seed: &Path,
    bundle_version: &Path,
    bundle_frontend_dist: Option<&Path>,
    layout: &Layout,
) -> Result<(), String> {
    if !bundle_agent.exists() {
        return Err(format!("bundle agent template missing: {bundle_agent:?}"));
    }
    let bundle_ver = fs::read_to_string(bundle_version)
        .map_err(|e| format!("read bundle VERSION {bundle_version:?}: {e}"))?;
    let installed = fs::read_to_string(&layout.marker).ok();
    let action = crate::version::decide(installed.as_deref(), &bundle_ver);

    fs::create_dir_all(&layout.root).map_err(|e| format!("create root {:?}: {e}", layout.root))?;
    // 可写可选依赖目录：始终确保存在；升级时不被清空（与 runtime_agent 的
    // copy_dir_recursive 无关——libs 永远是用户拥有的数据，不来自 bundle 模板）。
    fs::create_dir_all(&layout.runtime_libs)
        .map_err(|e| format!("create runtime_libs {:?}: {e}", layout.runtime_libs))?;

    if let Some(frontend_dist) = bundle_frontend_dist {
        if frontend_dist.exists() {
            let dest = layout
                .runtime_agent
                .parent()
                .unwrap()
                .join("frontend")
                .join("dist");
            replace_dir_recursive(frontend_dist, &dest)?;
        }
    }

    match action {
        crate::version::Action::Reuse => {}
        crate::version::Action::FirstRun | crate::version::Action::Upgrade => {
            copy_dir_recursive(bundle_agent, &layout.runtime_agent)?;
            if bundle_env_seed.exists() {
                fs::copy(bundle_env_seed, &layout.user_env)
                    .map_err(|e| format!("seed .env: {e}"))?;
            }
            if let Some(parent) = layout.marker.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&layout.marker, bundle_ver.trim())
                .map_err(|e| format!("write marker: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn make_bundle(dir: &std::path::Path, version: &str) {
        let agent = dir.join("agent");
        fs::create_dir_all(agent.join("src")).unwrap();
        fs::write(agent.join("api_server.py"), "# v1").unwrap();
        fs::write(agent.join(".env"), "SEED=1").unwrap();
        fs::write(dir.join("VERSION"), version).unwrap();
    }

    #[test]
    fn first_run_copies_agent_seeds_env_writes_marker() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(layout.runtime_agent.join("api_server.py").exists());
        assert_eq!(fs::read_to_string(layout.user_env).unwrap(), "SEED=1");
        assert_eq!(fs::read_to_string(layout.marker).unwrap().trim(), "1.0.0");
    }

    #[test]
    fn upgrade_overwrites_existing_user_env_with_bundle_seed() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        fs::create_dir_all(&home).unwrap();
        fs::write(&layout.user_env, "OLD_KEY=stale").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&layout.user_env).unwrap(), "SEED=1");

        fs::write(bundle.join("agent/.env"), "SEED=2\nNEW_KEY=fresh\n").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&layout.user_env).unwrap(),
            "SEED=2\nNEW_KEY=fresh\n"
        );
    }

    #[test]
    fn upgrade_refreshes_code_but_preserves_data_dirs() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();
        fs::create_dir_all(layout.runtime_agent.join("runs/r1")).unwrap();
        fs::write(layout.runtime_agent.join("runs/r1/x"), "data").unwrap();
        // bundle 升级到 v2
        fs::write(bundle.join("agent/api_server.py"), "# v2").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(layout.runtime_agent.join("api_server.py")).unwrap(),
            "# v2"
        );
        assert!(
            layout.runtime_agent.join("runs/r1/x").exists(),
            "user data preserved"
        );
        assert_eq!(fs::read_to_string(layout.marker).unwrap().trim(), "2.0.0");
    }

    #[test]
    fn prepare_failure_returns_readable_error() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        let layout = Layout::new(&home);
        let missing = tmp.path().join("nope/agent");
        let err = prepare(
            &missing,
            &missing.join(".env"),
            &tmp.path().join("VERSION"),
            None,
            &layout,
        )
        .unwrap_err();
        assert!(
            err.contains("agent") || err.contains("VERSION"),
            "msg: {err}"
        );
    }

    #[test]
    fn layout_exposes_runtime_libs_path() {
        let home = std::path::Path::new("/fake/home/.vibe-trading");
        let layout = Layout::new(home);
        assert_eq!(layout.runtime_libs, home.join("runtime").join("libs"));
    }

    #[test]
    fn prepare_creates_runtime_libs_dir() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(
            layout.runtime_libs.exists(),
            "runtime_libs should be created"
        );
        assert!(layout.runtime_libs.is_dir());
    }

    #[test]
    fn reuse_refreshes_frontend_dist_and_removes_stale_assets() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let frontend_dist = bundle.join("frontend/dist");
        fs::create_dir_all(frontend_dist.join("assets")).unwrap();
        fs::write(
            frontend_dist.join("index.html"),
            r#"<script src="/assets/old.js"></script>"#,
        )
        .unwrap();
        fs::write(frontend_dist.join("assets/old.js"), "old bundle").unwrap();
        let layout = Layout::new(&home);

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            Some(&frontend_dist),
            &layout,
        )
        .unwrap();

        fs::write(
            frontend_dist.join("index.html"),
            r#"<script src="/assets/new.js"></script>"#,
        )
        .unwrap();
        fs::remove_file(frontend_dist.join("assets/old.js")).unwrap();
        fs::write(frontend_dist.join("assets/new.js"), "new bundle").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            Some(&frontend_dist),
            &layout,
        )
        .unwrap();

        let runtime_dist = layout.runtime_agent.parent().unwrap().join("frontend/dist");
        assert_eq!(
            fs::read_to_string(runtime_dist.join("index.html")).unwrap(),
            r#"<script src="/assets/new.js"></script>"#
        );
        assert!(runtime_dist.join("assets/new.js").exists());
        assert!(!runtime_dist.join("assets/old.js").exists());
    }

    #[test]
    fn upgrade_preserves_runtime_libs_contents() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        // 模拟用户安装了一个包到 libs
        fs::create_dir_all(layout.runtime_libs.join("futu_api")).unwrap();
        fs::write(
            layout.runtime_libs.join("futu_api/__init__.py"),
            "# user installed",
        )
        .unwrap();

        // bundle 升级到 v2
        fs::write(bundle.join("agent/api_server.py"), "# v2").unwrap();
        fs::write(bundle.join("VERSION"), "2.0.0").unwrap();
        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(
            layout.runtime_libs.join("futu_api/__init__.py").exists(),
            "runtime_libs contents must survive an upgrade"
        );
        assert_eq!(
            fs::read_to_string(layout.runtime_libs.join("futu_api/__init__.py")).unwrap(),
            "# user installed"
        );
    }
}
