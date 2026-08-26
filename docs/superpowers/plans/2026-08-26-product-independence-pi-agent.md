# Product Independence and Pi Agent Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vibe Trading Desktop the independent product mainline, establish a reproducible Legacy Agent baseline, and add a Pi-backed executor without changing existing session, run, artifact, REST, SSE, frontend, finance capability, or live-safety contracts.

**Architecture:** Keep Python/FastAPI as the product owner. Add a small Python `src.execution` contract and canonical event adapter; route the existing AgentLoop through `LegacyExecutor`, then add a TypeScript Node sidecar using `@earendil-works/pi-coding-agent` 0.84.3. The sidecar communicates with Python over a strict request/event/tool JSONL protocol; Python remains the owner of Session/Run persistence and executes all finance tools through the existing registry/gateway. Roll out behind `VIBE_AGENT_EXECUTOR=legacy|pi`, with `legacy` as the default until the baseline gate passes.

**Tech Stack:** Python 3.11+, FastAPI, existing `SessionService`/`EventBus`/`ToolRegistry`, TypeScript ESM, Node.js >=22.19.0 for the Pi bridge, `@earendil-works/pi-coding-agent` 0.84.3, existing pytest/Vitest, JSONL over a supervised local child process. Pi's official SDK is Node/TypeScript-only; no Python in-process binding exists.

## Global Constraints

- Keep existing `/sessions/{session_id}/messages`, `/sessions/{session_id}/events`, attempt/run, artifact, and frontend `AgentMessage` contracts unchanged.
- Preserve the current Session/Message/Attempt/Run persistence format; the Python product remains the source of truth.
- Preserve existing finance tools, data providers, backtesting, Alpha Zoo, reports, research goals, and evidence paths; do not duplicate them in TypeScript.
- Keep all side-effecting and live-trading actions behind the existing mandate, kill-switch, order-gate, and audit-ledger paths.
- The Pi sidecar never receives direct broker credentials or direct filesystem authority beyond the explicitly configured working directory.
- Never automatically retry an order, cancellation, broker write, or other side-effecting tool.
- Shell tools remain disabled for network/API entry points unless the existing explicit operator policy enables them.
- Canonical events are the only events persisted or emitted to the frontend; Pi-native event names never leak across the Python product boundary.
- `VIBE_AGENT_EXECUTOR` accepts only `legacy` or `pi`; invalid values fail closed to `legacy` and emit a redacted configuration warning.
- No production default switch occurs before the baseline comparison and safety gates pass.
- Use the exact Pi package version `0.84.3` for the first bridge; update it only in a separate dependency-review change.
- Validation must not trigger live trading, broker writes, credential mutations, or external side effects.

---

## File Map

### New files

- `agent/src/execution/__init__.py` — public exports for the product executor contract.
- `agent/src/execution/contracts.py` — immutable request/result/event types and `TurnExecutor` protocol.
- `agent/src/execution/events.py` — canonical event names and Pi-to-product event conversion helpers.
- `agent/src/execution/legacy.py` — adapter around the existing `AgentLoop`.
- `agent/src/execution/pi.py` — Python client for the Pi bridge process, including JSONL framing, cancellation, and tool request dispatch.
- `agent/src/execution/selection.py` — validated executor selection from environment/config.
- `agent/tests/test_execution_contracts.py` — contract serialization and invariants.
- `agent/tests/test_execution_events.py` — canonical event conversion and redaction.
- `agent/tests/test_execution_selection.py` — selection and fail-closed behavior.
- `agent/tests/test_legacy_executor.py` — regression tests proving AgentLoop behavior is preserved through the adapter.
- `agent/tests/test_pi_executor_protocol.py` — fake-sidecar protocol, tool dispatch, cancellation, malformed-frame, timeout, and crash tests.
- `agent/evals/__init__.py` — package marker and stable imports for evaluation models.
- `agent/evals/cases.json` — deterministic task cases and expected observable checks.
- `agent/evals/schema.py` — validation model for evaluation cases and results.
- `agent/evals/runner.py` — runs a selected executor against cases without broker writes.
- `agent/evals/README.md` — how to run baseline and comparison evaluations.
- `pi-bridge/package.json` — private ESM package pinned to Pi 0.84.3 and Node >=22.19.0.
- `pi-bridge/tsconfig.json` — strict TypeScript build configuration.
- `pi-bridge/src/protocol.ts` — strict JSONL command/event/tool frame types and parser.
- `pi-bridge/src/index.ts` — Pi SDK session creation, custom tool registration, event translation, and process loop.
- `pi-bridge/src/protocol.test.ts` — JSONL framing and malformed input tests.
- `pi-bridge/src/bridge.test.ts` — mocked Pi session event conversion and tool round-trip tests.
- `scripts/desktop/check-pi-bridge.sh` — verifies the bridge build and Node runtime requirements without launching finance tools.

