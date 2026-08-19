# Task 5 Report: Login Custom Continuation

## Implementation

- Replaced the login footer's old home-route action with `使用自定义模型继续` (`data-test="continue-custom"`).
- The action refreshes the local environment, starts a stopped service through `useServiceStore.start({ openWebui: false })`, synchronizes the returned port into `useEnvStore`, and routes to `/settings`.
- A running service is reused without another start or any WebUI-open IPC call.
- Startup errors remain on `/login` and use the existing alert UI.
- Normal SMS, password, and registration redirects remain unchanged.

## TDD Evidence

RED, before production changes:

```text
LoginPage.test.ts: 3 failed, 14 passed
Unable to get [data-test="continue-custom"]
```

GREEN, after implementation:

```text
npx vitest run src/pages/__tests__/LoginPage.test.ts
17 passed
```

## Verification

```text
npx vitest run src/pages/__tests__/LoginPage.test.ts
17 passed

npm run build
vue-tsc --noEmit && vite build
success
```

## Files

- `src-tauri/console-app/src/pages/LoginPage.vue`
- `src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts`
