# Agent Reliability Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliability runtime that reduces wrong-tool calls, repairs safe argument/data failures, executes independent research steps efficiently, and blocks unsupported claims without replacing the existing `AgentLoop` or trading safety gates.

**Architecture:** Add a focused `src/reliability/` package containing typed step/error contracts, capability routing, bounded planning, the tool gateway, and evidence verification. Keep `AgentLoop` as the initial executor and preserve `SessionService`, SSE, run artifacts, MCP policy, mandate enforcement, kill switch, order gate, and audit ledger. Integrate behind a feature flag and migrate in small independently tested slices.

**Tech Stack:** Python 3.11+, Pydantic 2, existing `BaseTool`/`ToolRegistry`, FastAPI SSE `EventBus`, pytest, existing telemetry counters, optional provider/data-loader caches. No new runtime dependency is required for the first implementation.

## Global Constraints

- Keep all side-effecting and live-trading actions behind the existing Python mandate, kill-switch, order-gate, and audit-ledger paths.
- Never automatically retry an order, cancellation, broker write, or other side-effecting tool.
- Preserve existing `/sessions/{session_id}/messages`, `/sessions/{session_id}/events`, attempt/run, and frontend SSE event contracts.
- Keep shell tools disabled for network/API entry points unless the existing explicit operator policy enables them.
- Do not add a Rust or third-party CLI dependency before profiling demonstrates a deterministic CPU or process-supervision hotspot.
- Every new behavior must have deterministic tests and a feature-flagged rollout path before becoming the default.

---

## File Map

### New files

- `agent/src/reliability/__init__.py` — public exports for reliability contracts and runtime components.
- `agent/src/reliability/contracts.py` — enums and dataclasses for routes, plans, step results, typed errors, evidence, and execution reports.
- `agent/src/reliability/router.py` — deterministic capability routing and tool allowlist selection.
- `agent/src/reliability/planner.py` — bounded typed plan validation and dependency/DAG utilities.
- `agent/src/reliability/gateway.py` — argument normalization, policy checks, retry/fallback decisions, result envelopes, and tool invocation delegation.
- `agent/src/reliability/evidence.py` — evidence references, artifact/metric validation, claim verification, and verified synthesis input.
- `agent/src/reliability/runtime.py` — orchestration of router, planner, gateway, executor, budgets, and verifier.
- `agent/tests/test_reliability_contracts.py` — contract serialization and state-transition tests.
- `agent/tests/test_reliability_router.py` — capability routing and allowlist tests.
- `agent/tests/test_reliability_planner.py` — plan validation, budgets, and dependency tests.
- `agent/tests/test_reliability_gateway.py` — argument, timeout, fallback, retry, and side-effect policy tests.
- `agent/tests/test_reliability_evidence.py` — artifact, metric, stale/partial evidence, and claim tests.
- `agent/tests/test_reliability_runtime.py` — end-to-end orchestration with fake tools/LLM and fault injection.

### Existing files to modify

- `agent/src/session/service.py` — construct and invoke the reliability runtime behind an opt-in flag while preserving the existing executor path.
- `agent/src/agent/context.py` — accept a capability/tool allowlist so only selected tool definitions are rendered.
- `agent/src/agent/loop.py` — expose a narrow executor callback or gateway hook without changing live safety behavior; preserve current retry/cancel semantics.
- `agent/src/agent/tools.py` — expose read/write metadata and stable definitions needed by the gateway; do not weaken unknown-tool behavior.
- `agent/src/tools/__init__.py` — support metadata-only registry reuse and session-bound instance overlays without sharing mutable state.
- `agent/src/telemetry/counters.py` — add redacted reliability counters and phase timing aggregates.
- `agent/tests/test_session_service_mcp.py` and `agent/tests/test_session_events.py` — preserve registry-build responsiveness and SSE compatibility.
- `agent/tests/test_agent_loop_trace.py`, `agent/tests/test_tool_timeout.py`, and safety-critical live tests — regression coverage for unchanged current behavior.

---

## Task 1: Add baseline reliability telemetry and trace fields

