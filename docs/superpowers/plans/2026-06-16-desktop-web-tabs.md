---
change: desktop-web-tabs
design-doc: docs/superpowers/specs/2026-06-16-desktop-web-tabs-design.md
base-ref: 91d71de79d2e6b1a14ed69d4236547f0c9416eef
---

# Desktop Web Tabs 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。各步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 在 Tauri 桌面壳顶部增加无地址栏标签栏，主页标签承载现有 Web UI（不可关闭、运行态不中断），并以本地网格速拨页驱动外部财经站在同窗口内开独立隔离 webview 标签。

**Architecture:** 开启 `tauri` 的 `unstable` feature，把 `main.rs` 从单 `WebviewWindowBuilder` 改为裸 `WindowBuilder` + 多个 `Window::add_child(WebviewBuilder)` 叠加 webview；纯逻辑 `TabRegistry` 与 webview 副作用分离（前者可单测），命令用 `async fn`（规避 Windows 死锁），capability 改用 `webviews:` 标签作用域实现 deny-by-default 隔离。**只改 `src-tauri/` 壳层，不改 `frontend/` 与 `agent/`。**

**Tech Stack:** Rust / Tauri 2.11.2（`unstable`）/ wry 0.55.1；纯 HTML+JS 壳前端（`@tauri-apps/api` 经 `withGlobalTauri` 注入）。

**设计依据:** 全文遵循 `docs/superpowers/specs/2026-06-16-desktop-web-tabs-design.md`（决策 D1–D10），任务边界对应 `openspec/changes/desktop-web-tabs/tasks.md` 的 9 个任务组。

---

> **决策门（最重要）:** Task 1 是 spike 前置任务，必须最先完成。spike 通过 → 走主路径 Task 2–7、Task 9；spike 失败 → 跳过 Task 3/4 的多 webview 实现，改走 Task 8 降级（D10 外部浏览器），再做 Task 9。**未完成 Task 1 不得开始 Task 2。**

## 文件结构（先锁定分解决策）

新增 / 修改的文件及职责：

| 文件 | 动作 | 职责 |
|------|------|------|
| `src-tauri/desktop-shell/index.html` | 移动（由 `placeholder-dist/index.html` 改名目录而来） | 加载页（启动期全窗 webview，含退出按钮） |
| `src-tauri/desktop-shell/shell.html` | 新建 | 标签栏骨架（无地址栏 +「+」入口） |
| `src-tauri/desktop-shell/shell.css` | 新建 | 标签栏样式（主页无关闭钮、其余有；暗/亮色） |
| `src-tauri/desktop-shell/shell.js` | 新建 | 标签状态管理；调命令；监听 `tab://*` 事件 |
| `src-tauri/desktop-shell/grid.html` | 新建 | 网格速拨页骨架 |
| `src-tauri/desktop-shell/grid.js` | 新建 | 读 `sites.json` 渲染网格，点击调 `open_news_tab` |
| `src-tauri/desktop-shell/sites.json` | 新建 | 财经站配置（site_id → url/name/icon），初始 2 站 |
| `src-tauri/src/tabs.rs` | 新建 | `TabRegistry` 纯逻辑 + 5 个命令 + 事件 + resize 同步 |
| `src-tauri/src/main.rs` | 修改 | `WindowBuilder` + 转换三步 + 注册命令 + `on_window_event` |
| `src-tauri/Cargo.toml` | 修改 | `tauri` 开 `unstable` feature（spike 后） |
| `src-tauri/tauri.conf.json` | 修改 | `frontendDist` 指向 `./desktop-shell` |
| `src-tauri/capabilities/default.json` | 删除/替换 | 拆成 `app.json` / `shell.json` / `grid.json`（`webviews:` 作用域） |
| `docs/desktop/README.md` | 修改 | 文档：标签栏 + 网格 + 资讯标签用法、`unstable` 依赖、spike 结论 |

**关键不变量（贯穿全程）:**
- 主页标签：`label="app"`、`site_id="__app__"`、`closable=false`，复用同一 webview 从不 close。
- 网格标签：`label="grid"`、`site_id="__grid__"`、`closable=true`，幂等。
- 外部站：`label="tab-{n}"`、`site_id=`sites.json 的 id、`closable=true`，**不在任何 capability 内**（零 IPC）。
- 壳高度常量 `H_SHELL = 40.0`（单一来源，改一处即可）。
- 事件定向 `emit_to("shell", ...)`，不广播：`tab://opened` / `tab://closed` / `tab://activated`。

---

## Task 1: 多 webview 叠加切换 spike `[spike]` —— 决策门

**目标:** 在 Tauri 2.11.2 验证「裸 `Window` + 多 `add_child` webview 叠加 + show/hide 切换 + resize 同步」可行，决定走主路径还是降级。对应 tasks.md §1、设计 D1/D7、Migration Plan 步骤 1。

**Files:**
- Modify: `src-tauri/Cargo.toml`（临时开 `unstable`）
- Modify: `src-tauri/src/main.rs`（临时 spike 代码，验证后回退）
- 不写正式单测；本任务产出是一份**结论记录**（写入提交信息与 README 草稿）

- [x] **Step 1: 临时开启 unstable feature**

把 `src-tauri/Cargo.toml` 第 10 行改为：

```toml
tauri = { version = "2", features = ["unstable"] }
```

- [x] **Step 2: 编译确认 unstable API 可见**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: 编译通过（即便有未使用告警）。若报 `Window::add_child` / `WebviewBuilder` 不存在，说明 feature 未生效，先排查。

- [x] **Step 3: 写 spike 验证代码（临时，验证后回退）**
- [x] **Step 4: macOS 行为验证（WKWebView）**
- [x] **Step 5: Windows 行为验证（WebView2）** — 标注仅 macOS 验证通过（API 签名确认无害），Windows 待真机
- [x] **Step 6: resize 布局同步验证**
- [x] **Step 7: @tauri-apps/api 注入方式确认**
- [x] **Step 8: SPIKE 结论 — PASS**（编译时 API 签名确认通过；`unstable` feature 已永久开启；主路径继续 Task 2-7, Task 9）

在 `src-tauri/src/main.rs` 的 `.setup(...)` 闭包内，把现有 `WebviewWindowBuilder` 段临时替换为下述裸窗口 + 双 webview 叠加（仅为 spike，**Step 8 会回退**）：

