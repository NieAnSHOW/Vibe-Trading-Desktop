# Desktop Logout and Custom LLM Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop users sign out without restarting the local service, switch future work to their saved custom LLM configuration, and reach the settings editor directly when that configuration is incomplete.

**Architecture:** Python owns the hot runtime switch while the service is running: it restores persisted custom settings, removes all VIP-only process variables, and returns a redacted readiness result. Rust owns command orchestration and the stopped-service branch: it persists `DESKTOP_LLM_MODE=custom` atomically, then clears the desktop login token section only after the switch succeeds. Vue calls typed Rust commands, displays readiness-aware logout copy, navigates to `/login`, and starts the service without opening the WebUI when the user chooses custom continuation.

**Tech Stack:** FastAPI/Pydantic, Python dotenv runtime synchronization, Rust/Tauri v2 commands, reqwest loopback proxy, Vue 3, Pinia, TypeScript, Vitest, Rust unit tests, pytest.

## Global Constraints

- Logout never calls service stop/start and never cancels work whose LLM client was already created.
- New work created after logout must not receive or use `VIBE_DESKTOP_VIP_PROVISIONED`, `VIBE_DESKTOP_VIP_API_KEY`, `VIBE_DESKTOP_VIP_BASE_URL`, `VIBE_DESKTOP_VIP_MODELS_JSON`, `VIP_API_KEY`, or `VIP_BASE_URL`.
- Logout succeeds when custom settings are incomplete; readiness is informational and drives the warning copy.
- Ready copy is exactly `退出后，正在运行的会员任务将继续完成；后续任务将使用本机自定义模型配置。`.
- Not-ready copy is exactly `退出后，正在运行的会员任务将继续完成；后续任务需要先配置本机自定义模型，否则无法执行。`.
- The login secondary action is exactly `使用自定义模型继续` and navigates to `/settings` only after a service port is available.
- A runtime switch/persistence error leaves the Rust and Vue authentication state intact.
- The Python readiness payload contains only `custom_configured`, and the Tauri/Vue view contains only `customConfigured`; no API key, URL secret, or membership credential is serialized.
- Preserve the existing membership-change refresh flow, including its intentional service restart.

---

### Task 1: Add Python custom-runtime exit operation and readiness reporting

**Files:**
- Modify: `agent/src/api/settings_routes.py:1-120, 350-525, 680-820`
- Test: `agent/tests/test_settings_api.py:170-420`
- Test: `agent/tests/test_api_server_startup.py:86-107`

**Interfaces:**
- Produce `CustomLLMReadinessResponse(BaseModel)` with `custom_configured: bool`.
- Produce `_custom_llm_configured(values: Dict[str, str]) -> bool`.
- Produce `restore_custom_runtime() -> CustomLLMReadinessResponse`.
- Register `POST /settings/llm/desktop-exit-vip` with the same local-or-auth dependency used by `GET /settings/llm`.
- `restore_custom_runtime` reads the resolved dotenv path, persists `DESKTOP_LLM_MODE=custom`, restores provider/model/base URL/API key and numeric LLM values through `_sync_runtime_env`, removes all six VIP process variables, resets `_vip_selected_model`, and returns only the readiness boolean.

- [ ] **Step 1: Write failing unit tests for readiness and cleanup**

Add tests that monkeypatch the settings environment and assert all behavior explicitly:

```python
def test_restore_custom_runtime_clears_every_vip_variable_and_selected_model(settings_env, monkeypatch):
    settings_env.write_text(
        "DESKTOP_LLM_MODE=vip\nLANGCHAIN_PROVIDER=openai\n"
        "LANGCHAIN_MODEL_NAME=gpt-4o\nOPENAI_API_KEY=custom-key\n"
        "OPENAI_BASE_URL=https://api.openai.com/v1\n"
    )
    monkeypatch.setenv("VIBE_DESKTOP_VIP_PROVISIONED", "1")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_API_KEY", "member-key")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_BASE_URL", "https://member.example")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_MODELS_JSON", '["vip-model"]')
    monkeypatch.setenv("VIP_API_KEY", "member-key")
    monkeypatch.setenv("VIP_BASE_URL", "https://member.example/v1")
    monkeypatch.setattr(settings_routes, "_vip_selected_model", "vip-model")

    result = settings_routes.restore_custom_runtime()

    assert result.custom_configured is True
    saved = dict(line.split("=", 1) for line in settings_env.read_text().splitlines() if "=" in line)
    assert saved["DESKTOP_LLM_MODE"] == "custom"
    assert settings_routes._vip_selected_model is None
    for key in (
        "VIBE_DESKTOP_VIP_PROVISIONED", "VIBE_DESKTOP_VIP_API_KEY",
        "VIBE_DESKTOP_VIP_BASE_URL", "VIBE_DESKTOP_VIP_MODELS_JSON",
        "VIP_API_KEY", "VIP_BASE_URL",
    ):
        assert key not in os.environ
    assert os.environ["OPENAI_API_KEY"] == "custom-key"


def test_restore_custom_runtime_reports_incomplete_required_key(settings_env, monkeypatch):
    settings_env.write_text(
        "DESKTOP_LLM_MODE=vip\nLANGCHAIN_PROVIDER=openai\n"
        "LANGCHAIN_MODEL_NAME=gpt-4o\nOPENAI_API_KEY=your-api-key\n"
    )
    assert settings_routes.restore_custom_runtime().custom_configured is False


def test_desktop_exit_vip_route_is_redacted(client, settings_env):
    settings_env.write_text("LANGCHAIN_PROVIDER=ollama\nLANGCHAIN_MODEL_NAME=llama3\n")
    response = client.post("/settings/llm/desktop-exit-vip")
    assert response.status_code == 200
    assert response.json() == {"custom_configured": True}
    assert "api_key" not in response.text.lower()
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run `pytest agent/tests/test_settings_api.py -q -k 'restore_custom_runtime or desktop_exit_vip'`.
Expected: FAIL because the response model, helper, and route do not exist.

- [ ] **Step 3: Implement the minimal runtime switch**

Add the response model and helper near `LLMSettingsResponse` and the existing `_sync_runtime_env` helpers. Resolve the provider from persisted `LANGCHAIN_PROVIDER`; reject `vip_server` as not custom. Build updates from persisted values, call `_rewrite_env_values(..., {DESKTOP_LLM_MODE_KEY: "custom", ...}, drop_keys=_llm_env_keys())`, then call `_sync_runtime_env(provider, updates)`. Before synchronization, pop the four `VIBE_DESKTOP_VIP_*` keys, `VIP_API_KEY`, and `VIP_BASE_URL`, and set `_vip_selected_model = None`. Compute readiness as a non-empty model, non-empty base URL, and either no required key, a configured non-placeholder key, or a positive OAuth login status. Register:

```python
@app.post(
    "/settings/llm/desktop-exit-vip",
    response_model=CustomLLMReadinessResponse,
    dependencies=[Depends(require_local_or_auth)],
)
async def desktop_exit_vip():
    return restore_custom_runtime()
```

Do not remove `OPENAI_API_KEY` or `OPENAI_BASE_URL` after `_sync_runtime_env`; those aliases may be the saved custom OpenAI configuration.

- [ ] **Step 4: Run Python tests and startup regression checks**

Run `pytest agent/tests/test_settings_api.py -q -k 'restore_custom_runtime or desktop_exit_vip'` and `pytest agent/tests/test_api_server_startup.py -q`.
Expected: all selected tests PASS, including startup with incomplete custom settings.

- [ ] **Step 5: Commit the Python slice**

```bash
git add agent/src/api/settings_routes.py agent/tests/test_settings_api.py agent/tests/test_api_server_startup.py
git commit -s -m "feat: add desktop custom llm exit runtime switch"
```

### Task 2: Persist custom mode and coordinate Rust logout

**Files:**
- Modify: `src-tauri/src/auth.rs:205-231, 343-399` and inline tests near `2000`
- Modify: `src-tauri/src/console.rs:1-60, 1040-1060, 1280-1360` and inline tests near `2135`
- Modify: `src-tauri/src/main.rs:45-95`
- Modify: `src-tauri/build.rs:1-55`
- Modify: `src-tauri/src/sidecar.rs:30-92` and its command-environment tests

**Interfaces:**
- Produce `auth::persist_custom_mode_and_clear_token_section(layout: &Layout) -> Result<(), AuthError>`; one atomic `.env` write sets `DESKTOP_LLM_MODE=custom`, clears all `USER_*` login fields, and preserves custom/provider/data-source keys.
- Produce private `PythonCustomReadiness { custom_configured: bool }` for deserializing the FastAPI snake-case payload.
- Produce public `console::CustomReadinessView { custom_configured: bool }` serialized with `#[serde(rename_all = "camelCase")]` for Vue.
- Produce async Tauri commands:
  `console_custom_llm_readiness() -> Result<CustomReadinessView, String>` and
  `console_logout_to_custom(...) -> Result<CustomReadinessView, String>`.
