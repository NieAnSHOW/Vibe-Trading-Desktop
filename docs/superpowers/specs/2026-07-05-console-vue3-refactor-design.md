# 桌面控制台 Vite + Vue3 重构设计

- **日期**：2026-07-05
- **状态**：待评审
- **作者**：NieAnSHOW
- **影响范围**：`src-tauri/console-dist/`、`src-tauri/console-app/`（新增）、`scripts/desktop/`、`.github/workflows/desktop-build.yml`、`.gitignore`
- **不影响**：Rust 侧命令实现（`src-tauri/src/console.rs` 等 10 个 `console_*` 命令签名不变）、主前端 `frontend/`、Tauri 配置（`tauri.conf.json` 的 `frontendDist` 不变）

---

## 1. 背景与动机

桌面端 `src-tauri` 的控制台 UI（Tauri webview 加载的根内容）当前是一个**手工维护的单文件 SPA**：`src-tauri/console-dist/index.html`，1023 行 / 72KB，HTML + CSS + JS 全内联，无打包工具。

它对接了 10 个 `console_*` Tauri 命令与 6 个事件流，承载：环境/服务/渠道三类状态 badge、bootstrap 安装进度条（venv→installing→smoke→done 渐近爬升）、日志面板、关闭二次确认、打开 WebUI/日志目录等模块。控制台有独立版本号，由 `scripts/desktop/console-version.mjs` 维护，刻意与 app release 版本解耦。

近期四次提交（`75f10c5`、`22ac703`、`fb86ccf`、`22045cc`、`4fda7c4`）持续叠加功能，单文件结构已经撑不住后续要加的新功能。本次重构的**核心驱动力**是为以下四类新功能铺路：

1. 多渠道管理扩展（钉钉/飞书/Telegram 等）
2. 设置/配置面板（LLM、数据源、mandate 下沉到桌面）
3. 运行时监控可视化（端口、进程、资源、日志筛选）
4. 版本检查 / 自动更新

**重要边界**：重构本身 = 基础设施（Vite+Vue3+路由+状态+组件骨架）+ 1:1 迁移现有功能。上述四类新功能**不在本次交付**，各自后续单独立项。

## 2. 现状梳理

| 维度 | 现状 |
|---|---|
| 加载方式 | `tauri.conf.json` 的 `build.frontendDist: "./console-dist"`；Tauri webview 根内容 |
| 文件 | `src-tauri/console-dist/index.html`（1023 行单文件）；`src-tauri/console.html`（109 行旧版，已被取代，git 显示不再演化） |
| 构建链 | 无；`build.rs` 只跑 `tauri_build::build()`；手工编辑后直接提交单文件 |
| IPC | 裸用 `window.__TAURI__.core`（`withGlobalTauri: true`）；10 命令 + 6 事件 |
| 版本号 | footer 锚点 `data-console-version="vX.Y.Z"`；`console-version.mjs` 用正则读写 |
| dev 模式 | `beforeDevCommand` 跑 `frontend/`（React 业务 UI）dev server 给浏览器 WebUI 用；console 本身无 dev server，靠静态产物 |

**Tauri 命令契约**（`src-tauri/src/console.rs`，本次不变）：

| 命令 | 入参 | 返回 / 事件 |
|---|---|---|
| `console_status` | — | `StatusReport`（env 状态、svc 运行态、port） |
| `console_bootstrap` | — | 事件流 `bootstrap://event` + `bootstrap://exit` |
| `console_start_service` | — | 事件 `service://started` |
| `console_stop_service` | — | `()` |
| `console_open_webui` | `port: u16` | `()` |
| `console_open_logs` | — | `()` |
| `console_start_channels` | `port: u16` | `String` |
| `console_channels_status` | `port: u16` | `String` |
| `console_install_channel_dep` | `channel: String` | 事件流 `channeldep://progress` + `channeldep://exit` |
| `console_confirm_close` | — | `()` |

