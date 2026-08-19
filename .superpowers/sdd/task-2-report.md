# Task 2 Report: Persist Custom Mode and Coordinate Rust Logout

## RED

Added failing tests for atomic custom-mode persistence, running-service logout success/failure ordering, stopped-service behavior, and VIP environment removal. The initial focused compile/test run failed because the requested helper, orchestration functions, and commands did not yet exist.

## GREEN

Implemented:

- Atomic `auth::persist_custom_mode_and_clear_token_section` using the existing `.env` rewrite and atomic writer.
- Private snake-case Python DTO and public camelCase Tauri readiness view.
- Running-service POST proxy through trusted `SharedPort`.
- Stopped-service provider metadata readiness evaluation with conservative OAuth handling.
- `RuntimeOperationLock` coordination and switch/persistence-before-auth-invalidation ordering.
- Tauri command registration and command manifest entries.
- Explicit removal assertions for all four `VIBE_DESKTOP_VIP_*` variables when no VIP credential is supplied.

## Verification

- Focused auth test: PASS.
- Focused logout tests: PASS (5 tests).
- Focused sidecar environment test: PASS.
- Full `cd src-tauri && cargo test`: PASS (167 unit tests + 97 sidecar tests).

## Changed Files

- `src-tauri/src/auth.rs`
- `src-tauri/src/console.rs`
- `src-tauri/src/main.rs`
- `src-tauri/build.rs`
- `src-tauri/src/sidecar.rs`

## Self-Review

- Failed runtime switch/probe leaves in-memory and persisted authentication intact.
- Successful switch persists custom mode and clears token fields before invalidation.
- Stopped readiness failures degrade to `custom_configured: false` and do not block logout.
- Existing legacy `console_logout` remains unchanged.
- No VIP credential values are persisted or inherited by a custom sidecar start.

## Commit

Recorded with DCO as requested: see the commit hash in the handoff message.

## Concerns

The Tauri generated schema files are modified by concurrent command-manifest generation and were intentionally left unstaged because they are outside this task's ownership; the command allowlist source is updated in `src-tauri/build.rs`.
