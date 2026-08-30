# Task 5 Report: Packaging metadata and Tier 0 smoke

**Status:** DONE_WITH_CONCERNS (concern is informational; deliverable contract fully met)
**Commit:** `2f5b1649` — `chore(packaging): drop src.news package data and news smoke assertion` (3 files, 14 deletions, DCO `Signed-off-by` verified, no AI attribution)

## What was implemented

Followed `.superpowers/sdd/task-5-brief.md` exactly:

1. **`scripts/desktop/smoke_tier0.py`** — replaced the try-block body (lines 43–59): kept `import cli` + `from api_server import app` with the success print; dropped the `/news-api/watchlist-feed` route assertion and its inner try/except. Comments at lines 41–42 were already identical to the brief's replacement, so they were left in place (not duplicated).
2. **`pyproject.toml`** — deleted line 94: `"src.news" = ["source_registry.json", ...]` package-data entry.
3. **`MANIFEST.in`** — deleted lines 17–20: the four `include agent/src/news/...` rules.

## Verification commands + output

### Step 4 — smoke script

```
$ python scripts/desktop/smoke_tier0.py
OK   import fastapi
OK   import uvicorn
OK   import pydantic
OK   import langchain
OK   import langgraph
OK   import sse_starlette
OK   import httpx
OK   import rich
OK   import yaml
OK   import dotenv
OK   import requests
OK   import starlette
OK   import websockets
OK   import cli + api_server.app (serve 入口链路顶层就绪)

TIER0 SMOKE PASSED
EXIT=0
```

No route assertion output (expected — removed).

### Step 5 — archive checks

```
$ rm -rf /tmp/vtd-dist && python -m build --sdist --wheel -o /tmp/vtd-dist .
BUILD_EXIT=0
sdist src/news count: 0
wheel src/news count: 0
```

(`python -m build` was available; no pip install fallback needed.)

**Important intermediate finding:** the *first* build reported `wheel src/news count: 13` while sdist was 0. Root cause: stale setuptools intermediates in `build/lib/src/news/` from a pre-removal build were swept into the wheel — `build_py` does not prune files whose sources were deleted. Resolution: confirmed `build/` is gitignored (`.gitignore:70`), removed the stale generated dir (`rm -rf build/` — cache invalidation, not hand-editing generated content), rebuilt → both counts 0. **This means any CI/machine with a stale `build/` dir from before Task 4 will produce a news-contaminated wheel until `build/` is cleaned or CI builds from a fresh checkout.**

## Files changed

- `scripts/desktop/smoke_tier0.py` (−9 lines: route assertion block)
- `pyproject.toml` (−1 line: `src.news` package-data)
- `MANIFEST.in` (−4 lines: four news include rules)

## Self-review findings

- `grep` for `src\.news|src/news` in `pyproject.toml` → no matches.
- `grep` for `news` in `MANIFEST.in` → no matches.
- `grep` for `news|url_path_for` in `smoke_tier0.py` → no matches.
- Remaining "news"-named files in sdist are legitimate and out of scope: `agent/src/tools/stock_news_tool.py` (different feature, still live), `agent/tests/test_stock_news_tool.py`, and `agent/tests/test_news_api_removed.py` (the removal guard test added by an earlier task — intentionally shipped so dev installs can assert the API stays gone).
- Only my three files staged/committed; sibling task-report modifications left untouched.
- Historical records (`docs/superpowers/**`, `openspec/**`, `.superpowers/**`) untouched.

## Concerns

1. **[Informational] Ruff F401** on `from api_server import app` in the smoke script (`app` is now unused after dropping the route check). The brief mandated this exact content; the import is deliberate (side-effect: constructs the serve app). If the project ever gates on ruff, a `# noqa: F401` would be the one-line fix — left as-is per brief.
2. **Stale `build/` hygiene** (documented above): the wheel contamination reproduces on any machine holding a pre-removal `build/` dir. Fresh checkouts / CI are unaffected. No repo change made for this — `build/` is gitignored generated output, and the check itself is the deliverable.
