# Pi Coding Agent Execution Layer Design

## Status

Approved design. Implementation is intentionally separate from this document.

## Goal

Replace the self-managed Python `AgentLoop` execution layer with the mature Pi
Coding Agent SDK running as a bundled sidecar, while preserving Vibe Trading's
86 finance skills, Python tools, safety gates, long-term memory, API contracts,
and run artifacts.

The implementation uses Pi `AgentSession`, not the unfinished upstream
`AgentHarness` class. The Pi version is pinned to an exact release and its
lockfile is committed.

## Architecture

Pi runs as a long-lived sidecar in RPC mode. The Python service remains the
business and safety authority. Pi owns agent execution and conversation state;
Python owns financial capability execution and safety policy.

```text
Frontend/API
  -> Python SessionService
  -> Pi session manager
  -> Pi AgentSession: context, compaction, model, scheduling
  -> Pi extension tool call
  -> local JSON-RPC bridge
  -> Python ToolGateway / mandate / order gate
  -> tool result
  -> Pi event stream
  -> Python EventBus/SSE and API projection
```

### Responsibilities

Pi owns:

- Agent loop, provider streaming, retry and thinking-level handling.
- Context construction and automatic/manual compaction.
- Durable JSONL session trees, branch/fork navigation, and session recovery.
- Pi skills, extensions, prompt templates, model catalog, and usage events.

Python owns:

- Execution of all finance, data-provider, MCP, shell, shadow-account, and
  trading tools.
- `ToolGateway`, mandate enforcement, order gate, kill switch, consent, and
  audit ledger.
- Existing `PersistentMemory`, research memory files, run directories,
  backtest artifacts, metrics, and trade reports.
- Existing REST/SSE APIs and compatibility projections for the frontend.

Pi's built-in `read`, `write`, `edit`, and `bash` tools are disabled. No tool
execution is allowed to bypass the Python gateway.

## Sidecar and RPC Protocol

The sidecar is a custom Node/Bun entrypoint built on the Pi Coding Agent SDK.
It uses strict LF-delimited JSONL on stdin/stdout. stderr is a separate
diagnostic stream and is never mixed into protocol output.

Commands include:

- `open_session` / `new_session` with Vibe's existing `session_id`.
- `prompt`, `steer`, `follow_up`, and `abort`.
- `get_state`, `get_messages`, `set_model`, and `set_thinking_level`.
- `compact`, `navigate_tree`, and `export_session` as needed by API routes.

Every request and event carries `request_id`, `session_id`, and when relevant
`attempt_id` and `tool_call_id`. One session has one active writer and one
active turn.

Python sends a tool manifest containing each tool's name, description, JSON
Schema, `is_readonly`, `side_effecting`, `repeatable`, and timeout metadata.
The Pi extension registers these as custom tools. Tool execution requests go
back to Python over the same authenticated stdin/stdout JSONL bridge and are
handled by the existing registry/gateway.

Read-only calls may be scheduled in parallel, bounded by the Python executor.
Write and unknown calls are marked sequential. Tool output is truncated and
redacted by Python before it is returned to Pi.

## Session Persistence and Migration

Pi session JSONL files under `~/.vibe-trading/pi/sessions/` are the sole source
of truth for conversation messages, assistant/tool turns, compaction entries,
and branches. Existing Python `SessionStore` message files are no longer
written by the execution path.

The existing Python `Session`, `Attempt`, and run artifact records remain as a
business projection and execution ledger. They reference the Pi session ID and
Pi entry IDs but do not duplicate mutable conversation content.

### Existing session IDs

Vibe session IDs are passed as explicit Pi session IDs. They satisfy Pi's
allowed ID character set. A sidecar session index maps a Vibe ID to its JSONL
file; the sidecar validates the header before opening it.

### Lazy migration

Old `sessions/{id}` data is read-only. On first open/continue:

1. Read and validate the old session without modifying it.
2. Create a Pi session with the same ID.
3. Import user and assistant messages in chronological order.
4. Preserve attempt/run references as metadata only; do not put old traces into
   model context.
5. Atomically write a migration marker and publish the projection.

If migration fails, the old files remain unchanged and no partial Pi session is
advertised. A batch migration and integrity-check command is provided for
operators, but desktop upgrades do not migrate every session eagerly.

## Long-Term Memory

The current `PersistentMemory` format remains supported at
`~/.vibe-trading/memory/`.

The bundled `vibe-memory` Pi extension:

- Requests the frozen `MEMORY.md` snapshot and up to five relevant entries from
  Python before each agent turn.
- Appends them to the per-turn system prompt, never to the user's message or
  the durable conversation transcript.
- Registers compatibility tools for `remember`, `memory_search`, and
  `memory_remove` that call Python's memory service.
- Treats memory writes as immediately durable but does not mutate the current
  prompt snapshot, matching existing semantics.

Pi compaction only changes the conversation context. It never rewrites or
deletes long-term memory. If the memory service is unavailable, the turn may
continue with a degraded diagnostic event.

## Events and Result Compatibility

Pi events are normalized by the Python sidecar client:

| Pi event | Existing Vibe event |
| --- | --- |
| assistant text update | `text_delta` |
| reasoning update | `reasoning_delta` |
| `tool_execution_start` | `tool_call` |
| `tool_execution_update` | `tool_progress` |
| `tool_execution_end` | `tool_result` |
| compaction start/end | `compact` |
| retry events | `stream_reset` and diagnostics |
| `agent_settled` | attempt completion/failure projection |

The final result retains `status`, `content`, `run_dir`, `run_id`,
`react_trace`, `iterations`, `metrics`, and `reliability`. Pi session entry
IDs, branch information, and tool call IDs are included as metadata.

The existing SSE event names and reconnect behavior remain stable for the
frontend. Pi's raw event stream is never exposed as the public API contract.

## Idempotency, Cancellation, and Failure Handling

Each tool call has a stable idempotency key derived from
`session_id`, assistant entry ID, and `tool_call_id`.

- A completed duplicate returns the recorded result without executing again.
- Read-only provider failures may use existing gateway retry/fallback policy.
- Side-effecting calls are never automatically retried.
- If a write result is unknown after a connection failure, mark
  `outcome_unknown` and require state verification.
- User cancellation calls Pi `abort()` and signals Python tool cancellation.
- On Pi process failure, Python restarts it at most once and reopens the JSONL
  session. In-flight side-effecting calls are not replayed.
- Repeated sidecar startup failure returns `pi_sidecar_unavailable`; it does
  not silently run the legacy AgentLoop for the same request.
- The legacy AgentLoop remains only as an explicit operational fallback and is
  disabled by default.

## Packaging

The Pi bundle is built from the pinned upstream workspace using its Node 22
compatible bundling path, then compiled with Bun for each release target.
Build-time Node is `>=22.19`; end users do not need Node installed.

Staged resources:

```text
.desktop-build/pi/
  macos-aarch64/pi
  macos-x86_64/pi
  windows-x64/pi.exe
  extensions/
  skills/
```

Tauri bundles the platform binary and extension/skill resources. Writable Pi
state lives under `~/.vibe-trading/pi/`, never under the read-only app bundle.
The macOS deep-signing script signs the Pi binary; Windows packaging verifies
the executable. The Pi npm version, lockfile, and build provenance are
recorded with the desktop build.

## Verification

### Unit and contract tests

- Pi JSONL framing, request correlation, session reopen, event mapping, abort,
  and sidecar restart.
- Python sidecar client, manifest conversion, projection, idempotency, memory
  bridge, and lazy migration.
- Existing order-gate, mandate, kill-switch, audit-ledger, MCP, registry, and
  tool-security tests remain mandatory.

### Integration tests

Launch the compiled sidecar with a deterministic fake provider and verify:

- Multi-turn prompts and tool calls.
- Parallel read-only tools and serial writes.
- Manual/automatic compaction and session reopen.
- Steering, follow-up, cancellation, disconnect, and one-time restart.
- Duplicate tool-call suppression and unknown write outcome handling.
- Old-session migration and API projection.

### Packaging smoke tests

- Binary starts in RPC mode and emits no non-JSONL stdout.
- All bundled skills are discovered and their count matches the source tree.
- Tool manifest count matches the Python registry.
- Sessions and memory write to user directories.
- macOS and Windows artifacts contain executable Pi resources.

### Performance baseline

Record before/after first-token latency, tool throughput, retry rate,
cancellation latency, sidecar restart recovery rate, and task-level correctness
on a fixed finance research corpus. Performance improvements are accepted only
when safety and result-contract tests remain green.

## Non-goals

- Reimplementing Pi's unfinished `AgentHarness` in this repository.
- Letting Pi's default filesystem or shell tools bypass Python policy.
- Migrating all historical sessions eagerly during desktop upgrade.
- Removing Python financial tools or rewriting the 86 skill documents.