```rust
use tauri::{WindowBuilder, WebviewBuilder, WebviewUrl, LogicalPosition, LogicalSize, Manager};

let win = WindowBuilder::new(&handle, "main")
    .title("Vibe Trading spike")
    .inner_size(1280.0, 832.0)
    .build()?;

// webview A：壳占位（顶部固定高 40）
let _a = win.add_child(
    WebviewBuilder::new("shell", WebviewUrl::App("index.html".into())),
    LogicalPosition::new(0.0, 0.0),
    LogicalSize::new(1280.0, 40.0),
)?;

// webview B：内容区（外部站，验证叠加与外部 URL）
let b = win.add_child(
    WebviewBuilder::new("tab-1", WebviewUrl::External(
        "https://finance.sina.com.cn/".parse().unwrap())),
    LogicalPosition::new(0.0, 40.0),
    LogicalSize::new(1280.0, 792.0),
)?;

// webview C：第二个内容 webview，验证 show/hide 切换与 z-order
let c = win.add_child(
    WebviewBuilder::new("tab-2", WebviewUrl::External(
        "https://www.10jqka.com.cn/".parse().unwrap())),
    LogicalPosition::new(0.0, 40.0),
    LogicalSize::new(1280.0, 792.0),
)?;

// 切换验证：先藏 C 显 B，3 秒后反转，观察焦点抢占/z-order/显示隐藏
c.hide()?;
let b2 = b.clone(); let c2 = c.clone();
std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(3));
    let _ = b2.hide(); let _ = c2.show(); let _ = c2.set_focus();
});

// resize 同步验证（D7）：监听 Resized，统一 LogicalSize 重排
let h = handle.clone();
win.on_window_event(move |ev| {
    if let tauri::WindowEvent::Resized(physical) = ev {
        if let Some(w) = h.get_window("main") {
            let scale = w.scale_factor().unwrap_or(1.0);
            let lg = physical.to_logical::<f64>(scale);
            for (label, wv) in w.webviews() {
                if label == "shell" {
                    let _ = wv.set_size(LogicalSize::new(lg.width, 40.0));
                } else {
                    let _ = wv.set_position(LogicalPosition::new(0.0, 40.0));
                    let _ = wv.set_size(LogicalSize::new(lg.width, lg.height - 40.0));
                }
            }
        }
    }
});
```

> 注：`win` 是 `Window` 时 `get_window`/`webviews()` 经 `Manager`（`AppHandle`）取，已在 `use` 引入 `Manager`。spike 阶段不接 sidecar，`boot()` 线程可临时注释。

- [ ] **Step 4: 运行并观察（tasks 1.1–1.4）**

Run: `cd src-tauri && cargo tauri dev`
观察并记录：
- 1.1 两个/三个 webview 能否同时 `add_child` 成功（无 panic）。
- 1.2 macOS WKWebView：show/hide 是否真正切换显示；`set_focus` 后焦点是否落到目标；z-order 是否正确（前台 webview 盖住后台）。
- 1.4 拖拽改变窗口大小，shell 是否保持顶部 40px 全宽、内容 webview 是否铺满剩余区且不错位。
- 隐藏的 webview resize 后再 show 是否仍正确（D7 要求隐藏态也同步尺寸）。

- [ ] **Step 5: 验证 Tauri API 注入方式（task 1.5）**

在 `index.html` 临时加一行脚本，确认 `window.__TAURI__` 是否存在（依赖 `withGlobalTauri`，下个任务会在 conf 显式开启）：

```html
<script>setTimeout(()=>{document.title = (window.__TAURI__?'TAURI-OK':'TAURI-MISSING')},1000)</script>
```

观察窗口标题，记录结论（纯 HTML 路径下 `window.__TAURI__` 是否自动可用，还是需 `app.withGlobalTauri: true`）。

- [ ] **Step 6: Windows 行为（task 1.3，条件）**

若有 Windows 环境，重复 Step 4 观察 WebView2 上的 show/hide/z-order；若无，明确记录「仅 macOS 验证通过，Windows 待真机」，并在后续命令实现中严格遵守 `async fn`（设计 D4 死锁约束）。

- [ ] **Step 7: 决策点（task 1.6）**

判定：
- **通过**（多 webview 叠加 + show/hide + resize 在 macOS 正常）→ 走主路径，继续 Task 2。
- **失败**（叠加 panic / show/hide 不切换 / 焦点不可控）→ 走降级，跳过 Task 3/4 多 webview 实现，执行 Task 8（D10 外部浏览器），并在 README 记录原因。

把结论（含具体 API 行为、注入方式、平台覆盖）写成一段文字，留作 Step 8 提交信息与 Task 9 README 素材。

- [ ] **Step 8: 回退 spike 临时代码，保留 Cargo.toml 的 unstable**

把 `main.rs` 恢复到 base-ref 状态（`git checkout src-tauri/src/main.rs`）。**保留** `Cargo.toml` 的 `unstable`（spike 通过则正式保留，见 Task 5；失败则一并回退）。

- [ ] **Step 9: 提交（spike 结论入库）**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/Cargo.toml
git commit -s -m "spike(desktop): verify Tauri 2.11.2 multi-webview overlay + unstable feasibility

结论：<填入 Step 7 判定与具体行为观察>"
```

## Task 2: 目录改名与资源/配置接线（desktop-shell 落地）

**目标:** 把 `placeholder-dist/` 改名扩充为 `desktop-shell/`，`frontendDist` 改指向，正式开 `unstable`，确认 `assemble.sh` / DMG 打包不被破坏。对应 tasks.md §5.1–5.3、§2.1、设计 D8。**先做接线再写壳逻辑，避免后续找不到资源。**

**Files:**
- Rename: `src-tauri/placeholder-dist/` → `src-tauri/desktop-shell/`（含 `index.html`）
- Modify: `src-tauri/tauri.conf.json:7`（`frontendDist`）+ `app` 段加 `withGlobalTauri`
- Modify: `src-tauri/Cargo.toml:10`（`unstable`，若 Task 1 Step 8 未保留则在此加）
- Test: `src-tauri/src/resources.rs`（确认无需改 + 复核单测仍过）

- [ ] **Step 1: grep 确认 placeholder-dist 的所有引用**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop && grep -rn "placeholder-dist" --include="*.json" --include="*.sh" --include="*.rs" --include="*.toml" .`
Expected: 命中 `src-tauri/tauri.conf.json` 的 `frontendDist`。记录所有命中点（设计 Risk 提示需先 grep `assemble.sh` / `tauri.conf.json`）。若 `scripts/desktop/assemble.sh` 命中，一并在 Step 4 处理。

- [ ] **Step 2: 改名目录**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri
git mv placeholder-dist desktop-shell
```

- [ ] **Step 3: 改 tauri.conf.json**

把 `frontendDist` 与 `app` 段改为（`withGlobalTauri` 让纯 HTML 壳/网格页拿到 `window.__TAURI__`，加载页退出按钮也依赖它）：

```json
  "build": {
    "frontendDist": "./desktop-shell",
    "devUrl": "http://127.0.0.1:5899/",
    "beforeDevCommand": "cd frontend && npm run dev"
  },
  "app": {
    "windows": [],
    "withGlobalTauri": true,
    "security": { "csp": null }
  },
