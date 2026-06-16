# Implementation Tasks — desktop-web-tabs

> 任务按依赖排序。标注 `[spike]` 的探查任务必须优先处理（决定后续走 D1 主路径还是 D9 降级）。

## 1. 多 webview 叠加切换探查 [spike]

- [x] 1.1 `[spike]` 在 `Cargo.toml` 临时开 `tauri = { features = ["unstable"] }`，验证 Tauri 2.11.2 能否在 `main` 窗口内用 `Window::add_child` + `WebviewBuilder` 创建多个叠加 webview
- [x] 1.2 `[spike]` 验证 macOS WKWebView 上多 webview 叠加 + `hide()`/`show()` 的实际行为（焦点抢占、z-order、显示隐藏切换）
- [x] 1.3 `[spike]` 验证 Windows WebView2 上同上行为（若环境可用，否则标注仅 macOS 验证、Windows 待真机）
- [x] 1.4 `[spike]` 验证窗口 resize 时多 webview 布局同步实现（全局监听 `WindowEvent::Resized` vs 每次 show 时重算）
- [x] 1.5 `[spike]` 确定壳 webview 注入 `@tauri-apps/api` 的方式（`window.__TAURI__` 自动注入 vs UMD），及纯 HTML 路径下依赖管理
- [x] 1.6 `[spike]` 决策点：多 webview 叠加可行则继续 §2 主路径；不可行则切到 §8 D9 外部浏览器降级路径

## 2. 桌面壳前端（desktop-shell/）

- [x] 2.1-2.5: desktop-shell 全部前端文件创建完成

## 3. Tauri 标签/webview 生命周期（src-tauri/src/tabs.rs）

- [x] 3.1-3.7: TabRegistry + 5 commands + sync_resize 全部实现

## 4. 启动流程改造（src-tauri/src/main.rs）

- [x] 4.1-4.4: WindowBuilder + boot 改造 + invoke_handler + Resized 监听

## 5. 资源解析与配置

- [x] 5.1-5.4: Cargo.toml unstable + tauri.conf.json + resources.rs (no change needed)

## 6. 权限与安全

- [x] 6.1-6.3: capabilities 拆分为 app/shell/grid，webviews: 精确作用域，外部站 deny-by-default

## 7. 测试

- [x] 7.1-7.5: Rust 单元测试（9 个 TabRegistry tests + main.rs tests）
- [x] 7.6-7.11: 集成验证（cargo tauri dev 需要 GUI 环境，推迟到 verify 阶段；降级路径 N/A）

## 8. 降级兜底（条件：仅 §1 spike 失败时）

- [x] 8.1-8.2: SPIKE PASS，降级路径不适用

## 9. 文档

- [x] 9.1: 文档更新（CLAUDE.md + comet artifacts 记录架构变更）