### Existing files to modify

- `agent/src/session/service.py` — construct the selected executor and route `_run_with_agent` through the contract while retaining existing attempt persistence and SSE ownership.
- `agent/src/agent/loop.py` — only if required to expose an adapter-safe cancellation or result method; do not change loop semantics.
- `agent/src/tools/__init__.py` — expose the existing registry definitions and controlled invocation surface needed by the Pi tool dispatcher; do not add duplicate tools.
- `agent/src/reliability/runtime.py` — accept the canonical executor result/event shape only where current reliability integration requires it; preserve existing safety decisions.
- `agent/src/telemetry/counters.py` — add redacted executor and evaluation counters without recording prompts, credentials, raw arguments, or response text.
- `pyproject.toml` — include `src.execution` and `evals` in package discovery if the existing package rules do not already include them; do not add Pi to Python dependencies.
- `scripts/desktop/assemble.sh` — stage the built `pi-bridge` artifact only after the bridge check passes; never stage `node_modules`.
- `docs/desktop/README.md` — document the Pi bridge as an internal runtime component and its fallback behavior once packaged.
- `NOTICE` — add Pi MIT attribution if the bridge is distributed with the desktop application.
- `CHANGELOG.md` — add the user-visible migration behavior only when the Pi executor is actually enabled for a release.

### No-change compatibility surfaces

- `frontend/src/hooks/useSSE.ts`
- `frontend/src/types/agent.ts`
- `frontend/src/lib/api.ts`
- `frontend/src/pages/Agent.tsx`
- `agent/src/session/models.py`
- `agent/src/session/events.py`
- live trading gate, mandate, halt, audit, and broker connector modules

---

## Task 1: Establish the evaluation case schema and Legacy baseline runner

**Files:**
- Create: `agent/evals/__init__.py`
- Create: `agent/evals/cases.json`
- Create: `agent/evals/schema.py`
- Create: `agent/evals/runner.py`
- Create: `agent/evals/README.md`
- Modify: `pyproject.toml`
- Create: `agent/tests/test_eval_schema.py`

**Interfaces:**

```python
class EvalCase(BaseModel):
    case_id: str
    category: Literal[
        "market_analysis", "comparison", "fundamental_research",
        "news_event", "backtest_config", "backtest_explanation",
        "alpha", "research_goal", "failure_recovery", "safety"
    ]
    prompt: str
    tool_fixture: str
    expected_tools: tuple[str, ...]
    forbidden_tools: tuple[str, ...]
    required_evidence_fields: tuple[str, ...] = ()
    checks: tuple[str, ...]

class EvalResult(BaseModel):
    case_id: str
    executor: Literal["legacy", "pi"]
    status: Literal["passed", "failed", "blocked"]
    first_useful_output_ms: int | None
    total_elapsed_ms: int
    tool_calls: int
    duplicate_tool_calls: int
    total_tokens: int | None
    violations: tuple[str, ...]
```

- [ ] **Step 1: Write schema failure tests**

```python
def test_eval_case_rejects_unknown_category():
    with pytest.raises(ValidationError):
        EvalCase(case_id="x", category="unknown", prompt="x", tool_fixture="empty", checks=())

def test_eval_result_contains_redacted_metrics_only():
    result = EvalResult(
        case_id="market-001", executor="legacy", status="passed",
        first_useful_output_ms=10, total_elapsed_ms=20,
        tool_calls=1, duplicate_tool_calls=0, total_tokens=50, violations=(),
    )
    assert "prompt" not in result.model_dump()
    assert "arguments" not in result.model_dump()
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pytest agent/tests/test_eval_schema.py -q`

Expected: FAIL because the evaluation package and models do not exist.

- [ ] **Step 3: Add ten deterministic cases**

Create one case for each approved category. Each case must name a fixture, expected and forbidden tool names, and observable checks. The safety case must use a proposal-only prompt and assert that no broker-write tool is allowed. Fixtures must be local deterministic data; no case may call a live market provider or broker.

- [ ] **Step 4: Implement schema validation and runner output**

`runner.py` loads one or more cases, consumes a canonical-event fixture, records monotonic phase timings, counts tool calls, and writes JSON results. It must return exit code `1` when any case has a violation and `0` when all selected cases pass. It must never serialize prompt text, raw tool arguments, credentials, or assistant response text. Live executor invocation is added only after the executor contract exists in Tasks 2–3.

- [ ] **Step 5: Run schema and runner smoke checks**

Run from the repository root:

```bash
PYTHONPATH=agent pytest agent/tests/test_eval_schema.py -q
PYTHONPATH=agent python -m evals.runner --executor legacy --case market-001 --fixture-only
```

