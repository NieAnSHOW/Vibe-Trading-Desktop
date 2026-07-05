# 桌面控制台 Vite + Vue3 重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src-tauri/console-dist/index.html`（1023 行手工单文件 SPA）重构为 `src-tauri/console-app/` 下的 Vite + Vue3 + TS 工程，1:1 迁移全部现有功能，产物仍输出到 `console-dist/`，Tauri 配置零改动。

**Architecture:** Vite + Vue3 + TypeScript + Pinia + Vue Router + `@tauri-apps/api`。工程位于 `src-tauri/console-app/`，构建产物落到 `../console-dist/`（Tauri `frontendDist` 不变）。IPC 封装为类型安全的单一来源，4 个 Pinia store 映射现有状态域，8 个自写轻量组件复刻视觉，1:1 迁移到 `ConsolePage.vue`。零重型 UI 库。

**Tech Stack:** Vite 5, Vue 3.5, TypeScript 5, Pinia 2, Vue Router 4, `@tauri-apps/api` v2, vitest, @vue/test-utils, jsdom。

## Global Constraints

- **不改动 Rust 侧**：10 个 `console_*` 命令签名与 6 个事件名不变（见 spec 第 2 节契约表）。
- **不改动 `tauri.conf.json`**：`frontendDist: "./console-dist"` 保持；`withGlobalTauri: true` 保持；`beforeDevCommand` 保持跑 `frontend/`。
- **产物路径**：`console-app/vite.config.ts` 必须设 `build.outDir: '../console-dist'`、`emptyOutDir: true`、`base: './'`（Tauri 内嵌资源用相对路径）。
- **版本锚点**：`console-app/index.html` footer 必须含 `data-console-version="v0.1.0"`（当前版本）。
- **零重型 UI 库**：不引入 Element Plus / Naive UI 等；组件全部自写。
- **DCO/提交风格**：跟随仓库 gitmoji + 中文风格；个人 fork 不加 `Signed-off-by`。
- **测试范围**：仅对非平凡纯逻辑写单测（bootstrap 进度条算法、IPC 封装、store 状态转换）；组件渲染测试 YAGNI。
- **CSS 迁移**：从原 `console-dist/index.html` 第 7-490 行 `<style>` 整体复制到 `console-app/src/styles/console.css`，不改视觉。
- **dev 模式**：本次不动 `beforeDevCommand`；改 console 时手动 `cd src-tauri/console-app && npm run dev`（:5174），桌面 dev 仍加载 `console-dist/` 静态产物。

## File Structure

```
src-tauri/console-app/                    ← 新增工程
├── package.json                          ← 依赖与脚本
├── vite.config.ts                        ← outDir ../console-dist, base './'
├── tsconfig.json
├── tsconfig.node.json
├── index.html                            ← Vite 入口，footer 含版本锚点
├── src/
│   ├── main.ts                           ← createApp + router + pinia
│   ├── App.vue                           ← <RouterView/> + ErrorBoundary
│   ├── router.ts                         ← 4 路由
│   ├── ipc/
│   │   ├── types.ts                      ← Rust 返回类型镜像
│   │   ├── commands.ts                   ← 10 命令 typed wrapper
│   │   └── events.ts                     ← 6 事件 typed listen
│   ├── stores/
│   │   ├── env.ts                        ← envBadge 三态 + port
│   │   ├── service.ts                    ← svcBadge + 启停 + service://started
│   │   ├── bootstrap.ts                  ← 进度条状态机（算法原样搬）
│   │   └── channels.ts                   ← channel badge 状态机
│   ├── components/
│   │   ├── StatusBadge.vue
│   │   ├── AppButton.vue
│   │   ├── ProgressBar.vue
│   │   ├── LogViewer.vue
│   │   ├── ConfirmDialog.vue
│   │   ├── ChannelSelect.vue             ← 当前无消费者，为多渠道扩展预留
│   │   ├── VersionFooter.vue
│   │   └── HintBanner.vue
│   ├── composables/
│   │   └── useBusy.ts                    ← 按钮 busy 态（替代原 busy()）
│   ├── pages/
│   │   ├── ConsolePage.vue               ← 1:1 迁移现有功能
│   │   ├── ChannelsPage.vue              ← 占位
│   │   ├── SettingsPage.vue              ← 占位
│   │   └── MonitorPage.vue               ← 占位
│   └── styles/
│       └── console.css                   ← 从原 index.html 7-490 行迁移

scripts/desktop/build-console.sh          ← 新增构建脚本
scripts/desktop/console-version.mjs       ← 改 INDEX_PATH 指向 source
scripts/desktop/build-dmg.sh              ← assemble 前调 build-console.sh
scripts/desktop/build-windows.ps1         ← 同上
.github/workflows/desktop-build.yml       ← CI 加 build-console.sh
.gitignore                                ← console-dist/ 改忽略

删除：
src-tauri/console.html                    ← 旧版（迁移完成后删）
src-tauri/console-dist/index.html         ← 产物（gitignore 后由 build 生成）
```

---

### Task 1: Vite + Vue3 + TS 工程骨架 + 构建链跑通

**Files:**
- Create: `src-tauri/console-app/package.json`
- Create: `src-tauri/console-app/vite.config.ts`
- Create: `src-tauri/console-app/tsconfig.json`
- Create: `src-tauri/console-app/tsconfig.node.json`
- Create: `src-tauri/console-app/index.html`
- Create: `src-tauri/console-app/src/main.ts`
- Create: `src-tauri/console-app/src/App.vue`
- Create: `src-tauri/console-app/.gitignore`

**Interfaces:**
- Produces: 一个能 `npm run build` 出 `../console-dist/index.html` 的最小 Vue 工程；后续任务在此基础上填充。

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "vibe-trading-console",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.1.1",
    "pinia": "^2.2.6",
    "vue": "^3.5.13",
    "vue-router": "^4.4.5"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "@vue/test-utils": "^2.4.6",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.8",
    "vue-tsc": "^2.1.10"
  }
}
```

- [ ] **Step 2: 创建 `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 产物输出到 ../console-dist，Tauri frontendDist 不变即可加载。
// base: './' 保证 Tauri 内嵌时用相对路径加载 JS/CSS。
export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    outDir: "../console-dist",
    emptyOutDir: true,
    target: "es2020",
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

- [ ] **Step 3: 创建 `tsconfig.json` 与 `tsconfig.node.json`**

`tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`tsconfig.node.json`：
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: 创建 `src/main.ts` 与 `src/App.vue`（最小空壳）**

`src/main.ts`：
```ts
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

`src/App.vue`：
```vue
<script setup lang="ts"></script>

<template>
  <div class="console-skeleton">控制台重构中…</div>
</template>

<style>
.console-skeleton {
  padding: 32px;
  font-family: -apple-system, "PingFang SC", sans-serif;
  color: #e6e6e6;
  background: #0e0f13;
  min-height: 100vh;
}
</style>
```

- [ ] **Step 5: 创建 `index.html`（含版本锚点）**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vibe Trading 控制台</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
    <footer
      class="console-version"
      data-console-version="v0.1.0"
    ></footer>
  </body>
