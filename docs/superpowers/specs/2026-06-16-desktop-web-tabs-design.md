---
comet_change: desktop-web-tabs
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-16-desktop-web-tabs
status: final
---

# Desktop Web Tabs — 技术设计（HOW）

> OpenSpec delta spec（`openspec/changes/desktop-web-tabs/specs/desktop-shell/spec.md`）是需求事实源（WHAT）。本文是实现层技术设计（HOW），所有 Tauri API 已对照安装的 `tauri-2.11.2` / `tauri-utils-2.9.2` 源码逐条核实。

## Context

Tauri 桌面客户端（`src-tauri/src/main.rs`）启动时用 `WebviewWindowBuilder` 创建单个 `main` webview，`boot()` 线程在 sidecar 健康检查通过后 `win.navigate(sidecar_url)` 把整窗导航到 Web UI（dev: `http://127.0.0.1:5899` Vite，release: `http://127.0.0.1:<port>` sidecar 静态托管）。窗口被 Web UI 独占，无标签栏。

技术约束（已核实）：
- Tauri **2.11.2** / wry 0.55.1，`Cargo.toml` 未开任何 feature。
- 单 `WebviewWindow`；`tauri.conf.json` 的 `app.windows` 为空（程序化创建）。
- `capabilities/default.json` 仅授予 `windows:["main"]` 的 `core:default`/`core:window:*`/`process:default`，无 webview 创建/事件权限。
- `frontendDist: "./placeholder-dist"`（仅含加载页 `index.html`）；`bundle.resources` 另含 `../frontend/dist`（sidecar 托管的真 Web UI）。
- **关键**：`Window::add_child` 与 `WebviewBuilder` 均 `#[cfg(feature = "unstable")]` 门控；多 webview 必须开 `unstable`。

本功能只针对 Tauri 壳层，**不改 `frontend/`（Web UI）与 `agent/`（Python）任何代码**。

## Goals / Non-Goals

**Goals:**
- 窗口顶部新增无地址栏标签栏。
- 主页标签 = Web UI（`frontend`），固定首个、不可关闭，切换不中断运行态（SSE/流式）。
- 网格速拨页（本地）作可关闭的第二标签，配置驱动展示财经站（初始：新浪财经、同花顺）。
- 点击网格入口在同窗口内开独立 webview 标签，幂等切换。
- 标签栏「+」重新打开网格速拨页。
- 外部站与本地命令隔离（外部站 JS 调不动 Tauri command）。

**Non-Goals:**
- 不改 `frontend/`、`agent/` 任何代码。
- 不做地址栏/前进后退/书签/历史。
- v1 不持久化标签会话（重启恢复初始态）。
- 不处理外部站登录态/凭据。

## Decisions

### D1：同窗口多 webview 叠加（开 `unstable`）

`main.rs` 从 `WebviewWindowBuilder` 改为 `WindowBuilder`（裸窗口，`unstable` 门控），用 `window.add_child(WebviewBuilder, position, size) -> Webview` 叠加子 webview，`show()`/`hide()` 切换。

API 核实（`tauri-2.11.2`）：
- `Window::add_child` — `#[cfg(any(test, all(desktop, feature = "unstable")))]`，`src/window/mod.rs:1129`。
- `WebviewBuilder` — `unstable` 门控，`src/webview/mod.rs:260`。
- `Webview`：`show`/`hide`/`set_size`/`set_position`/`navigate`/`close` 均存在（`src/webview/mod.rs:1502-1689`）。

用 `WindowBuilder` 而非沿用 `WebviewWindowBuilder`：`add_child` 只在 `Window` 上，而 `WebviewWindow.window` 字段是 `pub(crate)`（`src/webview/webview_window.rs:1442`），取不出底层 `Window`。裸 `Window` + 全部 webview 走 `add_child` 是唯一干净的多 webview 拓扑。