**Files:**
- Modify: `agent/src/telemetry/counters.py`
- Modify: `agent/src/agent/loop.py`
- Modify: `agent/src/session/service.py`
- Create: `agent/tests/test_reliability_telemetry.py`

**Interfaces:**
- Produces `counters.record_reliability_phase(phase: str, elapsed_ms: int)` and `counters.record_reliability_event(name: str, value: int = 1)`.
- Produces trace-safe baseline fields: `registry_build_ms`, `agent_loop_ms`, `tool_ms`, and `tool_error_code`. Later reliability components add their own phase fields through the same counters.
- Does not change existing telemetry response keys; adds a `reliability` object only.

- [ ] **Step 1: Write failing telemetry tests**

```python
def test_reliability_snapshot_contains_phase_timings():
    counters.reset_for_test()
    counters.record_reliability_phase("router", 12)
    counters.record_reliability_event("recovery_success")
    snapshot = counters.snapshot()
    assert snapshot["reliability"]["phase_ms"] == {"router": 12}
    assert snapshot["reliability"]["events"] == {"recovery_success": 1}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pytest agent/tests/test_reliability_telemetry.py -q`

Expected: FAIL because the reliability counter methods and snapshot section do not yet exist.

- [ ] **Step 3: Implement the minimal thread-safe counters**

Add separate dictionaries to `_Counters`, reset them in `reset_for_test`, include them in `snapshot`, and expose module-level aliases. Keep all payloads numeric or allowlisted strings; never record prompts, raw tool arguments, credentials, or response text.

- [ ] **Step 4: Instrument existing phase boundaries**

Use `time.perf_counter()` around `build_registry` and `AgentLoop.run` in `SessionService._run_with_agent`, and around each existing tool invocation in `AgentLoop._invoke_tool`. Emit only elapsed values and error codes. Do not alter execution order or timeout behavior.

- [ ] **Step 5: Run telemetry and regression tests**

Run: `pytest agent/tests/test_reliability_telemetry.py agent/tests/test_telemetry_api.py agent/tests/test_session_service_mcp.py -q`

Expected: PASS; existing `/telemetry/sidecar-metrics` responses remain backward compatible.

- [ ] **Step 6: Commit**

```bash
git add agent/src/telemetry/counters.py agent/src/agent/loop.py agent/src/session/service.py agent/tests/test_reliability_telemetry.py
git commit -s -m "feat: instrument reliability runtime phases"
```

## Task 2: Define typed reliability contracts

**Files:**
- Create: `agent/src/reliability/__init__.py`
- Create: `agent/src/reliability/contracts.py`
- Create: `agent/tests/test_reliability_contracts.py`

**Interfaces:**

Define these exact public types:

```python
class StepStatus(str, Enum):
    SUCCESS = "success"
    PARTIAL = "partial"
    RECOVERABLE_ERROR = "recoverable_error"
    BLOCKED = "blocked"
    UNSAFE_ERROR = "unsafe_error"
    CANCELLED = "cancelled"

class ErrorCode(str, Enum):
    INVALID_ARGUMENT = "invalid_argument"
    AMBIGUOUS_SYMBOL = "ambiguous_symbol"
    DATA_UNAVAILABLE = "data_unavailable"
    PROVIDER_TIMEOUT = "provider_timeout"
    AUTH_REQUIRED = "auth_required"
    SCHEMA_MISMATCH = "schema_mismatch"
    UNSAFE_SIDE_EFFECT = "unsafe_side_effect"
    BUDGET_EXCEEDED = "budget_exceeded"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"

@dataclass(frozen=True)
class ToolError:
    code: ErrorCode
    message: str
    retryable: bool = False
    fallback: str | None = None
    repair_hint: str | None = None

@dataclass(frozen=True)
class EvidenceRef:
    source_type: str
    source_id: str
    field: str | None = None
    as_of: str | None = None

@dataclass(frozen=True)
class StepResult:
    step_id: str
    status: StepStatus
    data: object | None = None
    error: ToolError | None = None
    evidence: tuple[EvidenceRef, ...] = ()
    provider: str | None = None
    elapsed_ms: int = 0

@dataclass(frozen=True)
class CapabilityRoute:
    intent: str
    capabilities: tuple[str, ...]
    allowed_tools: tuple[str, ...]
    complexity: str
    budgets: dict[str, int]
```