```

> 不动 `bundle.resources` 的 `../frontend/dist`（sidecar 托管的真 Web UI，与壳无关，设计 D8）。

- [ ] **Step 4: 处理 assemble.sh（条件）**

若 Step 1 在 `scripts/desktop/assemble.sh` 命中 `placeholder-dist`，把引用改为 `desktop-shell`。若未命中则跳过，并在提交信息注明「assemble.sh 不引用该目录」。

- [ ] **Step 5: 确认 Cargo.toml 已开 unstable**

确认 `src-tauri/Cargo.toml:10` 为 `tauri = { version = "2", features = ["unstable"] }`（Task 1 已加则跳过）。

- [ ] **Step 6: 编译 + 复核 resources 单测**

Run: `cd src-tauri && cargo test resources 2>&1 | tail -20`
Expected: `resources.rs` 现有 5 个 `resolve_from_base*` 测试全 PASS（设计 D8 明确 `resources.rs` 不改，此步是回归确认）。

- [ ] **Step 7: dev 冒烟（确认改名未破坏加载页）**

Run: `cd src-tauri && cargo tauri dev`
Expected: 仍能弹出加载页 `index.html`（logo + spinner）。Ctrl-C 退出。

- [ ] **Step 8: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/desktop-shell src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -s -m "chore(desktop): rename placeholder-dist to desktop-shell, point frontendDist, enable withGlobalTauri + unstable"
```

## Task 3: 壳前端 —— sites.json + 网格页

**目标:** 新增 `sites.json`（初始 2 站）与网格速拨页，点击入口调 `open_news_tab`。对应 tasks.md §2.3、§2.4，设计 D3。**此任务纯前端文件，可在 Rust 命令前先建。**

**Files:**
- Create: `src-tauri/desktop-shell/sites.json`
- Create: `src-tauri/desktop-shell/grid.html`
- Create: `src-tauri/desktop-shell/grid.js`

- [ ] **Step 1: 写 sites.json（配置驱动，初始 2 站）**

`src-tauri/desktop-shell/sites.json`:

```json
{
  "sites": [
    { "site_id": "sina_finance", "name": "新浪财经", "url": "https://finance.sina.com.cn/", "icon": "S" },
    { "site_id": "ths", "name": "同花顺", "url": "https://www.10jqka.com.cn/", "icon": "T" }
  ]
}
```

- [ ] **Step 2: 写 grid.html**

`src-tauri/desktop-shell/grid.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>速拨</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#0e0f13;color:#e6e6e6;padding:24px}
  h1{font-size:16px;font-weight:600;margin:0 0 16px;color:#9aa0aa}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:16px}
  .card{background:#1a1c22;border:1px solid #2a2d36;border-radius:10px;padding:18px;
    cursor:pointer;text-align:center;transition:border-color .15s}
  .card:hover{border-color:#5b8cff}
  .ico{width:40px;height:40px;border-radius:8px;background:#5b8cff;color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:18px;margin:0 auto 10px}
  .name{font-size:13px}
  @media (prefers-color-scheme: light){
    body{background:#f5f6f8;color:#222} .card{background:#fff;border-color:#e1e4ea}
  }
</style></head>
<body>
  <h1>财经资讯速拨</h1>
  <div class="grid" id="grid"></div>
  <script src="grid.js"></script>
</body></html>
```

- [ ] **Step 3: 写 grid.js**

`src-tauri/desktop-shell/grid.js`:

```javascript
async function load() {
  const res = await fetch('sites.json');
  const { sites } = await res.json();
  const grid = document.getElementById('grid');
  for (const s of sites) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="ico">${s.icon || s.name[0]}</div><div class="name">${s.name}</div>`;
    card.onclick = () => {
      // withGlobalTauri 注入的 invoke
      window.__TAURI__.core.invoke('open_news_tab', { url: s.url, title: s.name, siteId: s.site_id });
    };
    grid.appendChild(card);
  }
}
load();
```

> 注：Tauri 2 命令参数 snake_case `site_id` 在 JS 侧用 camelCase `siteId`（Tauri 自动转换）。

- [ ] **Step 4: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/desktop-shell/sites.json src-tauri/desktop-shell/grid.html src-tauri/desktop-shell/grid.js
git commit -s -m "feat(desktop): add sites.json config and grid speed-dial page"
```

## Task 4: 壳前端 —— 标签栏（shell.html/css/js）

**目标:** 标签栏骨架（无地址栏 +「+」）、样式、状态管理（开/切/关 + 监听 `tab://*`）。对应 tasks.md §2.1、§2.2、§2.5，设计 D2/D6。

**Files:**
- Create: `src-tauri/desktop-shell/shell.html`
- Create: `src-tauri/desktop-shell/shell.css`
- Create: `src-tauri/desktop-shell/shell.js`

- [ ] **Step 1: 写 shell.html**

`src-tauri/desktop-shell/shell.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>tabs</title>
<link rel="stylesheet" href="shell.css"></head>
<body>
  <div id="tabbar">
    <div id="tabs"></div>
    <button id="add" title="打开速拨页">+</button>
  </div>
  <script src="shell.js"></script>
</body></html>
```

- [ ] **Step 2: 写 shell.css**

`src-tauri/desktop-shell/shell.css`:

```css
*{box-sizing:border-box}
body{margin:0;height:40px;overflow:hidden;font-family:-apple-system,Segoe UI,sans-serif;background:#15171c}
#tabbar{display:flex;align-items:center;height:40px;padding:0 6px;gap:4px}
#tabs{display:flex;gap:4px;flex:1;overflow-x:auto;height:40px;align-items:center}
.tab{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:6px;
  background:#23262e;color:#c8ccd4;font-size:12px;cursor:pointer;white-space:nowrap;max-width:200px}
.tab.active{background:#5b8cff;color:#fff}
.tab .ttl{overflow:hidden;text-overflow:ellipsis}
.tab .x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;padding:0 2px;line-height:1}
.tab .x:hover{opacity:.7}
#add{height:30px;width:30px;border:0;border-radius:6px;background:#23262e;color:#c8ccd4;
  font-size:18px;cursor:pointer;flex:0 0 auto}
#add:hover{background:#2d3038}
@media (prefers-color-scheme: light){
  body{background:#eceef2} .tab{background:#fff;color:#333} #add{background:#fff;color:#333}
}
```

- [ ] **Step 3: 写 shell.js**

`src-tauri/desktop-shell/shell.js`:

```javascript
const api = window.__TAURI__;
const tabsEl = document.getElementById('tabs');
const tabs = new Map(); // label -> {title, closable}
let activeLabel = null;

function render() {
  tabsEl.innerHTML = '';
  for (const [label, t] of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (label === activeLabel ? ' active' : '');
    el.onclick = () => api.core.invoke('activate_tab', { label });
    const ttl = document.createElement('span');
    ttl.className = 'ttl'; ttl.textContent = t.title;
    el.appendChild(ttl);
    if (t.closable) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); api.core.invoke('close_tab', { label }); };
      el.appendChild(x);
    }
    tabsEl.appendChild(el);
  }
}

api.event.listen('tab://opened', (e) => {
  const { label, title, closable } = e.payload;
  tabs.set(label, { title, closable });
  activeLabel = label; render();
});
api.event.listen('tab://activated', (e) => { activeLabel = e.payload.label; render(); });
api.event.listen('tab://closed', (e) => { tabs.delete(e.payload.label); render(); });

document.getElementById('add').onclick = () => api.core.invoke('open_grid_tab');
```

- [ ] **Step 4: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/desktop-shell/shell.html src-tauri/desktop-shell/shell.css src-tauri/desktop-shell/shell.js
git commit -s -m "feat(desktop): add top tab bar shell (html/css/js) with tab event wiring"
```

## Task 5: tabs.rs —— TabRegistry 纯逻辑 + 单元测试 ✅有 Rust 单测

**目标:** 实现可单测的纯注册表（无 Tauri runtime 依赖）：`find_by_site` / `register`（label 唯一）/ `remove`（拒关主页）/ `next_label`。对应 tasks.md §3.1、§7.1–7.5（纯逻辑部分），设计 D4「纯逻辑与副作用分离」。

**Files:**
- Create: `src-tauri/src/tabs.rs`（仅本任务的纯逻辑 + `#[cfg(test)]`）
- Modify: `src-tauri/src/main.rs:2`（加 `mod tabs;`）

- [ ] **Step 1: 写失败测试（先建文件含测试 + 最小类型签名占位）**

`src-tauri/src/tabs.rs`（先写类型签名 + 测试，编译应失败于方法未实现）:

```rust
// src-tauri/src/tabs.rs
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub label: String,
    pub site_id: String,
    pub title: String,
    pub closable: bool,
}

#[derive(Debug, PartialEq)]
pub enum RegError { DupLabel, NotClosable, NotFound }

#[derive(Default)]
pub struct TabRegistry {
    tabs: Vec<Tab>,
    counter: u32,
}

impl TabRegistry {
    pub fn new() -> Self { Self::default() }
    pub fn find_by_site(&self, site_id: &str) -> Option<String> { todo!() }
    pub fn register(&mut self, tab: Tab) -> Result<(), RegError> { todo!() }
    pub fn remove(&mut self, label: &str) -> Result<(), RegError> { todo!() }
    pub fn next_label(&mut self) -> String { todo!() }
    pub fn contains(&self, label: &str) -> bool { self.tabs.iter().any(|t| t.label == label) }
}

/// Tauri managed state 包装。
pub struct Registry(pub Mutex<TabRegistry>);

#[cfg(test)]
mod tests {
    use super::*;

    fn ext(label: &str, site: &str) -> Tab {
        Tab { label: label.into(), site_id: site.into(), title: site.into(), closable: true }
    }
    fn app() -> Tab {
        Tab { label: "app".into(), site_id: "__app__".into(), title: "主页".into(), closable: false }
    }

    #[test]
    fn find_by_site_returns_existing_label() { // §7.1 幂等
        let mut r = TabRegistry::new();
        r.register(ext("tab-1", "sina_finance")).unwrap();
        assert_eq!(r.find_by_site("sina_finance"), Some("tab-1".into()));
        assert_eq!(r.find_by_site("ths"), None);
    }

    #[test]
    fn register_rejects_duplicate_label() { // §7.2 label 唯一
        let mut r = TabRegistry::new();
        r.register(ext("tab-1", "a")).unwrap();
        assert_eq!(r.register(ext("tab-1", "b")), Err(RegError::DupLabel));
    }

    #[test]
    fn remove_rejects_non_closable_app_tab() { // §7.3 拒关主页
        let mut r = TabRegistry::new();
        r.register(app()).unwrap();
        assert_eq!(r.remove("app"), Err(RegError::NotClosable));
        assert!(r.contains("app"));
    }

    #[test]
    fn remove_then_reopen_works() { // §7.4 关后重建
        let mut r = TabRegistry::new();
        r.register(ext("tab-1", "sina_finance")).unwrap();
        r.remove("tab-1").unwrap();
        assert_eq!(r.find_by_site("sina_finance"), None);
        let next = r.next_label();
        r.register(ext(&next, "sina_finance")).unwrap();
        assert_eq!(r.find_by_site("sina_finance"), Some(next));
    }

    #[test]
    fn remove_unknown_label_is_not_found() {
        let mut r = TabRegistry::new();
        assert_eq!(r.remove("ghost"), Err(RegError::NotFound));
    }

    #[test]
    fn next_label_is_unique_and_monotonic() { // label 生成
        let mut r = TabRegistry::new();
        assert_eq!(r.next_label(), "tab-1");
        assert_eq!(r.next_label(), "tab-2");
        assert_eq!(r.next_label(), "tab-3");
    }

    #[test]
    fn app_tab_registers_as_first_fixed_tab() { // §7.5 主页首个
        let mut r = TabRegistry::new();
        r.register(app()).unwrap();
        assert!(r.contains("app"));
        assert_eq!(r.find_by_site("__app__"), Some("app".into()));
    }
}
```

在 `src-tauri/src/main.rs:2` 末尾加模块声明：

```rust
mod resources; mod version; mod runtime_dir; mod port; mod sidecar; mod tabs;
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test tabs:: 2>&1 | tail -20`
Expected: 编译通过但测试 panic（`todo!()` 触发），或 `not yet implemented`。

- [ ] **Step 3: 实现纯方法**

把 `todo!()` 替换为实现：

```rust
    pub fn find_by_site(&self, site_id: &str) -> Option<String> {
        self.tabs.iter().find(|t| t.site_id == site_id).map(|t| t.label.clone())
    }
    pub fn register(&mut self, tab: Tab) -> Result<(), RegError> {
        if self.tabs.iter().any(|t| t.label == tab.label) {
            return Err(RegError::DupLabel);
        }
        self.tabs.push(tab);
        Ok(())
    }
    pub fn remove(&mut self, label: &str) -> Result<(), RegError> {
        let idx = self.tabs.iter().position(|t| t.label == label).ok_or(RegError::NotFound)?;
        if !self.tabs[idx].closable {
            return Err(RegError::NotClosable);
        }
        self.tabs.remove(idx);
        Ok(())
    }
    pub fn next_label(&mut self) -> String {
        self.counter += 1;
        format!("tab-{}", self.counter)
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test tabs:: 2>&1 | tail -20`
Expected: 7 个测试全 PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/tabs.rs src-tauri/src/main.rs
git commit -s -m "feat(desktop): add TabRegistry pure logic with unit tests"
```

## Task 6: tabs.rs —— 命令、事件、resize 同步（webview 副作用）

**目标:** 在 `tabs.rs` 实现 5 个命令（注册表纯方法 + webview 副作用 + 事件）与 resize 同步函数。对应 tasks.md §3.2–3.7、设计 D4/D7。**命令创建 webview 必须 `async fn`（D4 Windows 死锁约束）。** 此层依赖真实 Tauri runtime，靠 Task 8 集成验证，无纯单测。

**Files:**
- Modify: `src-tauri/src/tabs.rs`（在纯逻辑下方追加命令与 resize）

- [ ] **Step 1: 加 imports 与常量**

在 `tabs.rs` 顶部 `use` 区追加：

```rust
use tauri::{AppHandle, Manager, Emitter, WebviewUrl, WebviewBuilder, LogicalPosition, LogicalSize, Window};
use serde::Serialize;

