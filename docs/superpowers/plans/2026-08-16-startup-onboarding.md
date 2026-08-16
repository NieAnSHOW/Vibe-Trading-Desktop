# Startup Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the console root route a first-run/recovery onboarding page, automatically launch healthy environments into Research, move account content to Profile, and remove Environment navigation.

**Architecture:** Rust remains the authoritative startup gate: a `Ready` environment always starts the sidecar and embeds Research, while non-ready states remain in the console onboarding route. The Vue onboarding page owns install/repair and post-install startup for the current session; Profile owns all account/usage/member UI; the two rails expose only Account, Research, theme, and Settings.

**Tech Stack:** Tauri v2/Rust, Vue 3 + Pinia + Vitest, React 19 + TypeScript + Vite, existing IPC/event APIs and CSS.

## Global Constraints

- Environment states are `ready`, `incomplete`, and `not_installed`; only `ready` may auto-start the service.
- The user must not be able to configure startup autostart; legacy settings must not block a ready environment.
- `/` remains the hidden console onboarding/recovery route and must remain usable by tray/crash fallbacks.
- Preserve existing sidecar safety, busy guards, login-expiry handling, and service stop-before-repair behavior.
- Do not add dependencies or change the normal WebUI research sidebar, which has no Environment item.

---

### Task 1: Make Rust startup unconditional for ready environments

**Files:**
- Modify: `src-tauri/src/main.rs` boot/startup gate and command registration
- Modify: `src-tauri/src/settings.rs` only if needed for legacy `autostart_service` compatibility
- Modify: `src-tauri/src/console.rs` autostart command/types if no longer referenced
- Test: existing Rust startup/settings/console tests under `src-tauri/src/**`

**Interfaces:**
- Consumes existing `compute_env_status`, `start_service_inner`, settings loading, and `webui_embed::embed`.
- Produces startup behavior where `EnvState::Ready` starts and embeds regardless of stored autostart value; non-ready states do not start.

- [ ] **Step 1: Add/adjust a focused Rust test** asserting a ready environment with `autostart_service = false` still takes the start path, while a non-ready environment does not.
- [ ] **Step 2: Run the focused Rust test** with `cd src-tauri && cargo test <startup_test_filter>` and confirm the old gate fails before implementation.
- [ ] **Step 3: Change `boot()`** so the `Ready` branch invokes the existing sidecar start/embed flow without checking `settings.autostart_service`; preserve error reporting and child-process guards.
- [ ] **Step 4: Remove only dead autostart IPC plumbing** (`console_set_autostart`, its registration/types/imports) after `rg "autostart|consoleSetAutostart|console_set_autostart"` confirms no live callers. Keep a deserializable legacy settings field only when required for reading old settings files, but never use it as a startup gate.
- [ ] **Step 5: Run `cd src-tauri && cargo test`** and confirm all Rust tests pass.
- [ ] **Step 6: Commit** with `git add src-tauri && git commit -s -m "feat: auto-start ready desktop environments"`.

### Task 2: Convert ConsolePage into onboarding/recovery flow

**Files:**
- Modify: `src-tauri/console-app/src/pages/ConsolePage.vue`
- Modify: `src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts`
- Modify: `src-tauri/console-app/src/stores/service.ts` only if a startup helper is needed

**Interfaces:**
- Consumes `useEnvStore`, `useBootstrapStore`, `useServiceStore`, bootstrap/service IPC events, and existing `consoleBootstrap`/status APIs.
- Produces a root page that renders installation/repair/start failure states, calls service startup after successful bootstrap, and contains no account/member panel.

