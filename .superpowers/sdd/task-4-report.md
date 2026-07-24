# Task 4 Report: Article Policy And Bounded Item Retention

Date: 2026-07-23

## Scope

Implemented Task 4 only in:

- `agent/src/news/pipeline.py`
- `agent/tests/news/test_pipeline.py`

The requested report replaces an obsolete report at this path. The unrelated
`frontend/src/pages/Usage.tsx` change was not edited or staged.

## TDD Evidence

### RED

Command:

```sh
pytest agent/tests/news/test_pipeline.py -q
```

Result: collection failed with `ImportError` because `UNDATED_RETENTION` did
not exist. This confirmed the v2 retention contract was absent; the old
pipeline also constructed `FeedItem` without required `article_access` and
`first_seen_at` fields.

### GREEN

Commands:

```sh
pytest agent/tests/news/test_pipeline.py -q
ruff check agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
python -m py_compile agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
git diff --check -- agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
```

Results:

- `12 passed in 0.17s`
- Ruff: `All checks passed!`
- Compilation and whitespace checks passed with no output.

## Implementation

- New normalized items now copy `SourceAssignment.article_access` and record
  `first_seen_at=now`.
- Retained dated items use the existing seven-day `WINDOW`; undated items use
  the seven-day `UNDATED_RETENTION` from `first_seen_at`.
- Fresh merges discard expired prior entries before sorting/capping and keep an
  existing item's original `first_seen_at` when its stable ID reappears.
- Stale-track reconstruction applies the same retention and cap. A stale track
  with no surviving items becomes unavailable.
- The pipeline now supplies v2 `SourceStats` totals and no longer exposes the
  RSS feed URL through `FeedSource`.
- No fetch or article-body request was added; this remains a pure normalization
  and merge path.

## Integration Note

`pytest agent/tests/news -q` currently reports `19 failed, 139 passed, 2
skipped`. The failures are outside Task 4 ownership: coordinator tests still
construct `RefreshStatus` without required `scope`, and LLM enrichment tests
still construct pre-v2 `FeedSource(url=...)`/`FeedItem` values. The focused
Task 4 pipeline suite is green.

## Commit

- `d0ac14b fix(news): expire stale article links` (signed; contains only the
  two Task 4 implementation/test files).

## Review Remediation

Independent review found that an expired undated item could reappear from the
feed with the same stable ID and be assigned a new `first_seen_at`. That made
the item fresh again indefinitely.

### RED

```sh
pytest agent/tests/news/test_pipeline.py -q
```

Result: `1 failed, 16 passed`. The new
`test_expired_undated_stable_reappearance_is_unavailable` received `fresh`
instead of `unavailable`, reproducing the retention bypass.

### Fix

- Use a complete prior-ID map solely to preserve an item's original
  `first_seen_at`, including when its prior version is already expired.
- Filter the merged replacement by retention after timestamp inheritance.
- When all current candidates are expired replacements, emit an unavailable
  track rather than an empty fresh track and do not mark it as updated.

The regression suite also adds explicit coverage for a new item's timestamp,
non-expired stable-ID reappearance, dated stale expiry, and a stale track with
no retention survivors.

### GREEN

```sh
pytest agent/tests/news/test_pipeline.py -q
ruff check agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
python -m py_compile agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
git diff --check -- agent/src/news/pipeline.py agent/tests/news/test_pipeline.py
```

Results: `17 passed in 0.23s`; Ruff, compilation, and whitespace checks
passed.

- `245f919 fix(news): retain expired article timestamps` (signed; contains
  only the two Task 4 implementation/test files).