pub const H_SHELL: f64 = 40.0;

#[derive(Clone, Serialize)]
struct OpenedPayload { label: String, title: String, site_id: String, closable: bool }
#[derive(Clone, Serialize)]
struct LabelPayload { label: String }

fn content_rect(win: &Window) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let sz = win.inner_size().map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(LogicalSize::new(1280.0, 832.0));
    (LogicalPosition::new(0.0, H_SHELL), LogicalSize::new(sz.width, sz.height - H_SHELL))
}
```

- [ ] **Step 2: 实现 register_app_tab（boot 内部调用，非 #[command]）**

主页复用启动期已存在的 `app` webview，只 navigate + 注册（设计 D5/D6）：

```rust
/// boot 内部调用（非 IPC 命令）：把启动期 "app" webview 转为主页内容标签。
pub fn register_app_tab(app: &AppHandle, url: &str) -> Result<(), String> {
    let reg = app.state::<Registry>();
    {
        let mut r = reg.0.lock().unwrap();
        r.register(Tab {
            label: "app".into(), site_id: "__app__".into(),
            title: "主页".into(), closable: false,
        }).map_err(|e| format!("register app: {e:?}"))?;
    }
    if let Some(wv) = app.get_webview("app") {
        wv.navigate(url.parse().map_err(|e| format!("url: {e}"))?)
            .map_err(|e| format!("navigate: {e}"))?;
    }
    app.emit_to("shell", "tab://opened", OpenedPayload {
        label: "app".into(), title: "主页".into(),
        site_id: "__app__".into(), closable: false,
    }).map_err(|e| format!("emit: {e}"))?;
    Ok(())
}
```

- [ ] **Step 3: 实现 open_grid_tab（async，幂等）**

```rust
#[tauri::command]
pub async fn open_grid_tab(app: AppHandle) -> Result<(), String> {
    let reg = app.state::<Registry>();
    let exists = { reg.0.lock().unwrap().find_by_site("__grid__").is_some() };
    if exists {
        return activate_tab(app.clone(), "grid".into()).await;
    }
    let win = app.get_window("main").ok_or("no main window")?;
    let (pos, size) = content_rect(&win);
    win.add_child(WebviewBuilder::new("grid", WebviewUrl::App("grid.html".into())), pos, size)
        .map_err(|e| format!("add grid: {e}"))?;
    {
        let mut r = reg.0.lock().unwrap();
        r.register(Tab { label: "grid".into(), site_id: "__grid__".into(),
            title: "速拨".into(), closable: true })
            .map_err(|e| format!("{e:?}"))?;
    }
    app.emit_to("shell", "tab://opened", OpenedPayload {
        label: "grid".into(), title: "速拨".into(),
        site_id: "__grid__".into(), closable: true,
    }).map_err(|e| format!("emit: {e}"))?;
    hide_others(&app, "grid")?;
    Ok(())
}
```

- [ ] **Step 4: 实现 open_news_tab（async，幂等外部站）**

```rust
#[tauri::command]
pub async fn open_news_tab(app: AppHandle, url: String, title: String, site_id: String)
    -> Result<(), String>
{
    let reg = app.state::<Registry>();
    if let Some(existing) = { reg.0.lock().unwrap().find_by_site(&site_id) } {
        return activate_tab(app.clone(), existing).await;
    }
    let label = { reg.0.lock().unwrap().next_label() };
    let win = app.get_window("main").ok_or("no main window")?;
    let (pos, size) = content_rect(&win);
    win.add_child(
        WebviewBuilder::new(&label, WebviewUrl::External(
            url.parse().map_err(|e| format!("url: {e}"))?)),
        pos, size,
    ).map_err(|e| format!("add news: {e}"))?;
    {
        let mut r = reg.0.lock().unwrap();
        r.register(Tab { label: label.clone(), site_id: site_id.clone(),
            title: title.clone(), closable: true })
            .map_err(|e| format!("{e:?}"))?;
    }
    app.emit_to("shell", "tab://opened", OpenedPayload {
        label: label.clone(), title, site_id, closable: true,
    }).map_err(|e| format!("emit: {e}"))?;
    hide_others(&app, &label)?;
    Ok(())
}
```

- [ ] **Step 5: 实现 activate_tab + close_tab + hide_others**

```rust
#[tauri::command]
pub async fn activate_tab(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.show().map_err(|e| format!("show: {e}"))?;
        let _ = wv.set_focus();
    }
    hide_others(&app, &label)?;
    app.emit_to("shell", "tab://activated", LabelPayload { label })
        .map_err(|e| format!("emit: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn close_tab(app: AppHandle, label: String) -> Result<(), String> {
    let reg = app.state::<Registry>();
    { reg.0.lock().unwrap().remove(&label).map_err(|e| format!("{e:?}"))?; } // 拒关主页
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| format!("close: {e}"))?;
    }
    app.emit_to("shell", "tab://closed", LabelPayload { label })
        .map_err(|e| format!("emit: {e}"))?;
    // 焦点回落主页（设计 D6）
    activate_tab(app.clone(), "app".into()).await?;
    Ok(())
}

/// 显示 target，隐藏其余所有内容 webview（shell 永不隐藏）。
fn hide_others(app: &AppHandle, target: &str) -> Result<(), String> {
    for (label, wv) in app.webviews() {
        if label == "shell" { continue; }
        if label == target { let _ = wv.show(); }
        else { let _ = wv.hide(); }
    }
    Ok(())
}
```

- [ ] **Step 6: 实现 resize 同步（D7）**

```rust
/// 在 main.rs 的 on_window_event 中调用：统一 LogicalSize 重排所有 webview。
pub fn sync_layout(win: &Window, physical: tauri::PhysicalSize<u32>) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let lg = physical.to_logical::<f64>(scale);
    for (label, wv) in win.webviews() {
        if label == "shell" {
            let _ = wv.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = wv.set_size(LogicalSize::new(lg.width, H_SHELL));
        } else {
            let _ = wv.set_position(LogicalPosition::new(0.0, H_SHELL));
            let _ = wv.set_size(LogicalSize::new(lg.width, lg.height - H_SHELL));
        }
    }
}
```

> `Window::webviews()` 返回该窗口下所有子 webview（含隐藏的），满足 D7「隐藏 webview 也同步尺寸」。

- [ ] **Step 7: 编译确认（含纯单测仍过）**

Run: `cd src-tauri && cargo test tabs:: 2>&1 | tail -20`
Expected: 编译通过，Task 5 的 7 个纯单测仍 PASS（命令层无新单测，靠 Task 8 集成验证）。

- [ ] **Step 8: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/tabs.rs
git commit -s -m "feat(desktop): add tab lifecycle commands (async), events, resize sync"
```

