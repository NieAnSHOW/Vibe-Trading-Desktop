# Desktop Logout and Custom LLM Continuity

## Goal

Let a desktop user sign out of the membership account without restarting the
local service or interrupting work already in progress. After sign-out, new
work uses the user's saved custom LLM configuration. A user without a usable
custom configuration can go directly from the login screen to the console
settings page to create one.

## Current Behavior

`ProfilePage.vue` clears the Rust-held login state, stops the Python sidecar,
starts it again, then navigates to the console root. This interrupts active
research work solely to remove a membership session.

The sidecar receives membership credentials as process-only environment
variables. Clearing the Rust session alone therefore does not remove the
credentials from a sidecar that is already running.

## Product Decisions

- A task already started with a membership model may finish after logout.
- The local service must not restart as part of logout.
- New tasks must use custom LLM settings after logout; they must not use
  membership credentials.
- Logout succeeds even when custom LLM settings are incomplete.
- When custom settings are incomplete, the UI must state that new work cannot
  run until the user configures a custom model.
- The login page offers `使用自定义模型继续`, not `回到首页` or `跳过登录`.
- Choosing that action goes directly to `/settings`. If the service is not
  running, the application starts it in custom mode before navigating.

## Architecture

### Sidecar Runtime Switch

Add a local settings operation for exiting membership mode. It is invoked by a
Rust command, not directly by the WebUI. The Rust layer also owns the
service-stopped branch, where there is no Python process to update.

The operation reads the persisted custom settings in the user `.env`, then:

1. Writes `DESKTOP_LLM_MODE=custom`.
2. Applies the saved provider, model, base URL, and key to the running Python
   process using the existing custom runtime synchronization logic.
3. Removes all active VIP provider variables and all desktop VIP injection
   variables from the Python process environment.
4. Returns a redacted status containing whether the custom model setup is
   usable. It must never return a custom API key or membership credential.

When the service is stopped, Rust writes `DESKTOP_LLM_MODE=custom` directly
using the existing desktop environment-file helpers and evaluates the same
redacted custom-readiness rules. A future service start then skips membership
credential injection and loads the persisted custom settings.

Existing work is not cancelled. It may retain the membership-model client it
created before the switch; work created after the switch resolves the custom
runtime configuration.

### Logout Orchestration

The console exposes:

- A read-only custom-readiness command used before the confirmation dialog is
  opened. It reads saved custom settings without exposing their values.
- One logout-to-custom command which coordinates the runtime switch and
  clearing the desktop login session.

The logout command first switches or persists custom mode. Only after that
succeeds does it clear the Rust-held session and persisted login-token section.
This prevents a runtime-switch failure from signing the user out while leaving
the running sidecar in VIP mode.

`ProfilePage` loads readiness before showing the dialog, calls the coordinated
logout command after confirmation, clears its Pinia auth presentation state,
and replaces the route with `/login`.

`ProfilePage` must not call `consoleStopService`, `consoleStartService`, or
open the WebUI during logout.

The membership logout dialog uses the preflight custom-readiness state:

- Ready: `退出后，正在运行的会员任务将继续完成；后续任务将使用本机自定义模型配置。`
- Not ready: `退出后，正在运行的会员任务将继续完成；后续任务需要先配置本机自定义模型，否则无法执行。`

### Continue With Custom Model

The login-page secondary action is renamed to `使用自定义模型继续`.

When selected:

1. If the local service is already running, navigate to `/settings`.
2. Otherwise start it using the existing custom-mode service path, which does
   not attempt membership credential injection, then navigate to `/settings`.
3. If startup fails, remain on the login page and show the failure. Do not
   navigate to settings without a service port.

The existing settings page remains the single editor for provider, model,
base URL, and API key. It can load defaults and accept a new custom setup even
when no valid custom API key existed before startup.

## Error Handling

- A readiness check failure uses the conservative not-ready dialog copy; it
  does not block the user from attempting logout.
- A runtime switch or custom-mode persistence failure must not present the
  logout as successful. The UI retains the account state and shows the command
  error.
- A custom configuration that lacks a required key is a valid signed-out
  state, not a logout failure. It is reported as not ready and guided to the
  settings page.
- Service startup for the settings route is independent of membership login;
  it runs with the persisted custom mode and without injected VIP credentials.

## Tests

- Python settings tests cover persistence of custom mode, process-environment
  cleanup of every VIP variable, redacted readiness reporting, and both ready
  and incomplete custom configurations.
- Rust console tests cover readiness without exposing secrets, coordinated
  logout while the service is running, custom-mode persistence while it is
  stopped, and verification that a later sidecar start has no VIP credential
  available.
- `ProfilePage` tests verify no service stop/start, correct modal copy for
  both readiness states, auth-state clearing, and navigation to `/login`.
- `LoginPage` tests verify the renamed action, direct navigation when running,
  start-then-navigate when stopped, and error handling when startup fails.

## Out of Scope

- Cancelling work that was already started with a membership model.
- Revoking a provider request that has already left the local process.
- Changing the general WebUI LLM settings editor or its provider catalog.