- [ ] **Step 1: Write serialization and invariant tests**

Cover enum wire values, JSON-safe conversion, rejection of an error-free
`recoverable_error`, rejection of a `success` result with malformed evidence,
and preservation of empty optional fields.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pytest agent/tests/test_reliability_contracts.py -q`

Expected: FAIL because the reliability package does not exist.

- [ ] **Step 3: Implement Pydantic/dataclass contracts**

Use the repository's Pydantic 2 conventions for externally serialized models.
Keep internal immutable evidence and error objects deterministic and redactable.
Implement `to_wire()` methods rather than serializing arbitrary exceptions.

- [ ] **Step 4: Run focused and type/syntax checks**

Run: `pytest agent/tests/test_reliability_contracts.py -q && python -m py_compile agent/src/reliability/contracts.py`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/reliability agent/tests/test_reliability_contracts.py
git commit -s -m "feat: add reliability result contracts"
```

## Task 3: Implement capability routing and bounded plan validation

**Files:**
- Create: `agent/src/reliability/router.py`
- Create: `agent/src/reliability/planner.py`
- Create: `agent/tests/test_reliability_router.py`
- Create: `agent/tests/test_reliability_planner.py`
- Modify: `agent/src/agent/context.py`

**Interfaces:**

```python
class TaskRouter:
    def route(self, user_message: str, tool_names: Sequence[str]) -> CapabilityRoute: ...

class PlanStep(BaseModel):
    id: str
    capability: str
    tool: str | None = None
    depends_on: list[str] = Field(default_factory=list)
    expected_fields: list[str] = Field(default_factory=list)
    retry_limit: int = 0
    timeout_seconds: float = 30.0
    side_effecting: bool = False

class ExecutionPlan(BaseModel):
    steps: list[PlanStep]
    budgets: dict[str, int]

class PlanValidator:
    def validate(self, plan: ExecutionPlan, route: CapabilityRoute) -> None: ...
    def ready_steps(self, plan: ExecutionPlan, completed: set[str]) -> list[PlanStep]: ...
```

- [ ] **Step 1: Write routing tests**

Test that a market-data request includes market-data/symbol capabilities,
excludes live-trading tools, and that an unknown or ambiguous intent returns a
safe minimal route rather than the full registry. Test stable ordering of
allowlisted tool names.

- [ ] **Step 2: Run routing tests to verify failure**

Run: `pytest agent/tests/test_reliability_router.py -q`

Expected: FAIL because `TaskRouter` is not defined.

- [ ] **Step 3: Implement deterministic routing**

Create a small capability registry with explicit keywords and tool-name
allowlists for symbol resolution, market data, fundamentals, news, backtest,
shadow account, and general research. Unknown intents use a conservative
general-research route without shell or live tools.

- [ ] **Step 4: Write plan validation tests**

Cover missing dependencies, cycles, unknown capabilities, side-effecting steps
outside the route, step-count/token/wall-clock budget overflow, and correct
ready-step ordering for independent nodes.

- [ ] **Step 5: Run plan tests to verify failure**

Run: `pytest agent/tests/test_reliability_planner.py -q`

Expected: FAIL because `ExecutionPlan` and `PlanValidator` are not defined.

- [ ] **Step 6: Implement plan models and DAG utilities**

Use Pydantic validation for plan input. Implement cycle detection with a
topological traversal, explicit budget checks, and a `ready_steps()` method
that returns only steps whose dependencies are successful.

- [ ] **Step 7: Add capability-aware context rendering**

Extend `ContextBuilder` with `allowed_tool_names: Collection[str] | None`.
When provided, `_format_tool_descriptions()` renders only those tools; the
default `None` preserves existing behavior. Keep the full registry available
to the gateway so an allowlist cannot be bypassed by model text.

- [ ] **Step 8: Run context and regression tests**

Run: `pytest agent/tests/test_context_attribution_layers.py agent/tests/test_reliability_router.py agent/tests/test_reliability_planner.py -q`

Expected: PASS; existing no-allowlist context behavior remains unchanged.