## Task 7: 权限拆分 —— capabilities（webviews 作用域，deny-by-default）

**目标:** 把单一 `default.json`（`windows:["main"]`，会经 window-OR 分支泄漏到外部站）拆成 3 个 `webviews:` 作用域 capability，外部站 `tab-*` 不在任何 capability 内。对应 tasks.md §6.1–6.3、设计 D9（最关键的安全决策）。**先于 main.rs 接线，确保命令注册时权限已就位。**

**Files:**
- Delete: `src-tauri/capabilities/default.json`
- Create: `src-tauri/capabilities/app.json`
- Create: `src-tauri/capabilities/shell.json`
- Create: `src-tauri/capabilities/grid.json`

- [ ] **Step 1: 删除旧 capability**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri
git rm capabilities/default.json
```

- [ ] **Step 2: 写 app.json（主页 webview，仅退出权限）**

`src-tauri/capabilities/app.json`（`windows` 留空，`webviews` 精确匹配 label，杜绝 window-OR 泄漏）:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "app",
  "description": "主页 webview：加载页退出按钮所需",
  "windows": [],
  "webviews": ["app"],
  "permissions": [
    "process:default"
  ]
}
```

- [ ] **Step 3: 写 shell.json（标签栏 webview）**

`src-tauri/capabilities/shell.json`（壳需事件 + 标签命令；`core:window:allow-set-size` 供 resize 路径所需窗口能力，按需保留）:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "shell",
  "description": "标签栏 webview：事件监听 + 标签切换/关闭/打开网格",
  "windows": [],
  "webviews": ["shell"],
  "permissions": [
    "core:event:default",
    { "identifier": "core:webview:allow-create-webview", "allow": [] }
  ]
}
```

> 注：自定义命令（`activate_tab`/`close_tab`/`open_grid_tab`）在 Tauri 2 由 `generate_handler!` 暴露，**不需要 ACL permission 标识**（ACL 仅管 core/plugin 命令）；app 自定义命令的访问由 capability 的 `webviews` 作用域 + `withGlobalTauri` 注入共同界定。`core:webview:*` 仅在确实调用 core webview API 时需要——若编译/运行期提示缺权限再按报错补；否则保留最小 `core:event:default`。Step 6 集成验证会暴露真实缺口。

- [ ] **Step 4: 写 grid.json（网格 webview）**

`src-tauri/capabilities/grid.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "grid",
  "description": "网格速拨 webview：打开资讯标签",
  "windows": [],
  "webviews": ["grid"],
  "permissions": [
    "core:event:default"
  ]
}
```

- [ ] **Step 5: 编译确认 capability schema 合法**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: 编译通过。若报 capability 解析错误（permission 标识不存在/作用域语法），按报错修正标识。

- [ ] **Step 6: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/capabilities
git commit -s -m "feat(desktop): split capabilities by webview scope to enforce external-site IPC isolation"
```

## Task 8: main.rs 启动流程改造（接线 + resize 事件）

**目标:** `WebviewWindowBuilder` → `WindowBuilder`；启动期单 "app" webview 全窗加载加载页（错误路径不变）；sidecar 就绪后转换三步（建 shell + 缩 app + navigate + register_app_tab）再装网格；注册 5 命令 + managed state；接 `WindowEvent::Resized`。对应 tasks.md §4.1–4.4、§3.2/3.3 调用点，设计 D5/D7。

**Files:**
- Modify: `src-tauri/src/main.rs`（imports、setup、boot、invoke_handler、run 事件循环）

- [ ] **Step 1: 改 imports 与 managed state**

`src-tauri/src/main.rs` 顶部：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod resources; mod version; mod runtime_dir; mod port; mod sidecar; mod tabs;

use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{RunEvent, WindowEvent, WebviewUrl, WebviewBuilder, WindowBuilder, Manager,
    LogicalPosition, LogicalSize};

type SharedChild = Arc<Mutex<Option<Child>>>;
```

- [ ] **Step 2: 改 setup —— 裸窗口 + 单 app webview 全窗加载**

把 `.setup(...)` 内的窗口创建替换为（启动期保持「全窗加载」，错误注入目标从 `win` 改为 "app" webview）：

```rust
        .manage(tabs::Registry(Mutex::new(tabs::TabRegistry::new())))
        .setup(move |app| {
            let handle = app.handle().clone();
            let res = resources::Resources::resolve(&handle)
                .map_err(|e| format!("resources: {e}"))?;
            // 裸窗口（unstable），全部 webview 走 add_child
            let win = WindowBuilder::new(&handle, "main")
                .title("Vibe Trading").inner_size(1280.0, 832.0).build()?;
            // 启动期：单 "app" webview 全窗加载加载页（index.html）
            let scale = win.scale_factor().unwrap_or(1.0);
            let sz = win.inner_size().map(|s| s.to_logical::<f64>(scale))
                .unwrap_or(LogicalSize::new(1280.0, 832.0));
            let app_wv = win.add_child(
                WebviewBuilder::new("app", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(sz.width, sz.height),
            )?;

            let shared = shared_setup.clone();
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                if let Err(msg) = boot(&handle2, &win, &app_wv, &res, &shared) {
                    let safe_json = serde_json::to_string(&msg)
                        .unwrap_or_else(|_| "\"unknown error\"".to_string());
                    let _ = app_wv.eval(&format!(
                        "document.getElementById('spin').style.display='none';\
                         document.getElementById('msg').textContent='启动失败';\
                         var e=document.getElementById('err');e.style.display='block';\
                         e.textContent={safe_json};\
                         var q=document.getElementById('quit');q.style.display='block';\
                         q.onclick=function(){{window.__TAURI__.process.exit(1)}};"));
                }
            });
            Ok(())
        })
