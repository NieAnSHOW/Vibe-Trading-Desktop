# Task 1 Report: Rename watchlist shortcut to news link

**Status:** DONE
**Commit:** `7f8e56fa` — feat(watchlist): relabel Tonghuashun shortcut as a news link (DCO signed, no AI attribution)

## What was implemented
- `frontend/src/pages/Watchlist.tsx`:
  - lucide-react import: `CandlestickChart as CandlestickIcon` → `Newspaper` (line 10; the separate `CandlestickChart as CandlestickChartView` chart import on line 17 preserved).
  - Anchor block in `WatchlistStockCard`: title/aria-label now `labels.newsLink`, testid `news-${stock.code}`, icon `<Newspaper size={14} />`. The pre-staged href change (`.../${stock.code}/news`) was kept as instructed.
  - Labels map: `kline: t("watchlist.kline", "同花顺 K 线")` → `newsLink: t("watchlist.newsLink", "同花顺资讯")`.
- `frontend/src/i18n/locales/en.json:1074`: `"kline": "10jqka K-Line"` → `"newsLink": "10jqka News"`.
- `frontend/src/i18n/locales/zh-CN.json:1074`: `"kline": "同花顺 K 线"` → `"newsLink": "同花顺资讯"`.
- `ar/ja/ko` locales untouched (no `watchlist` namespace, per brief).

## TDD evidence
- **RED:** `cd frontend && npx vitest run src/pages/__tests__/Watchlist.test.tsx` after adding the test → `Tests 1 failed | 17 passed (18)` with `Unable to find an element with data-testid="news-000001"` (old testid was `kline-000001`).
- **GREEN:** same command after implementation → `Tests 18 passed (18)`.
- **Build:** `cd frontend && npm run build` → `tsc -b` + vite build succeeded (`✓ built in 3.64s`; pre-existing >500kB chunk warning only).

## Files changed
- frontend/src/pages/Watchlist.tsx
- frontend/src/pages/__tests__/Watchlist.test.tsx (new test added after "renders stock code in its card")
- frontend/src/i18n/locales/en.json
- frontend/src/i18n/locales/zh-CN.json

## Self-review
- No `agent/` files touched. No deletions of news.db, stock_news_tool.py, watchlist CRUD, or third-party shortcuts.
- Test mocks react-i18next so `t()` returns the fallback string; assertions target `同花顺资讯` as specified.
- Commit uses `git commit -s` (Signed-off-by trailer); message contains no AI attribution.

## Concerns
- Minor: the pre-existing working tree already contained ~100 lines of whitespace-only reindentation in `Watchlist.tsx` (StockDetailSection block) alongside the pre-staged href hunk. Committed as handed to me rather than reverting unknown prior work, so the commit carries some formatting churn.