</html>
```

- [ ] **Step 6: 创建 `.gitignore`**

```
node_modules/
dist/
*.local
```

- [ ] **Step 7: 安装依赖并构建**

Run:
```bash
cd src-tauri/console-app && npm install && npm run build
```
Expected: 构建成功，`src-tauri/console-dist/index.html` 被生成（含 `<div id="app">` 和指向 `./assets/` 的 script/link）。

- [ ] **Step 8: 验证 Tauri 仍能加载（不跑桌面，只查产物结构）**

Run:
```bash
ls -la src-tauri/console-dist/ && head -20 src-tauri/console-dist/index.html
```
Expected: `index.html` + `assets/` 目录存在；HTML 引用相对路径 `./assets/`。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/console-app && git commit -m "✨ feat(console): 初始化 Vite+Vue3+TS 工程骨架

- src-tauri/console-app/ 最小 Vue 工程, 产物输出 console-dist/
- base: './' 保证 Tauri 内嵌相对路径加载
- footer 保留 data-console-version 锚点"
```

---

### Task 2: IPC 封装层（types + commands + events）+ 单测

**Files:**
- Create: `src-tauri/console-app/src/ipc/types.ts`
- Create: `src-tauri/console-app/src/ipc/commands.ts`
- Create: `src-tauri/console-app/src/ipc/events.ts`
- Test: `src-tauri/console-app/src/ipc/__tests__/commands.test.ts`
- Test: `src-tauri/console-app/src/ipc/__tests__/events.test.ts`

**Interfaces:**
- Consumes: `@tauri-apps/api` 的 `invoke`（`@tauri-apps/api/core`）与 `listen`（`@tauri-apps/api/event`）。
- Produces:
  - `types.ts`: `StatusReport`, `EnvState`, `BootstrapEvent`, `ChannelStatus`, `ChannelInfo`
  - `commands.ts`: `consoleStatus()`, `consoleBootstrap()`, `consoleStartService()`, `consoleStopService()`, `consoleOpenWebui(port)`, `consoleOpenLogs()`, `consoleStartChannels(port)`, `consoleChannelsStatus(port)`, `consoleInstallChannelDep(channel)`, `consoleConfirmClose()`
  - `events.ts`: `onBootstrapEvent(cb)`, `onBootstrapExit(cb)`, `onServiceStarted(cb)`, `onCloseRequested(cb)`, `onChanneldepProgress(cb)`, `onChanneldepExit(cb)`（均返回 `Promise<UnlistenFn>`）

- [ ] **Step 1: 写 `types.ts`（Rust 返回类型镜像）**

```ts
// 镜像 src-tauri/src/console.rs 的 StatusReport 与事件 payload 结构。

export type EnvState = "ready" | "incomplete" | "not_installed";

export interface StatusReport {
  env: EnvState;
  service_running: boolean;
  port: number | null;
}

export type BootstrapStage =
  | "venv"
  | "installing"
  | "smoke"
  | "done"
  | "failed";

export interface BootstrapEvent {
  stage: BootstrapStage;
  message?: string;
  ok?: boolean;
}

export interface ChannelInfo {
  enabled?: boolean;
  loaded?: boolean;
  running?: boolean;
  health?: "ok" | "expired" | string;
}

export interface ChannelStatus {
  channels?: Record<string, ChannelInfo>;
}
```

- [ ] **Step 2: 写失败测试 `commands.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core 的 invoke
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  consoleStatus,
  consoleBootstrap,
  consoleStartService,
  consoleOpenWebui,
  consoleChannelsStatus,
  consoleInstallChannelDep,
} from "../commands";

describe("ipc/commands", () => {
  beforeEach(() => invokeMock.mockReset());

  it("consoleStatus 调用 invoke 且无参数", async () => {
    invokeMock.mockResolvedValue({ env: "ready", service_running: false, port: null });
    const r = await consoleStatus();
    expect(invokeMock).toHaveBeenCalledWith("console_status", undefined);
    expect(r.env).toBe("ready");
  });

  it("consoleOpenWebui 透传 port 参数", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleOpenWebui(8899);
    expect(invokeMock).toHaveBeenCalledWith("console_open_webui", { port: 8899 });
  });

  it("consoleChannelsStatus 透传 port", async () => {
    invokeMock.mockResolvedValue('{"channels":{}}');
    await consoleChannelsStatus(8899);
    expect(invokeMock).toHaveBeenCalledWith("console_channels_status", { port: 8899 });
  });

  it("consoleInstallChannelDep 透传 channel", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleInstallChannelDep("weixin");
    expect(invokeMock).toHaveBeenCalledWith("console_install_channel_dep", { channel: "weixin" });
  });

  it("consoleBootstrap 调用命令名", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleBootstrap();
    expect(invokeMock).toHaveBeenCalledWith("console_bootstrap", undefined);
  });

  it("consoleStartService 返回 port", async () => {
    invokeMock.mockResolvedValue(8899);
    const port = await consoleStartService();
    expect(port).toBe(8899);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run:
```bash
cd src-tauri/console-app && npx vitest run src/ipc/__tests__/commands.test.ts
```
Expected: FAIL（`Failed to resolve import "../commands"`）。

- [ ] **Step 4: 实现 `commands.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { StatusReport } from "./types";

// 与 src-tauri/src/console.rs 的 #[tauri::command] 一一对应。
// 所有命令透传 invoke;Rust 侧 camelCase ↔ snake_case 由 Tauri 自动转换。

export const consoleStatus = (): Promise<StatusReport> =>
  invoke<StatusReport>("console_status");

export const consoleBootstrap = (): Promise<void> =>
  invoke<void>("console_bootstrap");

export const consoleStartService = (): Promise<number> =>
  invoke<number>("console_start_service");

export const consoleStopService = (): Promise<void> =>
  invoke<void>("console_stop_service");

export const consoleOpenWebui = (port: number): Promise<void> =>
  invoke<void>("console_open_webui", { port });

export const consoleOpenLogs = (): Promise<void> =>
  invoke<void>("console_open_logs");

export const consoleStartChannels = (port: number): Promise<string> =>
  invoke<string>("console_start_channels", { port });

export const consoleChannelsStatus = (port: number): Promise<string> =>
  invoke<string>("console_channels_status", { port });

export const consoleInstallChannelDep = (channel: string): Promise<void> =>
  invoke<void>("console_install_channel_dep", { channel });

export const consoleConfirmClose = (): Promise<void> =>
  invoke<void>("console_confirm_close");
```

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
cd src-tauri/console-app && npx vitest run src/ipc/__tests__/commands.test.ts
```
Expected: PASS（6 个测试全过）。

- [ ] **Step 6: 写 `events.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { onBootstrapEvent, onServiceStarted, onCloseRequested } from "../events";

describe("ipc/events", () => {
  it("onBootstrapEvent 注册 bootstrap://event 并返回 unlisten", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onBootstrapEvent(cb);
    expect(listenMock).toHaveBeenCalledWith("bootstrap://event", expect.any(Function));
    expect(result).toBe(unlisten);
  });

  it("onServiceStarted 注册 service://started", async () => {
    listenMock.mockResolvedValue(vi.fn());
    await onServiceStarted(vi.fn());
    expect(listenMock).toHaveBeenCalledWith("service://started", expect.any(Function));
  });

  it("onCloseRequested 注册 app://close-requested", async () => {
    listenMock.mockResolvedValue(vi.fn());
    await onCloseRequested(vi.fn());
    expect(listenMock).toHaveBeenCalledWith("app://close-requested", expect.any(Function));
  });
});
```

