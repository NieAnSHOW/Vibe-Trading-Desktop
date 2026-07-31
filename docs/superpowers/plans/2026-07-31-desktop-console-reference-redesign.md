# Desktop Console Reference Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Tauri desktop control console as a responsive wide operations workspace based on the supplied reference, while keeping all local workflows fully usable without login.

**Architecture:** `ConsolePage.vue` remains the orchestration owner and maps existing Pinia/Tauri state into a contextual primary action, a service workspace, and an optional authenticated membership sidebar. Existing child-component contracts and IPC payloads stay unchanged; `console.css` owns the responsive two-column/single-column presentation, and `tauri.conf.json` owns default/minimum window geometry.

**Tech Stack:** Vue 3.5, TypeScript 5.6, Pinia, Vue Router, Vitest, Vue Test Utils, Tauri v2, CSS custom properties, Lucide Vue icons.

## Global Constraints

- Use exact theme color `#1caea2` for primary actions, focus, and selected/healthy emphasis.
- Core local features remain available without login; login unlocks member services only.
- Signed-out users get no membership sidebar or empty reserved column; the service workspace spans full width.
- Default window is 1180 by 760 pixels, resizable, with a 900 by 680 pixel minimum.
- Preserve all IPC calls, event listeners, timers, busy states, confirmation dialogs, advertising, update, usage, error, log, and unmount-cleanup behavior.
- Preserve `AppButton`, `StatusBadge`, `ProgressBar`, `HintBanner`, `ConfirmDialog`, `AdSlot`, `UpdateBanner`, `LogViewer`, and `VersionFooter` public contracts.
- Use system sans typography, panel radii no larger than 12 pixels, WCAG AA contrast, and reduced-motion fallbacks.
- Do not add gradient text, decorative glass, wide ghost-card shadows, or ornamental motion.

---

## File Structure

- Modify `src-tauri/console-app/src/pages/ConsolePage.vue`: computed presentation state, responsive semantic markup, optional member sidebar, restored login notice, settings/profile navigation.
- Modify `src-tauri/console-app/src/styles/console.css`: exact brand tokens, wide shell, workspace layout, state strip, membership/sidebar rules, responsive fallback, motion reduction.
- Modify `src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts`: guest-mode, contextual-action, navigation, and login-notice regressions.
- Modify `src-tauri/console-app/package.json`: add `lucide-vue-next`.
- Modify `src-tauri/console-app/pnpm-lock.yaml`: lock the icon dependency used by the console build.
- Modify `src-tauri/tauri.conf.json`: default and minimum window geometry.
- Modify `src-tauri/src/main.rs`: lock the window geometry contract in a Rust configuration test.

### Task 1: Lock guest mode, navigation, and window geometry with failing tests