被否方案：iframe（财经站普遍 `X-Frame-Options` 拒载 + 需改 frontend）、单 webview navigate（切回主页重载、丢 SSE/流式）、多 OS 窗口（违反同窗口要求）。

### D2：桌面壳 webview（标签栏）

`desktop-shell/shell.html` + `shell.js` + `shell.css` 作为常驻顶部的 webview，渲染标签栏 +「+」入口；管理标签状态；调 Tauri command；监听 Rust→壳事件更新标签栏。壳是本地可信内容，注入 `@tauri-apps/api`。固定高度常量 `H_SHELL`（如 40px）。

### D3：网格速拨页（本地内容 webview）

`desktop-shell/grid.html` + `grid.js` 作为可关闭的内容 webview，读取 `sites.json` 以网格渲染财经站入口，点击调 `open_news_tab`。`sites.json` 定义 `site_id → {url, name, icon}`，初始 2 站（新浪财经、同花顺），配置驱动可扩展。网格页本地可信，可注入 IPC。

### D4：`tabs.rs` 注册表、命令与事件

**纯逻辑与副作用分离**（让单元测试无需真实 Tauri runtime）。

```
TabRegistry（Tauri managed state，Mutex 保护）
  tabs: Vec<Tab>
  Tab { label: String, site_id: String, title: String, closable: bool }

纯方法（可单测，无 webview 依赖）：
  find_by_site(&site_id) -> Option<String>    # 幂等查找已存在 label
  register(tab) -> Result<(), DupLabel>        # label 唯一性
  remove(&label) -> Result<(), NotClosable>    # closable=false 拒绝
  next_label() -> "tab-{n}"                    # 唯一 label 生成（计数器）
```

标识约定：

| 标签 | label | site_id | closable |
|------|-------|---------|----------|
| 主页 | `app` | `__app__` | false |
| 网格 | `grid` | `__grid__` | true |
| 外部站 | `tab-{n}` | sites.json 的 site_id | true |

命令（= 注册表纯方法 + webview 副作用 + 事件）：

| 命令 | 暴露给 | 行为 |
|------|--------|------|
| `register_app_tab(url)` | Rust 内部（boot 调用） | 注册主页（closable=false），navigate app webview |
| `open_grid_tab()` `async` | JS（壳「+」） | 幂等 `__grid__`：存在则 activate，否则 `add_child` grid.html |
| `open_news_tab(url, title, site_id)` `async` | JS（grid 页） | 幂等 site_id：存在则 activate，否则 `add_child` 外部 URL + activate |
| `activate_tab(label)` | JS（壳点标签） | `show()` 目标，`hide()` 其余，`emit_to("shell", "tab://activated")` |
| `close_tab(label)` | JS（壳关闭钮） | 拒绝 `__app__`；否则 `webview.close()` + `registry.remove` + `emit_to("shell", "tab://closed")`；激活回落到主页 |

Rust→壳事件（`emit_to("shell", ...)` 定向，不广播）：`tab://opened {label,title,site_id,closable}` / `tab://closed {label}` / `tab://activated {label}`。

**Windows 死锁约束**：`WebviewBuilder::new` doc（`src/webview/mod.rs:289`）明确警告同步命令中创建 webview 在 Windows 上死锁，要求用 async 命令 + 独立线程。故 `open_grid_tab`/`open_news_tab` **必须 `async fn`**。

### D5：启动流程改造（main.rs）

`boot()` 复用现有 sidecar 启动/健康检查/端口逻辑，仅把末尾 `win.navigate(sidecar_url)` 替换为转换三步：
1. `window.add_child("shell", App("shell.html"), Logical(0,0), Logical(W, H_SHELL))` — 建标签栏。
2. `app_webview.set_position(Logical(0, H_SHELL))` + `set_size(Logical(W, H-H_SHELL))` — 缩到内容区。
3. `app_webview.navigate(sidecar_url)` — 与今天 `win.navigate` 同款调用，把加载页 webview 转为主页内容，并 `register_app_tab`。