- [ ] **Step 7: 实现 `events.ts`**

```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BootstrapEvent } from "./types";

// 6 个事件的 typed wrapper,每个返回 unlisten,由调用方在 onUnmounted 时清理。

export const onBootstrapEvent = (cb: (e: BootstrapEvent) => void): Promise<UnlistenFn> =>
  listen<BootstrapEvent>("bootstrap://event", (ev) => cb(ev.payload));

export const onBootstrapExit = (cb: (code: number) => void): Promise<UnlistenFn> =>
  listen<number>("bootstrap://exit", (ev) => cb(ev.payload));

export const onServiceStarted = (cb: (port: number) => void): Promise<UnlistenFn> =>
  listen<number>("service://started", (ev) => cb(ev.payload));

export const onCloseRequested = (
  cb: (payload: { installing?: boolean } | unknown) => void,
): Promise<UnlistenFn> =>
  listen("app://close-requested", (ev) => cb(ev.payload));

export const onChanneldepProgress = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>("channeldep://progress", (ev) => cb(ev.payload));

export const onChanneldepExit = (cb: (code: number) => void): Promise<UnlistenFn> =>
  listen<number>("channeldep://exit", (ev) => cb(ev.payload));
```

- [ ] **Step 8: 跑全部 IPC 测试**

Run:
```bash
cd src-tauri/console-app && npx vitest run src/ipc/
```
Expected: PASS（commands 6 + events 3 = 9 个测试）。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/console-app/src/ipc && git commit -m "✨ feat(console): IPC 封装层(10 命令 + 6 事件, typed)

- commands.ts/types.ts/events.ts 单一来源
- vitest 单测覆盖参数透传与事件注册"
```

---

### Task 3: Pinia stores + bootstrap 进度条算法 TDD

**Files:**
- Create: `src-tauri/console-app/src/stores/bootstrap.ts`
- Create: `src-tauri/console-app/src/stores/env.ts`
- Create: `src-tauri/console-app/src/stores/service.ts`
- Create: `src-tauri/console-app/src/stores/channels.ts`
- Test: `src-tauri/console-app/src/stores/__tests__/bootstrap.test.ts`

**Interfaces:**
- Consumes: `src/ipc/commands.ts`、`src/ipc/events.ts`、`src/ipc/types.ts`
- Produces:
  - `bootstrap` store: state `pct: number`, `stageLabel: string`, `spinning: boolean`, `state: 'idle'|'running'|'done'|'failed'`, `visible: boolean`; actions `start()`, `advance(stage, message)`, `reset()`
  - `env` store: state `env: EnvState | null`, `port: number | null`, `loading: boolean`; actions `refresh()`, `setPort(port)`
  - `service` store: state `running: boolean`; actions `start()`, `stop()`, `setRunning(b)`
  - `channels` store: state `info: ChannelInfo | null`, `text: string`, `cls: string`; actions `refresh(port, serviceRunning)`

- [ ] **Step 1: 写失败测试 `bootstrap.test.ts`（进度条算法核心）**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useBootstrapStore } from "../bootstrap";

describe("bootstrap store 进度条算法", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("start() 后进入 running 态,百分比从低起点开始", () => {
    const s = useBootstrapStore();
    s.start();
    expect(s.state).toBe("running");
    expect(s.visible).toBe(true);
    expect(s.pct).toBeGreaterThanOrEqual(1);
    expect(s.pct).toBeLessThan(15);
  });

  it("advance('venv') 跳到 venv 阶段基准 5-15", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("venv", "创建虚拟环境");
    expect(s.pct).toBeGreaterThanOrEqual(5);
    expect(s.pct).toBeLessThanOrEqual(15);
    expect(s.stageLabel).toBe("创建虚拟环境");
  });

  it("advance('installing') 渐近爬升且单调不倒退", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "downloading a");
    const p1 = s.pct;
    s.advance("installing", "downloading b");
    const p2 = s.pct;
    s.advance("installing", "downloading c");
    const p3 = s.pct;
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
    // 永不到 100%
    expect(s3_pct_max(s, 50)).toBeLessThan(92);
  });

  it("advance('done') 直接到 100%", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("done", "安装完成");
    expect(s.pct).toBe(100);
    expect(s.state).toBe("done");
    expect(s.spinning).toBe(false);
  });

  it("advance('failed') 停在当前百分比,标记失败", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "x");
    const midPct = s.pct;
    s.advance("failed", "");
    expect(s.state).toBe("failed");
    expect(s.pct).toBe(midPct); // 不强推 100
  });

  it("百分比单调不倒退:smaller 输入不会回退", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "a");
    const high = s.pct;
    // 模拟后退输入(stage 回到 venv 的低基准不应让 pct 倒退)
    s.advance("venv", "重新创建");
    expect(s.pct).toBeGreaterThanOrEqual(high);
  });
});

// helper:推 N 次 installing,返回最大 pct
function s3_pct_max(s: ReturnType<typeof useBootstrapStore>, n: number): number {
  for (let i = 0; i < n; i++) s.advance("installing", "x");
  return s.pct;
}
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd src-tauri/console-app && npx vitest run src/stores/__tests__/bootstrap.test.ts
```
Expected: FAIL（`useBootstrapStore` 不存在）。

- [ ] **Step 3: 实现 `stores/bootstrap.ts`（算法原样搬自原 index.html）**

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import type { BootstrapStage } from "../ipc/types";

// 算法原样搬自 console-dist/index.html 的 STAGE 表 + advanceProgress:
// venv/installing/smoke/done/failed 五阶段;installing 期间渐近逼近 ceil(92),
// 每步行走「剩余距离」的 6%,越接近越慢,永不倒退、永不到 100%。

interface StageDef {
  base: number;
  ceil: number;
  label: string;
}

const STAGE: Record<BootstrapStage, StageDef> = {
  venv: { base: 5, ceil: 15, label: "创建虚拟环境" },
  installing: { base: 15, ceil: 92, label: "安装依赖包" },
  smoke: { base: 93, ceil: 98, label: "校验关键依赖" },
  done: { base: 100, ceil: 100, label: "安装完成" },
  failed: { base: 100, ceil: 100, label: "安装失败" },
};