- [ ] **Step 1: Update tests** to cover `not_installed` installation CTA, successful bootstrap triggering status refresh then service start/open, and startup failure leaving the page visible with an error.
- [ ] **Step 2: Run the ConsolePage test file** with the console app’s Vitest command and confirm the new post-bootstrap expectation fails.
- [ ] **Step 3: Extract or retain a single `startAfterReady()` path** that checks `envState === "ready"`, calls the existing service start behavior, updates port/running state, and converts errors into `errorMsg` without navigating to a blank route.
- [ ] **Step 4: In the bootstrap exit handler**, refresh environment state, call `startAfterReady()` only for successful bootstrap and `ready`, and leave failed bootstrap in the onboarding view.
- [ ] **Step 5: Remove ConsolePage member usage state, refresh handlers, QR dialogs, member panel markup, and unrelated imports; keep install/repair/service status UI and existing quit/update handling.
- [ ] **Step 6: Run `npx vitest run src/pages/__tests__/ConsolePage.test.ts` from `src-tauri/console-app`** and confirm all onboarding cases pass.
- [ ] **Step 7: Commit** with `git add src-tauri/console-app/src/pages/ConsolePage.vue src-tauri/console-app/src/pages/__tests__/ConsolePage.test.ts src-tauri/console-app/src/stores/service.ts && git commit -s -m "feat: turn console root into startup onboarding"`.

### Task 3: Move account and membership UI to ProfilePage

**Files:**
- Modify: `src-tauri/console-app/src/pages/ProfilePage.vue`
- Modify: `src-tauri/console-app/src/pages/__tests__/ProfilePage.test.ts`

**Interfaces:**
- Consumes the existing auth/env/service stores, membership IPC calls, QR config/assets, and busy/dialog components.
- Produces Profile UI for identity, tier/expiry, benefits, usage refresh, membership-change handling, support/reward dialogs, and logout.

- [ ] **Step 1: Add ProfilePage tests** for member usage rendering/refresh, membership-change restart flow, and presence of support/reward actions after moving the panel.
- [ ] **Step 2: Run the ProfilePage tests** and confirm the new assertions fail because the controls are not present.
- [ ] **Step 3: Move the computed values and handlers** (`accountName`, tier/expiry, usage formatting/percentage, auth refresh, usage refresh, membership restart, dialog close) from ConsolePage into ProfilePage, adapting local template refs.
- [ ] **Step 4: Move the member panel template and dialogs** into ProfilePage without changing IPC semantics or login-expiry behavior.
- [ ] **Step 5: Keep logout behavior returning to `/`** so environment state decides whether onboarding or automatic startup follows.
- [ ] **Step 6: Run `npx vitest run src/pages/__tests__/ProfilePage.test.ts`** and the full console-app page test subset.
- [ ] **Step 7: Commit** with `git add src-tauri/console-app/src/pages/ProfilePage.vue src-tauri/console-app/src/pages/__tests__/ProfilePage.test.ts && git commit -s -m "feat: move membership controls to profile"`.

### Task 4: Remove the Environment item from console navigation

**Files:**
- Modify: `src-tauri/console-app/src/components/Rail.vue`
- Modify: `src-tauri/console-app/src/components/App.vue`
- Modify: `src-tauri/console-app/index.html`
- Modify: `src-tauri/console-app/src/__tests__/Rail.test.ts`
- Modify: `src-tauri/console-app/src/__tests__/App.test.ts` if pre-render expectations require it

**Interfaces:**
- Consumes the existing hash router and service state.
- Produces Account/Research/theme/Settings navigation; Research falls back to `/` when service is stopped; no Environment label, icon, or active key remains.

- [ ] **Step 1: Update Rail tests** to assert no Environment button and to select Research by accessible name rather than array index; preserve disabled-state and stopped-service fallback assertions.
- [ ] **Step 2: Run `npx vitest run src/__tests__/Rail.test.ts src/__tests__/App.test.ts`** and observe failures from the old Environment item expectations.
- [ ] **Step 3: Remove `MonitorCog`, the `environment` rail key/active mapping, and the Environment button from `Rail.vue`; update comments and keep `openResearch()`’s `/` fallback.
- [ ] **Step 4: Remove the pre-rendered Environment node and its default highlight from `index.html`; set the neutral/default route marker so the first paint cannot show Environment.
- [ ] **Step 5: Update App comments and any pre-render assertions, then rerun the focused tests.
- [ ] **Step 6: Commit** with `git add src-tauri/console-app/src/components/Rail.vue src-tauri/console-app/src/components/App.vue src-tauri/console-app/index.html src-tauri/console-app/src/__tests__/Rail.test.ts src-tauri/console-app/src/__tests__/App.test.ts && git commit -s -m "refactor: remove environment console navigation"`.