**Files:**
- Modify: `src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `ConsolePage` rendered classes and existing routes.
- Produces: regression expectations for `.console-workspace--guest`, `.member-panel`, `[data-test="primary-service-action"]`, `[data-test="settings-entry"]`, and Tauri window geometry.

- [ ] **Step 1: Extend the test router and add guest-mode coverage**

Add lightweight route components and `/profile` plus `/settings` records next to the current test router:

```ts
const EmptyRoute = { template: "<div />" };

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: ConsolePage },
    { path: "/login", component: LoginPage },
    { path: "/profile", component: EmptyRoute },
    { path: "/settings", component: EmptyRoute },
  ],
});
```

Add a guest test that overrides the next authentication response and verifies that the local workspace remains primary:

```ts
it("keeps the local service workspace full width while signed out", async () => {
  mocks.consoleAuthStatus.mockResolvedValueOnce({
    authenticated: false,
    userInfo: null,
    expireAt: null,
  });
  const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

  await flushPromises();

  expect(wrapper.get(".console-workspace").classes()).toContain("console-workspace--guest");
  expect(wrapper.find(".member-panel").exists()).toBe(false);
  expect(wrapper.text()).toContain("登录使用会员服务");
  expect(wrapper.get('[data-test="primary-service-action"]').text()).toBe("启动研究服务");
});
```

- [ ] **Step 2: Add navigation and restored-notice tests**

Replace the existing login-success assertion so it targets the explicit notice:

```ts
expect(wrapper.get('[data-test="login-notice"]').attributes("role")).toBe("status");
expect(wrapper.get('[data-test="login-notice"]').text()).toBe("欢迎回来");
```

Add settings and account navigation coverage:

```ts
it("opens settings from the application header", async () => {
  const wrapper = mount(ConsolePage, { global: { plugins: [router] } });
  await flushPromises();

  await wrapper.get('[data-test="settings-entry"]').trigger("click");
  await flushPromises();

  expect(router.currentRoute.value.path).toBe("/settings");
});
```

Keep the existing account-entry assertion and add a click assertion to `/profile` in the same test.

- [ ] **Step 3: Add the Tauri geometry test**

In `src-tauri/src/main.rs` test module add:

```rust
#[test]
fn tauri_conf_uses_resizable_wide_console_window() {
    let cfg: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("parse tauri.conf.json");
    let window = &cfg["app"]["windows"][0];

    assert_eq!(window["width"], 1180);
    assert_eq!(window["height"], 760);
    assert_eq!(window["minWidth"], 900);
    assert_eq!(window["minHeight"], 680);
    assert_eq!(window["resizable"], true);
    assert_eq!(window["maximizable"], true);
}
```

- [ ] **Step 4: Run tests and verify the new expectations fail**

Run:

```bash
cd src-tauri/console-app
pnpm test -- src/pages/__tests__/ConsolePage.test.ts
cd ..
cargo test tauri_conf_uses_resizable_wide_console_window
```

Expected: Vue tests fail because the new workspace/test selectors do not exist; the Rust test fails because the window is still `650x880`, non-resizable, and has no minimum size.

- [ ] **Step 5: Commit the red tests**

```bash
git add src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts src-tauri/src/main.rs
git commit -s -m "test(console): lock wide guest-friendly layout"
```

### Task 2: Build the contextual service workspace and optional member sidebar

**Files:**
- Modify: `src-tauri/console-app/package.json`
- Modify: `src-tauri/console-app/pnpm-lock.yaml`
- Modify: `src-tauri/console-app/src/pages/ConsolePage.vue`

**Interfaces:**
- Consumes: `envState`, `port`, `serviceRunning`, `running`, current action handlers, authentication state, `memberTier`, `memberUsage`, `usagePercent`, and existing child components.
- Produces: `isServiceRunning: ComputedRef<boolean>`, `remainingPercent: ComputedRef<number>`, `primaryActionKind: ComputedRef<"install" | "start" | "open">`, and stable test selectors from Task 1.

- [ ] **Step 1: Add Lucide Vue icons**

Run:

```bash
cd src-tauri/console-app
pnpm add lucide-vue-next
```

Expected: `package.json` and `pnpm-lock.yaml` include `lucide-vue-next`; no other dependency versions are upgraded.

- [ ] **Step 2: Add icon imports and computed presentation state**

Import the icons used by the page:

```ts
import {
  ArrowUpRight,
  CircleUserRound,
  Database,
  ExternalLink,
  LogIn,
  MessageCircleMore,
  Play,
  RefreshCw,
  ServerCog,
  Settings,
  Square,
  Wrench,
} from "lucide-vue-next";
```

Add these computed values after the existing button-state computed values:

```ts
const isServiceRunning = computed(
  () => serviceRunning.value || running.value,
);

const remainingPercent = computed(() => {
  const usage = memberUsage.value;
  if (!usage || usage.total_granted <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, (usage.total_available / usage.total_granted) * 100),
  );
});