export const useBootstrapStore = defineStore("bootstrap", () => {
  const pct = ref(0);
  const stageLabel = ref("准备中…");
  const spinning = ref(false);
  const state = ref<"idle" | "running" | "done" | "failed">("idle");
  const visible = ref(false);

  function setProgress(nextPct: number, label: string, spin: boolean) {
    // 单调不倒退:取 max(当前, 新值),并 clamp 到 [0,100]。
    pct.value = Math.max(pct.value, Math.min(100, nextPct));
    stageLabel.value = label;
    spinning.value = spin;
  }

  function start() {
    pct.value = 0;
    visible.value = true;
    state.value = "running";
    setProgress(2, "准备中…", true);
  }

  function advance(stage: BootstrapStage, message: string) {
    const s = STAGE[stage];
    if (!s) return;
    if (stage === "installing") {
      // 渐近逼近 ceil:每步行剩余距离的 6%,越接近越慢。
      const target = s.ceil;
      const next = pct.value + (target - pct.value) * 0.06;
      setProgress(Math.max(next, s.base), message ? s.label : stageLabel.value, true);
      if (message) stageLabel.value = message;
    } else if (stage === "done") {
      state.value = "done";
      setProgress(100, s.label, false);
    } else if (stage === "failed") {
      state.value = "failed";
      // 失败时停在当前百分比,不强推 100。
      setProgress(pct.value, s.label, false);
    } else {
      // venv / smoke:直接跳到该阶段基准(但受单调约束)。
      setProgress(s.base, s.label, true);
    }
  }

  function reset() {
    pct.value = 0;
    stageLabel.value = "准备中…";
    spinning.value = false;
    state.value = "idle";
    visible.value = false;
  }

  return { pct, stageLabel, spinning, state, visible, start, advance, reset };
});
```

- [ ] **Step 4: 跑 bootstrap 测试确认通过**

Run:
```bash
cd src-tauri/console-app && npx vitest run src/stores/__tests__/bootstrap.test.ts
```
Expected: PASS（6 个测试全过）。

> **注意**：若"单调不倒退"测试失败，检查 `setProgress` 的 `Math.max(pct.value, ...)` 是否在所有分支生效；`venv` 分支也不应让 pct 倒退。

- [ ] **Step 5: 实现 `stores/env.ts`**

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { consoleStatus } from "../ipc/commands";
import type { EnvState } from "../ipc/types";

export const useEnvStore = defineStore("env", () => {
  const env = ref<EnvState | null>(null);
  const port = ref<number | null>(null);
  const serviceRunning = ref(false);
  const loading = ref(true);
  const error = ref<string>("");

  async function refresh() {
    loading.value = true;
    try {
      const s = await consoleStatus();
      env.value = s.env;
      serviceRunning.value = s.service_running;
      // port 由 service://started 事件或 startService 返回值设置,此处不覆盖已就绪的 port。
      if (s.port != null) port.value = s.port;
      error.value = "";
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  function setPort(p: number | null) {
    port.value = p;
  }

  return { env, port, serviceRunning, loading, error, refresh, setPort };
});
```

- [ ] **Step 6: 实现 `stores/service.ts`**

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  consoleStartService,
  consoleStopService,
  consoleOpenWebui,
} from "../ipc/commands";

export const useServiceStore = defineStore("service", () => {
  const running = ref(false);

  function setRunning(b: boolean) {
    running.value = b;
  }

  async function start() {
    // 返回 port;调用方负责 setPort 与自动打开 WebUI。
    const port = await consoleStartService();
    running.value = true;
    await consoleOpenWebui(port);
    return port;
  }

  async function stop() {
    await consoleStopService();
    running.value = false;
  }

  return { running, setRunning, start, stop };
});
```

- [ ] **Step 7: 实现 `stores/channels.ts`（渠道 badge 状态机，搬自 renderCh）**

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { consoleChannelsStatus } from "../ipc/commands";
import type { ChannelInfo, ChannelStatus } from "../ipc/types";

// 状态机搬自 console-dist/index.html 的 renderCh:
// expired → bad live "登录失效";running → ok live "运行中";
// enabled/loaded → warn "未登录";else → warn "未启用";服务未运行 → warn "未运行"。

export const useChannelsStore = defineStore("channels", () => {
  const info = ref<ChannelInfo | null>(null);
  const text = ref("未运行");
  const cls = ref("warn");
  const live = ref(false);

  function render(wx: ChannelInfo | null) {
    info.value = wx;
    live.value = false;
    if (!wx) {
      text.value = "未运行";
      cls.value = "warn";
      return;
    }
    if (wx.health === "expired") {
      cls.value = "bad"; live.value = true; text.value = "登录失效 · 需重新扫码";
    } else if (wx.running) {
      cls.value = "ok"; live.value = true; text.value = "运行中";
    } else if (wx.enabled || wx.loaded) {
      cls.value = "warn"; text.value = "未登录";
    } else {
      cls.value = "warn"; text.value = "未启用";
    }
  }

  async function refresh(port: number | null, serviceRunning: boolean) {
    if (!serviceRunning || port == null) {
      render(null);
      return;
    }
    try {
      const raw = await consoleChannelsStatus(port);
      const data: ChannelStatus = JSON.parse(raw);
      render(data.channels?.weixin ?? null);
    } catch {
      render(null);
    }
  }

  return { info, text, cls, live, render, refresh };
});
```

- [ ] **Step 8: 跑全部测试确认无回归**

Run:
```bash
cd src-tauri/console-app && npx vitest run
```
Expected: PASS（IPC 9 + bootstrap 6 = 15 个测试）。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/console-app/src/stores && git commit -m "✨ feat(console): Pinia stores(env/service/bootstrap/channels)

- bootstrap 进度条算法(渐近爬升+单调不倒退)原样迁移并配 TDD 单测
- channels badge 状态机搬自 renderCh
- env/service 调用 IPC 命令"
```

---

### Task 4: 自写组件（8 个）

**Files:**
- Create: `src-tauri/console-app/src/components/StatusBadge.vue`
- Create: `src-tauri/console-app/src/components/AppButton.vue`
- Create: `src-tauri/console-app/src/components/ProgressBar.vue`
- Create: `src-tauri/console-app/src/components/LogViewer.vue`
- Create: `src-tauri/console-app/src/components/ConfirmDialog.vue`
- Create: `src-tauri/console-app/src/components/ChannelSelect.vue`
- Create: `src-tauri/console-app/src/components/VersionFooter.vue`
- Create: `src-tauri/console-app/src/components/HintBanner.vue`
- Create: `src-tauri/console-app/src/composables/useBusy.ts`

**Interfaces:**
- Consumes: `bootstrap`/`env`/`service`/`channels` stores
- Produces: 8 个 Vue SFC 组件 + `useBusy` 组合式函数（返回 `{ busy: Ref<boolean>, label: Ref<string>, run: (label, fn) => Promise }`）

> 组件复刻现有视觉（CSS 类名与原 `console-dist/index.html` 一致，供 Task 5 的全局 `console.css` 接管样式）。组件不写渲染测试（YAGNI）。

- [ ] **Step 1: 实现 `composables/useBusy.ts`（替代原 busy() 函数）**

```ts
import { ref } from "vue";

// 替代原 index.html 的 busy(btn, label, fn):按钮 busy 态期间
// 显示 spinner + label 并禁用;完成或失败后恢复。
export function useBusy() {
  const busy = ref(false);
  const label = ref("");

  async function run<T>(busyLabel: string, fn: () => Promise<T>): Promise<T | undefined> {
    busy.value = true;
    label.value = busyLabel;
    try {
      return await fn();
    } finally {
      busy.value = false;
      label.value = "";
    }
  }

  return { busy, label, run };
}
```

- [ ] **Step 2: 实现 `StatusBadge.vue`**

```vue
<script setup lang="ts">
// cls: "ok" | "warn" | "bad";live 控制是否加呼吸动画类。
defineProps<{ cls: string; text: string; live?: boolean }>();
</script>

<template>
  <span class="badge" :class="[cls, { live }]">
    <span class="dot"></span>{{ text }}
  </span>
