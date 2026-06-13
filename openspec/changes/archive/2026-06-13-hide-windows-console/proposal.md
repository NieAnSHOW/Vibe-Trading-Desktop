---
name: hide-windows-console
description: 修复 Windows 启动 Tauri 应用时弹出终端窗口的问题
status: active
created: "2026-06-13"
---

# Proposal: 隐藏 Windows 终端窗口

## 问题背景

Windows 上启动 Tauri 桌面应用时，会同时弹出一个终端（控制台）窗口。该窗口是 Python 后端进程的控制台，一旦关闭则应用无法使用。

## 根因分析

`src-tauri/src/sidecar.rs` 的 `build_cmd` 函数使用 `std::process::Command::new(python)` 启动 Python 后端进程。在 Windows 平台，`Command` 默认会为子进程创建可见的控制台窗口。Unix 平台已通过 `#[cfg(unix)]` 块调用 `setsid()` 脱离终端，但 Windows 平台缺少对应的隐藏窗口标志。

## 修复目标

在 `build_cmd` 中添加 `#[cfg(windows)]` 块，使用 `CommandExt::creation_flags` 设置 `CREATE_NO_WINDOW` (0x08000000) 标志，阻止 Windows 为子进程创建可见控制台窗口。

## 范围

- 仅修改 `src-tauri/src/sidecar.rs`
- 不影响 Unix/macOS 平台行为
- 不改变 stdout/stderr 管道配置

## 非目标

- 不涉及架构变更
- 不修改进程管理逻辑
