## Context

Tauri 桌面客户端启动时（`src-tauri/src/main.rs`）创建单个 `main` webview，`boot()` 线程在 sidecar 健康检查通过后 `win.navigate(sidecar_url)` 把整个窗口导航到 Web UI（dev: `http://127.0.0.1:5899` Vite，release: `http://127.0.0.1:<port>` sidecar 静态托管）。窗口被 Web UI 独占。

技术约束（已核实）：
- Tauri **2.11.2** / wry 0.55.1，`Cargo.toml` 未开任何 feature。
- `main.rs` 用 `WebviewWindowBuilder` 建**单个** webview；`tauri.conf.json` 的 `app.windows` 为空（窗口全程程序化创建）。
- `capabilities/default.json` 仅授予 `main` 窗口 `core:default` / `core:window:*` / `process:default`，**无 webview 创建、webview 间事件通信权限**。
- 前端 `@tauri-apps/api` 非 `frontend/` 依赖，Web UI 从不直接调 Tauri。
- **关键**：Tauri 2 的 `WebviewWindow` 是 1 窗口=1 webview 封装。要在一个窗口里叠多个 webview（`Window::add_child` + `WebviewBuilder`）**必须开 `tauri` 的 `unstable` feature**。

本功能**只针对 Tauri 桌面壳层**，完全独立于 Web UI；**不改 `frontend/` 一行代码**。canonical HOW 技术设计将在 comet-design 阶段产出至 `docs/superpowers/specs/`。

## Goals / Non-Goals

**Goals:**
- 桌面窗口顶部新增无地址栏的标签栏。
- 主页标签 = Web UI（`frontend`），固定首个、不可关闭，切换不中断其运行态（SSE 会话、流式输出）。
- 网格速拨页（本地页）作可关闭的第二标签，网格展示配置驱动的财经站（初始：新浪财经、同花顺）。
- 点击网格入口在同窗口内新开独立 webview 标签，幂等切换。
- 标签栏「+」可重新打开网格速拨页。
- Web UI 与外部资讯站 DOM/JS 完全隔离，外部站无法调用本地 Tauri 命令。

**Non-Goals:**
- 不改 `frontend/`（Web UI）与 `agent/`（Python）任何代码。
- 不做地址栏 / 前进后退 / 书签 / 历史等完整浏览器功能。
- v1 不持久化标签会话：重启后恢复初始态（主页 + 网格入口），已开外部站标签不恢复。
- 不处理外部站登录态 / 凭据存储。

## Decisions

### D1：同窗口多 webview 叠加，hide/show 切换（开 `unstable`）
一个 `main` 窗口内多个 webview 堆叠：壳 webview 常驻顶部（标签条 ~40px），内容 webview 铺满其下内容区，同一时刻只 `show()` 激活的那个、其余 `hide()`。
- **为何不用 iframe**：同花顺/新浪等财经站普遍设 `X-Frame-Options`，iframe 加载即被拒；且要改 frontend。
- **为何不用单 webview + navigate**：切回主页会重载，丢失 SSE/流式状态（违反"切换不中断"）。
- **为何不用多 OS 窗口**：违反"同窗口内嵌标签"的产品要求。
- **代价**：`unstable` feature 的多 webview API 可能随 Tauri 小版本变动 → 以 spike + 外部浏览器降级（D8）兜底。

### D2：桌面壳 webview（标签条）
新增 `desktop-shell/index.html` + `shell.js` + `shell.css`，作为 `main` 窗口首个 webview 常驻顶部。渲染标签条（主页/网格/外部站标签）+「+」入口；管理标签状态（开/切/关）；调 Tauri command；监听 Rust→壳事件更新标签条。壳是本地可信内容，注入 `@tauri-apps/api`。

### D3：网格速拨页（本地内容 webview）
`desktop-shell/grid.html`（+ 复用 `sites.json`）作为可关闭的内容 webview。读取 `sites.json` 渲染财经站网格入口；点击调 `open_news_tab`。`sites.json` 定义站点（site_id → url/name/icon），初始 2 站（新浪财经、同花顺），配置驱动可扩展。网格页本地可信，可注入 IPC 以触发开标签。