启动期保持「全窗加载」：单 "app" webview 全窗加载 `index.html`，错误路径不变（壳未建，sidecar 失败时 eval 注入错误到 "app"）。`nav_target_dev_aware`/`sidecar_port_dev_aware` 的 dev/release 分支逻辑保留。

### D6：主页固定不可关闭；网格可关闭可重入

主页标签（label=`app`，closable=false）壳 UI 不渲染关闭按钮，`close_tab` 对其返回 `NotClosable`。因复用同一 webview 且从不 close，天然满足「不可关闭」。网格标签可关闭；关闭后「+」调 `open_grid_tab` 幂等重开。关闭当前激活的非主页标签后，激活回落到主页（Spec Patch 场景）。

### D7：resize 同步

`Window::on_window_event`（`src/window/mod.rs:1179`）注册闭包，捕获 `AppHandle` clone，匹配 `WindowEvent::Resized(PhysicalSize)`（`src/app.rs:111`）：

```
on Resized(physical):
  scale = window.scale_factor()
  logical = physical.to_logical(scale)         # 统一 LogicalSize 布局，规避 Retina/高 DPI 错位
  for (label, wv) in app.webviews():            # webviews() -> HashMap，src/lib.rs:571
    if label == "shell":
      wv.set_size(Logical(logical.w, H_SHELL))  # 标签栏：全宽、固定高
    else:                                        # app / grid / tab-*
      wv.set_position(Logical(0, H_SHELL))
      wv.set_size(Logical(logical.w, logical.h - H_SHELL))  # 内容区铺满
```

隐藏的 webview 也同步尺寸（避免切过去才发现错位）。`H_SHELL` 单一常量，改一处即可。

### D8：资源打包 + API 注入

shell 全是本地静态资源，复用 `frontendDist` 内嵌机制，`WebviewUrl::App("...")` 直接解析，**`resources.rs` 不改**：

```
placeholder-dist/ → 重命名/扩充为 desktop-shell/
  index.html            # 加载页（迁入；WebviewUrl::App("index.html")）
  shell.html/.js/.css   # 标签栏（WebviewUrl::App("shell.html")）
  grid.html/.js         # 网格速拨页（WebviewUrl::App("grid.html")）
  sites.json            # 站点配置
```

- `tauri.conf.json`：`frontendDist: "./placeholder-dist"` → `"./desktop-shell"`。
- `bundle.resources` 里 `../frontend/dist`（sidecar 托管的真 Web UI）是另一回事，不动。
- `app.withGlobalTauri: true`（`tauri-utils-2.9.2/src/config.rs:3075`）让纯 HTML 的壳/网格页拿到 `window.__TAURI__`（加载页退出按钮 `window.__TAURI__.process.exit` 也依赖它）。

### D9：安全边界 —— capability 用 `webviews` 作用域，杜绝 window-OR 泄漏

**关键发现**：IPC 派发逻辑（`src/ipc/authority.rs:457-461`）为 `origin.matches(&cmd.context) && (cmd.webviews.iter().any(match) || cmd.windows.iter().any(match))`——**window 分支是 OR**。今天的 `default.json` 用 `windows: ["main"]`，而所有标签都是 `main` 窗口的子 webview，会经 window 分支命中**包括外部站在内的每个子 webview**，外部站就能调 `process:exit`/`close_tab`，**击穿隔离**。

修正：capability 全部改用 `webviews:` 标签作用域（`tauri-utils-2.9.2/src/acl/capability.rs:174`，精确匹配 webview label，与所属窗口无关）、`windows` 留空，按 webview 拆分：

```
capabilities/
  app.json    → webviews: ["app"]    : process:default（加载页退出按钮）
  shell.json  → webviews: ["shell"]  : core:event:default + activate_tab/close_tab/open_grid_tab
  grid.json   → webviews: ["grid"]   : core:event:default + open_news_tab
  （外部站 tab-* ：不在任何 capability → 零 IPC）
```

