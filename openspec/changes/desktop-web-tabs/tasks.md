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

- [x] 2.1 新增 `desktop-shell/index.html`：顶部标签栏骨架（无地址栏）+「+」入口
- [x] 2.2 新增 `desktop-shell/shell.css`：标签栏样式（主页标签无关闭按钮、其余标签有关闭按钮），支持暗色/亮色
- [x] 2.3 新增 `desktop-shell/sites.json`：财经站配置（site_id → url/name/icon），初始 2 站（新浪财经、同花顺）
- [x] 2.4 新增 `desktop-shell/grid.html` + 配套脚本：读取 `sites.json` 以网格渲染快捷入口，点击调 `open_news_tab`
- [x] 2.5 新增 `desktop-shell/shell.js`：管理标签状态（开/切/关）；调 Tauri command；监听 `tab://opened`/`tab://closed`/`tab://activated` 更新标签栏；主页标签禁关；「+」调 `open_grid_tab`

## 3. Tauri 标签/webview 生命周期（src-tauri/src/tabs.rs）

- [ ] 3.1 新增 `tabs.rs`：标签状态结构（label/site_id/url/title/closable）与 webview 注册表（线程安全）
- [ ] 3.2 实现 `open_app_tab(app, url)`：把 Web UI 作为固定首个「主页」标签创建（site_id=`__app__`，closable=false），sidecar 就绪后调用
- [ ] 3.3 实现 `open_grid_tab(app)`：打开/激活网格速拨页（幂等：已存在则 activate），closable=true
- [ ] 3.4 实现 `open_news_tab(app, url, title, site_id)`：幂等（site_id 已存在则 activate），否则 `WebviewBuilder` 在 main 窗口内创建子 webview，emit `tab://opened`
- [ ] 3.5 实现 `activate_tab(app, label)`：show+focus 目标 webview，hide 其余，emit `tab://activated`
- [ ] 3.6 实现 `close_tab(app, label)`：拒绝关闭主页标签（closable=false）；其余销毁 webview、清理注册表，emit `tab://closed`
- [ ] 3.7 实现 resize 同步：监听 `WindowEvent::Resized`，遍历内容 webview 同步 `set_size`（y=壳高度、铺满内容区）

## 4. 启动流程改造（src-tauri/src/main.rs）

- [ ] 4.1 `mod tabs;` 并改 `WebviewWindowBuilder`：建 main 窗口后先建壳 webview（加载 `desktop-shell/index.html`，顶部固定高度）替代直接加载 Web UI
- [ ] 4.2 改 `boot()`：sidecar 健康检查通过后，把末尾 `win.navigate(sidecar_url)` 替换为 `open_app_tab(sidecar_url)`，随后 `open_grid_tab` 装入网格页
- [ ] 4.3 在 `invoke_handler` 注册 5 个 command（open_app_tab/open_grid_tab/open_news_tab/activate_tab/close_tab）
- [ ] 4.4 在 `.run(...)` 的事件循环接入 `WindowEvent::Resized` → resize 同步（3.7）

## 5. 资源解析与配置

- [ ] 5.1 改 `resources.rs`：解析 `desktop-shell` 资源路径（dev 从源文件、release 从 bundle 资源），新增对应字段 + 单元测试
- [ ] 5.2 改 `Cargo.toml`：`tauri` 正式开 `unstable` feature（spike 通过后）
- [ ] 5.3 改 `tauri.conf.json`：`bundle.resources` 映射 `desktop-shell/` 资源；确认 `frontendDist`/`beforeDevCommand` 不被破坏
- [ ] 5.4 （条件）若 §8 D9 降级路径启用，新增 `tauri-plugin-opener` 依赖

## 6. 权限与安全

- [x] 6.1 扩展 `src-tauri/capabilities/default.json`：新增 webview 创建/关闭 + 事件通信权限（`core:webview:*` / `core:event:default` 等）
- [x] 6.2 确认 capability 仅授予壳 webview 必需的最小权限集
- [x] 6.3 确认外部资讯站子 webview 不注入 Tauri IPC（验证外部站 JS 无法调用本地 command）

## 7. 测试

- [ ] 7.1 Rust 单元测试：`open_news_tab` 幂等（重复 site_id 不重建，只切前台）
- [ ] 7.2 Rust 单元测试：标签 label 唯一性
- [ ] 7.3 Rust 单元测试：`close_tab` 拒绝关闭主页标签（closable=false）
- [ ] 7.4 Rust 单元测试：`close_tab` 后再 `open_news_tab` 能正常重建；`open_grid_tab` 幂等
- [ ] 7.5 Rust 单元测试：`open_app_tab` 创建固定首个标签
- [ ] 7.6 集成验证（macOS dev `cargo tauri dev`）：网格 2 站都能加载，标签切换/关闭正常，主页不可关
- [ ] 7.7 集成验证：「+」入口在网格关闭后能重新打开网格
- [ ] 7.8 集成验证：resize 不错位，标签内容区始终铺满
- [ ] 7.9 集成验证：Web UI 与资讯标签互不干扰（切走再切回，会话不丢、SSE 不断）
- [ ] 7.10 集成验证：资讯站加载失败时该标签可关闭，不影响其他标签
- [ ] 7.11 （条件）降级路径验证：故意制造 webview 创建失败，确认资讯入口仍可外部浏览器打开（若启用 D9）

## 8. 降级兜底（条件：仅 §1 spike 失败时）

- [ ] 8.1 `open_news_tab` 改为调用 `tauri-plugin-opener` 在系统默认浏览器打开外部站点
- [ ] 8.2 网格页/标签栏交互对应调整，并在文档标注桌面内嵌不可用的原因

## 9. 文档

- [ ] 9.1 更新 `docs/desktop/README.md`：顶部标签栏 + 网格速拨页 + 资讯标签用法；记录 `unstable` feature 依赖与 spike 结论
