## Why

当前 Tauri 桌面客户端（`src-tauri/src/main.rs`）启动流程是：创建单个 `main` webview → 启动 Python sidecar → 健康检查通过后 `win.navigate(sidecar_url)` 把**整个窗口**导航到 Web UI。窗口被 Web UI 独占，没有标签栏。用户在桌面上做交易决策时若想参考行情/资讯（同花顺、新浪财经等），必须切到外部浏览器，打断工作流。

用户希望在桌面窗口顶部新增一条类浏览器的标签栏（**不展示地址栏**），主页标签固定为当前项目的 Web UI 且不可关闭；并提供一个网格速拨页快捷打开常用财经网站，点击即在**同窗口内新开标签页**以内嵌 webview 查看，无需离开桌面应用。

## What Changes

- 新增**桌面壳 webview**（`shell`），加载桌面专属的极简页面（纯 HTML/CSS/JS），常驻窗口顶部呈现**标签栏**，与 `frontend/`（Web UI）完全隔离。
- 标签内容区是**叠加的子 webview**：同一 `main` 窗口内多个 webview 堆叠，同一时刻只 `show()` 一个、其余 `hide()`。Web UI 成为固定的**首个**标签（不可关闭）。
- 新增**网格速拨页**（本地页面，作为可关闭的第二个标签）：以网格展示常用财经站快捷入口，**初始仅新浪财经、同花顺**，配置驱动以便后续增减。
- 点击网格入口 → 同窗口内新开标签，以**独立 webview** 内嵌加载该网站；对同一站点重复点击切换到已存在标签而非重建（**幂等**）。
- 标签栏「+」入口：重新打开/激活网格速拨页（网格标签可关闭，需重入途径）。
- **BREAKING**（仅桌面壳层内部启动流程，不影响 Web UI/后端）：`main.rs` 启动流程从「navigate 整窗到 Web UI」改为「建壳 webview + 把 Web UI 装为首个标签」。
- 开启 `tauri` 的 **`unstable`** feature 以支持同窗口多 webview；扩展 `capabilities/default.json` 新增 webview 创建/关闭 + 事件通信权限。
- 资讯快捷入口配置驱动（`desktop-shell/sites.json`）。

## Capabilities

### New Capabilities

无。本功能扩展既有桌面壳能力，不引入独立新 capability。

### Modified Capabilities

- `desktop-shell`：
  - 修改「应用启动时编排 Python 后端 sidecar」requirement —— sidecar 就绪后在桌面壳的**「主页」标签页**（而非整个窗口）中加载 Web UI；sidecar 启动/健康检查/端口逻辑保持不变。
  - 新增「顶部标签栏与主页固定标签」requirement —— 桌面壳 SHALL 在窗口顶部提供无地址栏的标签栏，Web UI 为固定首个标签且不可关闭。
  - 新增「网格速拨页与资讯快捷入口」requirement —— 提供可关闭的网格速拨标签页，以网格展示配置驱动的财经站入口（初始：新浪财经、同花顺）；并提供「+」入口重新打开网格。
  - 新增「资讯站点在同窗口内开新标签」requirement —— 点击网格入口在同窗口内新开独立 webview 标签，幂等切换。
  - 新增「标签切换与关闭」requirement —— 标签可切换/可关闭（主页除外），切换不中断 Web UI 运行态（SSE 会话、流式输出）。
  - 新增「外部资讯站点与本地命令隔离」requirement —— 外部站子 webview 不注入 Tauri IPC，无法调用本地 command。
  - 新增「资讯加载失败的容错」requirement —— 单个外部标签加载失败不影响应用与其他标签，用户可正常关闭。

## Impact

- **代码**：
  - 新增 `desktop-shell/`（`index.html` 标签条 + `shell.js` + `shell.css` + `grid.html` 网格速拨页 + `sites.json`）。
  - 新增 `src-tauri/src/tabs.rs`（标签/webview 生命周期 + Tauri command + resize 同步）。
  - 改 `src-tauri/src/main.rs`（启动建壳 webview + `open_app_tab`，替换 `win.navigate`，注册 command）。
  - 改 `src-tauri/src/resources.rs`（解析 shell 资源路径 dev/release）。
  - 改 `src-tauri/Cargo.toml`（`tauri` 开 `unstable` feature；条件新增 `tauri-plugin-opener` 降级路径用）。
  - 改 `src-tauri/capabilities/default.json`（新增 webview/event 权限）。
  - 可能改 `src-tauri/tauri.conf.json`（frontendDist / resources 兼容 shell 资源）。
- **不改**：`frontend/`（Web UI）全部代码、`agent/`（Python）、sidecar 启动逻辑。
- **平台**：macOS（WKWebView）主验证 + Windows（WebView2）尽力验证；多 webview 叠加切换行为需 plan 前期 spike 验证，失败则降级外部浏览器打开。
- **安全**：外部资讯站点是不可信内容，子 webview 不注入 Tauri IPC，与壳 DOM/JS 隔离。
- **体积**：壳前端纯 HTML/CSS/JS，体积可忽略（<50KB），无新原生依赖（除条件性 opener 降级）。
- **风险**：`unstable` feature 的多 webview API 可能随 Tauri 小版本变动；以 spike + 外部浏览器降级兜底。