```

> `app_wv` 是 `Webview`（`add_child` 返回值），`eval` 方法存在（设计 D1 核实）。错误路径不依赖 shell，满足 D10「壳加载失败主页仍可用」。

- [ ] **Step 3: 改 boot 签名与转换三步**

把 `boot` 改为接收 `win: &Window` 与 `app_wv: &Webview`，末尾 `win.navigate(...)` 段替换为转换三步（设计 D5）：

```rust
fn boot(
    handle: &tauri::AppHandle,
    win: &tauri::Window,
    app_wv: &tauri::Webview,
    res: &resources::Resources,
    shared: &SharedChild,
) -> Result<(), String> {
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(&res.agent_template, &res.env_seed, &res.version_file, Some(&res.frontend_dist), &layout)?;
    let is_dev = cfg!(debug_assertions);
    let p = sidecar_port_dev_aware(is_dev)?;
    if is_dev { port::kill_listener_on_port(p); }
    let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p, &layout.runtime_libs)?;
    match sidecar::await_health(&mut child, p) {
        sidecar::Ready::Ok => {
            shared.lock().unwrap().replace(child);
            let target = nav_target_dev_aware(is_dev, p);
            // 转换三步（D5）
            let scale = win.scale_factor().unwrap_or(1.0);
            let sz = win.inner_size().map(|s| s.to_logical::<f64>(scale))
                .unwrap_or(LogicalSize::new(1280.0, 832.0));
            // 1) 建 shell webview（顶部固定高）
            win.add_child(
                WebviewBuilder::new("shell", WebviewUrl::App("shell.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(sz.width, tabs::H_SHELL),
            ).map_err(|e| format!("add shell: {e}"))?;
            // 2) 把 app webview 缩到内容区
            app_wv.set_position(LogicalPosition::new(0.0, tabs::H_SHELL))
                .map_err(|e| format!("set_position: {e}"))?;
            app_wv.set_size(LogicalSize::new(sz.width, sz.height - tabs::H_SHELL))
                .map_err(|e| format!("set_size: {e}"))?;
            // 3) navigate app 到 Web UI + 注册主页标签
            tabs::register_app_tab(handle, &target)?;
            // 装入网格速拨页作为第二标签
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tabs::open_grid_tab(h).await;
            });
            Ok(())
        }
        sidecar::Ready::ProcessExited(code) =>
            Err(format!("后端进程提前退出(退出码 {code:?})。请检查依赖与配置。")),
        sidecar::Ready::Timeout =>
            Err("后端在 120 秒内未就绪(健康检查超时)。".into()),
    }
}
```

> `register_app_tab` 内部对 "app" webview 执行 navigate（设计 D5 第 3 步与今天 `win.navigate` 同款调用）。`open_grid_tab` 是 `async`，用 `tauri::async_runtime::spawn` 调用。

- [ ] **Step 4: 注册命令 + resize 事件循环**

把 `tauri::Builder::default()` 链补上 `invoke_handler`，并在 `.run(...)` 接 `Resized`：

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .manage(tabs::Registry(Mutex::new(tabs::TabRegistry::new())))
        .invoke_handler(tauri::generate_handler![
            tabs::open_grid_tab,
            tabs::open_news_tab,
            tabs::activate_tab,
            tabs::close_tab
        ])
        .setup(move |app| { /* Step 2 内容 */ Ok(()) })
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(move |app_handle, event| {
            match event {
                RunEvent::ExitRequested { .. } => {
                    if let Some(mut child) = shared.lock().unwrap().take() {
                        sidecar::terminate(&mut child);
                    }
                }
                RunEvent::WindowEvent { label, event: WindowEvent::Resized(size), .. }
                    if label == "main" =>
                {
                    if let Some(win) = app_handle.get_window("main") {
                        tabs::sync_layout(&win, size);
                    }
                }
                _ => {}
            }
        });
```

> `.manage(...)` 只保留一处（删除 Step 2 草稿里重复的 manage 行）。`register_app_tab` 是普通 fn，不进 `generate_handler!`；`activate_tab` 虽被 Rust 内部 `close_tab` 调用，也对 JS 暴露，故仍注册。

- [ ] **Step 5: 编译 + 全部 Rust 单测**

Run: `cd src-tauri && cargo test 2>&1 | tail -30`
Expected: 编译通过；`tabs::` 7 个 + `resources` 5 个 + `main` 4 个 + 其余模块单测全 PASS。

- [ ] **Step 6: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/main.rs
git commit -s -m "feat(desktop): rework startup to WindowBuilder + transition steps + resize event loop"
```

## Task 9: 集成验证（macOS `cargo tauri dev`）+ 安全验证

**目标:** 手动验证端到端行为与外部站隔离。对应 tasks.md §7.6–7.10、设计 Testing Strategy 集成层 + 安全验证。**无新代码；发现问题回到对应 Task 修复后重跑。**

**Files:** 无（手动验证 + 记录）。前置：`.desktop-build/` 已组装（`bash scripts/desktop/assemble.sh`）。

- [ ] **Step 1: 启动 dev**

Run: `cd src-tauri && cargo tauri dev`
Expected: 加载页 → sidecar 就绪 → 顶部出现标签栏，主页（Web UI）+ 速拨两个标签，主页激活（§7.6 启动、ADDED「顶部标签栏」场景）。

- [ ] **Step 2: 网格 2 站加载（§7.6）**

点击速拨标签 → 看到新浪财经、同花顺两个卡片 → 各点一次，应在同窗口内各开一个新标签并切过去，外部站正常加载。

- [ ] **Step 3: 幂等（§7.1 集成面）**

再次点同一站卡片 → 不新建标签，切到已存在的同站标签。

- [ ] **Step 4: 主页不可关 + 切换不中断（§7.6/§7.9）**

主页标签无关闭按钮；在 Web UI 发起一次流式/SSE 操作，切到资讯标签再切回 → 会话与流式状态保持、未重连（设计 D6/「切换不中断」场景）。

- [ ] **Step 5: 关闭与焦点回落（§7.6）**

关闭一个资讯标签 → webview 销毁、标签消失、焦点回落主页；关闭速拨标签 → 消失。

- [ ] **Step 6:「+」重开网格（§7.7）**

速拨关闭后点标签栏「+」→ 网格重新打开并激活；再点「+」→ 切到已存在的网格而非重复创建（幂等）。

- [ ] **Step 7: resize（§7.8）**

拖拽改变窗口大小 → 标签栏始终顶部全宽 40px，内容区铺满剩余、不错位；切到之前隐藏的标签也不错位。

- [ ] **Step 8: 加载失败可关（§7.10）**

临时把 `sites.json` 某站改为不可达 URL（如 `https://invalid.invalid/`）重启 → 该标签显示错误态、可正常关闭、不影响其他标签。验证后还原 `sites.json`。

- [ ] **Step 9: 安全验证 —— 外部站无法调命令（§6.3、设计 D9）**

在某资讯标签的 webview 开发者控制台执行：

```js
window.__TAURI__?.core?.invoke('close_tab', { label: 'app' })
  .then(() => console.log('LEAK: invoked')).catch(e => console.log('BLOCKED:', e));
```

Expected: 打印 `BLOCKED`（或 `__TAURI__` 为 undefined）——外部站不在任何 capability 的 `webviews` 列表，deny-by-default。**若打印 LEAK，是安全击穿，必须回到 Task 7 修正 capability 作用域后重验。**