</template>
```

- [ ] **Step 3: 实现 `AppButton.vue`**

```vue
<script setup lang="ts">
// variant: primary | ghost | danger;busy 期间显示 spinner + busyLabel。
const props = defineProps<{
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}>();
const cls = () => `btn-${props.variant ?? "primary"}`;
</script>

<template>
  <button
    :class="[cls(), { busy: busy }]"
    :disabled="disabled || busy"
    @click="$emit('click')"
  >
    <template v-if="busy">
      <span class="spinner"></span>{{ busyLabel }}
    </template>
    <slot v-else />
  </button>
</template>
```

- [ ] **Step 4: 实现 `ProgressBar.vue`（绑定 bootstrap store）**

```vue
<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useBootstrapStore } from "../stores/bootstrap";

const bootstrap = useBootstrapStore();
const { pct, stageLabel, spinning, state, visible } = storeToRefs(bootstrap);
</script>

<template>
  <div v-if="visible" id="progress" :class="{ done: state === 'done', failed: state === 'failed' }">
    <div class="progress-meta">
      <span class="progress-stage">
        <span v-if="spinning" class="spinner"></span>{{ stageLabel }}
      </span>
      <span class="progress-pct">{{ state === "failed" ? "已中断" : Math.round(pct) + "%" }}</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" :style="{ width: pct + '%' }"></div>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 实现 `LogViewer.vue`**

```vue
<script setup lang="ts">
import { ref, watch, nextTick } from "vue";

const lines = ref<string[]>([]);
const el = ref<HTMLDivElement | null>(null);

function append(line: string) {
  const atBottom =
    el.value && el.value.scrollHeight - el.value.scrollTop - el.value.clientHeight < 40;
  lines.value.push(line);
  if (atBottom) nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight; });
}
function clear() {
  lines.value = [];
}

defineExpose({ append, clear });
</script>

<template>
  <div>
    <div class="log-head">
      <span class="log-title">运行日志</span>
      <div>
        <button class="log-clear" @click="$emit('open-logs')">打开日志目录</button>
        <button class="log-clear" type="button" @click="clear">清空</button>
      </div>
    </div>
    <div
      id="log"
      ref="el"
      role="log"
      aria-live="polite"
      :class="{ empty: lines.length === 0 }"
    >
      <template v-if="lines.length">
        <span v-for="(l, i) in lines" :key="i">{{ l }}<br /></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 占位符样式由全局 console.css 接管;此处仅保留 empty 伪元素的兜底。 */
#log.empty::after {
  content: "等待操作输出…";
  color: hsl(0 0% 60% / 0.55);
}
</style>
```

- [ ] **Step 6: 实现 `ConfirmDialog.vue`（基于 `<dialog>`）**

```vue
<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ (e: "close", value: "ok" | "cancel"): void }>();
const dlg = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (o) => {
    if (o && dlg.value && !dlg.value.open) dlg.value.showModal();
    if (!o && dlg.value && dlg.value.open) dlg.value.close();
  },
);

function onClose() {
  emit("close", (dlg.value?.returnValue as "ok" | "cancel") ?? "cancel");
}
</script>

<template>
  <dialog ref="dlg" class="confirm" @close="onClose">
    <form method="dialog">
      <h3>{{ title }}</h3>
      <p v-html="$slots.default ? '' : ''">
        <slot />
      </p>
      <div class="confirm-actions">
        <button value="cancel" class="btn-ghost">取消</button>
        <button value="ok" class="btn-danger" type="submit">
          <slot name="confirm-text">确认</slot>
        </button>
      </div>
    </form>
  </dialog>
</template>
```

- [ ] **Step 7: 实现 `HintBanner.vue`（继承 `[hidden]` 修复）**

```vue
<script setup lang="ts">
defineProps<{ hidden: boolean; text?: string }>();
</script>

<template>
  <div id="hint" class="hint" :hidden="hidden">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
    <span>{{ text ?? "首次安装可能需要 5 - 20 分钟，保证良好网络，请勿安装时退出" }}</span>
  </div>
</template>
```

- [ ] **Step 8: 实现 `ChannelSelect.vue`（当前无消费者，多渠道扩展预留）**

```vue
<script setup lang="ts">
defineProps<{ modelValue: string }>();
defineEmits<{ (e: "update:modelValue", v: string): void }>();
const OPTIONS = ["weixin", "wecom", "telegram", "slack", "discord", "qq", "napcat", "feishu", "dingtalk"];
</script>

<template>
  <select
    class="channel-select"
    aria-label="消息渠道"
    :value="modelValue"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="o in OPTIONS" :key="o" :value="o">{{ o }}</option>
  </select>
</template>
```

- [ ] **Step 9: 实现 `VersionFooter.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";

// 读 index.html footer 的 data-console-version 锚点(由 console-version.mjs 维护)。
const version = ref("");
onMounted(() => {
  const el = document.querySelector<HTMLDivElement>(".console-version");
  version.value = el?.dataset.consoleVersion ?? "";
});
</script>

<template>
  <footer v-if="version" class="console-version-text">控制台 {{ version }}</footer>
</template>
```

- [ ] **Step 10: 构建确认组件编译通过**

Run:
```bash
cd src-tauri/console-app && npm run build
```
Expected: `vue-tsc --noEmit` 与 `vite build` 均成功，无类型错误。

- [ ] **Step 11: Commit**

```bash
git add src-tauri/console-app/src/components src-tauri/console-app/src/composables && git commit -m "✨ feat(console): 8 个自写组件 + useBusy 组合式

- StatusBadge/AppButton/ProgressBar/LogViewer/ConfirmDialog/HintBanner/ChannelSelect/VersionFooter
- 复刻现有视觉(类名交由全局 console.css)
- ChannelSelect 当前无消费者,为多渠道扩展预留"
```

---

### Task 5: ConsolePage.vue 1:1 迁移 + 占位路由 + CSS + 错误边界

**Files:**
- Create: `src-tauri/console-app/src/styles/console.css`
- Create: `src-tauri/console-app/src/pages/ConsolePage.vue`
- Create: `src-tauri/console-app/src/pages/ChannelsPage.vue`
- Create: `src-tauri/console-app/src/pages/SettingsPage.vue`
- Create: `src-tauri/console-app/src/pages/MonitorPage.vue`
- Create: `src-tauri/console-app/src/router.ts`
- Modify: `src-tauri/console-app/src/App.vue`
- Modify: `src-tauri/console-app/src/main.ts`

**Interfaces:**
- Consumes: Task 2 IPC 层、Task 3 stores、Task 4 组件
- Produces: 4 路由 + ConsolePage 完整功能 + 全局 CSS + ErrorBoundary

- [ ] **Step 1: 迁移 CSS**

把 `src-tauri/console-dist/index.html`（迁移前的原文件，若已被 Task 1 覆盖，从 git 取：`git show HEAD~N:src-tauri/console-dist/index.html`）第 7-490 行 `<style>...</style>` 内的全部 CSS，整体复制到 `src-tauri/console-app/src/styles/console.css`，**不做任何修改**。

补充以下 3 条规则到 `console.css` 末尾（Vue 重构新增）：

```css
/* Vue 重构新增:确认 dialog 的 v-html slot 兜底、版本号文本、log 空态 */
.hint[hidden] { display: none !important; }
.console-version-text {
  margin-top: 18px; text-align: center; font-size: 11px;
  letter-spacing: 0.02em; color: hsl(0 0% 60% / 0.6);
}
```