- Running-service commands use the trusted `SharedPort` and call `POST /settings/llm/desktop-exit-vip` through `proxy_settings`; stopped-service commands use the Rust atomic helper plus staged `src/providers/llm_providers.json` readiness evaluation.
- `console_logout_to_custom` acquires `RuntimeOperationLock`, switches/persists custom first, then calls `invalidate_authentication`; any switch error returns before token clearing.

- [ ] **Step 1: Write failing Rust tests for atomic persistence and ordering**

Add an auth test that writes a VIP mode and custom keys, calls `persist_custom_mode_and_clear_token_section`, and asserts mode is `custom`, all five user keys are absent, and `OPENAI_API_KEY`, `LANGCHAIN_MODEL_NAME`, and the data-source token remain. Add console tests with a loopback mock for a successful running-service POST and a failed POST; assert failed POST leaves `AuthState` authenticated and successful POST clears it. Add a stopped-service test asserting the persisted mode is custom and `sidecar::build_cmd_with_vip(..., None)` contains no injected VIP values.

- [ ] **Step 2: Run the focused Rust tests and verify they fail**

Run `cd src-tauri && cargo test auth::tests::persist_custom_mode_and_clear_token_section console::tests::logout_to_custom`.
Expected: FAIL because the helper, view, and commands do not exist.

- [ ] **Step 3: Implement the atomic auth helper**

Expose `DesktopLlmMode::as_env_value` within the crate and implement the helper by reading `layout.user_env`, applying `rewrite_env_keys` with `DESKTOP_LLM_MODE=custom` and empty values for `ENV_KEY_ACCESS`, `ENV_KEY_REFRESH`, `ENV_KEY_EXPIRE`, `ENV_KEY_REFRESH_EXPIRE`, and `ENV_KEY_REMEMBER_UNTIL`, then calling `write_env_atomic`. Keep unrelated and custom LLM keys intact.

- [ ] **Step 4: Implement readiness and coordinated logout commands**

Define a private `PythonCustomReadiness` that deserializes `{ "custom_configured": true }`, then map it into `CustomReadinessView`, whose Tauri JSON is `{ "customConfigured": true }`. For a running port, call the Python route and deserialize only the Python DTO. For a stopped service, inspect the saved provider metadata and validate provider is not `vip_server`, the resolved model/base URL (saved value or provider default) are non-empty, required API keys are non-placeholder, and `ollama` has no key requirement. Conservatively report OAuth providers as not ready while stopped because Rust cannot validate the Python OAuth token; this only affects warning copy and does not block logout. Treat all readiness inspection errors as `custom_configured: false`, but propagate runtime switch/persistence errors. Use `RuntimeOperationLock::try_acquire`; return a clear busy error if unavailable. Call `invalidate_authentication` only after the switch branch returns successfully. Register both commands in `main.rs` and the command allowlist in `build.rs`.

- [ ] **Step 5: Verify sidecar environment isolation**

Keep `build_cmd_with_vip`'s unconditional removal of all four `VIBE_DESKTOP_VIP_*` variables and add assertions for each key when the credential argument is `None`; this verifies a later custom-mode start cannot inherit membership credentials.

- [ ] **Step 6: Run Rust tests and commit**

