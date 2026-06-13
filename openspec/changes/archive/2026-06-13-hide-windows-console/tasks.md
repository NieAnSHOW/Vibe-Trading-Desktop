---
name: hide-windows-console
description: 修复任务清单
---

# Tasks: 隐藏 Windows 终端窗口

- [x] 在 `src-tauri/src/sidecar.rs` 的 `build_cmd` 函数中添加 `#[cfg(windows)]` 块，设置 `CREATE_NO_WINDOW` 标志
- [x] 验证编译通过（cargo build）
- [x] 验证测试通过（cargo test）