const primaryActionKind = computed<"install" | "start" | "open">(() => {
  if (envState.value !== "ready") return "install";
  return isServiceRunning.value ? "open" : "start";
});
```

Update `showStartBtn`, `showStopBtn`, the service badge, and WebUI availability to use `isServiceRunning` so the two existing service-state sources cannot render contradictory controls. Do not change the start, stop, bootstrap, or event-handler lifecycles.

- [ ] **Step 3: Replace the page template with the semantic shell**

Keep all existing `ConfirmDialog` instances and handlers. Reorganize the visible content into this structure:

```vue
<main ref="consoleElement" class="console-shell">
  <header class="app-header">
    <div class="brand-lockup">
      <img class="mark" alt="Trading Worker" :src="logoPng" />
      <div class="brand-copy">
        <h1>Trading Worker</h1>
        <span class="brand-divider" aria-hidden="true"></span>
        <p class="sub">您的专属 AI 理财专家</p>
      </div>
    </div>

    <nav class="header-actions" aria-label="控制台快捷操作">
      <button
        v-if="ProdConfig.enableLogin && authStore.authenticated"
        class="account-profile-entry"
        data-test="account-profile-entry"
        type="button"
        :aria-label="`打开个人中心，${accountName}`"
        @click="router.push('/profile')"
      >
        <CircleUserRound :size="18" aria-hidden="true" />
        <span class="account-name" :title="accountName">{{ accountName }}</span>
        <span v-if="memberTier" class="member-tier" :class="`member-tier--${memberTier.tone}`">
          <span class="member-tier-mark" aria-hidden="true">V</span>
          <span class="member-tier-name">{{ memberTier.name }}</span>
        </span>
      </button>
      <AppButton
        v-else-if="ProdConfig.enableLogin"
        variant="ghost"
        @click="router.push('/login')"
      >
        <LogIn :size="16" aria-hidden="true" />
        登录使用会员服务
      </AppButton>
      <button
        class="icon-button"
        data-test="settings-entry"
        type="button"
        aria-label="打开设置"
        title="设置"
        @click="router.push('/settings')"
      >
        <Settings :size="19" aria-hidden="true" />
      </button>
    </nav>
  </header>

  <UpdateBanner ref="updateBanner" />
  <p
    v-if="loginNotice"
    class="login-notice"
    data-test="login-notice"
    role="status"
  >
    {{ loginNotice }}
  </p>
  <AdSlot :ad="adBanner" variant="banner" />

  <div
    class="console-workspace"
    :class="{ 'console-workspace--guest': !ProdConfig.enableLogin || !authStore.authenticated }"
  >
    <section class="service-panel" aria-labelledby="service-title">
      <div class="service-hero">
        <div class="service-state-line">
          <StatusBadge
            :cls="isServiceRunning ? 'ok' : envBadge.cls"
            :text="isServiceRunning ? '服务就绪' : envBadge.txt"
            :live="isServiceRunning"
          />
          <span>{{ isServiceRunning ? `本地端口 ${port ?? '检测中'}` : '本地运行，数据保留在您的设备上' }}</span>
        </div>
        <h2 id="service-title">研究服务</h2>
        <p class="service-description">启动本地 AI 研究服务，在浏览器中进行市场分析、策略回测和投研对话。</p>

        <div class="primary-action-row">
          <AppButton
            v-if="primaryActionKind === 'install'"
            variant="primary"
            :busy="installing"
            busy-label="安装中"
            data-test="primary-service-action"
            @click="onInstall"
          >
            <Wrench :size="19" aria-hidden="true" />安装或修复依赖
          </AppButton>
          <AppButton
            v-else-if="primaryActionKind === 'start'"
            variant="primary"
            :disabled="btnStartDisabled"
            :busy="startBusy.busy.value"
            busy-label="启动中"
            data-test="primary-service-action"
            @click="onStart"
          >
            <Play :size="19" aria-hidden="true" />启动研究服务
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            :disabled="port === null"
            data-test="primary-service-action"
            @click="onOpenWebui"
          >
            <ExternalLink :size="19" aria-hidden="true" />进入研究工作台
          </AppButton>

          <AppButton
            v-if="isServiceRunning"
            variant="ghost"
            :busy="stopBusy.busy.value"
            busy-label="停止中"
            @click="onStop"
          >
            <Square :size="15" aria-hidden="true" />停止服务
          </AppButton>
        </div>
      </div>

      <div class="runtime-strip" aria-label="运行状态">
        <div class="runtime-item">
          <Database :size="21" aria-hidden="true" />
          <span><small>运行环境</small><b>{{ envBadge.txt }}</b></span>
        </div>
        <div class="runtime-item">
          <ServerCog :size="21" aria-hidden="true" />
          <span><small>研究服务</small><b>{{ isServiceRunning ? '运行中' : '已停止' }}</b></span>
        </div>
        <div class="runtime-item">
          <MessageCircleMore :size="21" aria-hidden="true" />
          <span><small>消息渠道</small><b>{{ channels.text }}</b></span>
        </div>
      </div>

      <div class="maintenance-row">
        <AppButton variant="ghost" :busy="clearVenvBusy.busy.value" @click="onClearVenv">
          <Wrench :size="15" aria-hidden="true" />强制清理环境
        </AppButton>
      </div>
      <HintBanner :hidden="hintHidden" />
      <ProgressBar />
    </section>

    <aside
      v-if="ProdConfig.enableLogin && authStore.authenticated"
      class="member-panel"
      aria-label="会员服务"
    >
      <button class="member-profile-link" type="button" @click="router.push('/profile')">
        <CircleUserRound :size="48" stroke-width="1.3" aria-hidden="true" />
        <span><b>{{ memberTier?.label ?? '会员账户' }}</b><small>{{ accountName }}</small></span>
        <ArrowUpRight :size="17" aria-hidden="true" />
      </button>
      <p v-if="memberExpireTime" class="member-expire-time">有效期至 {{ memberExpireTime }}</p>

      <div class="member-usage-head">
        <span class="member-usage-title">剩余用量</span>
        <AppButton variant="ghost" :busy="usageRefreshing" busy-label="刷新中" data-test="member-usage-refresh" @click="refreshMemberUsage">
          <RefreshCw :size="14" aria-hidden="true" />刷新
        </AppButton>
      </div>
      <template v-if="memberUsage?.unlimited_quota">
        <strong class="member-usage-unlimited" data-test="member-usage-unlimited">不限量</strong>
      </template>
      <template v-else-if="memberUsage">
        <div class="usage-summary">
          <strong>{{ formatUsageAmount(memberUsage.total_available) }}</strong><span>积分</span>
          <small>{{ Math.round(remainingPercent) }}% 可用</small>
        </div>
        <div class="member-usage-track" role="progressbar" aria-label="剩余额度" :aria-valuenow="remainingPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="member-usage-fill" :style="{ width: `${remainingPercent}%` }"></div>
        </div>
        <div class="usage-detail">
          <span>总量 <b>{{ formatUsageAmount(memberUsage.total_granted) }}</b></span>
          <span>已用 <b>{{ formatUsageAmount(memberUsage.total_used) }}</b></span>
        </div>
      </template>
      <p v-else class="member-usage-placeholder">用量暂未加载</p>
    </aside>
  </div>

  <ConfirmDialog :open="installStopDialogOpen" title="服务运行中，确认停止并安装？" @close="onInstallStopDialogClose">
    检测到后端服务正在运行，安装新版本依赖需要先停止服务。<b>停止将中断正在执行的任务</b>（回测、研究、实盘等），确认停止并继续安装吗？
    <template #confirm-text>停止并安装</template>
  </ConfirmDialog>
  <ConfirmDialog :open="stopDialogOpen" title="确认停止服务？" @close="onStopDialogClose">
    停止将中断后端进程，<b>请确保当前没有正在执行的任务</b>（回测、研究、实盘等）。
    <template #confirm-text>确认停止</template>
  </ConfirmDialog>
  <ConfirmDialog :open="clearVenvDialogOpen" title="确认强制清理环境？" @close="onClearVenvDialogClose">
    将删除 <b>~/.vibe-trading/venv</b> 虚拟环境(含已安装依赖)，<b>不会删除您的配置、会话等数据</b>。清理后需重新完整安装依赖，确认操作吗？
    <template #confirm-text>确认清理</template>
  </ConfirmDialog>
  <ConfirmDialog :open="clearLogsDialogOpen" title="确认清理日志文件？" @close="onClearLogsDialogClose">
    将删除 <b>~/.vibe-trading/logs</b> 下的所有日志文件（sidecar-*.log），<b>不影响配置、会话等数据</b>。服务运行中当天日志可能被占用而跳过，确认操作吗？
    <template #confirm-text>确认清理</template>
  </ConfirmDialog>
  <ConfirmDialog :open="quitDialogOpen" title="确认退出客户端？" @close="onQuitDialogClose">
    <span v-html="quitText"></span>
    <template #confirm-text>确认退出</template>
  </ConfirmDialog>
  <AdSlot :ad="adBottom" variant="bottom" />
  <div id="err">{{ errorMsg }}</div>
  <section class="operations-footer" aria-label="运行日志">
    <LogViewer ref="logViewer" @open-logs="onOpenLogs" @clear-logs="onClearLogs" />
  </section>
  <VersionFooter />
