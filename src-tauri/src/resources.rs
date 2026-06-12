// src-tauri/src/resources.rs
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 解析打包资源根。开发态回退到仓库内 .desktop-build / 源码目录。
pub struct Resources {
    pub runtime_python: PathBuf, // 内嵌解释器可执行
    pub agent_template: PathBuf, // 只读 agent/ 模板
    pub env_seed: PathBuf,       // agent/.env 种子
    pub loading_html: PathBuf,   // 加载页
    pub version_file: PathBuf,   // VERSION 标记
    pub frontend_dist: PathBuf,  // frontend/dist SPA 静态资源
}

impl Resources {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let base = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))?;
        let py = if cfg!(windows) {
            base.join("python-runtime").join("python.exe")
        } else {
            base.join("python-runtime").join("bin").join("python3")
        };
        Ok(Self {
            runtime_python: py,
            agent_template: base.join("agent"),
            env_seed: base.join("agent").join(".env"),
            loading_html: base.join("loading.html"),
            version_file: base.join("VERSION"),
            frontend_dist: base.join("frontend").join("dist"),
        })
    }
}

/// 从给定 base 目录解析资源路径(用于单元测试，不依赖 AppHandle)。
#[allow(dead_code)]
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
        loading_html: base.join("loading.html"),
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

        assert_eq!(res.agent_template, PathBuf::from("/opt/app/resources/agent"));
    }

    #[test]
    fn resolve_from_base_env_seed_is_agent_dot_env() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(res.env_seed, PathBuf::from("/opt/app/resources/agent/.env"));
    }

    #[test]
    fn resolve_from_base_loading_html_is_at_root() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(res.loading_html, PathBuf::from("/opt/app/resources/loading.html"));
    }

    #[test]
    fn resolve_from_base_version_file_is_at_root() {
        let base = Path::new("/opt/app/resources");
        let res = resolve_from_base(base);

        assert_eq!(res.version_file, PathBuf::from("/opt/app/resources/VERSION"));
    }

    #[test]
    fn resolve_from_base_all_paths_are_under_base() {
        let base = Path::new("/my/app");
        let res = resolve_from_base(base);

        // 所有路径都应以 base 为前缀
        assert!(res.runtime_python.starts_with(base));
        assert!(res.agent_template.starts_with(base));
        assert!(res.env_seed.starts_with(base));
        assert!(res.loading_html.starts_with(base));
        assert!(res.version_file.starts_with(base));
    }
}