外部站 webview 标签 `tab-{n}` 不出现在任何 capability 的 `webviews` 列表 → `resolve_access` 返回 `None`（源码 test `authority.rs:1041` 证 `is_none()`，deny-by-default）→ 即便 `withGlobalTauri` 注了 `__TAURI__`，调任何 command 都被拒。**双重保险**：注入层（外部站不依赖 IPC）+ ACL 层（deny-by-default）。

### D10：降级兜底

- 资讯站加载失败：子 webview 显示错误态，标签可关闭不影响其他。
- 多 webview 在某平台异常（spike 发现）：降级为 `tauri-plugin-opener` 外部浏览器打开。
- 壳前端加载失败：主页 "app" webview 仍可用（独立，不依赖壳 JS）。

## Risks / Trade-offs

- **[`unstable` 多 webview API 随小版本变动]** → spike 前置验证（Tauri 2.11.2）+ 锁定 Tauri 版本 + D10 外部浏览器降级。
- **[多 webview 叠加 hide/show 平台边界未验证]** → plan 前 spike（WKWebView/WebView2 焦点、z-order）。
- **[Windows 同步命令创建 webview 死锁]** → 创建命令一律 `async fn`（D4）。
- **[resize 多 webview 布局同步]** → 全局 `WindowEvent::Resized` 监听 + LogicalSize 统一换算（D7）。
- **[`placeholder-dist` 被别处引用导致打包破坏]** → plan 阶段先 grep `assemble.sh` / `tauri.conf.json` 再改 `frontendDist`。
- **[焦点抢占]** → 切换 show+focus 目标，壳不抢内容区焦点。
- **[外部站登录墙]** → 不处理、不存凭据。

## Migration Plan

1. spike 验证 Tauri 2.11.2 多 webview 叠加 hide/show + `unstable` 行为（D1 平台边界）。
2. `Cargo.toml` 开 `unstable`；新增 `desktop-shell/` + `src-tauri/src/tabs.rs`。
3. 按 webview 拆分扩展 `capabilities/`（D9）。
4. 改 `main.rs` 启动流程：`WindowBuilder` + 转换三步 + `register_app_tab` + `on_window_event` resize（D5/D7）。
5. macOS dev 集成验证：网格 2 站加载、切换/关闭、主页不可关、「+」重开网格、resize、Web UI 运行态不中断。
6. spike 失败时启用 D10 外部浏览器降级。
7. 回滚：改动隔离在壳层；回退 `main.rs` 启动分支即恢复单 webview navigate 行为。

## Testing Strategy

| 层 | 内容 |
|----|------|
| 纯单元（无 runtime） | `TabRegistry`：幂等 `find_by_site`、`register` 唯一性、`remove` 拒关主页、remove 后重建、`next_label` 生成 |
| 集成（`cargo tauri dev`，macOS 手动） | 网格 2 站加载、切换/关闭、主页不可关、「+」重开网格、resize 不错位、切走切回 Web UI SSE 不断、加载失败可关 |
| 安全验证 | 外部站 console 调 `__TAURI__.core.invoke('close_tab', ...)` 被拒 |
| spike 门禁 | 多 webview 叠加 + `unstable` 行为，失败转 D10 降级 |

## Open Questions（交 comet-build plan 阶段 spike）

- Tauri 2.11.2 多 webview 叠加 hide/show 在 WKWebView/WebView2 的焦点与 z-order 实际行为。
- app 自定义命令（`generate_handler!`）在 capability 里的权限引用写法（Tauri 2 app command 的 permission 标识形式）。
- 壳 webview 注入 `@tauri-apps/api` 的具体方式（`window.__TAURI__` 自动注入是否足够，纯 HTML 路径依赖管理）。
- `placeholder-dist` → `desktop-shell` 重命名对 `scripts/desktop/assemble.sh` 与 DMG 打包的影响。