</main>
```

Do not render the old standalone `.member-usage`, `.status`, or header WebUI button after this replacement. Preserve the screen-reader membership label and all five existing confirmation dialogs.

- [ ] **Step 4: Run the focused Vue tests**

Run:

```bash
cd src-tauri/console-app
pnpm test -- src/pages/__tests__/ConsolePage.test.ts
```

Expected: the new guest, notice, navigation, membership, and existing usage tests pass. Any assertion using the old used-quota progress value must be updated to the new remaining-quota label without weakening its numerical check.

- [ ] **Step 5: Commit the page behavior**

```bash
git add src-tauri/console-app/package.json src-tauri/console-app/pnpm-lock.yaml src-tauri/console-app/src/pages/ConsolePage.vue src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts
git commit -s -m "feat(console): build guest-friendly service workspace"
```

### Task 3: Implement the wide responsive visual system and window geometry

**Files:**
- Modify: `src-tauri/console-app/src/styles/console.css`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: semantic classes and test selectors produced in Task 2.
- Produces: 1180x760 resizable default window, 900x680 minimum, authenticated two-column layout, guest full-width layout, and sub-900px single-column fallback.

- [ ] **Step 1: Update the Tauri window definition**

Replace the current geometry fields with:

```json
{
  "title": "Trading Worker",
  "width": 1180,
  "height": 760,
  "minWidth": 900,
  "minHeight": 680,
  "resizable": true,
  "maximizable": true
}
```

- [ ] **Step 2: Replace console-page layout rules while preserving shared routes/components**

Keep shared profile, login, dialog, ad-carousel, badge, progress, and form selectors that other pages/components use. Replace the root console/header/member/status/log layout with these exact anchors; existing semantic badge, button, progress, dialog, error, and ad variants remain unchanged:

```css
:root {
  --bg: 210 24% 5%;
  --surface-1: 207 22% 8%;
  --surface-2: 205 19% 12%;
  --surface-3: 204 17% 15%;
  --line: 201 14% 23%;
  --ink: 190 18% 94%;
  --ink-dim: 194 10% 67%;
  --brand: 175.1 72.3% 39.6%;
  --brand-strong: 175 72% 35%;
  --on-brand: 180 30% 7%;
  --radius: 10px;
}

