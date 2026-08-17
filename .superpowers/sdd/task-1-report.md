# Task 1 Report: Rail-aware console shell contract

## RED

Command:

```bash
cd src-tauri/console-app && npm test -- App.test.ts
```

Result: expected failure. The new WebUI-visible and non-standalone-route assertions failed because `shell-content--rail` was absent; the remaining 11 tests passed.

## GREEN

Command:

```bash
cd src-tauri/console-app && npm test -- App.test.ts
```

Result: passed. `App.test.ts` completed with 13 tests passing.

## Files changed

- `src-tauri/console-app/src/App.vue`: added `hasRail` computed state and the `shell-content--rail` class binding.
- `src-tauri/console-app/src/__tests__/App.test.ts`: asserted rail absence on onboarding/login and rail presence on WebUI-visible and non-standalone routes.

## Concerns

None identified. `git diff --check` passed. CSS geometry remains intentionally out of scope for this task.

## Review fix

Changed files:

- `src-tauri/console-app/src/__tests__/App.test.ts`: added a focused regression test proving that opening WebUI from `/login` adds `shell-content--rail`.
- `.superpowers/sdd/task-1-report.md`: recorded this review fix and verification result.

Test command:

```bash
cd src-tauri/console-app && npm test -- App.test.ts
```

Result: passed. `App.test.ts` completed with 14 tests passing.
