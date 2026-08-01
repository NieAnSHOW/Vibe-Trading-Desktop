# Legacy Vibe Trading Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a confirmed Settings action that launches the Windows NSIS uninstaller or removes the legacy macOS app bundle while preserving `~/.vibe-trading` user data.

**Architecture:** Keep path discovery and process launching in a platform-gated Rust Tauri command. The Vue page only invokes the typed IPC wrapper after the existing confirmation dialog and busy-state flow. The command uses fixed candidate paths and never accepts a frontend path.

**Tech Stack:** Rust, Tauri 2 commands, Vue 3 `<script setup>`, TypeScript, Vitest, Vue Test Utils, Cargo tests.

## Global Constraints

- Windows must launch `%LOCALAPPDATA%\\Vibe Trading\\uninstall.exe` through the NSIS uninstaller.
- macOS may remove only `/Applications/Vibe Trading.app` or `~/Applications/Vibe Trading.app`.
- Never remove `~/.vibe-trading`, its contents, or any frontend-supplied path.
- Preserve the current `Trading Worker` process after starting legacy uninstall.
- Keep unrelated existing changes, including `src-tauri/Cargo.toml`, untouched.

---

### Task 1: Add tested Rust uninstall path and Tauri command

**Files:**
- Modify: `src-tauri/src/console.rs` near the existing maintenance commands and test module
- Modify: `src-tauri/src/main.rs` command registration
- Test: `src-tauri/src/console.rs` unit tests

**Interfaces:**
- Produces `pub fn console_uninstall_legacy_app() -> Result<(), String>` for Tauri IPC.
- The command has no frontend-provided arguments.

- [ ] **Step 1: Write failing Rust tests**

Add tests for a pure helper that accepts a home directory and returns platform candidate paths, plus missing-installation behavior. On Windows the expected candidate is `<home>\\AppData\\Local\\Vibe Trading\\uninstall.exe`; on macOS candidates are `<home>/Applications/Vibe Trading.app` and `/Applications/Vibe Trading.app`. Test fixtures must use `tempfile::tempdir()` and assert no `.vibe-trading` path is touched.

- [ ] **Step 2: Run the focused Rust tests and verify failure**

Run `cargo test --manifest-path src-tauri/Cargo.toml console::tests::legacy_uninstall -- --nocapture`.
Expected: FAIL because the helper and command do not exist yet.

- [ ] **Step 3: Implement minimal platform-gated behavior**

Add a private path helper with `#[cfg(windows)]` and `#[cfg(target_os = "macos")]` branches. Windows resolves `dirs::data_local_dir()`, verifies `uninstall.exe` is a file, then spawns it with `std::process::Command`; macOS checks the two fixed app bundle candidates, removes a user-level app directly, and launches a fixed `osascript` administrator prompt for `/Applications/Vibe Trading.app`. Return a clear missing-installation error, and return an unsupported-platform error for other targets. Register `console::console_uninstall_legacy_app` in `tauri::generate_handler!`.

- [ ] **Step 4: Run the focused Rust tests and verify success**

Run `cargo test --manifest-path src-tauri/Cargo.toml console::tests::legacy_uninstall -- --nocapture`.
Expected: PASS with all legacy uninstall tests green.

- [ ] **Step 5: Commit the Rust command**

Run `git add src-tauri/src/console.rs src-tauri/src/main.rs && git commit -m "feat: add legacy app uninstall command"`.

### Task 2: Add typed IPC and Settings page action

**Files:**
- Modify: `src-tauri/console-app/src/ipc/commands.ts`
- Modify: `src-tauri/console-app/src/pages/SettingsPage.vue`
- Modify: `src-tauri/console-app/src/pages/__tests__/SettingsPage.test.ts`

**Interfaces:**
- IPC wrapper: `consoleUninstallLegacyApp(): Promise<void>` invokes `console_uninstall_legacy_app`.
- Settings handler: confirmation calls `service.stop()` when `serviceRunning.value` is true, then calls `consoleUninstallLegacyApp()` and reports the result through existing maintenance notices.

- [ ] **Step 1: Write failing Vue tests**

Extend the existing command mock with `consoleUninstallLegacyApp`. Add tests that the `data-test="uninstall-legacy-action"` button renders, confirmation does not invoke the command, confirmation invokes `service.stop()` before the command when the service is running, and a rejected command renders the maintenance error.

- [ ] **Step 2: Run the focused Vue tests and verify failure**

Run `pnpm --dir src-tauri/console-app test --run src/pages/__tests__/SettingsPage.test.ts`.
Expected: FAIL because the action, handler, and IPC wrapper do not exist yet.

- [ ] **Step 3: Implement the typed wrapper and page flow**

Add `consoleUninstallLegacyApp` beside the other maintenance wrappers. In `SettingsPage.vue`, add `uninstallLegacyDialogOpen`, `uninstallLegacyBusy`, and `onUninstallLegacy` / `onUninstallLegacyDialogClose` handlers. Reuse `ConfirmDialog`, stop the service and clear the env port before invoking the command, then show a success notice that explicitly says user data is preserved. Add a danger `AppButton` row labelled `Vibe Trading` with the `data-test` selector and a confirmation dialog explaining that only the old application is removed.

- [ ] **Step 4: Run the focused Vue tests and verify success**

Run `pnpm --dir src-tauri/console-app test --run src/pages/__tests__/SettingsPage.test.ts`.
Expected: PASS with the existing and new Settings tests green.

- [ ] **Step 5: Commit the frontend action**

Run `git add src-tauri/console-app/src/ipc/commands.ts src-tauri/console-app/src/pages/SettingsPage.vue src-tauri/console-app/src/pages/__tests__/SettingsPage.test.ts && git commit -m "feat: add legacy uninstall action to settings"`.

### Task 3: Full verification and review

**Files:**
- Review: all files changed in Tasks 1-2

- [ ] **Step 1: Run the complete console-app test suite**

Run `pnpm --dir src-tauri/console-app test --run` and confirm zero failures.

- [ ] **Step 2: Run the complete Rust test suite**

Run `cargo test --manifest-path src-tauri/Cargo.toml` and confirm zero failures.

- [ ] **Step 3: Run frontend type/build checks**

Run `pnpm --dir src-tauri/console-app build` and confirm the production bundle completes successfully.

- [ ] **Step 4: Inspect the final diff**

Run `git diff HEAD~2..HEAD --check` and `git status --short`; verify only the intended files changed and `src-tauri/Cargo.toml` remains the user's pre-existing modification.