body {
  min-width: 0;
  min-height: 100vh;
  padding: 18px;
  align-items: stretch;
}

.console-shell {
  position: relative;
  z-index: 1;
  display: flex;
  width: min(100%, 1440px);
  min-height: calc(100vh - 36px);
  margin: 0 auto;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid hsl(var(--line));
  border-radius: 12px;
  background: hsl(var(--surface-1));
}

.app-header {
  display: flex;
  min-height: 74px;
  padding: 14px 22px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-bottom: 1px solid hsl(var(--line));
}

.console-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
  gap: 14px;
  padding: 14px;
}

.console-workspace--guest {
  grid-template-columns: minmax(0, 1fr);
}

.service-panel,
.member-panel {
  min-width: 0;
  border: 1px solid hsl(var(--line));
  border-radius: var(--radius);
  background: hsl(var(--surface-2));
}

.service-hero {
  padding: 42px 46px 30px;
}

.service-hero h2 {
  margin-top: 18px;
  font-size: 34px;
  line-height: 1.15;
  letter-spacing: -0.025em;
  text-wrap: balance;
}

.service-description {
  max-width: 62ch;
  margin-top: 14px;
  color: hsl(var(--ink-dim));
  font-size: 14px;
}

.primary-action-row {
  display: flex;
  margin-top: 30px;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.primary-action-row .btn-primary {
  min-height: 46px;
  padding-inline: 20px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 650;
}

.runtime-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0 46px 24px;
  border: 1px solid hsl(var(--line));
  border-radius: 8px;
}

.runtime-item {
  display: flex;
  min-width: 0;
  min-height: 76px;
  padding: 14px 18px;
  align-items: center;
  gap: 12px;
}

.runtime-item + .runtime-item {
  border-left: 1px solid hsl(var(--line));
}

.runtime-item > svg {
  flex: none;
  color: #1caea2;
}

.runtime-item span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.runtime-item small {
  color: hsl(var(--ink-dim));
  font-size: 11px;
}

