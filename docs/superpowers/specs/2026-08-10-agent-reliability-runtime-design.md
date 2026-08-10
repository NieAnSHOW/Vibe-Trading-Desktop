# Agent Reliability Runtime Design

Date: 2026-08-10

Status: Design approved for review; implementation not started.

## Problem

The current finance agent's main pain points are incorrect tool selection,
invalid tool arguments, provider/data-source failures, excessive execution
latency, and unsupported or fabricated conclusions. These problems are not
primarily caused by Python execution speed. They arise because the current
ReAct loop lets the model choose a tool on every turn, receives mostly raw
string results, and relies on the model to decide whether a failure was
recoverable and whether a final claim is supported.

The existing runtime already provides valuable behavior that must remain:

- session, attempt, SSE, run-directory, trace, and metrics contracts;
- local and MCP tool registry with read/write classification;
- read-only parallel execution, tool heartbeats, and timeout handling;
- provider stream retry, content-filter handling, and cooperative cancellation;
- mandate, kill-switch, order-gate, and audit-ledger safety boundaries.

The design therefore improves the execution control plane without replacing
the current financial tools or requiring a third-party agent CLI.

## Goals

1. Reduce wrong-tool and invalid-argument calls.
2. Recover deterministically from retryable tool and data-source failures.
3. Reduce unnecessary model rounds, context size, and duplicate data requests.
4. Prevent unsupported numerical or factual claims from appearing as verified
   results.
5. Preserve current API/SSE/frontend/run-artifact contracts.
6. Keep all side-effecting and live-trading actions behind the existing Python
   safety gates.
7. Make performance and correctness measurable before enabling new behavior by
   default.

## Non-goals

- Replacing `AgentLoop` wholesale with Rust or an external CLI.
- Automatically retrying orders, cancellations, or other side-effecting tools.
- Allowing an external CLI or unrestricted shell process to bypass the Python
  tool policy, mandate, kill switch, or audit ledger.
- Guaranteeing that every market-data provider returns complete data.

## Proposed architecture

The current `AgentLoop` remains an execution implementation behind a new
reliability runtime. The runtime is composed of five logical layers:

```text
User request
    -> Task Router
    -> Plan Compiler
    -> Capability / Tool Gateway
    -> Execution Runtime (current AgentLoop initially)
    -> Evidence Verifier and final synthesis
```

### Task Router

The router classifies the request into an intent and capability set, such as
`symbol_resolution`, `market_data`, `fundamentals`, `news`, `backtest`, or
`shadow_account`. It returns a structured allowlist and complexity/budget
profile. Only tools in the selected capability set are presented to the main
model. Live-trading capabilities are never admitted by ordinary research
intents.

The first implementation may use deterministic rules plus a small structured
model call. The router must not produce a final user-facing answer.

### Plan Compiler

For multi-step tasks, the planner emits a short typed plan. Each step contains
an id, capability, input bindings, dependencies, timeout, retry policy, and
expected output schema. Independent read steps form a DAG and can run in
parallel. Simple factual questions use a fast path with no full plan.

The plan validator rejects unknown capabilities, missing dependencies,
excessive step counts, and plans that request disallowed side effects.

### Capability / Tool Gateway

Every tool invocation passes through one gateway that performs:

- argument normalization and schema validation;
- symbol/date/enum normalization;
- read/write and side-effect classification;
- timeout and provider rate-limit policy;
- deterministic retry and fallback selection;
- structured result and error envelopes;
- redacted trace and SSE emission.

The gateway may keep session-bound tool instances while caching immutable tool
metadata and MCP discovery results. It must not share mutable session state
between sessions.

### Execution Runtime

The existing `AgentLoop` is the initial runtime implementation. Later,
`CodexCliExecutor`, `ClaudeCodeExecutor`, or `OpenCodeExecutor` may be added
behind the same interface, but only after the Python gateway and verifier are
in place. External executors receive restricted MCP capabilities and cannot
access live write tools directly.

### Evidence Verifier

