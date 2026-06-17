// src-tauri/src/port.rs
use std::net::TcpListener;

/// 让系统在 127.0.0.1 分配一个空闲端口,取号后立即释放交给后端绑定。
pub fn pick_free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Dev mode pre-launch cleanup: send SIGTERM to any process listening on `port`.
///
/// A previous ``cargo tauri dev`` session that was killed (SIGKILL / force-quit)
/// may leave behind a Python sidecar still bound to the dev port (8899).  During
/// the new session, the sidecar's cold-start phase can take 5-10 s (imports
/// pandas/scipy/duckdb), while the old process still responds to ``/health``.
/// ``await_health()`` then incorrectly returns ``Ready::Ok``, connecting the
/// webview to the stale backend.  Killing the stale listener before spawn
/// eliminates this race.
pub fn kill_listener_on_port(port: u16) {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("lsof")
            .args(["-t", "-i", &format!(":{port}"), "-sTCP:LISTEN"])
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                let pids: Vec<&str> = std::str::from_utf8(&out.stdout)
                    .unwrap_or("")
                    .lines()
                    .collect();
                // filter out our own process — lsof -t may include it
                let my_pid = std::process::id().to_string();
                for pid_str in pids {
                    let pid_str = pid_str.trim();
                    if pid_str.is_empty() || pid_str == my_pid {
                        continue;
                    }
                    if let Ok(pid) = pid_str.parse::<i32>() {
                        // SIGTERM first, then SIGKILL after 2 s if still alive
                        unsafe {
                            libc::kill(pid, libc::SIGTERM);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        // check if still running
                        let rc = unsafe { libc::kill(pid, 0) };
                        if rc == 0 {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            if unsafe { libc::kill(pid, 0) } == 0 {
                                unsafe {
                                    libc::kill(pid, libc::SIGKILL);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // On Windows, ``netstat -ano | findstr :{port}`` provides the PID,
        // then ``taskkill /PID <pid> /F`` performs the cleanup.
        let output = std::process::Command::new("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port} ^| findstr LISTENING') do @taskkill /F /PID %a 2>nul")])
            .output();
        let _ = output; // best-effort, ignore errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_bindable_loopback_port() {
        let p = pick_free_port().expect("should pick a port");
        assert!(p >= 1024, "got privileged port {p}");
        // 选出的端口应可再次绑定(已释放)
        let again = std::net::TcpListener::bind(("127.0.0.1", p));
        assert!(again.is_ok(), "picked port not bindable: {p}");
    }

    #[test]
    fn kill_listener_on_free_port_is_harmless() {
        // On a free port, this should not panic or crash
        kill_listener_on_port(19999);
    }
}
