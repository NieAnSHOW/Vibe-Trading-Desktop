# Task 7: Full Verification Sweep Report

- **Date:** 2026-08-30
- **Branch:** `feat/v0.1.17` @ `a209e2ee` (docs: remove investment news workspace from active docs and spec)
- **Scope:** verification only — mirrors design-spec §6.1–§6.3. No fixes applied; findings reported to controller.
- **Python interpreter sanity:** `python3 -c "print('ok')"` → `ok`; `python -c "print('ok')"` → `ok`.

## Verdict summary

| # | Check | Verdict |
|---|-------|---------|
| 1 | Static banned-token search | **FINDINGS (2)** — both are intentional absence-guard tests; see F-1/F-2 |
| 2 | Retained-behavior search | PASS |
| 3 | Frontend full gate (build + vitest) | PASS (23 failures = exact Task-2 baseline; must-be-green list all green) |
| 4 | Backend full non-live gate (compile + broad pytest + safety tests) | PASS (86 failing items byte-identical to pre-change baseline; safety tests 48/48) |
| 5 | Tier 0 smoke | PASS (`TIER0 SMOKE PASSED`, exit 0) |
| 6 | news.db non-touch grep | PASS (zero matches) |

**Overall: no regression findings. Two informational findings on Step 1 (guard tests mentioning the banned token by design).**

---

## Step 1: Static banned-token search — FINDINGS (informational)

Command (verbatim from brief):

```
grep -rn "WatchlistFeed\|useWatchlistFeed\|watchlist_feed_routes\|src\.news\|news-api" \
  --include="*.py" --include="*.ts" --include="*.tsx" --include="*.json" \
  --include="*.md" --include="*.yml" --include="*.toml" --include="*.in" --include="*.mjs" --include="*.sh" . \
  | grep -v node_modules | grep -v ".desktop-build" | grep -v "src-tauri/target" | grep -v "^./build/" \
  | grep -v "openspec/changes/archive" | grep -v "docs/superpowers" | grep -v ".superpowers" \
  | grep -v "__pycache__" | grep -v package-lock.json | grep -v "video/"
```

Observed output (2 lines; brief expected none):

```
./frontend/src/__tests__/viteProxy.test.ts:15:    expect(config).not.toContain('"/news-api"');
./agent/tests/test_news_api_removed.py:10:    offenders = {path for path in paths if path == "/news-api" or path.startswith("/news-api/")}
```