### Task 5: Remove the Environment item from embedded Research navigation

**Files:**
- Modify: `frontend/src/components/layout/DesktopShellRail.tsx`
- Modify: `frontend/src/components/layout/Layout.tsx`
- Modify: `frontend/src/components/layout/__tests__/DesktopShellRail.test.tsx`
- Modify: `frontend/src/i18n/locales/zh-CN.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/ja.json`
- Modify: `frontend/src/i18n/locales/ko.json`
- Modify: `frontend/src/i18n/locales/ar.json`

**Interfaces:**
- Consumes existing embedded-shell navigation and translation lookup.
- Produces Account/Research/Settings rail without `desktop-environment` telemetry or navigation; hidden console root fallback remains available through `desktopShell.ts`.

- [ ] **Step 1: Add a test** asserting the embedded rail has no Environment button and does not emit the old `desktop-environment` target.
- [ ] **Step 2: Run `npx vitest run src/components/layout/__tests__/DesktopShellRail.test.tsx`** from `frontend` and confirm the new assertion fails.
- [ ] **Step 3: Remove `MonitorCog` and the Environment `RailButton`; update the rail comment and Layout comment.
- [ ] **Step 4: Remove only orphaned `layout.rail.environment` keys from all five locale files; verify with `rg "layout\.rail\.environment" frontend` that no consumer remains.
- [ ] **Step 5: Run the focused test and `npm run build` from `frontend`.
- [ ] **Step 6: Commit** with `git add frontend && git commit -s -m "refactor: remove environment research navigation"`.

### Task 6: Remove the user-facing autostart setting and update compatibility tests

**Files:**
- Modify: `src-tauri/console-app/src/pages/SettingsPage.vue`
- Modify: `src-tauri/console-app/src/pages/__tests__/SettingsPage.test.ts`
- Modify: `src-tauri/console-app/src/ipc/commands.ts` and IPC types only if Task 1 leaves dead frontend bindings

**Interfaces:**
- Consumes existing theme and maintenance commands.
- Produces Settings without startup behavior UI, autostart state, or `consoleSetAutostart` calls; environment check/repair remains available.

- [ ] **Step 1: Delete tests for the autostart switch and add a regression assertion that the startup behavior section is absent while maintenance controls remain.
- [ ] **Step 2: Run the SettingsPage tests** and confirm old switch assertions fail.
- [ ] **Step 3: Remove autostart refs, load assignment, toggle handler, command imports, and template section; leave theme load/save and maintenance lifecycle intact.
- [ ] **Step 4: Remove now-unused frontend IPC wrappers/types only after `rg` confirms no caller.
- [ ] **Step 5: Run the SettingsPage test file and the full console-app test suite.
- [ ] **Step 6: Commit** with `git add src-tauri/console-app/src/pages/SettingsPage.vue src-tauri/console-app/src/pages/__tests__/SettingsPage.test.ts src-tauri/console-app/src/ipc && git commit -s -m "refactor: hide configurable service autostart"`.

### Task 7: Full verification and regression cleanup

**Files:**
- Modify: any test snapshots or fixtures identified by the commands below; no production changes unless a test exposes a requirement gap.

**Interfaces:**
- Validates all prior task outputs together.

- [ ] **Step 1: Run console-app tests** with `cd src-tauri/console-app && npx vitest run`.
- [ ] **Step 2: Run frontend tests** with `cd frontend && npx vitest run`.
- [ ] **Step 3: Run frontend production build** with `cd frontend && npm run build`.
- [ ] **Step 4: Run Rust tests** with `cd src-tauri && cargo test`.
- [ ] **Step 5: Run targeted static searches**: `rg "启动时自动启动服务|desktop-environment|layout\.rail\.environment|MonitorCog|consoleSetAutostart|console_set_autostart" src-tauri frontend` and remove only stale user-facing references or dead imports.
- [ ] **Step 6: Review `git diff --check` and `git status --short`; ensure only intended source/tests/docs are changed and no `.desktop-build` artifacts are staged.
- [ ] **Step 7: Commit any final test-only cleanup** with a signed commit message describing the regression fixed.
