# Task 2 Report: Delete News page, feed hook, feed API client, add /news redirect

**Status:** DONE
**Commit:** `3360f18a` — `feat(frontend): remove news page and feed client, redirect /news to /watchlist` (DCO `Signed-off-by: NieAnSHOW`, no AI attribution)
**Branch:** `feat/v0.1.17` (worked in place, no branch switch)

## What was implemented

Followed `.superpowers/sdd/task-2-brief.md` steps exactly:

1. **Redirect test (new):** `frontend/src/__tests__/newsRedirect.test.tsx` — asserts `routes` export from router, `/news` child element is `<Navigate to="/watchlist" replace />` (checks `element.type === Navigate`, `props.to`, `props.replace`).
2. **`frontend/src/router.tsx`:**
   - Deleted `const News = lazy(() => import("@/pages/News"));`
   - Replaced `{ path: "/news", element: wrap(News) }` with `{ path: "/news", element: <Navigate to="/watchlist" replace /> }` (comment: 旧版投资资讯路径：页面已移除（spec 2026-08-30 §2.3），重定向到自选股).
   - Extracted route tree to `export const routes = [...]` (type-inferred `RouteObject[]`); `router = createBrowserRouter(routes)`. Route list otherwise verbatim.
3. **Deletions:** `News.tsx`, `News.test.tsx`, `useWatchlistFeed.ts`, `useWatchlistFeed.test.tsx`, `e2e/news-responsive.spec.ts`, `playwright.config.ts`; `frontend/e2e/` dir removed (vanished with `git rm` of its sole file; explicit `rmdir` confirmed no-op).
4. **`npm uninstall @playwright/test`:** `package.json` devDependency removed; `package-lock.json` entry (`node_modules/@playwright/test`) fully gone. The only remaining `playwright` strings in the lock are `@vitest/browser-playwright` — vitest 4.1.8's own bundled metadata (optional browser-mode integration), unrelated to the removed dep.
5. **`frontend/src/lib/api.ts`:** deleted lines 68–243 (entire feed section: `Feed*` types, `WatchlistFeed`, `FeedRefreshAccepted`, `FEED_*` constants, `invalidFeedResponse`/`feedRecord`/`feedString`/`feedBoolean`/`feedArray`/`feedIsoDate`/`feedHttpUrl`, `parseFeedMatchedStock`/`parseFeedItem`/`parseWatchlistFeedResponse`/`parseFeedRefreshAccepted`) and lines 445–452 (`api.getWatchlistFeed`, `api.refreshWatchlistFeed`). `api` object now ends at `getDashboardIntradayBars`.
6. **`frontend/src/lib/__tests__/api.test.ts`:** import reduced to `import { ApiError } from "../api";`; deleted lines 65–123 (`validFeed` fixture + whole `describe("parseWatchlistFeedResponse")` block, end of file).

**Untouched as contracted (Task 3's):** `Layout.tsx` `/news` nav item + `layout.news` key in locale JSONs; `Layout.test.tsx` (mocks its own `/news` Route, passes). `Watchlist.tsx` uses lucide's `Newspaper` icon — unrelated, kept.

## TDD evidence

**RED** — `cd frontend && npx vitest run src/__tests__/newsRedirect.test.tsx` (before router change):
```
FAIL  src/__tests__/newsRedirect.test.tsx > legacy /news route > redirects to /watchlist with replace semantics
TypeError: Cannot read properties of undefined (reading 'find')
 ❯ src/__tests__/newsRedirect.test.tsx:7:25
Test Files  1 failed (1)   Tests  1 failed (1)
```
(`routes` not exported → undefined.)

**GREEN** — same command after router change:
```
Test Files  1 passed (1)   Tests  1 passed (1)
```

## Verification

- `npm run build` → PASS (tsc strict + vite; pre-existing >500 kB chunk warning only).
- `npx vitest run` (full suite) → **562 passed | 23 failed | 9 skipped**; 4/4 key files green: `newsRedirect.test.tsx`, `api.test.ts`, `Watchlist.test.tsx`, `Layout.test.tsx` (35/35 combined run).
- **Baseline check (`git stash -u` → rerun → pop):** identical 23 failures, same 14 files (RequireAuth, SetPasswordModal, MetricsCard ×2, SwarmStatusCard, ThinkingTimeline ×4, ErrorBoundary, ConnectionBanner ×2, UserMenu, apiUser, formatters ×2, Agent.attempt-completion ×4, Usage ×7, Profile, auth). Baseline totals 613 tests vs 594 after my change — delta of 19 is exactly the deleted feed tests (all had been passing). **My change introduces zero new failures and fixes none of the pre-existing ones.** Stash popped cleanly.
- **Dangling-reference sweep** (`grep` over frontend/src for `pages/News|useWatchlistFeed|WatchlistFeed|parseWatchlistFeed|FeedItem|FeedSource|FeedMatch|FeedRefresh|FEED_|@playwright/test`): zero matches.
- Commit scope: `git add -A frontend` only — the unrelated working-tree modification to `.superpowers/sdd/task-1-report.md` (not mine) was deliberately left unstaged/out of the commit; historical `.superpowers/**` untouched.

## Files changed (12, +22/−1154)

- Deleted: `frontend/src/pages/News.tsx`, `frontend/src/pages/__tests__/News.test.tsx`, `frontend/src/hooks/useWatchlistFeed.ts`, `frontend/src/hooks/__tests__/useWatchlistFeed.test.tsx`, `frontend/e2e/news-responsive.spec.ts` (+ empty `e2e/` dir), `frontend/playwright.config.ts`
- Modified: `frontend/src/router.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/__tests__/api.test.ts`, `frontend/package.json`, `frontend/package-lock.json`
- Added: `frontend/src/__tests__/newsRedirect.test.tsx`

## Self-review findings

- Brief line numbers matched on-disk reality exactly (api.ts 68–243 & 445–452; api.test.ts line 2 & 65–123) — verified by content before cutting.
- `export const routes` has inferred type; redirect test type-checks (`element.type`/`props.to`/`props.replace`) under tsc strict.
- No suppressions, no leftover aliases/shims; clean cutover.
- One tooling hiccup during editing (a multi-section edit momentarily injected a literal `PUT` line into router.tsx) was caught by the editor's parse warning and repaired immediately; final file verified clean by full re-read + successful build/tests.

## Concerns

None blocking. Two observations for the record:
1. Pre-existing failures (23) are stable and unrelated (baseline-proven); the brief's "known pre-existing failures" note covers them. Note the count has grown vs. the 13 previously recorded in project memory — growth happened before this task (present in stash baseline too).
2. `@vitest/browser-playwright` strings remain in `package-lock.json` via vitest's own metadata — not the removed dependency; nothing actionable.