> 注：`#log` 的 `:empty::after` 已在 `LogViewer.vue` scoped 兜底；全局 `console.css` 不再重复。

- [ ] **Step 2: 写 `pages/ConsolePage.vue`（核心迁移）**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { storeToRefs } from "pinia";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBootstrapStore } from "../stores/bootstrap";
import { useChannelsStore } from "../stores/channels";

import {
  consoleBootstrap,
  consoleOpenWebui,
  consoleOpenLogs,
  consoleConfirmClose,
} from "../ipc/commands";
import {
  onBootstrapEvent,
  onBootstrapExit,
  onServiceStarted,
  onCloseRequested,
  onChanneldepProgress,
  onChanneldepExit,
} from "../ipc/events";
import type { BootstrapEvent } from "../ipc/types";

import StatusBadge from "../components/StatusBadge.vue";
import AppButton from "../components/AppButton.vue";
import ProgressBar from "../components/ProgressBar.vue";
import LogViewer from "../components/LogViewer.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import HintBanner from "../components/HintBanner.vue";
import VersionFooter from "../components/VersionFooter.vue";
import { useBusy } from "../composables/useBusy";

const env = useEnvStore();
const service = useServiceStore();
const bootstrap = useBootstrapStore();
const channels = useChannelsStore();

const { env: envState, port, serviceRunning } = storeToRefs(env);
const { running } = storeToRefs(service);

const logViewer = ref<InstanceType<typeof LogViewer> | null>(null);
const errorMsg = ref("");

function log(line: string) {
  logViewer.value?.append(line);
}
function setErr(m: unknown) {
  errorMsg.value = m ? String(m) : "";
}

// ── ENV/SVC 渲染(搬自 renderEnv/renderSvc) ──────────────────────
const ENV_MAP = {
  ready: { txt: "就绪", cls: "ok" },
  incomplete: { txt: "依赖不全", cls: "warn" },
  not_installed: { txt: "未安装", cls: "bad" },
} as const;

const envBadge = computed(() => {
  if (!envState.value) return { txt: "检测中", cls: "warn" };
  return ENV_MAP[envState.value] ?? { txt: "未知", cls: "warn" };
});

// busy 期间不覆盖按钮态(交由 useBusy 的 busy ref 接管 disabled)。
const installBusy = useBusy();
const startBusy = useBusy();
const stopBusy = useBusy();

const showInstallBtn = computed(
  () => envState.value !== "ready" && !installBusy.busy.value,
);
const showStartBtn = computed(
  () => serviceRunning.value === false && !startBusy.busy.value,
);
const showStopBtn = computed(
  () => serviceRunning.value === true && !stopBusy.busy.value,
);
const btnStartDisabled = computed(
  () => envState.value !== "ready" || port.value !== null || startBusy.busy.value,
);

// ── 安装 ────────────────────────────────────────────────────────
async function onInstall() {
  await installBusy.run("安装中", async () => {
    setErr("");
    log("开始安装依赖…");
    bootstrap.start();
    try {
      await consoleBootstrap();
    } catch (e) {
      setErr(e);
      bootstrap.advance("failed", "");
    }
  });
}