- [ ] **Step 9: Commit**

```bash
git add agent/src/reliability/router.py agent/src/reliability/planner.py agent/src/reliability/__init__.py agent/src/agent/context.py agent/tests/test_reliability_router.py agent/tests/test_reliability_planner.py
git commit -s -m "feat: route capabilities and validate execution plans"
```

## Task 4: Add Tool Gateway validation, retry, and fallback policy

**Files:**
- Create: `agent/src/reliability/gateway.py`
- Create: `agent/tests/test_reliability_gateway.py`
- Modify: `agent/src/agent/tools.py`
- Modify: `agent/src/agent/loop.py`

**Interfaces:**

```python
class GatewayPolicy(BaseModel):
    allowed_tools: frozenset[str]
    retry_limit: int = 0
    fallback_tools: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = 30.0
    allow_side_effects: bool = False

class ToolGateway:
    def execute(self, tool_name: str, arguments: dict[str, object], *, step_id: str, policy: GatewayPolicy, session_id: str = "") -> StepResult: ...
    def normalize_arguments(self, tool_name: str, arguments: Mapping[str, object]) -> dict[str, object]: ...
```

- [ ] **Step 1: Write gateway tests for safety and validation**

Use fake `BaseTool` instances to assert unknown/disallowed tools are rejected,
invalid JSON-schema arguments never reach `execute`, symbol/date normalizers
are applied, and a side-effecting tool is rejected when
`allow_side_effects=False`.

- [ ] **Step 2: Run gateway tests to verify failure**

Run: `pytest agent/tests/test_reliability_gateway.py -q`

Expected: FAIL because `ToolGateway` is not defined.

- [ ] **Step 3: Implement schema and normalization checks**

Read `BaseTool.parameters`, validate object shape and required properties using
the repository's existing Pydantic dependency or a small internal validator.
Return `invalid_argument` with a field-specific `repair_hint`; never invoke
the tool for invalid arguments. Keep symbol normalization conservative and
explicitly support only known parameter names/types.

- [ ] **Step 4: Implement typed exception classification**

Map timeout, authentication, empty-data, provider-unavailable, validation,
and unknown exceptions to `ToolError`. Redact exception text using the
existing redaction helpers before emitting traces/events.

- [ ] **Step 5: Implement bounded read-only retry and fallback**

Retry only errors whose policy marks them retryable and only for read-only
tools. Enforce one repair/retry per step by default, add exponential backoff,
and invoke a configured fallback tool only when the original result is
`data_unavailable` or `provider_timeout`. Never retry or fallback a write tool.

- [ ] **Step 6: Wire AgentLoop tool invocation through the gateway**

Add an optional gateway callback to `AgentLoop`. When absent, preserve the
current direct registry path. When present, convert `StepResult` to the
existing tool-result message and SSE preview while retaining current
heartbeat, timeout, duplicate-success, and cancellation behavior.

- [ ] **Step 7: Run safety and timeout regression tests**

Run: `pytest agent/tests/test_reliability_gateway.py agent/tests/test_tool_timeout.py agent/tests/test_tool_registry_security.py agent/tests/test_mandate_enforcement.py agent/tests/test_sdk_order_gate.py -q`

Expected: PASS; no live-write test may execute a real broker call.

- [ ] **Step 8: Commit**

```bash
git add agent/src/reliability/gateway.py agent/src/agent/tools.py agent/src/agent/loop.py agent/tests/test_reliability_gateway.py
git commit -s -m "feat: add guarded tool gateway recovery"
```

## Task 5: Add evidence and artifact verification

**Files:**
- Create: `agent/src/reliability/evidence.py`
- Create: `agent/tests/test_reliability_evidence.py`
- Modify: `agent/src/agent/trace.py` only if a new redacted evidence trace entry is needed.

**Interfaces:**

```python
class ClaimKind(str, Enum):
    FACT = "fact"
    DERIVED = "derived"
    INTERPRETATION = "interpretation"

class Claim(BaseModel):
    text: str
    kind: ClaimKind
    evidence: list[EvidenceRef]

class EvidenceVerifier:
    def verify_step_result(self, result: StepResult, run_dir: Path | None = None) -> StepResult: ...
    def verify_claim(self, claim: Claim, evidence: Sequence[StepResult]) -> bool: ...
    def coverage(self, claims: Sequence[Claim], evidence: Sequence[StepResult]) -> float: ...
```

