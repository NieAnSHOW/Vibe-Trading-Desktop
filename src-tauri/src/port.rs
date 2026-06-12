// src-tauri/src/port.rs
use std::net::TcpListener;

/// 让系统在 127.0.0.1 分配一个空闲端口,取号后立即释放交给后端绑定。
pub fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    drop(listener);
    Ok(port)
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
}