.runtime-item b {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-panel {
  padding: 24px 22px;
}

.member-profile-link {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 0 0 20px;
  border: 0;
  border-bottom: 1px solid hsl(var(--line));
  border-radius: 0;
  background: transparent;
  color: hsl(var(--ink));
  text-align: left;
}

.usage-summary strong {
  display: inline-block;
  max-width: 100%;
  margin-top: 18px;
  overflow: hidden;
  font-size: 28px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
}

.operations-footer {
  margin-top: auto;
  padding: 0 18px 18px;
  border-top: 1px solid hsl(var(--line));
  background: hsl(var(--bg) / 0.45);
}

.operations-footer #log {
  height: 104px;
  border-radius: 8px;
}

.console-version-text {
  position: static;
  padding: 0 18px 10px;
}

@media (max-width: 899px) {
  body {
    padding: 12px;
  }

  .console-shell {
    min-height: calc(100vh - 24px);
  }

  .app-header,
  .brand-copy,
  .header-actions {
    flex-wrap: wrap;
  }

  .console-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .service-hero {
    padding: 30px 28px 24px;
  }

  .runtime-strip {
    margin-inline: 28px;
  }
}

@media (max-width: 620px) {
  .app-header {
    align-items: flex-start;
  }

  .runtime-strip {
    grid-template-columns: 1fr;
  }

  .runtime-item + .runtime-item {
    border-top: 1px solid hsl(var(--line));
    border-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Do not leave obsolete `.console`, `.head`, `.head-actions`, standalone `.status`, or standalone `.member-usage` selectors controlling `ConsolePage`; retain `.console` only where other route pages still rely on it. Ensure button focus and disabled states remain consistent with `AppButton`.

- [ ] **Step 3: Run formatting, tests, type checking, Rust geometry test, and production build**

Run:

```bash
cd src-tauri/console-app
pnpm test
pnpm exec vue-tsc --noEmit
pnpm build
cd ..
cargo test tauri_conf_uses_resizable_wide_console_window
```

Expected: all console tests pass, Vue type checking exits 0, Vite produces `src-tauri/console-dist`, and the targeted Rust test passes.

- [ ] **Step 4: Commit the responsive visual system**

```bash
git add src-tauri/console-app/src/styles/console.css src-tauri/tauri.conf.json src-tauri/src/main.rs
git commit -s -m "feat(console): adopt wide responsive desktop layout"
```

### Task 4: Real-window visual QA and final regression review

**Files:**
- Modify only files identified by QA findings.

**Interfaces:**
- Consumes: completed console UI and Tauri window configuration.
- Produces: screenshot evidence for desktop and minimum-width layouts, plus a clean verification run.

- [ ] **Step 1: Start the real Tauri development application**

Run:

```bash
cd src-tauri
cargo tauri dev
```

Expected: a resizable 1180x760 Trading Worker console opens and Tauri IPC initializes without browser-only invoke errors.

- [ ] **Step 2: Capture and inspect the authenticated desktop layout**

At 1180x760 verify header alignment, service workspace priority, member sidebar, contextual action, three-part status strip, bottom log, advertisements, and version placement. Confirm no nested-card appearance, clipped text, overlap, unexpected scrollbars, or low-contrast body text.

- [ ] **Step 3: Capture and inspect guest and minimum-size layouts**

At signed-out 1180x760 verify the membership sidebar is absent and the service workspace spans the full grid. Resize to 900x680 and verify content remains coherent; use a narrow browser rendering only for the CSS fallback below 900 because the native window minimum prevents smaller Tauri sizing.

- [ ] **Step 4: Exercise runtime state variants**

Verify environment not-ready, start busy, running, stop confirmation, bootstrap progress/failure, finite quota, unlimited quota, missing usage data, long error text, empty logs, populated logs, and all log actions. Do not run any broker-write or live-trading operation.

- [ ] **Step 5: Run the final regression commands after QA fixes**

```bash
cd src-tauri/console-app
pnpm test
pnpm exec vue-tsc --noEmit
pnpm build
cd ..
cargo test tauri_conf_uses_resizable_wide_console_window
git diff --check
```

Expected: every command exits 0 and the reviewer reports no P0/P1 defects.

- [ ] **Step 6: Commit any bounded QA fixes**

```bash
git add src-tauri/console-app src-tauri/tauri.conf.json src-tauri/src/main.rs
git commit -s -m "fix(console): resolve wide layout QA findings"
```