### D4：Tauri command 接口（`src-tauri/src/tabs.rs`）
定义并注册到 `invoke_handler`：
- `open_app_tab(app, url)` —— 把 Web UI 装为固定首个标签（sidecar 就绪后调用）。
- `open_news_tab(app, url, title, site_id)` —— 幂等：site_id 已存在则 activate，否则 `WebviewBuilder` 在 main 窗口创建子 webview。
- `open_grid_tab(app)` —— 打开/激活网格速拨页（供「+」与启动用）。
- `activate_tab(app, label)` —— show+focus 目标，hide 其余。
- `close_tab(app, label)` —— 销毁 webview、清理注册表（主页标签拒绝关闭）。
Rust→壳事件：`tab://opened`、`tab://closed`、`tab://activated`（标签条据此更新）。

### D5：启动流程变化（`main.rs`）
建壳 webview（顶部固定高度）替代直接 navigate；`boot()` 复用现有 sidecar 启动/健康检查/端口逻辑，仅把末尾 `win.navigate(sidecar_url)` 替换为 `open_app_tab(sidecar_url)` 把 Web UI 装为首个标签，随后 `open_grid_tab` 装入网格页。dev/release 的 url 选择逻辑（`nav_target_dev_aware`）保留。

### D6：主页固定不可关闭；网格可关闭可重入
主页标签（`tab[0]`，site_id 保留标识如 `__app__`）在壳 UI 不渲染关闭按钮，`close_tab` 对其拒绝。网格标签可关闭；关闭后「+」入口调 `open_grid_tab` 重新打开（幂等）。

### D7：标题栏 —— 保留原生，标签栏置其下
保留 macOS 红绿灯 / Windows 原生标题栏，标签栏放其下方，零额外窗口控制实现。

### D8：安全边界 —— 外部站点不注入 Tauri IPC
壳 / 网格 webview 注入 `@tauri-apps/api`（本地可信）；外部资讯站子 webview 加载外部 URL 时**不注入任何 Tauri API**，外部站 JS 无法调本地 command。不同 webview 间 DOM/JS 隔离。capability 仅给壳必需的最小权限。不收集用户在资讯站的任何数据/凭据。

### D9：降级兜底
- 资讯站加载失败：子 webview 显示错误态，标签可关闭不影响其他。
- 多 webview 在某平台异常（spike 发现）：降级为 `tauri-plugin-opener` 外部浏览器打开。
- 壳前端加载失败：主页标签 webview 仍可用（独立，不依赖壳 JS）。

## Risks / Trade-offs

- **[`unstable` 多 webview API 随小版本变动]** → spike 前置验证（Tauri 2.11.2）；锁定 Tauri 版本；失败启 D9 降级。
- **[多 webview 叠加 hide/show 平台边界未验证]** → plan 前 spike（WKWebView/WebView2 焦点、z-order）。
- **[resize 多 webview 布局同步]** → 监听 `WindowEvent::Resized`，遍历内容 webview 同步 `set_size`（y=壳高度、铺满内容区）。
- **[焦点抢占]** → 切换时 show+focus 目标，壳不抢内容区焦点。
- **[外部站登录墙]** → 不处理，不存凭据。
- **[权限收敛]** → capability 仅授予壳 webview 最小必需权限。

## Migration Plan

1. spike 验证 Tauri 2.11.2 多 webview 叠加 hide/show（D1 平台边界）+ `unstable` feature 行为。
2. `Cargo.toml` 开 `unstable`；新增 `desktop-shell/` + `src-tauri/src/tabs.rs`。
3. 扩展 `capabilities/default.json` 权限（D8）。
4. 改 `main.rs` 启动流程：建壳 webview + `open_app_tab` + `open_grid_tab`（D5）。
5. macOS dev 集成验证：网格 2 站加载、标签切换/关闭、主页不可关、「+」重开网格、resize、Web UI 运行态不中断。
6. spike 失败时启用 D9 外部浏览器降级。
7. 回滚策略：改动隔离在桌面壳层；回退 `main.rs` 启动分支即恢复单 webview navigate 行为。

## Open Questions（交 comet-build plan 阶段 spike）

- Tauri 2.11.2 多 webview 叠加 hide/show 在 WKWebView/WebView2 的焦点与 z-order 实际行为。
- resize 同步最佳实现（全局监听 `WindowEvent::Resized` vs show 时重算）。
- 壳 webview 注入 `@tauri-apps/api` 的方式（`window.__TAURI__` 自动注入 vs UMD），及纯 HTML 路径下的依赖管理。
- release 打包时 `desktop-shell/` 资源的 bundle 路径与 `tauri.conf.json` resources 映射。