**事件**：`app://close-requested`（触发关闭二次确认）、`bootstrap://event`、`bootstrap://exit`、`service://started`、`channeldep://progress`、`channeldep://exit`。

## 3. 方案选型

### 候选方案

- **方案 A**：Vite + Vue3 + TS 独立工程 `src-tauri/console-app/`，零重型依赖（自写轻量组件），产物落 `console-dist/`，本次只交付骨架 + 1:1 迁移。
- **方案 B**：同 A，但引入 Naive UI 组件库，本次额外交付多渠道管理作为样板页。
- **方案 C**：放弃 Vue3，改用 React 复用 `frontend/`，console 作为 `frontend/` 的独立入口或子工程。

### 选型：方案 A

理由：
1. 尊重用户明确意图（"使用 vite + vue3"）。
2. 最小可用：不背组件库，包体积可控，组件复刻现有视觉即可。
3. 与 Tauri 工程同目录（`src-tauri/console-app/`），便于构建脚本接入。
4. 交付边界清晰：四类新功能各自后续立项，避免单 spec 爆炸。
5. 与 `frontend/` 完全隔离，console 作为独立 UI 产物单独演进（与 `console-version.mjs` 的"刻意解耦"原则一致）。

放弃 C 的理由：偏离用户原话；`frontend/` 为浏览器 WebUI 设计，桌面入口耦合度高。

## 4. 详细设计

### 4.1 工程结构与构建链

**目录布局**（`src-tauri/console-app/`）：

```
src-tauri/
├── console-app/              ← 新增：Vite + Vue3 + TS 工程
│   ├── package.json          ← name: vibe-trading-console, version 与 console-version 锚点对齐
│   ├── vite.config.ts        ← build.outDir: '../console-dist', emptyOutDir: true, base: './'
│   ├── tsconfig.json
│   ├── index.html            ← Vite 入口（title、lang、footer 含 data-console-version 锚点）
│   └── src/
│       ├── main.ts           ← createApp + router + pinia
│       ├── App.vue           ← <RouterView/> + 全局错误边界
│       ├── router.ts         ← 4 路由，本次只实现 '/'
│       ├── stores/           ← pinia: env, service, bootstrap, channels
│       ├── ipc/              ← Tauri 命令/事件封装（@tauri-apps/api）
│       ├── components/       ← 自写轻量组件（见 4.4）
│       ├── pages/
│       │   ├── ConsolePage.vue    ← 迁移现有 console 全部功能
│       │   ├── ChannelsPage.vue   ← 占位空页（后续）
│       │   ├── SettingsPage.vue   ← 占位空页（后续）
│       │   └── MonitorPage.vue    ← 占位空页（后续）
│       └── styles/           ← 迁移现有 CSS，按组件拆 module
├── console-dist/             ← Vite 产物落点（Tauri frontendDist 不变）
│   └── index.html            ← 改为 gitignore（产物，可重建）
└── console.html              ← 迁移完成后删除
```

**依赖**（`console-app/package.json`）：

```json
{
  "dependencies": {
    "vue": "^3.5",
    "vue-router": "^4.4",
    "pinia": "^2.2",
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "vite": "^5",
    "@vitejs/plugin-vue": "^5",
    "typescript": "^5",
    "vue-tsc": "^2"
  }
}
```

**构建链接入**（不改 Tauri 配置）：

| 脚本 | 改动 |
|---|---|
| `scripts/desktop/build-console.sh` | **新增**：`cd src-tauri/console-app && npm ci && npm run build`，再跑 `console-version.mjs --check` |
| `scripts/desktop/build-dmg.sh` | 在 assemble 前调用 `build-console.sh` |
| `scripts/desktop/build-windows.ps1` | 同上 |
| `.github/workflows/desktop-build.yml` | CI 加一步 `build-console.sh` |

**版本锚点**：`console-app/index.html` footer 保留 `data-console-version="vX.Y.Z"`；`console-version.mjs` 的 `INDEX_PATH` 改为指向 `src-tauri/console-app/index.html`（源文件），构建后锚点带到产物；`package.json` version 与锚点对齐（`console-version.mjs` 增校验）。

