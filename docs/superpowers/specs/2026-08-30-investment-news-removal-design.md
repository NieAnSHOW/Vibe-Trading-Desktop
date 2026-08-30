# Investment News Removal Design

- Date: 2026-08-30
- Status: Approved for planning
- Scope: Remove the self-hosted investment-news product surface and its dedicated collection pipeline

## 1. Decision

Vibe Trading Desktop will remove the self-hosted investment-news feed. The product will no longer collect, store, match, paginate, or display a continuously updated news stream.

Third-party financial platforms already provide broader and faster news coverage. Vibe Trading should focus engineering effort on agent reliability and trustworthy real-time market data rather than maintaining a competing news-distribution pipeline.

This decision removes the current product surface. It does not prevent a future, independently designed agent workflow that analyzes cited third-party information in response to a concrete user request.

## 2. Product Behavior

### 2.1 Removed behavior

- Remove the Investment News navigation item.
- Remove the `/news` page and all feed loading, polling, refresh, pagination, source-health, and empty-state behavior.
- Stop exposing the `/news-api/watchlist-feed` and `/news-api/watchlist-feed/refresh` endpoints.
- Stop all background Eastmoney, Sina, SSE, and SZSE news collection tasks.
- Stop creating, updating, or reading `~/.vibe-trading/news.db`.

### 2.2 Retained behavior

- Preserve the watchlist stock shortcut that opens `https://stockpage.10jqka.com.cn/{code}/news`.
- Align that shortcut's icon, tooltip, accessible name, test identifier, and tests with its news destination. It must no longer present itself as a K-line shortcut.
- Preserve the existing general third-party financial-site shortcuts in the application layout.
- Preserve `agent/src/tools/stock_news_tool.py` and its tests. It is an independent, on-demand agent tool and is not part of the removed self-hosted feed.
- Preserve other independent agent capabilities that mention news, including `AStockDataTool`, `get_stock_news`, web search, and event-driven research skill documentation. Keyword matches alone do not place them inside the removal boundary.
- Preserve watchlist CRUD, quotes, charts, selection, and agent-prefill workflows.

### 2.3 Legacy URL compatibility

Keep a route-only compatibility redirect from `/news` to `/watchlist`. The redirect contains no news UI or data behavior and prevents old bookmarks or restored browser history from landing on an error page.

## 3. Removal Boundary

### 3.1 Frontend

Delete:

- `frontend/src/pages/News.tsx`
- `frontend/src/pages/__tests__/News.test.tsx`
- `frontend/src/hooks/useWatchlistFeed.ts`
- `frontend/src/hooks/__tests__/useWatchlistFeed.test.tsx`
- `frontend/src/i18n/__tests__/newsLocales.test.ts`
- `frontend/e2e/news-responsive.spec.ts`
- Feed-specific types, validators, parsers, and API methods in `frontend/src/lib/api.ts`
- Feed parser tests in `frontend/src/lib/__tests__/api.test.ts`

Update:

- Remove the Investment News navigation item and its dedicated `Newspaper` use from `frontend/src/components/layout/Layout.tsx`. The icon import remains if third-party shortcuts still use it.
- Replace the lazy `/news` page route in `frontend/src/router.tsx` with a redirect to `/watchlist`.
- Remove `layout.news` and the top-level feed-specific `news` locale namespace from all five supported locale files: English, Simplified Chinese, Arabic, Japanese, and Korean. Do not remove unrelated uses of the word "news" in third-party shortcut descriptions.
- Rename the watchlist shortcut's K-line-specific label and test identifier to a news-specific label in all supported locales, and update watchlist tests to assert both its accessible name and exact Tonghuashun news URL.
- Remove `/news-api` from the Vite proxy configuration and update its proxy test.
- Update layout tests so they assert that Investment News is absent while the rest of navigation remains intact.

### 3.2 Backend

Delete:

- `agent/src/api/watchlist_feed_routes.py`
- `agent/src/news/` and its dedicated tests under `agent/tests/news/`
- `agent/tests/test_watchlist_feed_routes.py`

Update:

- Remove feed construction, route registration, background collector startup, and collector shutdown from `agent/api_server.py`.
- Remove `/news-api` special handling that existed solely for the deleted endpoints from `agent/api_server.py` and `agent/src/api/security.py`, while preserving generic API-versus-SPA behavior.
- Remove feed-specific cases from shared authentication, header-redaction, and SPA fallback tests. Retain the generic security guarantees by testing another live API route where necessary.
- Remove the `/news-api/watchlist-feed` assertion from `scripts/desktop/smoke_tier0.py`; the smoke test must continue to validate that the serve entry point imports successfully.
- Remove stale `src.news` package-data configuration from `pyproject.toml`.
- Remove the four stale `agent/src/news/*` include rules from `MANIFEST.in`.

### 3.3 Local data and historical documentation

- Do not delete `~/.vibe-trading/news.db` during application startup, upgrade, uninstall, or test execution. The file becomes unused and may be addressed by a future, explicitly authorized cleanup mechanism.
- Keep earlier investment-news specifications, plans, reports, screenshots, and review artifacts as historical decision records.
- This document supersedes the active product direction in `2026-08-29-news-watchlist-refactor-design.md`.
- Remove the active canonical `openspec/specs/investment-news-hub/spec.md`, whose requirements directly contradict this decision. Preserve archived OpenSpec changes as historical records.
- Update active product documentation in `README.md` and any translated README that advertises the self-hosted Investment News workspace, workflow, or screenshot. Historical screenshots under archived review/spec directories may remain.

## 4. Data Flow After Removal

```text
Watchlist stock
    |
    +-- quote and charts --------> existing market-data APIs
    +-- analyze with agent ------> existing agent workflow
    +-- open news shortcut ------> third-party stock news page

No background news collector, local news database, news feed API, or news page remains.
```

## 5. Error Handling and Compatibility

- `/news` performs a client-side replace redirect to `/watchlist`; it must not render a blank page or retain a history-loop entry.
- `/news-api/*` is no longer an application API. Requests must not be silently handled by a stale news router.
- The generic SPA fallback remains responsible for browser navigation. Delete the news-only `agent/tests/test_spa_fallback.py` and retain generic SPA fallback coverage in `agent/tests/test_spa_static_files_fallback.py` rather than preserving a special `/news-api` branch.
- Removing news collectors must not affect FastAPI startup or shutdown of channel and scheduled-research runtimes.
- The watchlist third-party link remains an ordinary validated external `https` link and continues to open outside the embedded application context through the existing external-link handling.

## 6. Verification

### 6.1 Static checks

- Repository search finds no runtime imports or calls for `WatchlistFeed`, `useWatchlistFeed`, `watchlist_feed_routes`, `src.news`, or `/news-api` outside archived OpenSpec changes and historical `docs/superpowers` records.
- Active OpenSpec and README content no longer claim that the self-hosted Investment News product exists.
- Repository search confirms `stock_news_tool.py` and the Tonghuashun watchlist link remain.
- TypeScript strict build, Python compile/import checks, and Python sdist/wheel metadata checks pass without stale news package warnings.

### 6.2 Frontend behavior

- Navigation contains no Investment News item on desktop or responsive layouts.
- Visiting `/news` redirects to `/watchlist`.
- The watchlist Tonghuashun news shortcut targets `/news` under the selected stock page.
- The shortcut uses a news-appropriate icon and exposes a news-appropriate localized accessible name.
- Frontend unit tests and production build pass.

### 6.3 Backend behavior

- Importing `api_server.app` starts no news collector tasks and creates no news service objects.
- News feed routes are absent from the FastAPI route table.
- Existing watchlist, dashboard, authentication, SPA fallback, and desktop Tier 0 smoke tests pass.
- The broader non-live backend test suite passes; no live trading or broker-write validation is performed.

## 7. Non-Goals

- Replacing the feed with a new news provider or source-directory page.
- Adding an AI news-summary or event-intelligence workflow in this change.
- Changing the independent `StockNewsTool` behavior.
- Deleting user data from `~/.vibe-trading/`.
- Refactoring unrelated navigation, watchlist, market-data, or agent code.
