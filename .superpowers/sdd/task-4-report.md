# Task 4 Report - Profile logout UX

Status: **DONE**

## Implemented

- Added readiness preflight via `consoleCustomLlmReadiness()` before opening the logout dialog.
- Added the exact ready/not-ready dialog copy from the desktop logout design, with readiness failures conservatively using not-ready copy.
- Replaced the legacy logout/restart flow with `consoleLogoutToCustom()`, then clears Pinia auth and routes to `/login`.
- Logout no longer stops, starts, or opens the WebUI. Membership-change refresh retains its existing stop/start behavior.
- Added stable `data-test="logout-action"` and `data-test="logout-dialog"` hooks.
- Runtime switch failures keep authentication state and render the command error.

## TDD / Verification

RED: the new ProfilePage tests initially failed because the page had no stable logout hook and still used the old logout path.

GREEN:

```text
cd src-tauri/console-app && npx vitest run src/pages/__tests__/ProfilePage.test.ts
10 passed
```

The suite covers ready and not-ready copy, readiness rejection, coordinated logout success without service lifecycle calls, coordinated logout failure preserving auth, and the existing membership restart regression.

`npx tsc --noEmit -p tsconfig.json` was attempted but is blocked by the repository's existing missing Vue module/type declarations across unrelated pages (including `App.vue`, `LoginPage.vue`, and `ProfilePage.vue` imports).

## Files

- `src-tauri/console-app/src/pages/ProfilePage.vue`
- `src-tauri/console-app/src/pages/__tests__/ProfilePage.test.ts`