Run `cd src-tauri && cargo test`.
Expected: all Rust tests PASS, including the existing authentication invalidation and service lifecycle tests.

```bash
git add src-tauri/src/auth.rs src-tauri/src/console.rs src-tauri/src/main.rs src-tauri/build.rs src-tauri/src/sidecar.rs
git commit -s -m "feat: coordinate logout with custom llm mode"
```

### Task 3: Extend typed IPC and service-start bridge

**Files:**
- Modify: `src-tauri/console-app/src/ipc/types.ts:168-220`
- Modify: `src-tauri/console-app/src/ipc/commands.ts:1-180`
- Modify: `src-tauri/console-app/src/stores/service.ts:1-30`
- Test: `src-tauri/console-app/src/ipc/__tests__/commands.test.ts`
- Add/update: `src-tauri/console-app/src/stores/__tests__/service.test.ts`

**Interfaces:**
- Add `CustomLLMReadiness { customConfigured: boolean }`.
- Add `consoleCustomLlmReadiness(): Promise<CustomLLMReadiness>` and `consoleLogoutToCustom(): Promise<CustomLLMReadiness>` invoking `console_custom_llm_readiness` and `console_logout_to_custom`.
- Add `Credential` to the `AuthError.variant` union.
- Change `useServiceStore.start(options?: { openWebui?: boolean }): Promise<number>`; default `openWebui` remains `true`, while `start({ openWebui: false })` sets `running` without calling `consoleOpenWebui`.

- [ ] **Step 1: Write failing IPC and store tests**

Assert the two command wrappers invoke the exact Rust command names and that `start({ openWebui: false })` calls `consoleStartService`, sets running, and never calls `consoleOpenWebui`; retain a test that the default start still opens WebUI.

- [ ] **Step 2: Run focused Vitest tests and verify failure**

Run `cd src-tauri/console-app && npx vitest run src/ipc/__tests__/commands.test.ts src/stores/__tests__/service.test.ts`.
Expected: FAIL on missing wrappers/options.

- [ ] **Step 3: Implement types, wrappers, and option-aware start**

Use the exact signatures above. In `start`, destructure `{ openWebui = true } = {}`; call `consoleOpenWebui(port)` only when `openWebui` is true. Do not change `stop` or existing callers.

- [ ] **Step 4: Run tests and commit**

Run the focused Vitest command again; expected PASS. Commit with `git add src-tauri/console-app/src/ipc src-tauri/console-app/src/stores && git commit -s -m "feat: expose custom logout and quiet service start"`.

### Task 4: Update ProfilePage logout UX

**Files:**
- Modify: `src-tauri/console-app/src/pages/ProfilePage.vue:1-165` and logout dialog template
- Test: `src-tauri/console-app/src/pages/__tests__/ProfilePage.test.ts`

**Interfaces:**
- Consume `consoleCustomLlmReadiness()` and `consoleLogoutToCustom()`.
- Keep `useEnvStore`, `useServiceStore`, and membership-refresh restart behavior.
- `logoutText` derives from a `customConfigured` ref; readiness command failures use the not-ready copy.

- [ ] **Step 1: Add failing component tests**

Add authenticated-profile tests that open the logout dialog and assert the ready and not-ready exact copy. Emit `close("ok")`, then assert `consoleLogoutToCustom` and `auth.authenticated === false`, route `/login`, and zero calls to `consoleStopService`, `consoleStartService`, and `consoleOpenWebui`. Add a rejected readiness test asserting the not-ready copy, and a rejected coordinated-logout test asserting auth remains true and the error is visible.

- [ ] **Step 2: Run the ProfilePage tests and verify failure**

Run `cd src-tauri/console-app && npx vitest run src/pages/__tests__/ProfilePage.test.ts`.
Expected: FAIL because the page still invokes the old logout and restart path.

- [ ] **Step 3: Implement readiness-aware logout**

Before opening the confirmation dialog, call `consoleCustomLlmReadiness`; store `customConfigured`, defaulting to `false` on error. After confirmation, call `consoleLogoutToCustom`, then `auth.clear()` and `router.replace("/login")`. Keep all service stop/start calls inside `doRestartForMembershipUpdate` only. Add a stable `data-test="logout-dialog"` and `data-test="logout-action"` to the logout controls used by tests.

