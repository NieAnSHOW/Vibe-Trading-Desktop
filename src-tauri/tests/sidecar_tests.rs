// tests/sidecar_tests.rs
// Integration tests for sidecar module — testing auxiliary/unit-testable functions.
use std::path::PathBuf;

// We can't directly import from the binary crate, so we test via the
// fact that the sidecar module path is accessible.
// For a proper unit-test approach, we use the module's exported functions
// by including the module source via a path attribute.

#[path = "../src/sidecar.rs"]
mod sidecar;

use sidecar::{build_cmd, health_url};

#[test]
fn build_cmd_sets_current_dir() {
    let python = PathBuf::from("/fake/python3");
    let agent = PathBuf::from("/fake/agent");
    let cmd = build_cmd(&python, &agent, 9999, &PathBuf::from("/fake/libs"));

    assert_eq!(cmd.get_current_dir(), Some(agent.as_path()));
}

#[test]
fn build_cmd_sets_environment_vars() {
    let python = PathBuf::from("/fake/python3");
    let agent = PathBuf::from("/fake/agent");
    let cmd = build_cmd(&python, &agent, 9999, &PathBuf::from("/fake/libs"));

    let envs: Vec<(&std::ffi::OsStr, Option<&std::ffi::OsStr>)> = cmd.get_envs().collect();

    let has_pythonpath = envs.iter().any(|(k, v)| {
        k.to_string_lossy() == "PYTHONPATH"
            && v.map(|s| s.to_string_lossy().contains("/fake/agent"))
                .unwrap_or(false)
    });
    assert!(has_pythonpath, "PYTHONPATH not set correctly");

    let has_pyonly = envs.iter().any(|(k, v)| {
        k.to_string_lossy() == "PYTHONDONTWRITEBYTECODE"
            && v.map(|s| s.to_string_lossy() == "1").unwrap_or(false)
    });
    assert!(has_pyonly, "PYTHONDONTWRITEBYTECODE not set to '1'");
}

#[test]
fn health_url_format() {
    assert_eq!(health_url(8899), "http://127.0.0.1:8899/health");
    assert_eq!(health_url(0), "http://127.0.0.1:0/health");
}