// ── 启动服务 ────────────────────────────────────────────────────
async function onStart() {
  await startBusy.run("启动中", async () => {
    setErr("");
    try {
      const p = await service.start();
      env.setPort(p);
      hintHidden.value = true;
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 停止服务(二次确认) ──────────────────────────────────────────
const stopDialogOpen = ref(false);
function onStop() {
  stopDialogOpen.value = true;
}
async function onStopDialogClose(v: "ok" | "cancel") {
  stopDialogOpen.value = false;
  if (v !== "ok") return;
  await stopBusy.run("停止中", async () => {
    try {
      await service.stop();
      env.setPort(null);
      await refresh();
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 打开 WebUI / 日志 ───────────────────────────────────────────
async function onOpenWebui() {
  if (port.value == null) return;
  try {
    await consoleOpenWebui(port.value);
  } catch (e) {
    setErr(e);
  }
}
async function onOpenLogs() {
  try {
    await consoleOpenLogs();
  } catch (e) {
    setErr(e);
  }
}

// ── 关闭二次确认 ────────────────────────────────────────────────
const closeDialogOpen = ref(false);
const closeInstalling = ref(false);
const closeText = computed(() =>
  closeInstalling.value
    ? '依赖仍在安装中，<b>关闭客户端将中断安装</b>，下次需要重新安装。确认要关闭吗？'
    : '后端服务仍在运行，<b>关闭客户端将终止服务并中断正在执行的任务</b>（回测、研究、实盘等）。确认要关闭吗？',
);
async function onCloseDialogClose(v: "ok" | "cancel") {
  closeDialogOpen.value = false;
  if (v !== "ok") return;
  try {
    await consoleConfirmClose();
    const win = (window as any).__TAURI__?.window?.getCurrentWindow?.();
    if (win) await win.close();
  } catch (e) {
    setErr(e);
  }
}

// ── hint 显隐 ───────────────────────────────────────────────────
const hintHidden = ref(false);

// ── 刷新(轮询) ──────────────────────────────────────────────────
async function refresh() {
  await env.refresh();
  // 渲染依赖 envState/serviceRunning 的 computed 自动更新。
  hintHidden.value = envState.value === "ready" || serviceRunning.value;
  await channels.refresh(port.value, serviceRunning.value);
  setErr("");
}

// ── 事件监听(生命周期内) ────────────────────────────────────────
let unlistens: UnlistenFn[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  unlistens = await Promise.all([
    onBootstrapEvent((e: BootstrapEvent) => {
      if (e.message) log(`[${e.stage}] ${e.message}`);
      bootstrap.advance(e.stage, e.message ?? "");
      if (e.ok === false) setErr(e.message || "依赖安装失败");
    }),
    onBootstrapExit((code: number) => {
      log("bootstrap 退出码: " + code);
      if (code !== 0 && bootstrap.state !== "done") bootstrap.advance("failed", "");
      refresh();
    }),
    onServiceStarted((p: number) => {
      env.setPort(p);
      service.setRunning(true);
      hintHidden.value = true;
      refresh();
    }),
    onCloseRequested((payload: any) => {
      closeInstalling.value = !!payload?.installing;
      closeDialogOpen.value = true;
    }),
    onChanneldepProgress((line: string) => log(line)),
    onChanneldepExit((code: number) => {
      log("渠道依赖安装退出码: " + code);
      refresh();
    }),
  ]);
  refresh();
  pollTimer = setInterval(refresh, 3000);
});

onUnmounted(() => {
  unlistens.forEach((u) => u());
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <main class="console">
    <!-- head: logo + 标题 + 打开 WebUI -->
    <div class="head">
      <div style="display: flex; align-items: center; gap: 13px">
        <img
          class="mark"
          alt="Vibe Trading"
          src="data:image/png;base64,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"
        />
        <div>
          <h1>Vibe Trading</h1>
          <p class="sub">桌面运行环境控制台</p>
        </div>
      </div>
      <AppButton variant="ghost" :disabled="!running" @click="onOpenWebui">
        在浏览器打开 WebUI
      </AppButton>
    </div>

    <!-- status -->
    <div class="status">
      <div class="status-row">
        <span class="status-label">运行环境</span>
        <div style="display: flex; gap: 8px">
          <StatusBadge :cls="envBadge.cls" :text="envBadge.txt" />
          <AppButton
            v-if="showInstallBtn"
            :variant="envState === 'ready' ? 'ghost' : 'primary'"
            :busy="installBusy.busy.value"
            busy-label="安装中"
            @click="onInstall"
          >
            安装/修复依赖
          </AppButton>
        </div>
      </div>
      <div class="status-row">
        <span class="status-label">研究服务</span>
        <div style="display: flex; gap: 8px">
          <StatusBadge
            :cls="running ? 'ok' : 'warn'"
            :text="running ? '运行中' : '已停止'"
            :live="running"
          />
          <div class="action-group">
            <AppButton
              v-if="showStartBtn"
              variant="primary"
              :disabled="btnStartDisabled"
              :busy="startBusy.busy.value"
              busy-label="启动中"
              @click="onStart"
            >
              启动服务
            </AppButton>
            <AppButton
              v-if="showStopBtn"
              variant="danger"
              :busy="stopBusy.busy.value"
              busy-label="停止中"
              @click="onStop"
            >
              停止服务
            </AppButton>
          </div>
        </div>
      </div>
      <div class="status-row">
        <span class="status-label">消息渠道</span>
        <StatusBadge :cls="channels.cls" :text="channels.text" :live="channels.live" />
      </div>
    </div>

    <HintBanner :hidden="hintHidden" />

    <ProgressBar />

    <ConfirmDialog
      :open="stopDialogOpen"
      title="确认停止服务？"
      @close="onStopDialogClose"
    >
      停止将中断后端进程，<b>请确保当前没有正在执行的任务</b>（回测、研究、实盘等）。
      <template #confirm-text>确认停止</template>
    </ConfirmDialog>

    <ConfirmDialog
      :open="closeDialogOpen"
      title="确认关闭客户端？"
      @close="onCloseDialogClose"
    >
      <span v-html="closeText"></span>
      <template #confirm-text>确认关闭</template>
    </ConfirmDialog>

    <div id="err">{{ errorMsg }}</div>

    <LogViewer ref="logViewer" @open-logs="onOpenLogs" />

    <VersionFooter />
  </main>
</template>

<style>
@import "../styles/console.css";
</style>
```

> **注意 logo base64**：上面 `<img src="data:image/png;base64,...">` 的 base64 是**截断示意**。实现时必须从原 `console-dist/index.html` 第 496-499 行完整复制整段 base64（约 6KB），不要用截断值。

- [ ] **Step 3: 写 3 个占位页面**

`pages/ChannelsPage.vue`：
```vue
<template>
  <main class="console"><div class="placeholder">消息渠道管理（待实现）</div></main>
</template>
```
`pages/SettingsPage.vue`：
```vue
<template>
  <main class="console"><div class="placeholder">设置面板（待实现）</div></main>
</template>
```
`pages/MonitorPage.vue`：
```vue
<template>
  <main class="console"><div class="placeholder">运行时监控（待实现）</div></main>
</template>
```

- [ ] **Step 4: 写 `router.ts`**

```ts
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

// hash history: Tauri 加载本地文件,无服务端路由。
const routes: RouteRecordRaw[] = [
  { path: "/", component: () => import("./pages/ConsolePage.vue") },
  { path: "/channels", component: () => import("./pages/ChannelsPage.vue") },
  { path: "/settings", component: () => import("./pages/SettingsPage.vue") },
  { path: "/monitor", component: () => import("./pages/MonitorPage.vue") },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
```

- [ ] **Step 5: 改 `main.ts` 接入 pinia + router + 全局 CSS**

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./styles/console.css";

createApp(App).use(createPinia()).use(router).mount("#app");
```

- [ ] **Step 6: 改 `App.vue` 加 ErrorBoundary + IPC 降级提示**

```vue
<script setup lang="ts">
import { ref, onErrorCaptured } from "vue";

const errMsg = ref("");
onErrorCaptured((e) => {
  errMsg.value = String(e);
  return false; // 阻止向上抛
});
</script>

<template>
  <div v-if="errMsg" class="fatal">
    控制台发生错误：{{ errMsg }}
  </div>
  <router-view v-else />
</template>

<style>
.fatal {
  padding: 24px; color: #ff8080; font-family: ui-monospace, Menlo, monospace;
  background: #0e0f13; min-height: 100vh;
}
</style>
```

- [ ] **Step 7: 构建确认**

Run:
```bash
cd src-tauri/console-app && npm run build
```
Expected: 类型检查 + 构建成功，`console-dist/index.html` + `assets/` 生成。

- [ ] **Step 8: 手动 smoke（HMR 看页面骨架）**

Run:
```bash
cd src-tauri/console-app && npm run dev
```
打开浏览器 `http://localhost:5174/`，确认页面骨架渲染（head/logo/三行 status/日志区/footer），按钮因 IPC 不可用（浏览器环境）应处于降级态。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/console-app/src && git commit -m "✨ feat(console): ConsolePage 1:1 迁移 + 4 路由 + CSS + ErrorBoundary

- ConsolePage 迁移全部现有功能(状态/启停/进度条/日志/二次确认/渠道)
- channels/settings/monitor 占位页
- console.css 从原 index.html 整体迁移
- App.vue 全局错误边界"
```

---

### Task 6: 构建脚本接入 + 版本锚点 + gitignore + 删除旧文件

**Files:**
- Create: `scripts/desktop/build-console.sh`
- Modify: `scripts/desktop/console-version.mjs`
- Modify: `scripts/desktop/build-dmg.sh`
- Modify: `scripts/desktop/build-windows.ps1`
- Modify: `.github/workflows/desktop-build.yml`
- Modify: `.gitignore`
- Delete: `src-tauri/console.html`
- Delete: `src-tauri/console-dist/index.html`（gitignore 改后由 build 生成）

**Interfaces:**
- Consumes: Task 1 的 `console-app/` 工程
- Produces: 完整构建链（本地 + CI 均能产出 `console-dist/`）

- [ ] **Step 1: 创建 `scripts/desktop/build-console.sh`**

```bash
#!/usr/bin/env bash
# 构建 src-tauri/console-app/ 的 Vue 工程到 ../console-dist/。
# Tauri frontendDist 指向 console-dist,所以桌面打包前必须先跑这个。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/src-tauri/console-app"

if [ ! -d "$APP_DIR" ]; then
  echo "[build-console] console-app 不存在,跳过" >&2
  exit 0
fi

echo "[build-console] 安装依赖并构建 console-app..."
cd "$APP_DIR"
npm ci
npm run build

echo "[build-console] 校验 console 版本锚点..."
cd "$ROOT"
node scripts/desktop/console-version.mjs --check

echo "[build-console] 完成"
```

赋权：
```bash
chmod +x scripts/desktop/build-console.sh
```

- [ ] **Step 2: 改 `scripts/desktop/console-version.mjs` 的 `INDEX_PATH`**

定位 `console-version.mjs` 第 10 行：
```js
const INDEX_PATH = "src-tauri/console-dist/index.html";
```
改为：
```js
// 源文件改为 console-app/index.html(Vite 源);构建后锚点带到 console-dist 产物。
const INDEX_PATH = "src-tauri/console-app/index.html";
```

> 校验逻辑（`ANCHOR_RE`）不变；`--check` 仍读 `data-console-version`。

- [ ] **Step 3: 改 `build-dmg.sh`，在 assemble 前调 build-console**

定位 `scripts/desktop/build-dmg.sh` 中调用 `assemble.sh` 的那行之前，插入：
```bash
bash "$ROOT/scripts/desktop/build-console.sh"
```
（具体行号在实现时用 `grep -n "assemble.sh" scripts/desktop/build-dmg.sh` 定位。）

- [ ] **Step 4: 改 `build-windows.ps1`，在 assemble 前调 build-console**

定位 `scripts/desktop/build-windows.ps1` 中调用 `assemble.ps1` 之前，插入：
```powershell
bash "$PSScriptRoot/build-console.sh"
```
（Windows 构建若用 PowerShell，可改为对应的 `npm ci && npm run build` 调用；具体看 assemble.ps1 的调用风格。）

- [ ] **Step 5: 改 `.github/workflows/desktop-build.yml` 加 build-console 步骤**

在 desktop-build job 里、assemble 步骤之前，加一步：
```yaml
- name: Build console UI
  working-directory: src-tauri/console-app
  run: |
    npm ci
    npm run build
```

- [ ] **Step 6: 改 `.gitignore`，把 console-dist 改为产物忽略**

定位 `.gitignore` 中相关行，确保：
```gitignore
# Tauri console 产物(console-app 构建生成)
src-tauri/console-dist/
```
（`src-tauri/console-app/node_modules/` 已被 Task 1 的工程内 `.gitignore` 覆盖。）

- [ ] **Step 7: 删除旧文件**

```bash
git rm src-tauri/console.html
git rm --cached src-tauri/console-dist/index.html 2>/dev/null || true
# 物理文件 console-dist/index.html 由 build-console.sh 重新生成;gitignore 已忽略。
```

- [ ] **Step 8: 端到端构建验证**

Run:
```bash
bash scripts/desktop/build-console.sh
```
Expected:
- `console-app/` 跑 `npm ci && npm run build`
- 产物落到 `src-tauri/console-dist/`
- `console-version.mjs --check` 输出 `console version ok: v0.1.0`

- [ ] **Step 9: Commit**

```bash
git add scripts/desktop .github .gitignore && git commit -m "🔧 build(console): 构建脚本接入 + 版本锚点 + gitignore + 清理旧文件

- 新增 build-console.sh,build-dmg/windows/CI 在 assemble 前调用
- console-version.mjs INDEX_PATH 指向 console-app 源文件
- console-dist/ 改 gitignore(产物由 build 生成)
- 删除旧版 console.html"
```

---

### Task 7: DoD 手动验证（无代码）

**Files:** 无（验证清单）

> 本任务由人工在 `cargo tauri dev` 下逐条点验，确认 1:1 迁移成功。每条对应一个现有行为。

- [ ] **Step 1: 启动桌面 dev**

Run:
```bash
bash scripts/desktop/build-console.sh && cd src-tauri && cargo tauri dev
```
Expected: Tauri 窗口打开，显示新 console 页面（logo + 标题 + 三行 status + 日志区 + footer 版本号）。

- [ ] **Step 2: DoD 逐条勾验**

逐项点验，全部应与重构前一致：

1. [ ] 环境状态 badge：未安装态显示"未安装"（bad），点安装后变"依赖不全"或"就绪"
2. [ ] 就绪态：安装按钮消失（或降为 ghost 隐藏），启动按钮可点
3. [ ] 启动服务：badge 变"运行中"（ok live），自动打开浏览器 WebUI
4. [ ] 启停互斥：运行中只显示停止按钮（danger），停止后只显示启动按钮
5. [ ] 安装进度条：venv→installing（渐近爬升、单调不倒退）→smoke→done（100%）
6. [ ] 安装失败：进度条红色，停在当前百分比，显示"已中断"
7. [ ] 停止服务：弹二次确认 dialog，确认后停止
8. [ ] 关闭窗口（运行中）：弹关闭确认 dialog，确认后关闭
9. [ ] 渠道 badge：服务运行后显示微信渠道状态（未登录/运行中/登录失效）
10. [ ] 日志区：bootstrap 日志逐行追加、自动滚底、清空按钮有效
11. [ ] 打开日志目录按钮有效
12. [ ] hint banner：未就绪时显示，就绪后隐藏
13. [ ] footer 显示"控制台 v0.1.0"
14. [ ] 3 秒轮询：badge 状态随 backend 变化更新

- [ ] **Step 3: IPC 降级验证**

在浏览器直接打开 `console-dist/index.html`（非 Tauri 环境）：
Expected: 页面不抛错，badge 显示"检测中…"，操作按钮触发时显示降级错误提示（不崩溃）。

- [ ] **Step 4: 全量测试回归**

Run:
```bash
cd src-tauri/console-app && npx vitest run
```
Expected: PASS（IPC 9 + bootstrap 6 = 15 个测试全过）。

- [ ] **Step 5: 提交验证记录（可选）**

```bash
git commit --allow-empty -m "✅ test(console): DoD 手动验证通过(14 项 + 降级 + 测试回归)"
```

---

## Self-Review Notes

**Spec 覆盖核对**（逐节）：
- spec 4.1 工程结构 → Task 1 + Task 6 ✓
- spec 4.2 IPC 封装层 → Task 2 ✓
- spec 4.3 Pinia stores → Task 3 ✓
- spec 4.4 组件清单（8 个）→ Task 4 ✓
- spec 4.5 路由 → Task 5 ✓
- spec 4.6 错误处理与降级 → Task 5 Step 6（ErrorBoundary）+ Task 7 Step 3（降级验证）✓
- spec 5.1 交付范围 → 全部 Task ✓
- spec 6 DoD 8 项 → Task 7 Step 2（细化为 14 条勾验）✓
- spec 7 测试策略 → Task 2/3 TDD + Task 7 回归 ✓
- spec 8 风险缓解 → base:'./'（Task 1）、build-console 接入（Task 6）、版本锚点（Task 6）✓

**Placeholder 扫描**：
- ConsolePage logo base64 已标注"实现时从原文件完整复制"——这是引用源文件，不是占位符（避免 plan 文档塞 6KB base64）。
- build-dmg.sh / build-windows.ps1 的插入位置用 `grep -n` 定位——已给具体 grep 命令，不是含糊指令。
- 无 TBD/TODO/"实现细节后补"。

**类型一致性**：
- `BootstrapStage` 在 types.ts 定义，bootstrap store 与 ProgressBar 都用同一类型 ✓
- `consoleStatus()` 返回 `StatusReport`，env store 消费 ✓
- `useBootstrapStore().advance(stage, message)` 签名在 store 与 ConsolePage 调用一致 ✓
- `onCloseRequested` 的 payload 类型为 `{ installing?: boolean } | unknown`，ConsolePage 用 `payload?.installing` ✓

**已知简化（标注 ponytail:）**：
- ChannelSelect 当前无消费者，为多渠道扩展预留（spec 列入清单，本次实现最小版本）
- CSS 整体迁移而非模块化（避免本次重写 483 行 CSS，1:1 保真优先）
- dev HMR 直连留作后续（本次不动 beforeDevCommand）