- [ ] **Step 4: Run page tests and commit**

Run `cd src-tauri/console-app && npx vitest run src/pages/__tests__/ProfilePage.test.ts`; expected PASS.

```bash
git add src-tauri/console-app/src/pages/ProfilePage.vue src-tauri/console-app/src/pages/__tests__/ProfilePage.test.ts
git commit -s -m "feat: switch profile logout to custom llm"
```

### Task 5: Route LoginPage custom continuation to settings

**Files:**
- Modify: `src-tauri/console-app/src/pages/LoginPage.vue:1-15,220-280,420-455`
- Test: `src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts`

**Interfaces:**
- Consume `useEnvStore`, `useServiceStore`, `useBusy`, and `router`.
- The secondary button text is `使用自定义模型继续` and has `data-test="continue-custom"`.

- [ ] **Step 1: Add failing LoginPage tests**

Register `/settings` in the test router. Mock `consoleStatus`, `consoleStartService`, and `consoleOpenWebui`. Add tests that click the new button while `env.serviceRunning` is true and expect `/settings` with no start; while false expect one start, `env.port` set to `8899`, no WebUI open, and `/settings`; and when start rejects expect the route remains `/login` and an alert contains the error.

- [ ] **Step 2: Run LoginPage tests and verify failure**

Run `cd src-tauri/console-app && npx vitest run src/pages/__tests__/LoginPage.test.ts`.
Expected: FAIL because the old button returns to `/` and no settings-start handler exists.

- [ ] **Step 3: Implement custom continuation**

Import the env/service stores, create `continueCustomBusy = useBusy()`, and implement:

```ts
async function continueWithCustom() {
  err.value = "";
  await continueCustomBusy.run("启动中", async () => {
    try {
      await env.refresh();
      if (!env.serviceRunning) {
        const port = await service.start({ openWebui: false });
        env.setPort(port);
        env.serviceRunning = true;
      }
      if (env.port == null) throw new Error("无法获取本地服务端口");
      await router.replace("/settings");
    } catch (error) {
      err.value = responseMessage(error, "本地服务启动失败");
    }
  });
}
```

Replace only the old secondary button action; keep normal membership login redirects unchanged.

- [ ] **Step 4: Run LoginPage tests and commit**

Run `cd src-tauri/console-app && npx vitest run src/pages/__tests__/LoginPage.test.ts`; expected PASS.

```bash
git add src-tauri/console-app/src/pages/LoginPage.vue src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts
git commit -s -m "feat: continue from login with custom model"
```

### Task 6: Integrated verification and review

**Files:**
- Modify only files identified by failing verification; do not alter `.impeccable/critique/`.

- [ ] **Step 1: Run all feature-focused tests**

Run:

```bash
pytest agent/tests/test_settings_api.py -q
cd src-tauri && cargo test
cd console-app && npx vitest run src/pages/__tests__/ProfilePage.test.ts src/pages/__tests__/LoginPage.test.ts src/ipc/__tests__/commands.test.ts src/stores/__tests__/service.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Run build and static checks**

Run:

```bash
cd src-tauri/console-app && npm run build
cd ../.. && git diff --check
python -m py_compile agent/api_server.py agent/src/api/settings_routes.py
```

Expected: TypeScript/Vite build succeeds, `git diff --check` emits no errors, and Python compilation succeeds.

- [ ] **Step 3: Review behavior against the approved spec**

Confirm manually from the code and tests that: active clients are not recreated; all six VIP process variables are removed; stopped starts pass `None` VIP credentials; failed switches retain auth; ready/not-ready copy is exact; logout routes to `/login`; custom continuation starts quietly and routes to `/settings`; membership-change restart remains unchanged.

- [ ] **Step 4: Commit any verification-only corrections**

Use `git add` for only corrected feature files and `git commit -s -m "fix: verify desktop custom logout flow"`; leave the unrelated `.impeccable/critique/` file untouched.
