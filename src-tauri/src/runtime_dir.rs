// src-tauri/src/runtime_dir.rs
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct Layout {
    pub root: PathBuf,            // ~/.vibe-trading
    pub runtime_agent: PathBuf,   // ~/.vibe-trading/runtime/agent
    pub runtime_libs: PathBuf,    // ~/.vibe-trading/runtime/libs (按需安装的可选依赖)
    pub marker: PathBuf,          // ~/.vibe-trading/runtime/.installed_version
    pub resource_marker: PathBuf, // ~/.vibe-trading/runtime/.installed_resources
    pub user_env: PathBuf,        // ~/.vibe-trading/.env
}

impl Layout {
    pub fn new(home_vibe: &Path) -> Self {
        Self {
            root: home_vibe.to_path_buf(),
            runtime_agent: home_vibe.join("runtime").join("agent"),
            runtime_libs: home_vibe.join("runtime").join("libs"),
            marker: home_vibe.join("runtime").join(".installed_version"),
            resource_marker: home_vibe.join("runtime").join(".installed_resources"),
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

fn remove_runtime_agent_template(dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dst).map_err(|e| format!("read_dir {dst:?}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let keep = matches!(
            name.to_str(),
            Some("runs" | "sessions" | "uploads" | ".swarm")
        );
        if keep {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("remove_dir_all {path:?}: {e}"))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("remove_file {path:?}: {e}"))?;
        }
    }
    Ok(())
}

fn refresh_agent_template(src: &Path, dst: &Path) -> Result<(), String> {
    remove_runtime_agent_template(dst)?;
    copy_dir_recursive(src, dst)
}

fn refresh_frontend_dist(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        fs::remove_dir_all(dst).map_err(|e| format!("remove_dir_all {dst:?}: {e}"))?;
    }
    copy_dir_recursive(src, dst)
}

fn fnv1a_update(hash: &mut u64, bytes: &[u8]) {
    const FNV_PRIME: u64 = 1_099_511_628_211;
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

fn hash_path(path: &Path, root: &Path, hash: &mut u64) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|e| format!("strip_prefix {path:?}: {e}"))?;
    fnv1a_update(hash, relative.to_string_lossy().as_bytes());

    if path.is_dir() {
        fnv1a_update(hash, b"\0dir\0");
        let mut entries = fs::read_dir(path)
            .map_err(|e| format!("read_dir {path:?}: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            hash_path(&entry.path(), root, hash)?;
        }
    } else {
        fnv1a_update(hash, b"\0file\0");
        let mut file = fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
        let mut buffer = [0_u8; 8192];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("read {path:?}: {e}"))?;
            if read == 0 {
                break;
            }
            fnv1a_update(hash, &buffer[..read]);
        }
    }
    Ok(())
}

fn fingerprint_dir(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok("missing".to_string());
    }
    const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
    let mut hash = FNV_OFFSET;
    hash_path(path, path, &mut hash)?;
    Ok(format!("{hash:016x}"))
}

fn resource_signature(
    bundle_ver: &str,
    bundle_agent: &Path,
    bundle_frontend_dist: Option<&Path>,
) -> Result<String, String> {
    let frontend = match bundle_frontend_dist {
        Some(path) => fingerprint_dir(path)?,
        None => "none".to_string(),
    };
    Ok(format!(
        "version={}\nagent={}\nfrontend={}\n",
        bundle_ver.trim(),
        fingerprint_dir(bundle_agent)?,
        frontend
    ))
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
    let bundle_resources = resource_signature(&bundle_ver, bundle_agent, bundle_frontend_dist)?;
    let installed_resources = fs::read_to_string(&layout.resource_marker).ok();
    let resources_changed = installed_resources.as_deref() != Some(bundle_resources.as_str());

    fs::create_dir_all(&layout.root).map_err(|e| format!("create root {:?}: {e}", layout.root))?;
    // 可写可选依赖目录：始终确保存在；升级时不被清空（与 runtime_agent 的
    // copy_dir_recursive 无关——libs 永远是用户拥有的数据，不来自 bundle 模板）。
    fs::create_dir_all(&layout.runtime_libs)
        .map_err(|e| format!("create runtime_libs {:?}: {e}", layout.runtime_libs))?;

    if matches!(action, crate::version::Action::Reuse) && !resources_changed {
        // 版本和资源都一致，保持现状。
    } else {
        refresh_agent_template(bundle_agent, &layout.runtime_agent)?;
        // 复制 frontend/dist 到可写运行目录（api_server.py 硬编码从 agent 的
        // parent.parent/frontend/dist 加载 SPA 静态资源）
        if let Some(frontend_dist) = bundle_frontend_dist {
            if frontend_dist.exists() {
                let dest = layout
                    .runtime_agent
                    .parent()
                    .unwrap()
                    .join("frontend")
                    .join("dist");
                refresh_frontend_dist(frontend_dist, &dest)?;
            }
        }
        if let Some(parent) = layout.marker.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&layout.marker, bundle_ver.trim()).map_err(|e| format!("write marker: {e}"))?;
        fs::write(&layout.resource_marker, bundle_resources)
            .map_err(|e| format!("write resource marker: {e}"))?;
    }

    // .env 仅在用户配置缺失时种入
    if !layout.user_env.exists() && bundle_env_seed.exists() {
        fs::copy(bundle_env_seed, &layout.user_env).map_err(|e| format!("seed .env: {e}"))?;
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
    fn same_version_refreshes_changed_agent_template() {
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
        fs::write(bundle.join("agent/api_server.py"), "# changed").unwrap();

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
            "# changed"
        );
    }

    #[test]
    fn refreshing_agent_template_preserves_user_data_and_removes_stale_files() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        fs::write(bundle.join("agent/removed.py"), "# old").unwrap();
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
        fs::write(layout.runtime_agent.join("runs/r1/output.json"), "{}").unwrap();
        fs::remove_file(bundle.join("agent/removed.py")).unwrap();
        fs::write(bundle.join("agent/api_server.py"), "# fresh").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            None,
            &layout,
        )
        .unwrap();

        assert!(
            layout.runtime_agent.join("runs/r1/output.json").exists(),
            "runtime user data should survive template refresh"
        );
        assert!(
            !layout.runtime_agent.join("removed.py").exists(),
            "files removed from the bundle template should not survive"
        );
    }

    #[test]
    fn same_version_refreshes_changed_frontend_dist() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let home = tmp.path().join("home");
        make_bundle(&bundle, "1.0.0");
        let frontend_dist = bundle.join("frontend/dist");
        fs::create_dir_all(&frontend_dist).unwrap();
        fs::write(frontend_dist.join("index.html"), "old").unwrap();
        let layout = Layout::new(&home);

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            Some(&frontend_dist),
            &layout,
        )
        .unwrap();
        fs::write(frontend_dist.join("index.html"), "new").unwrap();

        prepare(
            &bundle.join("agent"),
            &bundle.join("agent/.env"),
            &bundle.join("VERSION"),
            Some(&frontend_dist),
            &layout,
        )
        .unwrap();

        let runtime_index = layout
            .runtime_agent
            .parent()
            .unwrap()
            .join("frontend/dist/index.html");
        assert_eq!(fs::read_to_string(runtime_index).unwrap(), "new");
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
