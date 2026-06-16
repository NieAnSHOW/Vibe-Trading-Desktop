# Verification Report — fix-spa-staticfiles-api-fallback

- **Date**: 2026-06-14
- **Change**: `fix-spa-staticfiles-api-fallback` (comet hotfix)
- **Workflow**: hotfix → open → build → verify
- **verify_mode**: `light` (manually overridden from auto `full`; see rationale below)

## Scope override rationale

`comet-state scale` auto-assessed `full` (Tasks 5 > 3; Changed files 7 > 4). Manual
override to `light` because the 7-file / 5-task counts are inflated by **change
metadata** (proposal/design/tasks/.openspec.yaml/.comet.yaml = 5 files) and **verification
sub-tasks** (1.3, 2.1, 2.2 are run-the-checks steps, not implementation). The true
change footprint is **2 code files**, 0 delta spec, 0 cross-module coordination — a
single-method fallback fix. This matches the hotfix rule "small no-delta-spec hotfix →
light". Override is explicitly permitted by comet-verify Step 1.

## Root cause (recap, systematic-debugging Phase 1)

The user-reported desktop error `加载可选依赖失败: JSON Parse error: Unrecognized token '<'`
has **two layers**:

1. **Trigger (not a code bug)**: the desktop bundle (`.desktop-build/agent`) and runtime
   copy (`~/.vibe-trading/runtime/agent`) are a **stale 6/12 assemble** that predates the
   `optional_deps` implementation (6/14). `runtime marker == bundle VERSION`
   (`de48ae9-20260613163311`), so `version.rs::decide` returns `Reuse` and the runtime
   never upgrades. Core fix = re-run `assemble.sh` + repackage (out of this hotfix's code
   scope; user opted to do separately).
2. **Code defect fixed here**: `SPAStaticFiles.get_response` fell back to `index.html`
   (HTML) for **every** 404, including unknown API paths. A stale backend missing an API
   route therefore returned HTML, and the frontend's `JSON.parse` threw
   `Unrecognized token '<'` — an opaque error hiding the real cause.

## Change made

- `agent/api_server.py`: `SPAStaticFiles.get_response` 404 branch now checks the request
  `Accept` header (via new module-level `_accept_header(scope)` helper). Browser
  navigation (`Accept: text/html`) still gets the SPA shell; API callers
  (`application/json` / `*/*`) get `JSONResponse({"detail":"Not Found"}, 404)`.
  `SPAStaticFiles` lifted from inside `serve_main` to module scope for testability.
- `agent/tests/test_spa_static_files_fallback.py`: new regression tests.

## Light verification — 5 checks

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | tasks.md all complete | PASS | `done=5 pending=0` |
| 2 | code diff matches tasks | PASS | `api_server.py +57/-14`, `test_spa_static_files_fallback.py +87`; no scope creep |
| 3 | compile passes | PASS | `compileall agent/cli` + `py_compile api_server.py mcp_server.py` → exit 0 |
| 4 | relevant tests pass | PASS | `19 passed, 2 warnings` (5 new + 13 spa_deep_link + 1 optional_deps) |
| 5 | no secrets / unsafe | PASS | diff scan for api_key/secret/password/token/eval/exec/os.system/shell=True/unsafe → no hits |

## TDD red-green evidence (systematic-debugging Phase 4)

The new tests genuinely capture the bug: temporarily reverting the fix to the
pre-fix unconditional fallback made the two API-fallback tests **FAIL**:

```
FAILED test_unknown_api_path_returns_json_404_not_html
FAILED test_wildcard_accept_returns_json_404
2 failed, 3 passed
```

Restoring the fix → `19 passed`. The browser-navigation, static-asset, and helper tests
are unaffected by the fix (correctly).

## Regression

- `test_spa_deep_link.py` (the separate `_spa_html_deep_link_fallback` middleware
  matcher): 13 passed — the middleware is untouched.
- `test_api_server_optional_deps.py` (optional-deps mount + list): 1 passed.
- Pre-existing ruff `E402` at `api_server.py:2285` (`optional_deps_router` import) is
  unrelated to this change (introduced by the archived desktop-runtime-deps-on-demand
  change). No new lint findings in the edited regions.

## Out of scope (user action required)

This hotfix makes version-mismatch failures **diagnosable** (JSON 404 instead of opaque
HTML), but does **not** restore the missing `/optional-deps` routes on the desktop
build. To make the feature actually work the user must, separately:

```bash
bash scripts/desktop/assemble.sh   # rebuilds bundle WITH optional_deps + fresh VERSION timestamp
# repackage desktop (cargo tauri build / dev)
# launch: new VERSION != runtime marker → Upgrade → runtime gets optional_deps
```

## Result

**PASS** — all 5 light checks green, 0 CRITICAL. Ready for branch handling and archive.