The verifier accepts only structured, successful tool results and persisted run
artifacts as evidence. It checks artifact existence, metric schemas, symbol and
date coverage, provider/as-of metadata, and required fields before a result can
be cited in the final answer.

Claims are classified as raw facts, derived calculations, or interpretations.
Numerical and factual claims must carry evidence references. If evidence is
missing, partial, stale, or contradictory, the final response must state that
the result could not be verified instead of filling the gap with a model guess.

## Error and recovery semantics

Every step returns one of:

```text
success | partial | recoverable_error | blocked | unsafe_error | cancelled
```

Errors use a typed envelope, for example:

```json
{
  "ok": false,
  "error_code": "data_unavailable",
  "retryable": true,
  "fallback": "yfinance",
  "repair_hint": "Use a supported US ticker",
  "evidence": []
}
```

Recovery policies:

- invalid arguments: local normalization and at most one repair attempt;
- ambiguous symbols: resolve through the symbol resolver before data access;
- read timeout or transient provider failure: bounded backoff and provider
  fallback;
- no data coverage: return `partial` or `blocked`, never interpret as zero;
- auth/configuration failure: stop and request operator action;
- side-effecting failure: stop, do not retry automatically;
- repeated failure without new evidence: circuit-break the step or task.

Budgets are intent-specific rather than a universal 50-iteration allowance.
Each task has a step budget, tool-call budget, wall-clock budget, and token
budget. The runtime stops when a budget is exhausted and reports verified
partial results plus unresolved steps.

## Performance design

Performance work targets avoided work first:

1. Cache tool metadata, skill indexes, and MCP discovery while retaining
   session-bound instances.
2. Restrict tool definitions by router capability.
3. Summarize large tool results at the tool boundary and persist raw data as
   artifacts.
4. Reuse completed plan-step results and deduplicate equivalent calls.
5. Run independent read steps through a bounded DAG scheduler.
6. Add three cache layers: per-attempt memory, settled historical disk cache,
   and short-TTL intraday/news cache with explicit `as_of` metadata.
7. Use a small model for routing/parameter repair and a stronger model only
   for planning or evidence-based synthesis.

Concurrency remains bounded globally, per task, and per provider. Write tools
remain serial. Increasing the existing global thread-pool size is not a valid
optimization without measurement because nested read parallelism can already
oversubscribe resources.

Rust is considered only after profiling. Candidate hotspots are pure Python
backtest loops, bulk indicator calculation, large-file parsing, and high-volume
event encoding. Prompt construction, planning, error policy, MCP business
logic, and trading safety are not Rust targets unless profiling provides
contrary evidence.

## Observability and verification

Each attempt records:

- time to first token and total wall time;
- router, planner, verifier, and synthesis durations;
- LLM round count and token usage;
- tool count, wall time, cache hits, and error codes;
- recovery and provider-fallback counts;
- evidence coverage and verified-claim ratio;
- plan completion and unresolved-step counts.

Tests must include fault-injected cases for malformed arguments, ambiguous
symbols, provider outage, timeout, empty/partial data, malformed backtest
artifacts, malformed CLI/stream events, cancellation, and side-effecting
failures. Contract tests must verify that existing SSE events and attempt/run
completion behavior remain compatible.

## Rollout

1. Replay historical traces without repeating external calls; compare routing,
   plans, and evidence decisions.
2. Enable the router and gateway for one opt-in session while retaining the
   old loop as a fallback for read-only tasks.
3. Enable bounded plans, DAG execution, and evidence verification.
4. Promote to default after latency, recovery, and hallucination metrics meet
   agreed thresholds.

No automatic fallback or retry is allowed after a side effect has begun.

## Acceptance criteria

- Wrong-tool calls decrease on a fixed regression corpus.
- Invalid arguments are rejected or normalized before reaching providers.
- Retryable provider failures recover or are reported as partial/blocked with a
  clear reason.
- Unsupported numerical claims are absent from verified final reports.
- P95 latency and token usage do not regress for simple questions.
- Existing session, SSE, run artifact, mandate, and order-gate tests remain
  passing.

