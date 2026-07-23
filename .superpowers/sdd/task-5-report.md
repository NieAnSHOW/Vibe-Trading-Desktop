# Task 5 Report: Scoped Coordinators And Source Outcomes

Date: 2026-07-23

## Scope

Implemented Task 5 in:

- `agent/src/news/coordinator.py`
- `agent/src/api/news_routes.py`
- `agent/api_server.py`
- `agent/tests/news/test_coordinator.py`
- `agent/tests/test_news_routes.py`
- `agent/tests/news/test_end_to_end.py`

The end-to-end test received the minimal v2 storage/catalog migration needed
by the Task 5 required regression command. The unrelated
`frontend/src/pages/Usage.tsx` and Task 4 report changes were not edited or
staged.

## TDD Evidence

### RED

```sh
cd agent && pytest tests/news/test_coordinator.py tests/test_news_routes.py -q
```

Result: failures confirmed that the coordinator did not provide the required
`RefreshStatus.scope`, did not expose `NewsCoordinatorRegistry`, and the
routes still accepted one coordinator rather than a validated scope.

### GREEN

```sh
cd agent && pytest tests/news/test_coordinator.py tests/test_news_routes.py tests/news/test_end_to_end.py -vv --tb=short
```

Result: `21 passed in 33.13s`.

Additional checks:

```sh
cd agent && ruff check src/news/coordinator.py src/api/news_routes.py tests/news/test_coordinator.py tests/test_news_routes.py tests/news/test_end_to_end.py
cd agent && python -m py_compile src/news/coordinator.py src/api/news_routes.py api_server.py
git diff --check
```

Ruff, compilation, and whitespace checks passed. A full Ruff invocation that
includes `api_server.py` still reports its pre-existing `ENV_PATH` F811 at
lines 87 and 149; this task did not change either line.

## Implementation

- Added lazy `NewsCoordinatorRegistry`, with one coordinator per approved
  scope and coordinated shutdown of the created instances.
- Coordinators now use scope-specific snapshot stores, emit scope-bearing
  refresh statuses, and persist schema-v2 snapshots with scope-aware totals.
- Each endpoint result is copied to each of its assignments as a safe public
  source outcome. Success records a timestamp; circuit-open maps to
  `skipped_circuit_open`; stable transport errors map to their public reason;
  unknown failures become `network_error` without disclosure.
- Source outcomes are attached only to their owning track and tests prove that
  every configured assignment has exactly one outcome for its track.
- The HTTP boundary accepts only an optional single `scope` parameter,
  defaults it to `a_share`, rejects repeated/unknown parameters and any body,
  and resolves the registry only after validation.
- `api_server` owns one lazy registry, passes it to the routes, and closes that
  same registry during shutdown.
- The end-to-end regression now uses `AtomicSnapshotStore("global_industry",
  data_dir=...)` and the real scoped catalog, with a no-delay fake transport.

## Independent Review

The independent review identified that a parser-failed assignment was counted
as a failure but inherited its endpoint's successful source outcome. The
regression `test_parser_failure_is_a_failed_source_outcome` first failed with
`success`, then passed after the coordinator carried normalization failures to
the outcome builder and emitted `failed/network_error` with no success time.

The reviewer also noted that v2 model validation permits empty source outcomes
because `AtomicSnapshotStore` deliberately upgrades legacy v1 A-share
snapshots to that compatible form. Tightening that storage/model distinction
requires a separate v2 migration-contract decision, so it is intentionally
outside this Task 5 coordinator/routing change.

## Commit

`feat(news): isolate scoped news refreshes` (signed).
