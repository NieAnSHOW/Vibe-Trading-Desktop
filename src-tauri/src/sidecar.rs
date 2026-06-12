// src-tauri/src/sidecar.rs
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Sidecar {
    pub child: Child,
    pub port: u16,
}

const BOOT: &str = "import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))";

/// Build the Command for spawning the python sidecar.
/// Extracted for testability — allows verifying the argument/env construction
/// without actually spawning a process.
pub fn build_cmd(python: &Path, runtime_agent: &Path, port: u16) -> std::process::Command {
    let mut cmd = Command::new(python);
    cmd.arg("-c")
        .arg(BOOT)
        .arg("serve")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(runtime_agent)
        .env("PYTHONPATH", runtime_agent)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    cmd
}

pub fn spawn(python: &Path, runtime_agent: &Path, port: u16) -> Result<Child, String> {
    let mut cmd = build_cmd(python, runtime_agent, port);
    cmd.spawn().map_err(|e| format!("spawn sidecar failed: {e}"))
}

/// mac/unix: kill by process group (child.id() is the pgid, because it is the group leader)
#[cfg(unix)]
pub fn terminate(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    // fallback
    let _ = child.kill();
    let _ = child.wait();
}

/// Windows 进程清理：使用 kill + wait 确保进程终止。
/// 后续可改进为 WinAPI Job Object（CreateJobObject / AssignProcessToJobObject），
/// 以便内核级关联所有子孙进程，确保在异常退出时也无残留。
#[cfg(windows)]
pub fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub enum Ready {
    Ok,
    ProcessExited(Option<i32>),
    Timeout,
}

/// Poll /health endpoint, monitoring child process for early exit.
pub fn await_health(child: &mut Child, port: u16) -> Ready {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::blocking::Client::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Ready::ProcessExited(status.code());
        }
        if let Ok(resp) = client
            .get(&url)
            .timeout(Duration::from_millis(1000))
            .send()
        {
            if resp.status().is_success() {
                return Ready::Ok;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ready::Timeout
}

/// Build the health URL for a given port. Extracted for testability.
pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/health")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn spawn_command_has_expected_args() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let cmd = build_cmd(python, agent, 8899);

        // Verify the program path is set correctly
        assert_eq!(cmd.get_program(), "/fake/python3");

        // Verify key env vars via iterator (get_envs returns HashMap<&OsStr, Option<&OsStr>>)
        let mut found_pythonpath = false;
        let mut found_bytecode = false;
        for (key, val) in cmd.get_envs() {
            let k = key.to_str().unwrap_or("");
            let v = val.and_then(|v| v.to_str()).unwrap_or("");
            if k == "PYTHONPATH" && v == "/fake/agent" {
                found_pythonpath = true;
            }
            if k == "PYTHONDONTWRITEBYTECODE" && v == "1" {
                found_bytecode = true;
            }
        }
        assert!(found_pythonpath, "PYTHONPATH not set correctly");
        assert!(found_bytecode, "PYTHONDONTWRITEBYTECODE not set correctly");
    }

    #[test]
    fn boot_const_is_valid() {
        // BOOT is the -c argument for Python, which imports cli and calls cli.main
        assert!(BOOT.contains("cli.main"));
        assert!(BOOT.contains("import"));
    }

    #[test]
    fn build_cmd_includes_serve_args() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let cmd = build_cmd(python, agent, 8899);

        let args: Vec<&str> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        let args_str = args.join(" ");
        assert!(args_str.contains("serve"), "expected 'serve' in args: {}", args_str);
        assert!(args_str.contains("127.0.0.1"), "expected '127.0.0.1' in args: {}", args_str);
        assert!(args_str.contains("8899"), "expected '8899' in args: {}", args_str);
    }

    #[test]
    fn health_url_formats_correctly() {
        assert_eq!(health_url(8899), "http://127.0.0.1:8899/health");
        assert_eq!(health_url(3000), "http://127.0.0.1:3000/health");
    }
}
