// src-tauri/src/sidecar.rs
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BOOT: &str = "import cli, sys; raise SystemExit(cli.main(sys.argv[1:]))";

/// Build the Command for spawning the python sidecar.
/// Extracted for testability — allows verifying the argument/env construction
/// without actually spawning a process.
pub fn build_cmd(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
    sessions_dir: &Path,
) -> std::process::Command {
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
        .env("VIBE_RUNTIME_LIBS", runtime_libs)
        .env("VIBE_SESSIONS_DIR", sessions_dir)
        // 桌面 sidecar 启动时自动恢复 enabled IM 渠道(复用磁盘 token),避免
        // "启停服务→微信 poll 循环随进程被杀→重启后渠道不自动起→前端要求重新扫码"。
        // CLI 直接 `vibe-trading serve` 不经此函数,行为不受影响。
        .env("VIBE_TRADING_CHANNELS_AUTO_START", "1")
        // Default pip mirror: Tsinghua (HTTPS) so first-run installs are fast
        // on CN networks. The Python side (optional_deps.mirror) can override
        // per-install via --index-url; this is just the process default.
        .env("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
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

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

pub fn spawn(
    python: &Path,
    runtime_agent: &Path,
    port: u16,
    runtime_libs: &Path,
    sessions_dir: &Path,
) -> Result<Child, String> {
    let mut cmd = build_cmd(python, runtime_agent, port, runtime_libs, sessions_dir);
    // ponytail: kill stale listener before bind, else await_health may
    // connect to a leftover sidecar from a killed previous session.
    crate::port::kill_listener_on_port(port);
    cmd.spawn()
        .map_err(|e| format!("spawn sidecar failed: {e}"))
}

/// SIGTERM 后回收 sidecar 的最长等待时间。超时则升级为 SIGKILL 兜底。
///
/// 5s 同时覆盖 Python 侧 uvicorn 的 `timeout_graceful_shutdown=5s`——正常情况下
/// sidecar 会在此窗口内自行退出；若它卡住（graceful shutdown 等不到 SSE 连接关闭
/// 等），SIGKILL 兜底确保 `terminate` 一定在此上限内返回。
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(5);

/// mac/unix: kill by process group (child.id() is the pgid, because it is the group leader).
/// killpg sends SIGTERM to all processes in the group; we then wait for the leader to exit.
///
/// 必须带超时兜底：若 sidecar 收到 SIGTERM 后不退出（uvicorn 默认 `timeout_graceful_shutdown=None`,
/// 会无限等待活跃 SSE 连接关闭），`child.wait()` 会无限阻塞——而本函数运行在
/// `RunEvent::ExitRequested` 回调即 Tauri 主事件循环线程上，一旦阻塞，应用窗口
/// 无法关闭、进程无法退出，表现为「退出时卡死 / 必须强制退出」。
#[cfg(unix)]
pub fn terminate(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    wait_or_kill(child, pid, TERMINATE_GRACE);
}

/// SIGTERM 之后限时轮询子进程；超时或异常则对整个进程组 SIGKILL 再回收。
#[cfg(unix)]
fn wait_or_kill(child: &mut Child, pid: i32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    // 超时兜底：SIGKILL 整个进程组（连同 sidecar fork 出的子孙进程），再回收僵尸。
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

/// Windows 进程清理：使用 kill + wait 确保进程终止。
///
/// `child.kill()` 即 `TerminateProcess`，同步立即结束句柄、`wait` 随即返回，
/// 不存在 unix 那种 graceful-shutdown 卡住的可能，因此无需超时兜底。
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

pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/health")
}

/// Poll /health endpoint, monitoring child process for early exit.
pub fn await_health(child: &mut Child, port: u16) -> Ready {
    let url = health_url(port);
    let client = reqwest::blocking::Client::new();
    let deadline = Instant::now() + Duration::from_secs(120); // was 60; Python cold-start (pandas/scipy/duckdb) can exceed 60 s on first run
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Ready::ProcessExited(status.code());
        }
        if let Ok(resp) = client.get(&url).timeout(Duration::from_millis(1000)).send() {
            if resp.status().is_success() {
                return Ready::Ok;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ready::Timeout
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn spawn_command_has_expected_args() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let cmd = build_cmd(python, agent, 8899, Path::new("/fake/libs"), Path::new("/fake/sessions"));

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
        let cmd = build_cmd(python, agent, 8899, Path::new("/fake/libs"), Path::new("/fake/sessions"));

        let args: Vec<&str> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        let args_str = args.join(" ");
        assert!(
            args_str.contains("serve"),
            "expected 'serve' in args: {}",
            args_str
        );
        assert!(
            args_str.contains("127.0.0.1"),
            "expected '127.0.0.1' in args: {}",
            args_str
        );
        assert!(
            args_str.contains("8899"),
            "expected '8899' in args: {}",
            args_str
        );
    }

    #[test]
    fn build_cmd_injects_runtime_libs_env() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let libs = Path::new("/fake/libs");
        let cmd = build_cmd(python, agent, 8899, libs, Path::new("/fake/sessions"));

        let mut found = false;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("VIBE_RUNTIME_LIBS")
                && val.and_then(|v| v.to_str()) == Some("/fake/libs")
            {
                found = true;
            }
        }
        assert!(found, "VIBE_RUNTIME_LIBS not set to libs path");
    }

    #[test]
    fn build_cmd_injects_default_pip_mirror() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let libs = Path::new("/fake/libs");
        let cmd = build_cmd(python, agent, 8899, libs, Path::new("/fake/sessions"));

        let mut index = None;
        let mut trusted = None;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("PIP_INDEX_URL") {
                index = val.and_then(|v| v.to_str()).map(String::from);
            }
            if key.to_str() == Some("PIP_TRUSTED_HOST") {
                trusted = val.and_then(|v| v.to_str()).map(String::from);
            }
        }
        assert_eq!(
            index.as_deref(),
            Some("https://pypi.tuna.tsinghua.edu.cn/simple"),
            "PIP_INDEX_URL must default to the Tsinghua mirror"
        );
        assert_eq!(trusted, None, "HTTPS mirror needs no trusted-host");
    }

    #[test]
    fn build_cmd_injects_sessions_dir_env() {
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let libs = Path::new("/fake/libs");
        let sessions = Path::new("/fake/home/.vibe-trading/sessions");
        let cmd = build_cmd(python, agent, 8899, libs, sessions);

        let mut found = false;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("VIBE_SESSIONS_DIR")
                && val.and_then(|v| v.to_str()) == Some("/fake/home/.vibe-trading/sessions")
            {
                found = true;
            }
        }
        assert!(found, "VIBE_SESSIONS_DIR not set to sessions path");
    }

    #[test]
    fn build_cmd_injects_channels_autostart() {
        // 桌面 sidecar 必须自动恢复 IM 渠道:启停服务会杀进程,若启动时不
        // autostart,微信 poll 循环不会恢复 → 前端判定需重新扫码(磁盘 token 仍在)。
        let python = Path::new("/fake/python3");
        let agent = Path::new("/fake/agent");
        let cmd = build_cmd(python, agent, 8899, Path::new("/fake/libs"), Path::new("/fake/sessions"));
        let mut found = false;
        for (key, val) in cmd.get_envs() {
            if key.to_str() == Some("VIBE_TRADING_CHANNELS_AUTO_START")
                && val.and_then(|v| v.to_str()) == Some("1")
            {
                found = true;
            }
        }
        assert!(found, "VIBE_TRADING_CHANNELS_AUTO_START=1 not injected");
    }

    /// 回归测试：模拟一个「收到 SIGTERM 但拒绝退出」的 sidecar（复刻 uvicorn
    /// 在 `timeout_graceful_shutdown=None` 下无限等待 SSE 关闭的场景），断言
    /// `wait_or_kill` 会升级为 SIGKILL 并在有限时间内回收，而不是无限阻塞。
    #[cfg(unix)]
    #[test]
    fn wait_or_kill_escalates_to_sigkill_when_sigterm_is_ignored() {
        use std::os::unix::process::CommandExt;

        // 复刻 build_cmd 的 setsid 语义：让子进程成为新 session/group 组长，
        // 这样 child.id() == pgid，killpg 才能命中整个进程组。
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("trap '' TERM; sleep 30");
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id() as i32;

        // 先发 SIGTERM（被 trap 忽略），再进入限时回收路径。
        unsafe {
            libc::killpg(pid, libc::SIGTERM);
        }
        let start = Instant::now();
        super::wait_or_kill(&mut child, pid, Duration::from_secs(1));

        // 必须已退出，且远早于 `sleep 30` 的自然结束 —— 证明 SIGKILL 兜底生效，
        // 而非把 Tauri 主事件循环挂死。
        let status = child.try_wait().expect("try_wait after kill");
        assert!(status.is_some(), "sidecar 应被 SIGKILL 回收，而非继续挂起");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "terminate 不应阻塞超过 5s，实际 {:?}",
            start.elapsed()
        );
    }
}
