# Task 3 Report: Remove Investment News nav item, locale keys, and Vite proxy entry

## Status: DONE

Commit: `a4340f85` feat(frontend): drop investment news nav, locales, and news-api proxy (signed with -s, no AI attribution). 10 files changed, +7/−170.

## What was implemented (per brief, exactly)

1. **Layout test (TDD RED first)** — `frontend/src/components/layout/__tests__/Layout.test.tsx`:
   - Deleted the `/news` test route (`<Route path="/news" ... />`).
   - Replaced "renders the investment news workspace link with active state" with "does not render an investment news nav item while workspace nav stays intact" — asserts `投资资讯` link absent while `自选股 → /watchlist` and `智能体 → /agent` remain.
2. **RED evidence**: `npx vitest run src/components/layout/__tests__/Layout.test.tsx` → 1 failed (absence assertion found the still-rendered 投资资讯 link) | 13 passed.
3. **Layout.tsx**: removed the 7-line `<NavLink to="/news" icon={Newspaper} label={t("layout.news")} ... />` block (old lines 418-424).
4. **GREEN evidence**: same test file → 14 passed.
5. **Locales**: ran the brief's assert-guarded python script verbatim from `frontend/src/i18n/locales`. All five files (en, zh-CN, ar, ja, ko): `removed layout.news + news namespace`, followed by five `valid JSON` lines from `python3 -m json.tool`. No reformatting — surgical regex only (verified: `layout.news` line + trailing top-level `news` namespace removed; diff shows only deletions).
6. **Deleted** `frontend/src/i18n/__tests__/newsLocales.test.ts` via `git rm`.
7. **Vite proxy**: removed `"/news-api",` from `PROXY_PATHS` in `vite.config.ts`; flipped the viteProxy test to `it("no longer proxies the removed news API")` with `not.toContain`.

## Verification

- `npx vitest run src/__tests__/viteProxy.test.ts` → 2 passed.
- Full `npx vitest run`: **23 failed | 557 passed | 9 skipped (589)** — exactly the 23 known pre-existing failures (verified list includes RequireAuth/SetPasswordModal/MetricsCard/ThinkingTimeline/ErrorBoundary/ConnectionBanner/UserMenu/apiUser/formatters/Agent/Usage/Profile/auth stores; zero news/Layout/i18n-related). No new failures.
- `npm run build` → ✓ built in 3.48s (chunk-size warning only, pre-existing).

## Self-review findings

- `Newspaper` import retained in Layout.tsx — still used at lines 64 and 99 (external shortcuts: tencentFinance, wallstreetcn). Confirmed via grep.
- Residual-reference sweep (`grep -rn "news-api|layout.news|newsLocales" src/ vite.config.ts`) → only the intentional negative assertion in viteProxy.test.ts. Clean.
- Third-party shortcut description strings containing "news" (e.g. wallstreetcn descriptions) untouched — the brief's regex was line-anchored and only matched the two target shapes.
- Locale files remain valid JSON with no churn (only deletion hunks in diff).
- `~/.vibe-trading/news.db` never referenced in this change; nothing deleted outside frontend.
- Only `frontend/` staged in the commit; sibling report files (.superpowers/sdd/task-1/2-report.md) left unstaged for the main agent.

## Concerns

None.