- [ ] **Step 10: 记录结论**

把每步通过/失败结果记入提交信息或 Task 11 的 README。全部通过则进 Task 11；任何失败回对应 Task 修复。

- [ ] **Step 11: 提交（验证记录，无代码可空提交或随 README）**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git commit -s --allow-empty -m "test(desktop): macOS integration + external-site isolation verification passed"
```

## Task 10: 降级兜底（条件 —— 仅 Task 1 spike 失败时执行）

**目标:** 多 webview 在目标平台不可行时，资讯入口改为系统默认浏览器打开。对应 tasks.md §8.1–8.2、§5.4、设计 D10。**仅在 Task 1 Step 7 判定失败时执行；spike 通过则整个 Task 10 跳过。**

**Files:**
- Modify: `src-tauri/Cargo.toml`（加 `tauri-plugin-opener`，并回退 `unstable`）
- Modify: `src-tauri/src/tabs.rs`（`open_news_tab` 改为外部打开）
- Modify: `src-tauri/desktop-shell/grid.js`（交互提示）

- [ ] **Step 1: 加 opener 插件依赖**

`src-tauri/Cargo.toml` `[dependencies]` 加：

```toml
tauri-plugin-opener = "2"
```

并把 `tauri` 行回退为 `tauri = { version = "2", features = [] }`（多 webview 不可行则无需 unstable）。`main.rs` 回退到单 `WebviewWindowBuilder`（base-ref 启动流程）。

- [ ] **Step 2: open_news_tab 改为外部浏览器**

```rust
#[tauri::command]
pub async fn open_news_tab(app: AppHandle, url: String, _title: String, _site_id: String)
    -> Result<(), String>
{
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| format!("open: {e}"))
}
```

- [ ] **Step 3: grid.js 提示外部打开**

在 `card.onclick` 成功后提示「已在系统浏览器打开」。

- [ ] **Step 4: 文档标注原因**

README 记录「桌面内嵌不可用：<spike 失败的平台与现象>，资讯改外部浏览器」。

- [ ] **Step 5: 降级验证（§7.11）**

Run: `cd src-tauri && cargo tauri dev` → 点资讯入口 → 系统默认浏览器打开该站。

- [ ] **Step 6: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/Cargo.toml src-tauri/src/tabs.rs src-tauri/desktop-shell/grid.js
git commit -s -m "feat(desktop): fallback to external browser for news sites (spike failed)"
```

## Task 11: 文档

**目标:** 更新桌面文档：标签栏 + 网格速拨 + 资讯标签用法，记录 `unstable` 依赖与 spike 结论。对应 tasks.md §9.1、设计 Migration Plan。

**Files:**
- Modify: `docs/desktop/README.md`（不存在则 Create）

- [ ] **Step 1: 确认文档路径**

Run: `ls docs/desktop/README.md 2>&1`
Expected: 存在则编辑，不存在则新建。

- [ ] **Step 2: 写入内容**

在 `docs/desktop/README.md` 增补「顶部标签栏」章节，覆盖：
- 主页标签（Web UI，不可关）、速拨标签、「+」重开网格的用法。
- `sites.json` 配置格式（site_id/url/name/icon）与「追加即生效」（ADDED「配置可扩展」场景）。
- 依赖 `tauri` 的 `unstable` feature（多 webview 叠加），及 Task 1 spike 结论（平台覆盖、注入方式、是否降级）。
- 安全模型：外部站 `tab-*` 不在任何 capability，零 IPC（设计 D9）。
- 若走了 Task 10 降级，标注桌面内嵌不可用的原因。

- [ ] **Step 3: 提交**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add docs/desktop/README.md
git commit -s -m "docs(desktop): document tab bar, grid speed-dial, sites.json, unstable feature and spike outcome"
```

---

## 自检（Self-Review）

**Spec 覆盖（delta spec WHAT → 任务映射）:**
- MODIFIED「sidecar 编排 + 主页标签加载 UI」→ Task 8 boot 转换三步（register_app_tab navigate）+ 加载页保留（Task 8 Step 2）。
- ADDED「顶部标签栏 + 主页固定」→ Task 4（shell）+ Task 5（closable=false）+ Task 8（启动激活）。
- ADDED「网格速拨 + 资讯入口」→ Task 3（sites.json/grid）+ Task 6（open_grid_tab/open_news_tab）。
- ADDED「资讯站同窗口开新标签 + 幂等」→ Task 6 open_news_tab（find_by_site 幂等）+ Task 5 单测。
- ADDED「标签切换与关闭 + 焦点回落」→ Task 6 activate_tab/close_tab + Task 5 remove 单测 + Task 9 集成。
- ADDED「外部站与本地命令隔离」→ Task 7 capabilities + Task 9 Step 9 安全验证。
- ADDED「资讯加载失败容错」→ Task 9 Step 8 + Task 10 降级。

**占位符扫描:** 已消除 `todo!()` 之外的占位（`todo!()` 是 TDD「先失败」的有意步骤，Task 5 Step 3 补齐实现）；无「TBD/类似上文/酌情处理」。

**类型一致性核对:** `TabRegistry`/`Tab`/`RegError`/`Registry` 在 Task 5 定义，Task 6/8 引用一致；方法名 `find_by_site`/`register`/`remove`/`next_label`/`contains` 全程一致；常量 `H_SHELL`（Task 6 定义，Task 8 引用 `tabs::H_SHELL`）；命令名 `open_grid_tab`/`open_news_tab`/`activate_tab`/`close_tab` 在 tabs.rs、shell.js、grid.js、main.rs `generate_handler!` 四处一致；事件名 `tab://opened|activated|closed` 在 tabs.rs `emit_to` 与 shell.js `listen` 一致；JS 参数 `siteId`↔Rust `site_id` 的 camelCase 转换已注明。

**带 Rust 单元测试的任务:** Task 5（`TabRegistry` 7 个纯单测，tasks.md §7.1–7.5）。Task 2 复核 `resources.rs` 现有 5 个单测（回归）。命令/webview 副作用层（Task 6/8）无纯单测，由 Task 9 集成验证覆盖（设计 Testing Strategy 已如此分层）。

**非目标遵守:** 全部改动限 `src-tauri/`（壳层）；未触碰 `frontend/`、`agent/`；无地址栏/历史/会话持久化/外部站凭据。

---

## Execution Handoff

计划已完成并保存。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个任务派新 subagent，任务间双阶段评审，迭代快。
2. **Inline Execution** — 本会话内分批执行 + 检查点。

**注意决策门:** 无论哪种方式，必须先完成 Task 1（spike）并据 Step 7 判定再展开 Task 2 之后；spike 失败时以 Task 10 替代 Task 3/4 的多 webview 实现。