- [ ] **Step 1: Write evidence tests**

Test valid and missing artifact references, missing metrics fields, stale
`as_of` metadata, partial provider coverage, derived claims with no source
fields, and an unsupported numerical claim being rejected.

- [ ] **Step 2: Run evidence tests to verify failure**

Run: `pytest agent/tests/test_reliability_evidence.py -q`

Expected: FAIL because `EvidenceVerifier` is not defined.

- [ ] **Step 3: Implement evidence reference validation**

Resolve only paths under the approved run directory, verify file existence and
optional hashes when present, parse metrics JSON/CSV using existing run-card
helpers, and attach provider/date/coverage metadata. A missing or malformed
artifact returns `partial` or `blocked`, never `success`.

- [ ] **Step 4: Implement claim verification and coverage**

Require at least one successful evidence reference for facts and derived
claims. Require source fields for derived values and mark interpretations as
unsupported when their premises are absent. Return a coverage ratio and a
list of unresolved claims for final response policy.

- [ ] **Step 5: Run evidence and run-card regressions**

Run: `pytest agent/tests/test_reliability_evidence.py agent/tests/test_run_card_strict_json.py agent/tests/test_run_card_content_filter.py agent/tests/test_agent_loop_trace.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/reliability/evidence.py agent/src/agent/trace.py agent/tests/test_reliability_evidence.py
git commit -s -m "feat: verify research evidence and claims"
```

## Task 6: Orchestrate the reliability runtime

**Files:**
- Create: `agent/src/reliability/runtime.py`
- Create: `agent/tests/test_reliability_runtime.py`
- Modify: `agent/src/reliability/__init__.py`

**Interfaces:**

```python
class ReliabilityRuntime:
    def run(
        self,
        *,
        user_message: str,
        session_id: str,
        registry: ToolRegistry,
        executor: Callable[..., dict[str, object]],
        event_callback: Callable[[str, dict[str, object]], None] | None = None,
    ) -> dict[str, object]: ...
```

The returned dictionary must preserve the current `status`, `content`/`reason`,
`run_dir`, `run_id`, `metrics`, and usage fields while adding a redacted
`reliability` summary.

- [ ] **Step 1: Write orchestration tests**

Use fake router/planner/gateway/executor/verifier components to assert:

- simple requests take the fast path;
- independent plan steps execute concurrently and dependent steps wait;
- a retryable failure follows the configured fallback;
- a repeated failure trips the step budget;
- an unverified claim produces a partial/blocked result;
- `attempt.completed` is not emitted for an unverified successful-looking run;
- no write step is retried.

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest agent/tests/test_reliability_runtime.py -q`

Expected: FAIL because `ReliabilityRuntime` is not defined.

- [ ] **Step 3: Implement orchestration and budget accounting**

Route the request, build/validate the plan, schedule ready read steps with a
bounded executor, feed results into the evidence verifier, and invoke final
synthesis only with verified/partial evidence. Emit existing event names plus
`reliability` fields; map plan/recovery state to `tool_progress` so the
frontend remains compatible.

- [ ] **Step 4: Implement terminal-state policy**

Return `success` only when required claims and artifacts verify. Return
`partial` with verified results and unresolved steps when the task budget or
provider coverage is incomplete. Return `failed` only for runtime faults or
unsafe blocked paths. Preserve cancellation and current run trace cleanup.

- [ ] **Step 5: Run runtime and safety regressions**

Run: `pytest agent/tests/test_reliability_runtime.py agent/tests/test_agent_loop_terminal_state.py agent/tests/test_agent_loop_stream_retry.py agent/tests/test_api_live_runtime.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/reliability/runtime.py agent/src/reliability/__init__.py agent/tests/test_reliability_runtime.py
git commit -s -m "feat: orchestrate reliable research execution"
```

## Task 7: Integrate the runtime behind a feature flag

**Files:**
- Modify: `agent/src/session/service.py`
- Modify: `agent/src/config/schema.py`
- Modify: `agent/src/config/loader.py` only if the new flag needs validated config.
- Create: `agent/tests/test_session_service_reliability.py`
- Modify: `agent/tests/test_session_service_mcp.py`

**Interfaces:**

Add an operator-controlled setting with default off during rollout:

```text
VIBE_RELIABILITY_RUNTIME=off|shadow|enforce
```

- `off`: current `AgentLoop` path exactly as today;
- `shadow`: replay/plan/verify decisions are recorded without duplicating
  external provider calls;
- `enforce`: reliability runtime owns the attempt and falls back to the old
  path only for read-only failures before any side effect.

- [ ] **Step 1: Write service integration tests**

Assert default `off` preserves current registry/AgentLoop construction,
`shadow` does not duplicate tool/provider calls, and `enforce` forwards the
same session id, event callback, run directory, and shell-tool policy. Assert
that no fallback occurs after a write tool begins.

- [ ] **Step 2: Run integration tests to verify failure**

Run: `pytest agent/tests/test_session_service_reliability.py agent/tests/test_session_service_mcp.py -q`

Expected: FAIL because the feature flag and runtime branch do not exist.

- [ ] **Step 3: Add validated configuration and service branch**

Read the environment once per attempt, reject unknown modes by falling back to
`off` with a warning, construct the same registry and persistent-memory objects,
and invoke `ReliabilityRuntime` only for `shadow`/`enforce`. Preserve
`self._active_loops` cancellation for the current path and add a runtime
cancel handle for the new path.

- [ ] **Step 4: Preserve SSE and attempt completion semantics**

Ensure `attempt.created`, `attempt.started`, tool lifecycle events,
`attempt.completed`, and `attempt.failed` carry the same `attempt_id`. Keep
mandate proposal/live-action relays unchanged and ensure unverified results
cannot trigger a successful completion path.

- [ ] **Step 5: Run session/API/safety tests**

Run: `pytest agent/tests/test_session_service_reliability.py agent/tests/test_session_service_mcp.py agent/tests/test_session_events.py agent/tests/test_api_live_runtime.py agent/tests/test_mandate_enforcement.py agent/tests/test_sdk_order_gate.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/session/service.py agent/src/config/schema.py agent/src/config/loader.py agent/tests/test_session_service_reliability.py agent/tests/test_session_service_mcp.py
git commit -s -m "feat: gate reliability runtime rollout"
```

## Task 8: Add bounded caches and provider health policy

**Files:**
- Create: `agent/src/reliability/cache.py`
- Create: `agent/src/reliability/providers.py`
- Create: `agent/tests/test_reliability_cache.py`
- Create: `agent/tests/test_reliability_providers.py`

**Interfaces:**

```python
class ResultCache:
    def get(self, key: str, *, now: datetime | None = None) -> StepResult | None: ...
    def put(self, key: str, result: StepResult, *, ttl_seconds: float) -> None: ...

class ProviderHealth:
    def record_success(self, provider: str, elapsed_ms: int) -> None: ...
    def record_failure(self, provider: str, code: ErrorCode) -> None: ...
    def choose_fallback(self, provider: str, candidates: Sequence[str]) -> str | None: ...
```

- [ ] **Step 1: Write cache and health tests**

Test normalized keys ignore argument ordering, settled historical results can
be reused, short-TTL entries expire, provider failures open a bounded circuit,
and a live/side-effect result is never cached.

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest agent/tests/test_reliability_cache.py agent/tests/test_reliability_providers.py -q`

Expected: FAIL because the new classes do not exist.

- [ ] **Step 3: Implement in-memory cache and health state**

Use bounded size, monotonic expiry, normalized JSON keys, and no raw prompt or
credential values. Include `provider` and `as_of` in cache metadata. Provider
health state must be process-local and resettable for tests.

- [ ] **Step 4: Integrate gateway lookup and provider fallback**

Check cache before provider invocation, emit cache-hit telemetry, and update
health state only with redacted provider/code/elapsed data. Keep existing loader
cache behavior intact when the reliability runtime is off.

- [ ] **Step 5: Run cache and loader regressions**

