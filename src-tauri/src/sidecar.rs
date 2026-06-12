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

/// Windows cleanup (future Task will improve with Job Object)
#[cfg(not(unix))]
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
