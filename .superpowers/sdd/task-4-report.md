# Task 4 Report: Remove the backend news pipeline and its wiring

**Status:** DONE
**Commit:** `dc1ddf6e` — `feat(backend): remove investment news pipeline and /news-api wiring` (amended once to strip unintended reformat noise; DCO `Signed-off-by` present, no AI attribution)
**Branch:** feat/v0.1.17 (worked in place)

## What was implemented

Followed the brief's steps 1-11 in order (TDD: RED → delete/unwire → GREEN).

1. **Step 1-2 (RED):** Created `agent/tests/test_news_api_removed.py` (route-table assertion + 8-singleton absence assertion). Ran it pre-removal: `2 failed` — offenders were exactly `/news-api/watchlist-feed`, `/news-api/watchlist-feed/refresh`, and `_feed_store` (first singleton hit). Matches the brief's expected failure.
2. **Step 3:** `git rm` of `agent/src/api/watchlist_feed_routes.py`, `agent/tests/test_watchlist_feed_routes.py`, `agent/tests/test_spa_fallback.py`, recursive `git rm -r agent/src/news agent/tests/news`; removed stale `__pycache__` dirs.
3. **Step 4:** `agent/api_server.py` — SPA 404 branch (old lines 176-178) reduced to the generic `if "text/html" not in _accept_header(scope): return JSONResponse(... 404 ...)`; deleted the entire feed wiring block (old lines 402-437): banner comment, `register_watchlist_feed_routes` import, eight `from src.news...` imports, all eight `_feed_*`/`_flash_aggregator`/`_announcement_collector` singletons, the `register_watchlist_feed_routes(app, ...)` call, `_feed_stop = asyncio.Event()`, and both `@app.on_event("startup")`/`("shutdown")` handlers. File now goes `register_dashboard_routes(app, require_auth=require_auth)` → `# Scheduled Research Routes` banner.
4. **Step 5:** `agent/src/api/security.py` — `_redact_access_log_query` is now the single `return _QUERY_SECRET_RE.sub(r"\1[redacted]", value)` with the "Redact known credential query values" docstring; no `/news-api` path special-case.
5. **Step 6 (GREEN):** `python -m pytest agent/tests/test_news_api_removed.py -q` → `2 passed`.
6. **Step 7:** `agent/tests/test_security_auth_api.py` — removed `from src.news.refresh import RefreshDecision` import (line 14); `from src.api import security` kept. Deleted the nine feed-only tests/helpers: `test_remote_news_api_requires_existing_auth_dependency`, `test_cross_site_news_refresh_is_rejected_before_coordinator_work`, `_accepted_refresh_decision`, `test_vite_origin_can_refresh_across_ports`, `test_unconfigured_loopback_origin_cannot_start_news_refresh`, old news-based `test_custom_cors_origins_do_not_merge_loopback_defaults`, `test_same_origin_request_can_start_news_refresh`, `test_non_browser_request_without_origin_can_start_news_refresh`, `test_remote_trusted_origin_still_requires_api_key`. Kept `test_unconfigured_loopback_origin_cannot_write_watchlist_before_persistence` and `test_watchlist_write_allows_trusted_or_absent_origin`. Added the CORS-merge replacement test on the live `/watchlist/stocks` route verbatim from the brief (`monkeypatch security._CORS_ORIGINS=["http://localhost:5899"]` + `watchlist_routes._get_connection` spy → untrusted Vite loopback origin gets 403 and zero writes).
7. **Step 8:** `agent/tests/test_sse_ticket_and_headers.py` — deleted `test_uvicorn_filter_removes_all_query_values_from_news_api_subroute_access_logs` (old lines 124-139); generic redaction test retained.
8. **Step 9-10:** see verification below.
9. **Step 11:** committed with `git add -A agent && git commit -s`.

## Verification

- **py_compile:** `python -m py_compile agent/api_server.py agent/src/api/security.py` → OK.
- **Focused suite (Step 9 set; watchlist file substituted, see Deviations):** `python -m pytest agent/tests/test_news_api_removed.py agent/tests/test_security_auth_api.py agent/tests/test_sse_ticket_and_headers.py agent/tests/test_spa_static_files_fallback.py agent/tests/test_watchlist_crud.py agent/tests/test_watchlist_routes_skeleton.py -q` → **82 passed, 5 failed**.
  - All 5 failures baseline-verified pre-existing via `git stash push -u` → same tests fail identically on the unmodified tree → `git stash pop`: 2× llm-settings `assert 422 == 200` + 3× `TestClient.__init__() got an unexpected keyword argument 'client'` (the known env drift).