Run: `pytest agent/tests/test_reliability_cache.py agent/tests/test_reliability_providers.py agent/tests/test_local_loader.py agent/tests/test_yahoo_loader.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/reliability/cache.py agent/src/reliability/providers.py agent/tests/test_reliability_cache.py agent/tests/test_reliability_providers.py
git commit -s -m "feat: add bounded result cache and provider health"
```

## Task 9: Add replay benchmarks, fault injection, and rollout documentation

**Files:**
- Create: `agent/tests/fixtures/reliability_cases.json`
- Create: `agent/tests/test_reliability_replay.py`
- Create: `agent/tests/test_reliability_faults.py`
- Create: `docs/desktop/agent-reliability.md`
- Modify: `agent/src/telemetry/counters.py` if benchmark export needs new redacted fields.

**Interfaces:**

The fixture format is:

```json
{
  "name": "provider_fallback_after_timeout",
  "prompt": "Get AAPL daily data for the last 20 sessions",
  "expected_intent": "market_data",
  "expected_status": "success",
  "faults": [{"provider": "primary", "error_code": "provider_timeout"}],
  "required_evidence": ["market_data"]
}
```

- [ ] **Step 1: Add fixed replay cases**

Include wrong-tool prevention, invalid symbol, bad date, provider timeout,
empty provider response, partial financial statement, budget exhaustion,
malformed backtest metrics, unsupported claim, cancellation, and side-effect
no-retry cases.

- [ ] **Step 2: Write replay/fault tests**

Run each case with fake providers and fake LLM outputs. Assert terminal status,
selected tools, recovery count, evidence coverage, and absence of unsupported
claims. Never call live market or broker services from these tests.

- [ ] **Step 3: Run the new replay tests and verify they fail**

Run: `pytest agent/tests/test_reliability_replay.py agent/tests/test_reliability_faults.py -q`

Expected: FAIL because the replay runner and fault injection adapters are not
defined.

- [ ] **Step 4: Implement the replay runner and fault injection adapters**

Load the fixed JSON fixtures, inject fake provider/tool outcomes through the
gateway interfaces, and assert only deterministic status, selected-tool,
recovery-count, and evidence-coverage fields. Do not send network requests or
call broker connectors.

- [ ] **Step 5: Run the replay suite and verify it passes**

Run: `pytest agent/tests/test_reliability_replay.py agent/tests/test_reliability_faults.py -q`

Expected: PASS with stable outputs suitable for before/after benchmark
comparison.

- [ ] **Step 6: Document rollout and operational metrics**

Document `VIBE_RELIABILITY_RUNTIME`, cache behavior, error statuses,
evidence-verification semantics, feature-flag rollback, and the benchmark
fields in `docs/desktop/agent-reliability.md`.

- [ ] **Step 7: Run the required backend validation**

Run:

```bash
pytest --ignore=agent/tests/e2e_backtest \
  --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q
pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q
python -m compileall -q agent/cli
python -m py_compile agent/api_server.py agent/mcp_server.py
```

Expected: PASS. Any safety-test failure blocks rollout.

- [ ] **Step 8: Commit**

```bash
git add agent/tests/fixtures/reliability_cases.json agent/tests/test_reliability_replay.py agent/tests/test_reliability_faults.py docs/desktop/agent-reliability.md
git commit -s -m "test: add reliability replay and rollout checks"
```

## Rust profiling follow-up

Do not include Rust in the first implementation batch. After Task 9, collect
phase timings and run `py-spy`/cProfile against representative backtest and
research traces. A separate plan is required for any Rust/PyO3 rewrite and
must include a Python baseline, a profiling threshold, data-equivalence tests,
and a rollback path.

## Final verification checklist

- [ ] All reliability package tests pass.
- [ ] Existing session/SSE and AgentLoop regression tests pass.
- [ ] Safety-critical order-gate and mandate tests pass.
- [ ] Replay corpus shows reduced wrong-tool and unsupported-claim rates.
- [ ] Simple-question P95 latency and token usage do not regress.
- [ ] `off` mode is behaviorally unchanged.
- [ ] No third-party CLI or Rust dependency was added without profiling evidence.