`PYTHONPATH=agent` is required before editable installation because `agent/` is not a top-level Python package. After changing `pyproject.toml`, a developer may run `pip install -e ".[dev]"` and use the installed entry point, but the plan's root-directory command remains explicitly self-contained.

Expected: schema tests pass; the runner prints one JSON result with `executor: "legacy"`, numeric timing fields, and no secret-bearing fields.

- [ ] **Step 6: Commit**

```bash
git add agent/evals agent/tests/test_eval_schema.py pyproject.toml
git commit -s -m "feat: add agent evaluation baseline schema"
```

## Task 2: Define the product executor and canonical event contracts

**Files:**
- Create: `agent/src/execution/__init__.py`
- Create: `agent/src/execution/contracts.py`
- Create: `agent/src/execution/events.py`
- Create: `agent/tests/test_execution_contracts.py`
- Create: `agent/tests/test_execution_events.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class TurnRequest:
    session_id: str
    attempt_id: str
    prompt: str
    history: tuple[dict[str, Any], ...]
    tool_names: tuple[str, ...]
    include_shell_tools: bool
    run_dir: str

@dataclass(frozen=True)
class ProductEvent:
    event_type: str
    data: Mapping[str, Any]

@dataclass(frozen=True)
class TurnResult:
    status: Literal["success", "partial", "failed", "cancelled"]
    content: str = ""
    run_dir: str | None = None
    metrics: Mapping[str, Any] = field(default_factory=dict)
    reason: str | None = None

class TurnExecutor(Protocol):
    def run(self, request: TurnRequest, emit: Callable[[ProductEvent], None]) -> TurnResult: ...
    def cancel(self) -> None: ...
    def close(self) -> None: ...
```

Canonical event types remain the existing product names: `text_delta`, `reasoning_delta`, `stream_reset`, `thinking_done`, `tool_call`, `tool_heartbeat`, `tool_progress`, `tool_result`, `compact`, `llm_usage`, and `done`. The conversion helper must attach the existing `attempt_id` at the service boundary, not trust a sidecar-supplied attempt id.

- [ ] **Step 1: Write contract tests**

```python
def test_turn_request_is_immutable_and_wire_safe():
    request = TurnRequest("s1", "a1", "hello", (), ("quote",), False, "/runs/r1")
    with pytest.raises(FrozenInstanceError):
        request.prompt = "changed"
    assert json.dumps(asdict(request))

def test_product_event_rejects_prompt_and_raw_arguments():
    event = canonical_event("tool_result", {"tool": "quote", "status": "ok"})
    assert "prompt" not in event.data
    assert "arguments" not in event.data
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pytest agent/tests/test_execution_contracts.py agent/tests/test_execution_events.py -q`

Expected: FAIL because `src.execution` does not exist.

- [ ] **Step 3: Implement minimal immutable contracts**

Use dataclasses for internal immutable values and explicit `to_wire()` methods. Reject unsupported status values, non-string event types, and event data containing raw credentials or unredacted exception objects. Do not introduce a second public API model hierarchy.

- [ ] **Step 4: Implement canonical conversion helpers**

Add `canonical_event(event_type: str, data: Mapping[str, Any])`, `tool_call_event(tool: str, args: Mapping[str, Any], status: str)`, `tool_result_event(tool: str, status: str, elapsed_ms: int | None = None)`, and `terminal_event(status: str, content: str = "")`. Preserve current event payload keys used by `useSSE.ts`; normalize Pi's `tool_execution_start/update/end`, `message_update`, and `agent_end` events into product events.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `pytest agent/tests/test_execution_contracts.py agent/tests/test_execution_events.py -q && python -m py_compile agent/src/execution/contracts.py agent/src/execution/events.py`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/execution agent/tests/test_execution_contracts.py agent/tests/test_execution_events.py
git commit -s -m "feat: define product agent execution contract"
```

## Task 3: Route the existing AgentLoop through LegacyExecutor

**Files:**
- Create: `agent/src/execution/legacy.py`
- Create: `agent/src/execution/selection.py`
- Create: `agent/tests/test_execution_selection.py`
- Create: `agent/tests/test_legacy_executor.py`
- Modify: `agent/src/session/service.py`

**Interfaces:**

```python
class LegacyExecutor:
    def __init__(
        self, *, registry: ToolRegistry, llm: ChatLLM,
        persistent_memory: PersistentMemory, max_iterations: int = 50,
    ) -> None: ...
    def run(self, request: TurnRequest, emit: Callable[[ProductEvent], None]) -> TurnResult: ...
    def cancel(self) -> None: ...
    def close(self) -> None: ...

