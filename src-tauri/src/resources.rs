// src-tauri/src/resources.rs
use std::path::PathBuf;
use tauri::AppHandle;
// Manager trait 仅为 release 分支的 app.path() 所需；dev 分支不调用，故门控引入。
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// 解析打包资源根。开发态回退到仓库内 .desktop-build / 源码目录。
pub struct Resources {
    pub runtime_python: PathBuf, // 内嵌解释器可执行
    pub agent_template: PathBuf, // 只读 agent/ 模板
    pub env_seed: PathBuf,       // agent/.env 种子
    pub version_file: PathBuf,   // VERSION 标记
    pub frontend_dist: PathBuf,  // frontend/dist SPA 静态资源
}

impl Resources {
    #[cfg(debug_assertions)]
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let _ = app;
        resolve_dev()
    }

    #[cfg(not(debug_assertions))]
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let base = resolve_base(app)?;
        Ok(resolve_from_base(&base))
    }
}

/// 解析资源根目录。
///
/// - **release / 打包态**：使用打包内嵌的 `resource_dir()`（.app/Contents/Resources 等）。
/// - **dev 态（`cargo tauri dev`）**：直接使用仓库 `.desktop-build/`——dev 时
///   `resource_dir()` 指向 `target/debug/`，那里的资源副本陈旧/损坏（python 运行时
///   被 SIGKILL），会导致 sidecar 启动即死、后端完全无效。
///
/// dev 回退由 `#[cfg(debug_assertions)]` 编译期门控：**release 构建不编译此分支**，
/// 因此正式构建的资源解析路径与定位逐字节不变。
#[cfg(not(debug_assertions))]
fn resolve_base(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(not(debug_assertions))]
    {
        app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))
    }
    #[cfg(debug_assertions)]
    {
        let _ = app; // dev 分支不依赖 AppHandle
        dev_build_base()
    }
}

/// dev 专用：解析到仓库 `.desktop-build/` 并校验 python-runtime / agent 就绪。
/// 抽取为独立纯函数便于单元测试。
#[cfg(debug_assertions)]
fn dev_build_base() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest
        .parent()
        .ok_or("无法从 CARGO_MANIFEST_DIR 解析仓库根目录")?;
    let build = repo.join(".desktop-build");
    let py = if cfg!(windows) {
        build.join("python-runtime").join("python.exe")
    } else {
        build.join("python-runtime").join("bin").join("python3")
    };
    if py.exists() && build.join("agent").exists() {
        Ok(build)
    } else {
        Err(format!(
            "dev 模式资源缺失：未在 {build:?} 找到可用的 python-runtime / agent。\n\
             请先执行组装脚本：\n  bash scripts/desktop/fetch-runtime.sh\n  \
             bash scripts/desktop/install-deps.sh .desktop-build/python-runtime\n  \
             bash scripts/desktop/assemble.sh"
        ))
    }
}

#[cfg(debug_assertions)]
fn resolve_dev() -> Result<Resources, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest
        .parent()
        .ok_or("无法从 CARGO_MANIFEST_DIR 解析仓库根目录")?;
    let build = dev_build_base()?;
    let mut res = resolve_from_base(&build);
    res.agent_template = repo.join("agent");
    res.env_seed = repo.join("agent").join(".env");
    res.frontend_dist = repo.join("frontend").join("dist");
    Ok(res)
}

/// 从给定 base 目录解析资源路径（resolve 与单元测试共享的构建器）。
pub fn resolve_from_base(base: &std::path::Path) -> Resources {
    let py = if cfg!(windows) {
        base.join("python-runtime").join("python.exe")
    } else {
        base.join("python-runtime").join("bin").join("python3")
    };
    Resources {
        runtime_python: py,
        agent_template: base.join("agent"),
        env_seed: base.join("agent").join(".env"),
        version_file: base.join("VERSION"),
        frontend_dist: base.join("frontend").join("dist"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resolve_from_base_produces_correct_python_path() {
        let base = Path::new("/fake/resource/dir");
        let res = resolve_from_base(base);

        if cfg!(windows) {
            assert_eq!(
                res.runtime_python,
                PathBuf::from("/fake/resource/dir/python-runtime/python.exe")
            );
        } else {
            assert_eq!(
                res.runtime_python,
                PathBuf::from("/fake/resource/dir/python-runtime/bin/python3")
            );
        }
    }

    #[test]
    fn resolve_from_base_agent_template_points_to_agent_dir() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(
            res.agent_template,
            PathBuf::from("/opt/app/resources/agent")
        );
    }

    #[test]
    fn resolve_from_base_env_seed_is_agent_dot_env() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(res.env_seed, PathBuf::from("/opt/app/resources/agent/.env"));
    }

    #[test]
    fn resolve_from_base_version_file_is_at_root() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(
            res.version_file,
            PathBuf::from("/opt/app/resources/VERSION")
        );
    }

    #[test]
    fn resolve_from_base_all_paths_are_under_base() {
        let base = Path::new("/my/app");
        let res = resolve_from_base(base);

        // 所有路径都应以 base 为前缀
        assert!(res.runtime_python.starts_with(base));
        assert!(res.agent_template.starts_with(base));
        assert!(res.env_seed.starts_with(base));
        assert!(res.version_file.starts_with(base));
    }

    // dev 回退测试：仅在 debug 构建编译运行（cargo test 默认 debug）。
    // .desktop-build 已组装时应解析到该目录；CI/全新克隆未组装时跳过（返回 Err）。
    #[cfg(debug_assertions)]
    #[test]
    fn dev_build_base_resolves_to_desktop_build_when_present() {
        match dev_build_base() {
            Ok(p) => assert!(
                p.ends_with(".desktop-build"),
                "expected path ending in .desktop-build, got {p:?}"
            ),
            Err(_) => { /* .desktop-build 未组装（CI/全新克隆），跳过 */ }
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_resources_use_source_agent_and_frontend_dist() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo = manifest.parent().unwrap();

        match dev_build_base() {
            Ok(base) => {
                let res = resolve_dev().unwrap();

                assert_eq!(res.agent_template, repo.join("agent"));
                assert_eq!(res.env_seed, repo.join("agent").join(".env"));
                assert_eq!(res.frontend_dist, repo.join("frontend").join("dist"));
                assert_eq!(res.version_file, base.join("VERSION"));
                assert!(res.runtime_python.starts_with(base));
            }
            Err(_) => { /* .desktop-build 未组装（CI/全新克隆），跳过 */ }
        }
    }
}