**dev 模式（本次最小侵入）**：
- 不动 `tauri.conf.json` 的 `beforeDevCommand`（保持 frontend dev 给浏览器 WebUI）。
- 改 console 时：`cd src-tauri/console-app && npm run dev`（:5174 HMR），浏览器直连看效果。
- Tauri 桌面 dev 仍加载 `console-dist/` 静态产物；改完 console 跑一次 `npm run build` 再 `cargo tauri dev`。
- **后续优化（不在本次）**：`beforeDevCommand` 改并行脚本 + 加 `devUrl`，让桌面 dev 直连 HMR。

**`.gitignore`**：`src-tauri/console-dist/` 改为忽略；`src-tauri/console-app/node_modules/` 忽略。

### 4.2 IPC 封装层

`src/ipc/`，类型安全，单一来源：

```
src/ipc/
├── commands.ts    ← 10 个命令的 typed wrapper（薄封装 @tauri-apps/api invoke）
├── events.ts      ← 6 个事件的 typed listen/unlisten + 自动 cleanup
└── types.ts       ← Rust 侧返回类型镜像（StatusReport / BootstrapEvent / ...）
```

- `commands.ts` 统一 `try/catch invoke`；若 `window.__TAURI__` 不存在（被外部浏览器打开），命令 reject → store 进入"IPC 不可用"降级态，UI 显示提示而非抛错。
- `events.ts` 提供 `onXxx(cb)` 返回 `unlisten`，组件 `onUnmounted` 自动 cleanup。

### 4.3 Pinia stores

4 个 store 对应现有状态域：

| store | 职责 |
|---|---|
| `env.ts` | envBadge 三态（检测中/就绪/未安装/不完整）+ port |
| `service.ts` | svcBadge + start/stop/open 动作 + 监听 `service://started` |
| `bootstrap.ts` | 进度条状态机（venv→installing→smoke→done/failed，渐近爬升算法原样搬） |
| `channels.ts` | channel badge + 选择器 + start/install 状态 |

进度条的"渐近爬升 + 单调不倒退"算法（现有 `STAGE` 表 + `advanceProgress`）**原样迁移**到 `bootstrap.ts`，已验证的 UX 不动。

### 4.4 组件清单

自写，零依赖，复刻现有视觉：

| 组件 | 职责 |
|---|---|
| `StatusBadge.vue` | `.ok/.warn/.bad` 三态 badge |
| `AppButton.vue` | primary / ghost 两变体 + disabled |
| `ProgressBar.vue` | 进度条 + stage label + spinner + done/failed 状态 |
| `LogViewer.vue` | 增量日志 + 自动滚底 + 清空（`role="log"` `aria-live`） |
| `ConfirmDialog.vue` | `<dialog>` 二次确认（停止服务 / 关闭窗口） |
| `ChannelSelect.vue` | 渠道下拉 |
| `VersionFooter.vue` | footer，注入 `data-console-version` 锚点 |
| `HintBanner.vue` | 可隐藏提示条（继承 `22045cc` 的 `[hidden]` 修复） |

### 4.5 路由

```ts
const routes = [
  { path: '/',          component: () => import('./pages/ConsolePage.vue') },  // 本次实现
  { path: '/channels',  component: () => import('./pages/ChannelsPage.vue') }, // 占位
  { path: '/settings',  component: () => import('./pages/SettingsPage.vue') }, // 占位
  { path: '/monitor',   component: () => import('./pages/MonitorPage.vue') },  // 占位
]
```

本次 `/` 唯一完整页面；其余 3 个为占位空页。导航条本次**不渲染**（单页 console，避免引入未实现的导航 UI）；等 channels/settings/monitor 任一立项时再加。

### 4.6 错误处理与降级