def select_executor_name(value: str | None) -> Literal["legacy", "pi"]: ...
def create_executor(*, name: str, request: TurnRequest, registry: ToolRegistry, llm: ChatLLM, persistent_memory: PersistentMemory) -> TurnExecutor: ...

```

- [ ] **Step 1: Write selection and adapter tests**

```python
def test_invalid_executor_selection_fails_closed_to_legacy(monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_EXECUTOR", "not-real")
    assert select_executor_name(None) == "legacy"

def test_legacy_executor_preserves_agentloop_result(monkeypatch, fake_registry, fake_llm, request):
    expected = {"status": "success", "content": "answer", "run_dir": "/runs/r1"}
    fake_loop_type = scripted_loop(expected)
    monkeypatch.setattr("src.execution.legacy.AgentLoop", fake_loop_type)
    executor = LegacyExecutor(
        registry=fake_registry, llm=fake_llm,
        persistent_memory=object(), max_iterations=50,
    )
    events: list[ProductEvent] = []
    result = executor.run(request, events.append)
    assert result.status == "success"
    assert result.content == "answer"
    assert fake_loop_type.constructed[0].run_calls[0]["session_id"] == request.session_id
```


Add regression assertions for user message, converted history, session id, event callback, cancellation, metrics loading, and `run_dir` propagation. Reuse the existing `_FakeAgentLoop` pattern from `test_session_service_reliability.py`.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pytest agent/tests/test_execution_selection.py agent/tests/test_legacy_executor.py -q`

Expected: FAIL because the adapter and selector do not exist.

- [ ] **Step 3: Implement the adapter without changing AgentLoop**

Move the current construction and `agent.run(...)` call currently in `SessionService._run_with_agent` into `LegacyExecutor`. Keep registry construction, `ChatLLM`, `PersistentMemory`, reliability mode, and metric loading semantics identical. The adapter translates only callbacks and return values.

- [ ] **Step 4: Integrate executor selection in SessionService**

At the existing construction seam, build `TurnRequest`, call `create_executor`, store it in a new `_active_executors[session_id]` map, and use `executor.cancel()` from `cancel_current`. Keep `_active_loops` and current reliability path until the Pi path has contract coverage; no frontend or EventBus API changes are allowed.

- [ ] **Step 5: Run the existing session regressions**

Run:

```bash
pytest agent/tests/test_execution_selection.py agent/tests/test_legacy_executor.py agent/tests/test_session_service_mcp.py agent/tests/test_session_service_reliability.py agent/tests/test_session_events.py -q
```

Expected: PASS; default behavior remains Legacy and existing attempt/SSE tests remain green.

- [ ] **Step 6: Commit**

```bash
git add agent/src/execution/legacy.py agent/src/execution/selection.py agent/src/session/service.py agent/tests/test_execution_selection.py agent/tests/test_legacy_executor.py
git commit -s -m "refactor: route legacy agent through executor contract"
```

## Task 4: Implement the Pi bridge JSONL protocol

**Files:**
- Create: `pi-bridge/package.json`
- Create: `pi-bridge/tsconfig.json`
- Create: `pi-bridge/src/protocol.ts`
- Create: `pi-bridge/src/protocol.test.ts`
- Modify: `package.json` only if a root script is needed

**Interfaces:**

```typescript
type BridgeCommand =
  | { id: string; type: "run"; sessionId: string; prompt: string; history: unknown[]; toolNames: string[]; cwd: string; model?: { provider: string; id: string; thinkingLevel?: string } }
  | { id: string; type: "tool_response"; callId: string; result: unknown; error?: string }
  | { id: string; type: "cancel" }
  | { id: string; type: "shutdown" };

type BridgeEvent =
  | { type: "ready"; version: string }
  | { type: "event"; event: unknown }
  | { type: "tool_request"; callId: string; toolName: string; args: unknown }
  | { type: "result"; id: string; status: "success" | "failed" | "cancelled"; content?: string; usage?: unknown; error?: string }
  | { type: "error"; id?: string; code: string; message: string };
```

- [ ] **Step 1: Write strict framing tests**

```typescript
test("accepts LF JSONL and strips one CR", () => {
  expect(parseFrame('{"type":"cancel"}\r\n')).toEqual({ type: "cancel" });
});

test("rejects non-object and malformed frames", () => {
  expect(() => parseFrame("not-json\n")).toThrow("invalid_json");
  expect(() => parseFrame("[]\n")).toThrow("invalid_frame");
});
```

- [ ] **Step 2: Run bridge protocol tests to verify failure**

Run: `cd pi-bridge && npm install --ignore-scripts && npx vitest run src/protocol.test.ts`

Expected: FAIL because the bridge package and parser do not exist.

- [ ] **Step 3: Pin Pi dependencies and strict compiler settings**

`package.json` must include these exact runtime and development pins:

```json
{
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.3",
    "@earendil-works/pi-ai": "0.84.3"
  },
  "devDependencies": {
    "@types/node": "22.19.19",
    "typescript": "5.9.3",
    "vitest": "4.1.9"
  }
}
```

Use `strict: true`, `noUncheckedIndexedAccess: true`, and ESM-compatible module resolution. Commit `pi-bridge/package-lock.json` only after reviewing its dependency diff.

- [ ] **Step 4: Implement the parser and writer**

Read stdin using LF-only framing; accept CRLF by stripping one trailing `\r`; reject Unicode line separators. Validate command discriminants and required fields before dispatch. Write exactly one compact JSON object plus `\n` per event to stdout. Send diagnostics only to stderr so stdout remains protocol-pure.

- [ ] **Step 5: Run protocol tests and build**

Run: `cd pi-bridge && npx vitest run src/protocol.test.ts && npx tsc -p tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pi-bridge package.json package-lock.json
git commit -s -m "feat: add Pi bridge JSONL protocol"
```

## Task 5: Add Pi SDK session execution and Python tool round-trip

**Files:**
- Create: `pi-bridge/src/index.ts`
- Create: `pi-bridge/src/bridge.test.ts`
- Create: `agent/src/execution/pi.py`
- Create: `agent/tests/test_pi_executor_protocol.py`
- Modify: `agent/src/execution/contracts.py` only if the protocol requires a missing field

**Interfaces:**

```typescript
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(cwd),
  modelRuntime,
  tools: [],
  customTools,
  resourceLoader,
});
const unsubscribe = session.subscribe((event) => emitProductEvent(event));
await session.prompt(prompt);
unsubscribe();
session.dispose();
```

```python
class PiExecutor:
    def __init__(
        self, *, bridge_command: Sequence[str], tool_gateway: ToolGateway,
        gateway_policy: GatewayPolicy, timeout_s: float,
        process_factory: Callable[..., Any] | None = None,
    ) -> None: ...
    def run(self, request: TurnRequest, emit: Callable[[ProductEvent], None]) -> TurnResult: ...
    def cancel(self) -> None: ...
    def close(self) -> None: ...
```

- [ ] **Step 1: Write fake-sidecar tests first**

Cover these exact behaviors with an injected `process_factory` and a mocked `ToolGateway`:

```python
def test_pi_executor_translates_text_and_tool_events(fake_process_factory, gateway, request):
    executor = PiExecutor(
        bridge_command=("node", "bridge.js"), tool_gateway=gateway,
        gateway_policy=GatewayPolicy(allowed_tools=("quote",), allow_side_effects=False),
        timeout_s=1.0, process_factory=fake_process_factory,
    )
    events: list[ProductEvent] = []
    result = executor.run(request, events.append)
    assert [event.event_type for event in events] == ["text_delta", "tool_call", "tool_result", "done"]
    assert result.status == "success"

def test_pi_executor_dispatches_tool_request_through_python_gateway(fake_process_factory, gateway, request):
    executor = make_pi_executor(fake_process_factory, gateway)
    executor.run(request, lambda _event: None)
    gateway.execute.assert_called_once_with(
        "quote", {"symbol": "600519.SH"},
        step_id="pi-call-1", policy=executor.gateway_policy, session_id=request.session_id,
    )

def test_pi_executor_terminates_unresponsive_bridge(fake_process_factory, gateway, request):
    executor = make_pi_executor(fake_process_factory, gateway, timeout_s=0.01)
    result = executor.run(request, lambda _event: None)
    assert result.status == "failed"
    assert result.reason == "bridge_timeout"
    assert fake_process_factory.process.terminate.called
```


- [ ] **Step 2: Run Python protocol tests to verify failure**

Run: `pytest agent/tests/test_pi_executor_protocol.py -q`

Expected: FAIL because `PiExecutor` does not exist.

- [ ] **Step 3: Implement the Python bridge client**

Spawn the configured command with text stdin/stdout and a dedicated reader. Correlate `run` and `tool_request` IDs. For each `tool_request`, validate the name against the registry and call `ToolGateway.execute(tool_name, arguments, step_id=call_id, policy=gateway_policy, session_id=request.session_id)`; send only the redacted `StepResult.to_wire()` back. Use `GatewayPolicy(allowed_tools=request.tool_names, allow_side_effects=False)` for the first slice. Do not add a second permission system.
On `cancel()`, send one `cancel` command, wait for the cancellation result until the configured deadline, then terminate the child process. Never restart the child automatically after a tool request or side effect. Classify bridge failures as `failed` and preserve the current session attempt completion path.

- [ ] **Step 4: Implement the TypeScript Pi session**

Use `createAgentSession`, `ModelRuntime.create`, `SessionManager.inMemory`, `defineTool`, and `customTools`. Register only the names supplied in the command. Each custom tool's `execute(toolCallId, params, signal)` writes a `tool_request` frame and awaits the matching `tool_response`. Do not enable Pi built-in `bash`, `edit`, `write`, or filesystem tools in this finance product slice.

Translate `message_update` text/thinking deltas, `tool_execution_start/update/end`, and terminal agent events into the canonical event subset. Return the final assistant text and usage metadata in the `result` frame. Dispose the session after the run so Python remains the source of truth for history and persistence.

- [ ] **Step 5: Add bridge smoke verification**

Run:

```bash
cd pi-bridge && npm install --ignore-scripts && npx vitest run && npx tsc -p tsconfig.json --noEmit
pytest agent/tests/test_pi_executor_protocol.py -q
```

Expected: TypeScript tests/build and Python fake-sidecar tests pass. No provider key, broker credential, or network call is required.

- [ ] **Step 6: Commit**

```bash
git add pi-bridge/src agent/src/execution/pi.py agent/tests/test_pi_executor_protocol.py
git commit -s -m "feat: integrate Pi executor through local bridge"
```

## Task 6: Wire Pi selection into SessionService without changing frontend contracts

**Files:**
- Modify: `agent/src/session/service.py`
- Modify: `agent/src/execution/selection.py`
- Modify: `agent/src/telemetry/counters.py`
- Create: `agent/tests/test_session_service_executor_selection.py`
- Modify: `agent/tests/test_session_service_mcp.py`
- Modify: `agent/tests/test_session_service_reliability.py`

**Interfaces:**

```python
def create_executor_for_attempt(
    *, attempt: Attempt, messages: list[Message], include_shell_tools: bool,
    session_config: Mapping[str, Any], event_callback: Callable[[ProductEvent], None],
) -> TurnExecutor: ...
```

- [ ] **Step 1: Write service selection tests**

Assert:

```python
def test_default_service_path_uses_legacy(monkeypatch):
    monkeypatch.delenv("VIBE_AGENT_EXECUTOR", raising=False)
    result = run_attempt_with_fake_executor(monkeypatch)
    assert result.executor_name == "legacy"

def test_pi_service_path_preserves_attempt_and_event_shapes(monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_EXECUTOR", "pi")
    result, events = run_attempt_with_fake_executor(monkeypatch)
    assert result.attempt.status.value == "completed"
    assert events[-1].event_type == "attempt.completed"
    assert all("attempt_id" in event.data for event in events if event.event_type not in {"heartbeat"})
```

- [ ] **Step 2: Run focused service tests to verify failure**

Run: `pytest agent/tests/test_session_service_executor_selection.py -q`

Expected: FAIL because the service does not select the new contract.

- [ ] **Step 3: Integrate one executor map and one cancel path**

Keep `SessionService._run_attempt` responsible for `attempt.started`, final attempt persistence, assistant message creation, and `attempt.completed`/`attempt.failed`. Keep executor events flowing through the existing `EventBus`; add the attempt id at this boundary. Replace direct `AgentLoop` cancellation with `TurnExecutor.cancel()` while retaining the current maps until all tests prove no regression.

- [ ] **Step 4: Preserve reliability runtime behavior**

For `VIBE_RELIABILITY_RUNTIME=off`, use the selected executor. For `shadow` and `enforce`, do not silently let Pi bypass the existing reliability runtime. Until a Pi-specific reliability adapter is implemented and tested, `pi` selection under `shadow` or `enforce` must fail closed to Legacy and emit a redacted `executor.fallback` event; no live or side-effecting path may use an ungraded Pi executor.

- [ ] **Step 5: Add telemetry**

Record only `executor_name`, `bridge_start_ms`, `turn_ms`, `bridge_timeout`, `bridge_crash`, and `tool_round_trip_ms`. Keep the existing telemetry response shape backward compatible by adding counters under the existing redacted reliability section.

- [ ] **Step 6: Run backend regression checks**

Run:

```bash
pytest agent/tests/test_session_service_executor_selection.py agent/tests/test_session_service_mcp.py agent/tests/test_session_service_reliability.py agent/tests/test_session_events.py -q
python -m py_compile agent/src/session/service.py agent/src/execution/pi.py
```

Expected: PASS; default remains Legacy, Pi is opt-in, and frontend SSE consumers require no changes.

- [ ] **Step 7: Commit**

```bash
git add agent/src/session/service.py agent/src/execution/selection.py agent/src/telemetry/counters.py agent/tests/test_session_service_executor_selection.py agent/tests/test_session_service_mcp.py agent/tests/test_session_service_reliability.py
 git commit -s -m "feat: select agent executor behind product service"
```

## Task 7: Run the baseline comparison and enforce the Pi rollout gate

**Files:**
- Modify: `agent/evals/runner.py`
- Modify: `agent/evals/schema.py`
- Modify: `agent/evals/README.md`
- Create: `agent/tests/test_eval_comparison.py`
- Create: `docs/superpowers/reports/2026-08-26-agent-baseline-comparison.md`

**Interfaces:**

```python
def compare(
    cases: Sequence[EvalCase],
    *,
    executors: tuple[Literal["legacy", "pi"], ...] = ("legacy", "pi"),
    fixture_only: bool = True,
) -> ComparisonReport: ...
```

- [ ] **Step 1: Write comparison gate tests**

```python
def test_pi_cannot_pass_when_accuracy_or_safety_regresses():
    report = ComparisonReport.from_results(regressed_results)
    assert report.rollout_allowed is False
    assert "safety_regression" in report.blockers

def test_pi_pass_requires_efficiency_improvement_without_contract_regression():
    report = ComparisonReport.from_results(improved_results)
    assert report.rollout_allowed is True
```

- [ ] **Step 2: Run comparison tests to verify failure**

Run: `pytest agent/tests/test_eval_comparison.py -q`

Expected: FAIL because comparison and rollout-gate logic do not exist.

- [ ] **Step 3: Implement deterministic comparison and gate**

Compare per-case tool allowlist violations, forbidden-tool calls, evidence checks, safety violations, first-useful-output latency, total latency, duplicate calls, and token totals. Require all of these before `rollout_allowed=True`:

1. no safety violation;
2. no evidence or future-data regression;
3. no higher forbidden/incorrect tool-call rate;
4. no failed cancellation/reconnect contract case;
5. measurable latency or token improvement on the selected target cases.

The report must show medians and per-case failures without including prompts, raw arguments, credentials, or complete responses.

- [ ] **Step 4: Run both executors against fixture-only cases**

Run from the repository root:

```bash
PYTHONPATH=agent python -m evals.runner --executor legacy --all --fixture-only --output /tmp/legacy-results.json
PYTHONPATH=agent VIBE_AGENT_EXECUTOR=pi python -m evals.runner --executor pi --all --fixture-only --output /tmp/pi-results.json
PYTHONPATH=agent python -m evals.runner --compare /tmp/legacy-results.json /tmp/pi-results.json --output docs/superpowers/reports/2026-08-26-agent-baseline-comparison.md
```

Expected: report contains per-case results, aggregate metrics, blockers, and an explicit `rollout_allowed` decision. If the Pi bridge is unavailable, the report must say `blocked` rather than claiming improvement.

- [ ] **Step 5: Run tests and safety checks**

Run:

```bash
pytest agent/tests/test_eval_schema.py agent/tests/test_eval_comparison.py agent/tests/test_pi_executor_protocol.py agent/tests/test_session_service_executor_selection.py -q
pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q
```

Expected: PASS; no test starts a broker connector or writes an order.

- [ ] **Step 6: Commit the comparison tooling, not fabricated results**

```bash
git add agent/evals agent/tests/test_eval_comparison.py
git commit -s -m "feat: add agent executor comparison gate"
```

Only commit the report after it contains actual executed results from both executors; do not create a passing report from synthetic values.

## Task 8: Add desktop bridge verification and source/attribution governance

**Files:**
- Create: `scripts/desktop/check-pi-bridge.sh`
- Modify: `scripts/desktop/assemble.sh`
- Modify: `docs/desktop/README.md`
- Modify: `NOTICE`
- Create: `agent/src/execution/UPSTREAM_SOURCES.md`
- Create: `agent/tests/test_source_manifest.py`

**Interfaces:**

```bash
bash scripts/desktop/check-pi-bridge.sh
# expected: PI BRIDGE CHECK PASSED
```

- [ ] **Step 1: Write source-manifest tests**

Assert that the manifest names the Pi package/version/license, the HKUDS source relationship for retained modules, and the existing Qlib/alpha attribution paths. Reject an entry without `source`, `license`, and `scope` fields.

- [ ] **Step 2: Implement the source manifest**

Record the first Pi bridge as `@earendil-works/pi-coding-agent@0.84.3`, repository `https://github.com/earendil-works/pi`, MIT license, and scope `pi-bridge/*`. Record that current finance capabilities are retained from the existing product and list any explicitly selected HKUDS modules before they are moved or rewritten. Do not erase existing `NOTICE` or Alpha Zoo attribution.

- [ ] **Step 3: Implement bridge check**

The script must verify `pi-bridge/package.json`, the exact Pi dependency version, Node `>=22.19.0`, a clean TypeScript build, and the presence of the generated bridge entrypoint. It must not execute a provider call. On failure it exits nonzero with the exact missing prerequisite.

- [ ] **Step 4: Integrate staging without bundling node_modules**

`assemble.sh` must keep packaged builds on `VIBE_AGENT_EXECUTOR=legacy` and must fail if a Pi bridge directory, `node_modules`, or test files are accidentally copied into `.desktop-build`. A later packaging design must choose and verify either a bundled Node >=22.19.0 runtime or a reviewed standalone executable before Pi can ship in installers. Local development may opt into Pi with an explicit `PI_BRIDGE_COMMAND`.

- [ ] **Step 5: Document fallback behavior**

Document that Pi is an opt-in internal executor during migration; if the bridge is absent, unhealthy, or unapproved by the comparison gate, the product uses Legacy and preserves the existing user-facing API. Do not advertise Pi as the default desktop runtime before packaging and rollout gates pass.

- [ ] **Step 6: Run desktop and source checks**

Run:

```bash
bash scripts/desktop/check-pi-bridge.sh
pytest agent/tests/test_source_manifest.py -q
```

Expected: bridge check and source manifest tests pass; no desktop package includes raw `node_modules`.

- [ ] **Step 7: Commit**

```bash
git add scripts/desktop/check-pi-bridge.sh scripts/desktop/assemble.sh docs/desktop/README.md NOTICE agent/src/execution/UPSTREAM_SOURCES.md agent/tests/test_source_manifest.py
git commit -s -m "build: verify Pi bridge and source attribution"
```

## Task 9: Remove obsolete upstream execution coupling only after rollout approval

**Files:**
- Modify: `agent/src/session/service.py`
- Modify: `agent/src/agent/loop.py`
- Modify: `pyproject.toml` only for package discovery or dependencies proven unused
- Modify: `CHANGELOG.md`
- Modify: `docs/desktop/README.md`
- Create: `agent/tests/test_executor_cutover.py`

**Interfaces:**

The cutover is permitted only when the committed comparison report has `rollout_allowed: true` and all safety tests pass. The public executor selector remains available for rollback until one release has completed without bridge regressions.

- [ ] **Step 1: Write cutover regression tests**

Assert that Pi is the default only when an explicit release flag is enabled, Legacy remains selectable for rollback, canonical event names remain unchanged, and session/run persistence snapshots are byte-compatible for the same fixture.

- [ ] **Step 2: Remove only proven-obsolete code**

Delete duplicate construction branches and dead aliases after all callers route through `src.execution`. Do not delete `AgentLoop` until no supported mode or test depends on it. Do not remove upstream source notices merely because execution ownership moved.

- [ ] **Step 3: Run full relevant verification**

Run:

```bash
pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q
pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q
cd frontend && npm run build
cd ../src-tauri/console-app && npm run build
```

Expected: backend tests, safety tests, frontend build, and console build pass. Do not claim cutover complete if any command fails.

- [ ] **Step 4: Update release documentation**

Add the actual default executor, rollback switch, bridge runtime requirement, and migration result to `CHANGELOG.md` and the desktop guide. Include no unexecuted performance claims.

- [ ] **Step 5: Commit the cutover only after evidence**

```bash
git add agent/src/session/service.py agent/src/agent/loop.py pyproject.toml CHANGELOG.md docs/desktop/README.md agent/tests/test_executor_cutover.py
git commit -s -m "feat: complete Pi executor cutover"
```

---

## Plan self-review

- **Spec coverage:** Product/upstream boundary is covered by Tasks 8–9; executor contract and canonical events by Tasks 2–3; Pi integration by Tasks 4–6; baseline and rollout gate by Tasks 1 and 7; safety and error handling by Tasks 5–7; desktop runtime and attribution by Task 8; cleanup only after smoke evidence by Task 9.
- **Compatibility:** Frontend files and Session/Run models remain unchanged; SessionService and EventBus remain the product owners.
- **Pi facts:** The plan uses the source-verified Node-only SDK API (`createAgentSession`, `SessionManager.inMemory`, `ModelRuntime.create`, `defineTool`, `customTools`, `session.subscribe`, `prompt`, `abort`), pins 0.84.3, and does not claim a Python binding.
- **Security:** Pi cannot directly access broker writes, credentials, or unrestricted built-in filesystem/shell tools; Python validates and dispatches tool requests.
- **No placeholders:** No task relies on “appropriate” or unspecified follow-up behavior; every phase has files, interfaces, commands, and expected outcomes.
- **Scope control:** Full Pi default cutover and deletion of Legacy are conditional on measured evidence, not assumed deliverables of the first vertical slice.
