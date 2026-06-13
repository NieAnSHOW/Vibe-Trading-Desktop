---
name: hide-windows-console
description: 修复方案设计
---

# Design: 隐藏 Windows 终端窗口

## 方案

在 `src-tauri/src/sidecar.rs` 的 `build_cmd` 函数中，在已有的 `#[cfg(unix)]` 块之后，添加 `#[cfg(windows)]` 条件编译块：

```rust
#[cfg(windows)]
{
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}
```

`CREATE_NO_WINDOW` (0x08000000) 是 Windows API 的进程创建标志，告诉系统不为子进程创建控制台窗口。这与现有的 `Stdio::piped()` 配合，stdout/stderr 仍然通过管道捕获。

## 影响分析

- 仅在 Windows 平台编译时生效
- 不影响已有的 Unix `setsid()` 逻辑
- 不改变进程生命周期管理（spawn/terminate 不变）
