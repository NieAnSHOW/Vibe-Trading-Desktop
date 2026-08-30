# Task 6 Report: Active documentation and OpenSpec spec removal

**Status:** DONE
**Commit:** `a209e2ee` — `docs: remove investment news workspace from active docs and spec`
**Branch:** `feat/v0.1.17` (worked in place, no branch switch)

## What was implemented

### Step 1 — README.md (5 edits, all matched brief line references exactly; no drift)

1. **Line 47** (English summary workspace list): `market workspace (dashboard, anomalies, indices, watchlist, news)` → `market workspace (dashboard, anomalies, indices, watchlist)`.
2. **Line 74** (closed-loop sentence): removed `资讯筛选 → ` from the workflow chain — now `市场看板 → 异动跟踪 → 指数详情 → 自选股一键交给 Agent → 自然语言研究 → 回测验证 → 因子探索`.
3. **Line 85** (research workspace table cell): `Agent 对话、市场数据、资讯、自选股、回测与可视化` → `Agent 对话、市场数据、自选股、回测与可视化`.
4. **Lines 143–150** (preceding blank line + `### 投资资讯` section incl. `assets/light_news.png` screenshot block and description): deleted. Post-delete structure verified: 自选股 description → exactly one blank line → `### AI 研究 Agent` heading.
5. **Line 269** (upstream-comparison table cell): `A 股优先的工作台（看板/异动/自选/资讯）` → `A 股优先的工作台（看板/异动/自选）`.

> **Drift note:** line 269 was listed in the brief's *Files* section but had no explicit numbered step. Applied the obvious semantic edit (drop `/资讯` from the table cell), consistent with the ticket contract requiring no 资讯 mention in table rows. Reported here per instructions.

### Step 2 — Deletions

- `git rm assets/light_news.png` ✔ (orphaned; only README referenced it)
- `git rm -r openspec/specs/investment-news-hub` ✔ (contained only `spec.md`)

### Step 3 — Verification

Brief's grep, verbatim:

```
$ grep -rn "投资资讯\|Investment News\|light_news" README.md README_zh.md README_ja.md README_ko.md README_ar.md openspec/specs/ 2>/dev/null
grep exit: 1
```

Expected no output / exit 1 — **matches**.

Additional self-review checks:

- `git grep -n "light_news"` across tracked files excluding protected paths → no matches (exit 1).
- `ls openspec/specs/ | grep -c investment-news-hub` → `0` (dir fully gone; 10 sibling specs untouched).
- Full `git diff README.md` reviewed: only the 5 semantic edits; no unrelated content removed.
- Blank-line/table structure intact: 自选股 section flows into `### AI 研究 Agent` with exactly one blank line; both edited markdown tables still well-formed (pipe counts unchanged).
- `git status` after commit: only the pre-existing `.superpowers/sdd/task-1..5-report.md` modifications from prior tasks remain (untouched by me; excluded from this commit via scoped `git add`).

### Step 4 — Commit

```
$ git add -A README.md assets openspec/specs
$ git commit -s -m "docs: remove investment news workspace from active docs and spec"
[feat/v0.1.17 a209e2ee] 3 files changed, 4 insertions(+), 208 deletions(-)
```

DCO verified: `Signed-off-by: NieAnSHOW <42022984+NieAnSHOW@users.noreply.github.com>`; no AI attribution.

## Files changed

- `README.md` — 5 edits (4 insertions, 12 deletions incl. section removal)
- `assets/light_news.png` — deleted
- `openspec/specs/investment-news-hub/spec.md` — deleted (dir removed)

## Out-of-scope items verified untouched

- `openspec/changes/archive/**`, `docs/superpowers/**`, `.superpowers/**`, `video/**` — not in diff/status.
- `README_zh.md` / `README_ja.md` / `README_ko.md` / `README_ar.md` — not modified; grep over them returns nothing for the three patterns.
- Unrelated commit `6ec1c170` (pi coding agent design doc) — untouched.
- Pre-existing uncommitted `.superpowers/sdd/task-1..5-report.md` changes — left as-is, not staged.

## Concerns

None blocking. Two cosmetic notes only:

1. Rows 85/261 of their tables now have slightly more trailing cell padding than neighbors (cell content shortened). Repo has no markdown formatter (no prettier config / lint-staged); markdown renders identically, so padding was left untouched rather than restyled.
2. Line 269 had no explicit step in the brief (Files list only) — semantic edit applied as above.
