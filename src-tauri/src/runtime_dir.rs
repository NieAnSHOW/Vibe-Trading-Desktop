// src-tauri/src/runtime_dir.rs
use std::fs;
use std::path::{Path, PathBuf};

pub struct Layout {
    pub root: PathBuf,           // ~/.vibe-trading
    pub runtime_agent: PathBuf,  // ~/.vibe-trading/runtime/agent
    pub marker: PathBuf,         // ~/.vibe-trading/runtime/.installed_version
    pub user_env: PathBuf,       // ~/.vibe-trading/.env
}

impl Layout {
    pub fn new(home_vibe: &Path) -> Self {
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
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

    fs::create_dir_all(&layout.root)
        .map_err(|e| format!("create root {:?}: {e}", layout.root))?;

    match action {
        crate::version::Action::Reuse => {}
        crate::version::Action::FirstRun | crate::version::Action::Upgrade => {
            copy_dir_recursive(bundle_agent, &layout.runtime_agent)?;
            // 复制 frontend/dist 到可写运行目录（api_server.py 硬编码从 agent 的
            // parent.parent/frontend/dist 加载 SPA 静态资源）
            if let Some(frontend_dist) = bundle_frontend_dist {
                if frontend_dist.exists() {
                    let dest = layout.runtime_agent.parent().unwrap().join("frontend").join("dist");
                    copy_dir_recursive(frontend_dist, &dest)?;
                }
            }
            if let Some(parent) = layout.marker.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&layout.marker, bundle_ver.trim())
                .map_err(|e| format!("write marker: {e}"))?;
        }
    }

    // .env 仅在用户配置缺失时种入
    if !layout.user_env.exists() && bundle_env_seed.exists() {
        fs::copy(bundle_env_seed, &layout.user_env)
            .map_err(|e| format!("seed .env: {e}"))?;
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
        assert_eq!(
            fs::read_to_string(layout.marker).unwrap().trim(),
            "1.0.0"
        );
    }

    #[test]
    fn does_not_overwrite_existing_user_env() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let layout = Layout::new(&home);
        fs::create_dir_all(&home).unwrap();
        fs::write(&layout.user_env, "USER_KEY=keep").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(layout.user_env).unwrap(),
            "USER_KEY=keep"
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
        assert_eq!(
            fs::read_to_string(layout.marker).unwrap().trim(),
            "2.0.0"
        );
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
}