- **Step 10 import sanity:** `python -c "...import api_server; print('app ok, routes:', len(api_server.app.routes))"` → `app ok, routes: 85` (no `ModuleNotFoundError`).
- **Safety tests:** `agent/tests/test_sdk_order_gate.py` + `agent/tests/test_mandate_enforcement.py` → **48 passed**.
- **TDD evidence:** RED `2 failed` (stale routes + `_feed_store`) before removal; GREEN `2 passed` after; full run before commit.

## Files changed (full list, commit dc1ddf6e — 26 files, +46/−3670)

Deleted:
- `agent/src/api/watchlist_feed_routes.py`
- `agent/src/news/__init__.py`, `calendar.py`, `health.py`, `matcher.py`, `refresh.py`, `store.py`, `transport.py`
- `agent/src/news/announcements/__init__.py`, `collector.py`
- `agent/src/news/flash/__init__.py`, `service.py`
- `agent/tests/news/test_announcements.py`, `test_calendar.py`, `test_flash_service.py`, `test_health.py`, `test_matcher.py`, `test_store.py`, `test_transport.py`
- `agent/tests/test_watchlist_feed_routes.py`
- `agent/tests/test_spa_fallback.py` (news-only SPA branch test; `agent/tests/test_spa_static_files_fallback.py` untouched and still passing)

Modified:
- `agent/api_server.py` (SPA branch + feed wiring unwired)
- `agent/src/api/security.py` (single-hunk redaction simplification)
- `agent/tests/test_security_auth_api.py` (9 removals + 1 replacement test)
- `agent/tests/test_sse_ticket_and_headers.py` (news redaction test deleted)

Added:
- `agent/tests/test_news_api_removed.py` (removal contract, 2 tests)

Explicitly preserved (verified untouched via `git status`/`git diff`): `agent/src/tools/stock_news_tool.py`, `agent/tests/test_stock_news_tool.py`, `agent/tests/test_spa_static_files_fallback.py`. `~/.vibe-trading/news.db` was never referenced or deleted — the file simply loses its reader.

## Self-review findings

- **Grep sweep** of `agent/` (excluding `__pycache__`): zero remaining hits for `src.news`, `_feed_`, `watchlist_feed_routes`, `news-api` outside the new contract test's own assertion strings. Remaining "feed" matches are unrelated subsystems (backtest `_event_feed_specs`, rsshub provider, Alpaca `feed` config). No `from src import news` / `import news` alternates. `asyncio` import in api_server still used (line 252 watchlist backfill).
- **Contract met:** zero `/news-api` routes and zero `_feed_*` attributes on `api_server.app` (pinned by the new test); SPA fallback 404s non-HTML purely on Accept; `_redact_access_log_query` has no path special-case; security test file keeps generic Origin guarantees on live routes plus the new CORS-merge test.

## Incidents & deviations

1. **Unintended reformat noise, found and removed (important):** The first commit (`d5647a28`) accidentally included ~5 reformat-only hunks in `agent/src/api/security.py` (expanded `frozenset(...)`, joined log strings, collapsed comprehensions — ruff-format style) that I did not author. Root cause observed: the edit-tool path on this file reapplies a formatter — after I restored the file byte-identical to the parent via `cp` and re-applied only my hunk with the edit tool, the reformat reappeared on disk (verified by grep), though my post-restore read had shown parent formatting. Fix: rebuilt the file from `git show a4340f85:agent/src/api/security.py` + the redaction hunk via a bash/python patch (bypassing the edit path), verified `git diff a4340f85 -- agent/src/api/security.py` shows exactly one hunk, then `git commit --amend -s --no-edit` → final commit `dc1ddf6e` (+46/−3670 vs the noisy +59/−3688). Post-amend checks: committed blob retains parent compact formatting, py_compile OK, focused tests unchanged. **Note for main agent:** any future `edit`-tool hunk on `agent/src/api/security.py` may silently drag in whole-file reformatting; verify `git diff` immediately after editing that file.
2. **Brief's Step 9 filename:** `agent/tests/test_watchlist_routes.py` does not exist in the repo. Substituted the actual watchlist route tests `agent/tests/test_watchlist_crud.py` + `agent/tests/test_watchlist_routes_skeleton.py` (same intent: prove watchlist CRUD untouched — both pass).
3. **First edit hunk numbering:** after the SPA-branch edit shifted lines, the feed-wiring block was re-read and cut at its fresh positions (401-437); likewise the three later news tests in `test_security_auth_api.py` (original 366-416) needed a second cut after the earlier hunks shifted them — LSP flagged the dangling `RefreshDecision` references, which is how they were caught.

## Concerns

- None blocking. The 5 focused-suite failures are pre-existing (stash-baseline proven). The formatter-reapplies-on-edit behavior of `agent/src/api/security.py` is a harness quirk worth remembering, not a repo defect.