### F-1: `frontend/src/__tests__/viteProxy.test.ts:15`
- **What:** negative assertion `expect(config).not.toContain('"/news-api"')` inside the test *"no longer proxies the removed news API"* (Task 2's updated guard for the vite proxy).
- **Assessment:** mentions the banned token solely to assert its absence. Not live feature code. The token also appears in this test's name/description but only line 15 matched the grep.

### F-2: `agent/tests/test_news_api_removed.py:10`
- **What:** removal-contract test (docstring: *"Removal contract (spec 2026-08-30 §6.3): no news feed routes or singletons"*) asserting `offenders == set()` over `api_server.app.routes`; second test asserts the 8 feed singletons are gone.
- **Assessment:** deliberate spec-mandated guard; the token appears only in the absence check.

**Recommendation to controller:** both are intentional absence-guards required by spec §6.3; the brief's "no output" expectation was over-strict. No action needed unless the controller wants the greps satisfied literally (would require deleting the guard tests — not recommended). Not fixed per verification-only constraint.

---

## Step 2: Retained-behavior search — PASS

Command:

```
ls agent/src/tools/stock_news_tool.py agent/tests/test_stock_news_tool.py && \
grep -c "stockpage.10jqka.com.cn/\${stock.code}/news" frontend/src/pages/Watchlist.tsx && \
grep -c "Newspaper" frontend/src/components/layout/Layout.tsx
```

Observed:

```
agent/src/tools/stock_news_tool.py
agent/tests/test_stock_news_tool.py
1
3
```

Verdict: both retained files listed; per-stock news-link count `1` (expected 1); `Newspaper` count `3` (expected ≥2: icon import + shortcut uses). `StockNewsTool` untouched by design. ✓

---

## Step 3: Frontend full gate — PASS

### Build
Command: `cd frontend && npm run build`

Observed (tail): `✓ built in 3.64s`, `BUILD_EXIT=0` (chunk-size warning only, pre-existing).

### Full suite
Command: `cd frontend && npx vitest run` (log: `/tmp/t7-vitest.log`)

Observed: **Test Files 14 failed | 55 passed (69) — Tests 23 failed | 557 passed | 9 skipped (589)**

- 23 failures = exact count of the Task-2 stash-verified pre-existing baseline.
- Failed files are all outside the news/watchlist surface: RequireAuth, SetPasswordModal, MetricsCard (×2), SwarmStatusCard, ThinkingTimeline (×4), ErrorBoundary, ConnectionBanner (×2), UserMenu, apiUser, formatters (×2), Agent.attempt-completion (×4), Usage (×8), Profile, auth store.

### Must-be-green list (brief requirement)
Full-suite reporter only prints failures, so the 7 files were run explicitly:

`npx vitest run src/pages/__tests__/Watchlist.test.tsx src/pages/__tests__/newsRedirect.test.tsx src/components/layout/__tests__/Layout.test.tsx src/lib/__tests__/api.test.ts src/__tests__/viteProxy.test.ts src/i18n/__tests__/i18n.test.ts src/i18n/__tests__/locales.test.ts`

Observed: `Test Files 6 passed (6) — Tests 58 passed | 9 skipped (67)` plus a separate `npx vitest run newsRedirect` → **1 file, 1 test passed** (`newsRedirect.test.tsx` was not picked up by the multi-path invocation — invocation quirk only; it passes standalone).

All 7 must-be-green files green: Watchlist ✓ newsRedirect ✓ Layout ✓ api ✓ viteProxy ✓ i18n ✓ locales ✓

Verdict: PASS — no new frontend failures.

---

## Step 4: Backend full non-live gate — PASS

### Compile
Command: `python -m compileall -q agent/cli && python -m py_compile agent/api_server.py agent/mcp_server.py`
Observed: no output, `COMPILE_OK`. ✓

### Broad suite
Command:

```
python -m pytest --ignore=agent/tests/e2e_backtest \
       --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q
```

Observed (log: `/tmp/t7-pytest.log`): **60 failed, 5361 passed, 10 skipped, 26 errors in 108.06s** (exit 1)

### Baseline comparison (decisive)
The brief's baseline is approximate ("~62"), and `test_api_infrastructure::test_api_server_is_thin_assembler` is api_server-structural (news-adjacent), so a strict comparison was run: detached worktree at pre-change base `6ec1c170`, same command (log: `/tmp/t7-pytest-baseline.log`).

- Baseline: 60 failed, 5359 passed, 12 skipped, 26 errors
- Failure/error name sets diffed (`comm` on `FAILED|ERROR` ids, 86 = 86): **zero new, zero gone — byte-identical sets.**

All 86 failing items are pre-existing env/baseline failures:
- 66 × `TypeError: TestClient.__init__() got an unexpected keyword argument 'client'` (known starlette/httpx kwarg drift) — e.g. test_api_live_runtime (13), test_alpha_compare_api (7), test_goal_api (4), test_channels_api (4), test_sse_ticket_and_headers (3), test_settings_api (3), test_user_api_proxy (3, known-stale pre-change), test_correlation (2), test_security_auth_api (2), test_upload_api (2), test_web_reader_security (1), test_upload_security errors (16)
- 1 × `test_api_infrastructure::test_api_server_is_thin_assembler` — `api_server.py has 685 lines, expected < 400`; **fails identically at the pre-change base** (line-count threshold long exceeded; news removal only shrank the file further from that state)
- remainder: loader-registry/env-dependent assertions (test_registry ×6, test_sina/mootdx/tiingo/fmp_loader, test_dotenv_observability, test_security_scanner, test_factor_operators) — all present in baseline set

(Worktree removed after comparison; main tree untouched.)

### Safety-critical narrow tests
Command: `python -m pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q --tb=short`
Observed: **48 passed, 1 warning in 5.26s** ✓

Verdict: PASS — no new backend failures vs. baseline.

---

## Step 5: Tier 0 smoke — PASS

Command: `python scripts/desktop/smoke_tier0.py`

Observed: 13 × `OK   import …` lines (fastapi, uvicorn, pydantic, langchain, langgraph, sse_starlette, httpx, rich, yaml, dotenv, requests, starlette, websockets) + `OK   import cli + api_server.app (serve 入口链路顶层就绪)` → **`TIER0 SMOKE PASSED`**, `SMOKE_EXIT=0`. ✓

(The news smoke assertion dropped in Task 6 commit `2eac0093` is confirmed absent — the script no longer references news.)

---

## Step 6: news.db non-touch grep — PASS

Command: `grep -rn "news\.db" agent/ scripts/ --include="*.py" | grep -v __pycache__`

Observed: no output (grep exit 1 = zero matches).

Verdict: nothing in the repo references or deletes `news.db`; the on-disk user data file is left untouched per spec §3.3. ✓

---

## Findings list

| ID | Check | Evidence | Impact |
|----|-------|----------|--------|
| F-1 | Step 1 static search | `frontend/src/__tests__/viteProxy.test.ts:15` — negative assertion `not.toContain('"/news-api"')` | Informational: intentional absence-guard test (Task 2), not a remnant. No action recommended. |
| F-2 | Step 1 static search | `agent/tests/test_news_api_removed.py:10` — removal-contract test asserting no `/news-api` routes/singletons | Informational: spec §6.3-mandated guard test, not a remnant. No action recommended. |

**Regression findings: none.** Every gate (frontend, backend, safety, smoke) matches or beats its documented pre-change baseline; retained behaviors verified; user data (`news.db`) untouched.

## Notes
- No commits made (verification-only; nothing fired that required a fix).
- Ephemeral artifacts: `/tmp/t7-vitest.log`, `/tmp/t7-pytest.log`, `/tmp/t7-pytest-baseline.log`, `/tmp/t7-fail-{current,baseline}.txt` (full-suite logs kept for evidence; baseline worktree removed).