- IPC 不可用（外部浏览器打开）：store 降级态，UI 显示提示而非抛错。
- 全局错误边界：`App.vue` 用 `<ErrorBoundary>` 包裹 `<RouterView/>`，未捕获错误落到错误提示位。
- 加载态：`console_status` 首次拉取前 badge 显示"检测中…"。

## 5. 交付边界

### 5.1 本次交付（In Scope）

- Vite + Vue3 + TS 工程骨架（`src-tauri/console-app/`）
- 1:1 迁移现有 console 全部功能到 `ConsolePage.vue`
- 4 路由文件 + 3 个占位空页
- IPC 封装层（10 命令 + 6 事件，typed）
- 4 个 Pinia store + 8 个自写组件
- 构建链接入（`build-console.sh` / dmg / windows / CI）
- 删除 `src-tauri/console.html`
- `console-dist/` 改 gitignore + 源文件版本锚点对齐

### 5.2 不做（Out of Scope，后续各自立项）

- 多渠道管理页面实现
- 设置/配置面板实现
- 运行时监控可视化实现
- 版本检查/自动更新实现
- 导航条 UI（等占位页有内容再加）
- Tauri dev 模式 HMR 直连优化

## 6. 完成定义（DoD）

`cargo tauri dev` 加载新 console，以下行为与现状**逐项一致**：

1. 环境状态 badge 三态正确（检测中 → 就绪/未安装/不完整）
2. 服务启停按钮 disabled 逻辑 + 启停互斥（就绪态隐藏安装按钮，承接 `fb86ccf`）
3. bootstrap 进度条四阶段 + 渐近爬升 + 失败态停在中断位
4. 关闭二次确认 dialog + `console_confirm_close` 调用
5. 渠道 badge + 选择器 + 启动 + 安装渠道依赖（承接微信渠道逻辑）
6. 日志增量追加 + 自动滚底 + 清空 + 打开日志目录
7. hint banner 显隐（承接 `22045cc` 的 `[hidden]` 修复）
8. footer 版本号锚点 + `console-version.mjs --check` 通过

## 7. 测试策略

| 层 | 工具 | 范围 |
|---|---|---|
| 非平凡逻辑单测 | `vitest` | `bootstrap.ts` 进度条算法（单调不倒退、阶段基准、逼近 ceil）；`service.ts`/`env.ts` 状态转换 |
| IPC 封装单测 | `vitest` + mock `@tauri-apps/api` | 命令调用参数正确、事件 listen/unlisten cleanup |
| Rust 侧 | `cargo test`（现有） | 不改 Rust，现有测试全覆盖 |
| 端到端验证 | 手动 | DoD 8 项逐条在 `cargo tauri dev` 点验 |

组件渲染测试 YAGNI；`console-app/` 的 coverage 不强求。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Vite 产物体积 ↑（当前 72KB → Vue runtime + 应用代码） | gzip 后 Vue runtime ~30KB，可接受；构建后看体积报告，若 >200KB 再优化 |
| Tauri 内嵌资源路径（asset 必须相对路径） | `vite.config.ts` 设 `base: './'` |
| `console-dist/` 改 gitignore 后新 clone 无法直接跑桌面 | `assemble.sh` / `build-dmg.sh` / `build-windows.ps1` 均先调 `build-console.sh`；README 增补 |
| `withGlobalTauri: true` + `@tauri-apps/api` 共存 | api 包优先用注入的全局，兼容；`withGlobalTauri` 不动 |
| 迁移漏掉细微交互 | DoD 8 项逐条勾验，承接最近 5 次 console commit 修复 |

## 9. 后续新功能立项的接口预留

- 3 个占位路由（`channels`/`settings`/`monitor`，页面均为空）
- 2 个后续 store 骨架（`settings.ts`/`monitor.ts` 仅留空 setup，等对应页面立项时填充；`channels.ts` 本次已实现现有微信渠道逻辑，多渠道扩展时再追加内容）
- IPC 层 `commands.ts` 结构化，加新命令只需追加 wrapper
- `src/ipc/types.ts` 集中放 Rust 返回类型镜像
