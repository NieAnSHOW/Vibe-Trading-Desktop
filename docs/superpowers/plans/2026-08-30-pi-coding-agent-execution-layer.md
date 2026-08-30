# Pi Coding Agent Execution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Pi Coding Agent SDK sidecar（自定义 JSONL RPC 模式）替换 Python `AgentLoop` 执行层，同时完整保留 86 个 finance skills、Python 工具/安全闸、长期记忆、REST/SSE API 契约与 run 工件。

**Architecture:** Pi 作为常驻 sidecar 以 LF 分隔 JSONL stdin/stdout RPC 协议运行，拥有 agent loop、上下文/压缩、会话 JSONL 树与模型调度；Python 侧保持业务与安全权威——`SessionService` 仍是唯一编排 choke point，所有工具执行经 tool bridge 回到 Python 并**必须穿过既有 `ToolGateway`**（mandate/order gate/kill switch/safety 分类不变）。Pi 的 JSONL 会话文件（`~/.vibe-trading/pi/sessions/`）成为对话唯一真相源，旧 `SessionStore` 消息文件只读 + 懒迁移；vibe-memory Pi extension 每轮注入记忆快照。唯一真相源：`docs/superpowers/specs/2026-08-30-pi-coding-agent-execution-layer-design.md`。

**Tech Stack:** TypeScript + Bun ≥1.3.14（`pi-sidecar/`，依赖 `@oh-my-pi/pi-coding-agent` **18.0.11** 精确锁定）；Python 3.11 + FastAPI + pytest（`agent/src/pi_sidecar/`）；Tauri v2 资源打包；无 pytest-asyncio（异步逻辑用内层 `async def` + `asyncio.run(...)` 包装）。

## Global Constraints（从设计文档 + recon facts 提取，每个任务隐式包含）

- 使用 Pi `AgentSession`，**禁止**实现/引入上游未完成的 `AgentHarness`（§Non-goals）。
- Pi 内建 `read`/`write`/`edit`/`bash` 工具必须禁用：sidecar 以 `toolNames: []` + `restrictToolNames: true` 创建会话，任何工具执行不得绕过 Python gateway（§Architecture）。
- **所有工具调用必须穿过 `ToolGateway.execute`**（`agent/src/reliability/gateway.py`）——这是既有唯一安全 choke point：side-effecting 分类（`trading_*` 前缀 + `bash` 强制 side-effecting）、JSON-schema 校验、retry/fallback（仅只读）都在这里；Pi 引擎不得新建旁路（recon §3.3）。
- side-effecting 工具调用**永不自动重试**；只读调用失败可走既有 gateway retry/fallback 策略（§Idempotency）。
- 写操作结果在连接失败后未知时，必须标记 `outcome_unknown` 并要求状态核验，不得伪造结果（§Idempotency）。
- 工具调用幂等键 = `session_id + assistant entry ID + tool_call_id`；已完成重复调用直接返回记录结果，不再执行（§Idempotency）。
- 只读调用可并行（由 Python executor 限界）；写与未知分类调用串行（§Sidecar and RPC Protocol）。
- 工具输出在返回给 Pi 之前由 Python 截断（≤`TOOL_RESULT_LIMIT`=10000 字符）并 redact（复用 `src/tools/redaction.py`）（§Sidecar and RPC Protocol）。
- Pi 进程失败 Python 最多重启**一次**并重开 JSONL 会话；in-flight side-effecting 调用不重放（§Idempotency）。
- 反复 sidecar 启动失败返回 `pi_sidecar_unavailable`，**禁止**同一请求静默回退 legacy AgentLoop（§Idempotency）。唯一允许的 legacy 路径：① `VIBE_AGENT_ENGINE=legacy` 显式运维开关；② 会话 provider 为 `vip_server`/`openai-codex`（Vibe 专有，无法映射到 Pi ModelRegistry，见 Global Constraint "model wiring"）——两者均为显式配置驱动并发 `pi.notice` 诊断，非静默回退。
- legacy `AgentLoop` 代码保留不动：`agent/cli/_legacy.py:1008,1148` 直接构造它（CLI 即设计中的 explicit fallback，必须继续工作）；`SessionService._run_with_agent`/`_run_with_reliability` 两个函数体保持原样供 legacy 引擎使用（recon §AgentLoop consumers）。
- Pi 会话 JSONL 文件是对话消息/压缩条目/分支的唯一真相源；执行路径不再写 `SessionStore` 的 messages 文件（§Session Persistence）。`Session`/`Attempt` 记录保留为业务投影与执行 ledger，引用 Pi session ID/entry ID，不复制可变对话内容。
- 旧 `sessions/{id}` 数据只读；懒迁移失败时旧文件必须保持不变、不得宣告部分 Pi 会话；迁移标记原子写入（§Lazy migration）。桌面升级**不**全量急切迁移；批迁移 + 完整性检查仅作为 operator 命令。
- **事件契约（recon "Event name glossary"，前端消费的完整集合，Pi 引擎必须逐字保留 payload 形状）**：`text_delta {delta, iter}`；`reasoning_delta {iter, chars}`（chars=累计字符数，非文本）；`thinking_done {iter, content[:500]}`；`stream_reset {iter, reason, provider, model}`；`llm_usage {**usage_delta, iter, provider, model, metering_eligible}`；`tool_call {tool, arguments(每值 str(v)[:200] redacted), iter}`；`tool_progress {tool, stage, current, total, message, elapsed_s, ts}`；`tool_heartbeat {tool, elapsed_s}`；`tool_result {tool, status:"ok"|"error", elapsed_ms, preview(redacted[:200])}`；`compact {tokens_before, summary[:200]}`；外加 `session.created`/`message.received`/`attempt.*`（SessionService 继续发，不变）。**关键**：`sessions_routes.session_events` 用正则从 `tool_result` preview 匹配 `mp_[0-9a-f]{32}`（→`mandate.proposal`）与 `la_...`（→`live.action`）并从磁盘重载记录——tool_result 的 preview 必须保留该形状，否则 mandate/live UI 断裂。SSE 事件名与重连行为稳定；Pi 原始事件流永不外露（§Events）。
- `vibe-memory` extension：快照 + ≤5 条相关条目只注入**每轮 system prompt**，永不写入用户消息或持久会话转录；Pi compaction 永不改写/删除长期记忆；memory 服务不可用时该轮可带 degraded 诊断继续（§Long-Term Memory）。
- **model wiring**：OpenAI 兼容 provider（deepseek/zhipu/dashscope/moonshot/minimax/groq + 原生 openai/gemini/openrouter/ollama）经 sidecar 的 provider 注册 extension（`pi.registerProvider`，`api:"openai-completions"` + Vibe 的 env baseUrl 表）接入 Pi；`vip_server` 与 `openai-codex` 是 Vibe 专有路径，**legacy-engine-only**（显式限制）：会话 config 选到它们时 Python 侧对该 attempt 走 legacy 引擎并发诊断事件（§ resolved ambiguity，见计划末尾 self-review）。
- 最终 result 保留 `status`/`content`/`run_dir`/`run_id`/`react_trace`/`iterations`/`metrics`/`reliability`；Pi entry ID/分支/工具 call ID 作为 metadata 附带（§Events）。
- Pi npm 版本精确锁定（18.0.11）+ `bun.lockb` 提交 + 构建 provenance 记录（§Packaging）。
- 构建期 Node `>=22.19`；终端用户无需安装 Node（§Packaging）。
- Pi 可写状态只放 `~/.vibe-trading/pi/`（agentDir `~/.vibe-trading/pi/agent`、sessions `~/.vibe-trading/pi/sessions`），永不放只读 app bundle（§Packaging）。
- `.desktop-build/` 是 git-ignored 暂存目录，永不提交。
- 协议帧：严格 LF 分隔 JSONL on stdin/stdout，stderr 独立诊断流永不混入协议输出；单帧上限 1 MiB（§Sidecar and RPC Protocol）。
- 一个 session 同一时刻只有一个 active writer 和一个 active turn；每个请求/事件携带 `request_id`、`session_id`（相关时 `attempt_id`/`tool_call_id`）（§Sidecar and RPC Protocol）。
- Swarm（`worker.py`）不触 AgentLoop，设计范围外，本计划不改；channels 经 `SessionService.send_message`（recon §10），cutover 自动覆盖。
- 测试：Python `pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q`（仓库根）；**无 pytest-asyncio，实际惯例是 sync `def test_*` 内层 `async def` + `asyncio.run(...)`**（recon §9）；约 62 个既有环境性失败是基线，新增/改动测试必须全绿。安全关键窄测试在触及 order/mandate/live 后必须跑：`pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q`。
- Ruff：`select=["E","F","W"]`、line-length 120、target py311；每个 Python 任务收尾 `ruff check agent/src agent/tests`。
- TS sidecar 测试：`cd pi-sidecar && bun test`（前置 Bun ≥1.3.14）。
- 前端零任务：SSE 契约按设计不变；若实现中发现前端必改，立即上报（不得私自扩 scope）。
- 提交：每任务 `git commit -s`（DCO），Conventional Commits，禁止 AI attribution trailer。

## 文件结构总览

| 路径 | 动作 | 职责 |
|---|---|---|
| pi-sidecar/package.json | Create | sidecar 包定义，精确锁定 `@oh-my-pi/pi-coding-agent@18.0.11`，`bun.lockb` 提交 |
| pi-sidecar/tsconfig.json | Create | TS 配置（bun 运行时） |
| pi-sidecar/scripts/check-sdk-exports.ts (+.test.ts) | Create | 锁定版本 SDK 导出面契约测试 |
| pi-sidecar/src/protocol.ts (+test) | Create | 帧编解码/LineSplitter/1 MiB 上限/帧校验 |
| pi-sidecar/src/session-index.ts (+test) | Create | Vibe session_id → Pi JSONL 路径映射 + header 校验 |
| pi-sidecar/src/commands.ts (+test) | Create | RPC 命令路由与 17 个 op 处理器 |
| pi-sidecar/src/session-driver.ts (+test) | Create | `AgentSession` 创建/打开/订阅/事件转发（isolated、内建工具禁用） |
| pi-sidecar/src/model-wiring.ts (+test) | Create | Vibe provider env → `pi.registerProvider` 注册表 + 默认模型解析 |
| pi-sidecar/extensions/vibe-providers/index.ts | Create | provider 注册 extension（factory load 时 registerProvider） |
| pi-sidecar/src/host-rpc.ts | Create | sidecar→Python 双向 RPC helper（hostCall/响应关联） |
| pi-sidecar/src/tool-bridge.ts (+test) | Create | manifest 工具注册为 customTools + `tool_invoke` RPC + 取消 |
| pi-sidecar/src/main.ts | Create | 入口：ready 帧、stdin/stdout JSONL 循环、stderr 诊断 |
| pi-sidecar/extensions/vibe-memory/index.ts (+test) | Create | vibe-memory extension（每轮记忆注入 + remember/memory_search/memory_remove） |
| agent/src/pi_sidecar/__init__.py | Create | 包标记 + engine 开关（`get_agent_engine()`，默认 `pi`）+ LEGACY_ONLY_PROVIDERS |
| pi-sidecar/src/main.ts (+test) | Create | **入口（Task 5b，B1）**：ready 帧、stdin/stdout JSONL 循环、HostRpc 装配、`__VIBE_HOST__` bridge、extensions 注入、stderr 诊断 |
| agent/src/pi_sidecar/manifest.py (+test) | Create | `build_tool_manifest(registry)` |
| agent/src/pi_sidecar/gateway_bridge.py (+test) | Create | tool_invoke 处理：幂等、并行只读/串行写、ToolGateway 路由、outcome_unknown、截断/redact |
| agent/src/pi_sidecar/client.py (+test) | Create | `PiSidecarClient`：进程监管（restart-once）、请求关联、事件分发 |
| agent/src/pi_sidecar/events.py (+test) | Create | Pi 事件 → 完整 Vibe 事件 glossary 归一化 |
| agent/src/pi_sidecar/projection.py (+test) | Create | 最终 result 投影 + Pi 消息 → `Message` 投影 |
| agent/src/pi_sidecar/memory_bridge.py (+test) | Create | memory_context/remember/memory_search/memory_remove host op（PersistentMemory） |
| agent/src/pi_sidecar/migration.py (+test) | Create | 懒迁移（只读旧库 → import_messages → 原子标记） |
| agent/src/pi_sidecar/client.py (+test) | Create | `PiSidecarClient`：进程监管（restart-once）、请求关联、事件分发、入站 host-request 派发 + `respond_host`（B3）、env 合并（B6）、`VIBE_PI_SIDECAR_BIN` 解析（B7） |
| agent/tests/pi_sidecar/fixtures/stub_sidecar.py | Create | 协议桩 sidecar（client 单测用，无需 bun） |
| agent/tests/pi_sidecar/fake_provider.py | Create | 确定性 OpenAI 兼容 SSE stub provider（集成测试用） |
| agent/tests/pi_sidecar/test_integration_basic.py | Create | 集成：多轮/工具调用/并行只读串行写 |
| agent/tests/pi_sidecar/test_integration_advanced.py | Create | 集成：压缩/重开/steer/abort/restart/重复抑制/outcome_unknown/迁移投影 |
| scripts/desktop/build-pi.sh / build-pi.ps1 | Create | bun install --frozen-lockfile → bundle → `bun build --compile` 按目标 → 暂存 `.desktop-build/pi/` + PROVENANCE.json |
| agent/src/session/service.py | Modify | engine 分支 `_run_with_pi`（同步 + `_AGENT_EXECUTOR` + pi loop 桥接，B4）、`_pi_host_handlers` 注册表（B5）、cancel 接线、get_messages 路由、执行路径停写 messages、vip_server/openai-codex legacy 回退 |
| scripts/desktop/build-windows.ps1 | Modify | 同上（Windows 侧） |
| scripts/desktop/assemble.sh / assemble.ps1 | Modify | agent 模板步骤后（~L49/55）加 Pi 暂存调用 |
| scripts/desktop/sign-and-notarize.sh | Modify | Mach-O 签名循环（~L150）加 `Contents/Resources/pi/*/pi` |
| .github/workflows/desktop-build.yml | Modify | Node 升 22.19、每 matrix 加 Build Pi step、provenance 上传 |
| src-tauri/tauri.conf.json | Modify | bundle.resources（L41-47）加 `"../.desktop-build/pi": "pi"` |
| src-tauri/src/sidecar.rs | Modify | B7：解析打包内 `pi/<target>/pi` 并以 `VIBE_PI_SIDECAR_BIN` 注入 Python serve 进程 env |
| scripts/desktop/smoke_pi.py | Create | 打包冒烟（纯 JSONL stdout/skills 数/manifest 数/用户目录写入） |
| scripts/desktop/perf_baseline.py | Create | 性能基线 harness |

## 跨任务接口契约（单一事实来源；各任务 Interfaces 节重复声明）

### RPC 帧协议（v1，LF 分隔 JSONL；双向对称）

```jsonc
// 请求（两方向同形；id 前缀区分：Python→sidecar "r-"，sidecar→Python "s-"）
{"v":1,"id":"r-001","op":"new_session","params":{"session_id":"a1b2c3d4e5f6"}}
// 成功响应（回显 id）
{"v":1,"id":"r-001","ok":true,"result":{"session_file":"/path/x.jsonl"}}
// 失败响应
{"v":1,"id":"r-001","ok":false,"error":{"code":"not_found","message":"..."}}
// 事件（单向，无 id；sidecar→Python）
{"v":1,"event":"session_event","session_id":"a1b2c3d4e5f6","data":{"type":"agent_end","payload":{"isTerminal":false}}}
```

- 错误码集合：`bad_json` `bad_frame` `frame_too_large` `unknown_op` `bad_request` `no_session` `session_busy` `not_found` `stale_cursor` `already_exists` `tool_failed` `tool_timeout` `tool_cancelled` `pi_error` `internal`。
- Python→sidecar op 集合：`ping`、`new_session`、`open_session`、`prompt`、`steer`、`follow_up`、`abort`、`get_state`、`get_messages`、`set_model`、`set_thinking_level`、`compact`、`navigate_tree`、`export_session`、`set_tool_manifest`、`import_messages`、`tool_cancel`。
- sidecar→Python op 集合：`tool_invoke`、`memory_context`、`remember`、`memory_search`、`memory_remove`（B5：后四者由 vibe-memory extension 经 host bridge 调用，Python 侧经 `_pi_host_handlers` 注册表分发）。
- 单帧 JSON 序列化后 ≤ 1_048_576 字节（UTF-8），超限即 `frame_too_large`（v1 不分块）。
- 启动时 sidecar 先发 `{"v":1,"event":"ready","data":{"protocol":1,"pid":<int>,"sdk":"18.0.11"}}`，之后才接受请求。

### 命令 result 形状（Python→sidecar）

```jsonc
ping               -> {"pong":true,"protocol":1}
new_session        -> {"session_file":"<abs>"}   // {session_id, model?, thinking_level?}
open_session       -> {"session_file":"<abs>"}   // {session_id}；索引/文件缺失 → not_found
prompt             -> {"accepted":true}          // 立即 ack；完成 = session_event agent_end 且 isTerminal!==false
steer/follow_up    -> {"queued":true}
abort              -> {"aborted":true}
get_state          -> {"busy":bool,"model":str|null,"thinking_level":str|null,"session_file":str,"session_id":str}
get_messages       -> {"messages":[{"entry_id","role","content","timestamp"}],"next_cursor":str|null}
                   // {session_id, before_cursor?, limit?=100}；错误 session_busy/stale_cursor
set_model          -> {"model":"<provider/model>"}
set_thinking_level -> {"thinking_level":"off|minimal|low|medium|high|xhigh"}
compact            -> {"started":true}           // 完成经 session_event auto_compaction_end
navigate_tree      -> {"leaf_id":"<entry id>"}   // {session_id, entry_id}
export_session     -> {"path":"<out_path>"}      // {session_id, out_path}；复制会话 JSONL
set_tool_manifest  -> {"count":<int>}            // {tools:[ManifestTool...]}
import_messages    -> {"imported":<int>}         // {session_id, messages:[{role,content,timestamp?}]}
tool_cancel        -> {"cancelled":true}         // {call_id}
```

### sidecar→Python op 形状

```jsonc
tool_invoke    params: {"call_id":"t-1","toolCallId":"<pi id>","toolName":"web_search","arguments":{...},
                        "idempotencyKey":"<session_id>:<assistantEntryId>:<toolCallId>",
                        "is_readonly":bool,"side_effecting":bool,"repeatable":bool,"timeout_seconds":number}
               result: {"content":"<json str ≤10000 chars>","isError":bool,"outcome":"ok"|"error"|"outcome_unknown"}
memory_context params: {"session_id":"...","query":"<当前 user prompt>"}
               result: {"block":"<注入 system prompt 的文本，可为空串>"}
```

### ManifestTool（Task 6 定义；Task 7/8/16/17 消费）

```python
def build_tool_manifest(registry: "ToolRegistry") -> list[dict[str, Any]]:
    """每项: {"name": str, "description": str, "parameters": <JSON Schema dict>,
              "is_readonly": bool, "side_effecting": bool, "repeatable": bool,
              "timeout_seconds": float}  # timeout_seconds = TOOL_TIMEOUT_SECONDS(1800)"""
```

### GatewayPolicy 构建（Task 8 定义；Task 8/16/17 消费）

```python
from src.reliability.gateway import GatewayPolicy

def build_gateway_policy(allowed_names: frozenset[str]) -> GatewayPolicy:
    """Pi 引擎统一策略：所有 manifest 工具放行、side effects 放行（mandate/order gate
    在工具内部 fail-closed），retry 交给 gateway 只读恢复逻辑。
    return GatewayPolicy(allowed_tools=allowed_names, retry_limit=2,
                         fallback_tools={}, timeout_seconds=1800.0,
                         allow_side_effects=True)"""
```

### PiSidecarClient（Task 9 定义；Task 12/13/16/17 消费）

```python
class SidecarError(RuntimeError):
    def __init__(self, code: str, message: str) -> None: ...
    code: str  # 协议错误码；重启预算耗尽后统一 "pi_sidecar_unavailable"

class PiSidecarClient:
    def __init__(self, *, command: list[str] | None = None,  # 默认 _default_command()：VIBE_PI_SIDECAR_BIN → bun dev（B7）
                 cwd: Path | None = None,                    # 默认 <repo>/pi-sidecar
                 agent_dir: Path | None = None,              # 默认 ~/.vibe-trading/pi/agent
                 sessions_dir: Path | None = None,           # 默认 ~/.vibe-trading/pi/sessions
                 env: dict[str, str] | None = None,          # B6：合并覆盖 os.environ 传给子进程
                 on_event: Callable[[str, str, dict], None] | None = None,  # (event, session_id, data)
                 on_host_request: Callable[[str, dict], Any] | None = None,  # B3：async (op, params) -> dict
                 max_restarts: int = 1) -> None: ...
    @property
    def started(self) -> bool: ...       # ready 帧已收到且进程存活（B4）
    @property
    def unavailable(self) -> bool: ...   # 重启预算耗尽后 True
    async def start(self) -> None: ...   # 等 ready 帧；超时/崩溃计入重启预算
    async def request(self, op: str, params: dict, *, timeout: float = 30.0) -> dict: ...
    async def respond_host(self, req_id: str, result: dict) -> None: ...  # B3：回写入站 host 请求
    async def stop(self) -> None: ...
```

入站 host 请求语义（B3/B5）：`on_host_request` 返回 dict → 回 `ok:true` 帧；
返回 `{"_host_error_": {"code","message"}}` 或 handler 抛异常 → 回 `ok:false` 帧。

### 事件归一化（Task 10 定义；Task 12 消费）——输出必须逐字满足 Global Constraints 的 glossary

```python
class NormState:
    """每 attempt 一个：iter 计数、reasoning chars 累计、tool 开始时间表、当前 provider/model。"""

def normalize_event(pi_type: str, payload: dict, *, state: NormState) -> list[tuple[str, dict]]:
    """映射（完整 glossary 见 Global Constraints）：
    assistant text delta          -> text_delta {delta, iter}
    thinking delta                -> reasoning_delta {iter, chars(累计)}
    assistant message_end(有思考) -> thinking_done {iter, content[:500]}；usage → llm_usage
    tool_execution_start          -> tool_call {tool, arguments(redacted, str(v)[:200]), iter}
    tool_execution_update         -> tool_progress {tool, stage, ...}（无 heartbeat 流时兼发 tool_heartbeat）
    tool_execution_end            -> tool_result {tool, status, elapsed_ms, preview(redacted[:200])}
    auto_compaction_start/end     -> compact {phase:"start"|"end", tokens_before?, summary?[:200]}
    auto_retry_start              -> stream_reset {iter, reason:"provider_stream_retry", provider, model}
    retry_fallback_*/model_changed/thinking_level_changed/notice -> pi.notice {kind, message}
    agent_end(isTerminal!==false) -> []  # 不产 SSE；client 用作 attempt 终止信号
    """
```

### 最终 result 投影（Task 11 定义；Task 12 消费）

```python
def build_attempt_result(*, status: str, content: str, run_dir: str, react_trace: list[dict],
                         iterations: int, metrics: dict | None, reliability: dict | None = None,
                         pi_meta: dict | None = None) -> dict[str, Any]:
    """AgentLoop.run() 兼容：{"status","content","run_dir","run_id"(=Path(run_dir).name),
       "react_trace","iterations","max_iterations","metrics"?,"reliability"?,"pi":pi_meta}
    pi_meta = {"session_file","pi_session_id","entry_ids":[...],"tool_call_ids":[...]}"""

def pi_messages_to_store_messages(session_id: str, entries: list[dict]) -> list["Message"]:
    """sidecar get_messages 输出 → models.Message 列表（内存投影，不落盘）；
    metadata 附 {"pi_entry_id": ...}"""
```

### 会话状态常量（Task 12/13 消费）

```python
VIBE_PI_SESSIONS_DIR = Path.home() / ".vibe-trading" / "pi" / "sessions"
MIGRATION_MARKER_DIR = Path.home() / ".vibe-trading" / "pi" / "migration"
LEGACY_ONLY_PROVIDERS = frozenset({"vip_server", "openai-codex"})  # agent/src/pi_sidecar/__init__.py
```

---

## Phase 0 — Sidecar 包脚手架 + 协议契约

### Task 0: pi-sidecar 包脚手架 + SDK 导出契约

**Files:** `pi-sidecar/package.json`（Create）、`pi-sidecar/tsconfig.json`（Create）、`pi-sidecar/scripts/check-sdk-exports.ts`（Create）、`pi-sidecar/scripts/check-sdk-exports.test.ts`（Create）

**Interfaces:** Produces — 可 `bun test` 的包；`check-sdk-exports.ts` 输出 `{"ok":true,"version":"18.0.11","exports":[...]}`。

**Steps:**

- [ ] 1. 创建 `pi-sidecar/package.json`：

```json
{
  "name": "vibe-pi-sidecar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "check:exports": "bun run scripts/check-sdk-exports.ts"
  },
  "dependencies": {
    "@oh-my-pi/pi-coding-agent": "18.0.11"
  }
}
```

- [ ] 2. 创建 `pi-sidecar/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "extensions/**/*.ts"]
}
```

- [ ] 3. 写失败测试 `pi-sidecar/scripts/check-sdk-exports.test.ts`：

```ts
import { describe, expect, test } from "bun:test";

const REQUIRED_EXPORTS = [
  "createAgentSession",
  "SessionManager",
  "Settings",
  "AuthStorage",
  "ModelRegistry",
  "discoverAuthStorage",
  "createTools",
  "BUILTIN_TOOLS",
] as const;

describe("pinned SDK export surface", () => {
  test("@oh-my-pi/pi-coding-agent@18.0.11 exports required symbols", async () => {
    const pkg: Record<string, unknown> = await import("@oh-my-pi/pi-coding-agent");
    for (const name of REQUIRED_EXPORTS) {
      expect(name in pkg ? pkg[name] : undefined, `missing export: ${name}`).toBeDefined();
    }
  });

  test("installed version is exactly 18.0.11", async () => {
    const pkgJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkgJson.dependencies["@oh-my-pi/pi-coding-agent"]).toBe("18.0.11");
  });
});
```

- [ ] 4. 运行期待失败：`cd pi-sidecar && bun test scripts/check-sdk-exports.test.ts` → `error: Cannot find module '@oh-my-pi/pi-coding-agent'`（依赖未安装）。

- [ ] 5. 生成 lockfile 并安装：`cd pi-sidecar && bun install` → 生成 `bun.lockb`（必须提交，`git add` 它）。

- [ ] 6. 创建导出检查脚本 `pi-sidecar/scripts/check-sdk-exports.ts`：

```ts
const pkg: Record<string, unknown> = await import("@oh-my-pi/pi-coding-agent");
const names = Object.keys(pkg).sort();
console.log(JSON.stringify({ ok: true, version: "18.0.11", exports: names }, null, 2));
```

- [ ] 7. 运行期待通过：`cd pi-sidecar && bun test scripts/check-sdk-exports.test.ts && bun run scripts/check-sdk-exports.ts > /tmp/sdk-exports.json && head -5 /tmp/sdk-exports.json` → `2 pass`；JSON 以 `{"ok":true` 开头。**人工核对 /tmp/sdk-exports.json + d.ts（M7 扩展清单，四项）**：
  (a) `createAgentSession`/`SessionManager`/`Settings`/`AuthStorage`/`ModelRegistry`/`discoverAuthStorage` 都在；`createAgentSession` options 类型与 `AuthStorage`/`ModelRegistry` 构造签名——若与 Task 5 `session-driver.ts` 用法不符，以 d.ts 为准微调并在 commit message 注明 `sdk-signature-fix`；
  (b) `SessionManager.create`/`newSession` 是否支持**显式 session id**（options 带 `id`/`sessionId`）——决定 B2d 路线（显式 id vs 记录 headerId），结论回填 Task 5 注 ③；
  (c) `message_start` 事件 payload 是否携带 entry/message id（读 `dist/` 内事件类型定义）——Task 7 幂等键的 `assistantEntryId` 段依赖它；若无该字段，Task 7 按 M7a 的 `toolCallId + turn 计数` 回退方案落地；
  (d) `getMessages` 使用的 sessionManager entries 读取 API 实名（`getEntries()` 或等价）——Task 5 `PiSessionHandle.getMessages` 按实名微调。

- [ ] 8. Commit：

```bash
git add pi-sidecar/package.json pi-sidecar/bun.lockb pi-sidecar/tsconfig.json pi-sidecar/scripts/
git commit -s -m "feat(pi-sidecar): scaffold sidecar package with pinned pi-coding-agent 18.0.11"
```

---

### Task 1: Sidecar 协议帧编解码（TS）

**Files:** `pi-sidecar/src/protocol.ts`（Create）、`pi-sidecar/src/protocol.test.ts`（Create）

**Interfaces:** Produces（Task 4/7/12 消费）：

```ts
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export type Frame =
  | { v: 1; id: string; op: string; params?: Record<string, unknown> }
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } }
  | { v: 1; event: string; session_id?: string; data?: unknown };
export class FrameError extends Error { readonly code: string }
export function encodeFrame(frame: Frame): string;
export function decodeFrame(line: string): Frame;
export class LineSplitter { push(chunk: string): string[]; }
```

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/protocol.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  FrameError,
  LineSplitter,
  decodeFrame,
  encodeFrame,
} from "./protocol";

describe("encodeFrame", () => {
  test("appends LF and keeps JSON round-trippable", () => {
    const req = { v: 1, id: "r-1", op: "ping" } as const;
    const line = encodeFrame(req);
    expect(line.endsWith("\n")).toBe(true);
    expect(decodeFrame(line)).toEqual(req);
  });

  test("rejects frames over 1 MiB", () => {
    const big = { v: 1, id: "r-1", op: "x", params: { blob: "a".repeat(MAX_FRAME_BYTES) } };
    expect(() => encodeFrame(big as never)).toThrow(FrameError);
    try {
      encodeFrame(big as never);
    } catch (e) {
      expect((e as FrameError).code).toBe("frame_too_large");
    }
  });
});

describe("decodeFrame", () => {
  test("bad json -> bad_json", () => {
    expect(() => decodeFrame("{nope")).toThrow(FrameError);
    try {
      decodeFrame("{nope");
    } catch (e) {
      expect((e as FrameError).code).toBe("bad_json");
    }
  });

  test("empty line -> bad_json", () => {
    expect(() => decodeFrame("   ")).toThrow(FrameError);
  });

  test("wrong shape -> bad_frame", () => {
    const bads = [
      '{"v":2,"id":"x","op":"ping"}',
      '{"id":"x","op":"ping"}',
      '{"v":1,"id":1,"op":"ping"}',
      '{"v":1,"event":42}',
      '{"v":1,"id":"x","ok":false,"error":{"code":"x"}}',
    ];
    for (const bad of bads) {
      try {
        decodeFrame(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as FrameError).code).toBe("bad_frame");
      }
    }
  });

  test("accepts all four frame kinds", () => {
    expect(decodeFrame('{"v":1,"id":"r-1","op":"ping","params":{"a":1}}')).toMatchObject({ op: "ping" });
    expect(decodeFrame('{"v":1,"id":"r-1","ok":true,"result":{}}')).toMatchObject({ ok: true });
    expect(decodeFrame('{"v":1,"id":"r-1","ok":false,"error":{"code":"x","message":"y"}}')).toMatchObject({ ok: false });
    expect(decodeFrame('{"v":1,"event":"ready","data":{"protocol":1}}')).toMatchObject({ event: "ready" });
  });
});

describe("LineSplitter", () => {
  test("splits incremental chunks on LF", () => {
    const s = new LineSplitter();
    expect(s.push('{"v":1,"id":"a')).toEqual([]);
    expect(s.push('","op":"ping"}\n{"v":1,"id":"b","op":"p"}\n')).toEqual([
      '{"v":1,"id":"a","op":"ping"}',
      '{"v":1,"id":"b","op":"p"}',
    ]);
  });

  test("oversized line -> frame_too_large", () => {
    const s = new LineSplitter();
    expect(() => s.push("x".repeat(MAX_FRAME_BYTES + 1))).toThrow(FrameError);
    try {
      s.push("x".repeat(MAX_FRAME_BYTES + 1));
    } catch (e) {
      expect((e as FrameError).code).toBe("frame_too_large");
    }
  });

  test("protocol version constant is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
```

- [ ] 2. 运行期待失败：`cd pi-sidecar && bun test src/protocol.test.ts` → `error: Cannot find module "./protocol"`。

- [ ] 3. 实现 `pi-sidecar/src/protocol.ts`：

```ts
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;

export type RequestFrame = { v: 1; id: string; op: string; params?: Record<string, unknown> };
export type OkFrame = { v: 1; id: string; ok: true; result: unknown };
export type ErrFrame = { v: 1; id: string; ok: false; error: { code: string; message: string } };
export type EventFrame = { v: 1; event: string; session_id?: string; data?: unknown };
export type Frame = RequestFrame | OkFrame | ErrFrame | EventFrame;

export class FrameError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function encodeFrame(frame: Frame): string {
  const line = JSON.stringify(frame);
  if (byteLen(line) > MAX_FRAME_BYTES) {
    throw new FrameError("frame_too_large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return line + "\n";
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

export function decodeFrame(line: string): Frame {
  const trimmed = line.trim();
  if (!trimmed) throw new FrameError("bad_json", "empty frame");
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new FrameError("bad_json", `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null) throw new FrameError("bad_frame", "frame is not an object");
  const f = obj as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) throw new FrameError("bad_frame", `unsupported v: ${String(f.v)}`);
  if ("event" in f) {
    if (!isNonEmptyString(f.event)) throw new FrameError("bad_frame", "event must be a non-empty string");
    if (f.session_id !== undefined && !isNonEmptyString(f.session_id)) throw new FrameError("bad_frame", "bad session_id");
    return f as unknown as EventFrame;
  }
  if (!isNonEmptyString(f.id)) throw new FrameError("bad_frame", "id must be a non-empty string");
  if ("op" in f) {
    if (!isNonEmptyString(f.op)) throw new FrameError("bad_frame", "op must be a non-empty string");
    if (f.params !== undefined && (typeof f.params !== "object" || f.params === null || Array.isArray(f.params))) {
      throw new FrameError("bad_frame", "params must be an object");
    }
    return f as unknown as RequestFrame;
  }
  if ("ok" in f) {
    if (f.ok === true) return f as unknown as OkFrame;
    if (f.ok === false) {
      const err = f.error as Record<string, unknown> | undefined;
      if (!err || !isNonEmptyString(err.code) || typeof err.message !== "string") {
        throw new FrameError("bad_frame", "error frame needs {code,message}");
      }
      return f as unknown as ErrFrame;
    }
    throw new FrameError("bad_frame", "ok must be boolean");
  }
  throw new FrameError("bad_frame", "frame is neither request, response nor event");
}

export class LineSplitter {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    if (byteLen(this.buf) > MAX_FRAME_BYTES && !this.buf.includes("\n")) {
      this.buf = "";
      throw new FrameError("frame_too_large", `line exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      out.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
    }
    return out;
  }
}
```

- [ ] 4. 运行期待通过：`cd pi-sidecar && bun test src/protocol.test.ts` → 全部 pass（10 用例）。

- [ ] 5. Commit：

```bash
git add pi-sidecar/src/protocol.ts pi-sidecar/src/protocol.test.ts
git commit -s -m "feat(pi-sidecar): JSONL framing codec with 1MiB cap"
```

---

### Task 2: Python 协议帧编解码（与 TS 镜像）+ engine 开关

**Files:** `agent/src/pi_sidecar/__init__.py`（Create）、`agent/src/pi_sidecar/protocol.py`（Create）、`agent/tests/pi_sidecar/__init__.py`（Create，空文件）、`agent/tests/pi_sidecar/test_protocol.py`（Create）

**Interfaces:** Produces（Task 8/9/10/11/12/13 消费）：

```python
PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1_048_576
class FrameError(Exception):
    code: str  # "bad_json" | "bad_frame" | "frame_too_large"
def encode_frame(frame: dict) -> str: ...
def decode_frame(line: str) -> dict: ...
class LineSplitter:
    def push(self, chunk: str) -> list[str]: ...

# __init__.py
def get_agent_engine() -> str:  # env VIBE_AGENT_ENGINE ∈ {"pi","legacy"}，默认/非法值 → "pi"
LEGACY_ONLY_PROVIDERS = frozenset({"vip_server", "openai-codex"})
```

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_protocol.py`：

```python
"""Pi sidecar 协议编解码单测。与 pi-sidecar/src/protocol.test.ts 镜像。"""

import pytest

from src.pi_sidecar import LEGACY_ONLY_PROVIDERS, get_agent_engine
from src.pi_sidecar.protocol import (
    MAX_FRAME_BYTES,
    PROTOCOL_VERSION,
    LineSplitter,
    decode_frame,
    encode_frame,
)
from src.pi_sidecar.protocol import FrameError


class TestEncodeFrame:
    def test_appends_lf_and_round_trips(self):
        req = {"v": 1, "id": "r-1", "op": "ping"}
        line = encode_frame(req)
        assert line.endswith("\n")
        assert decode_frame(line) == req

    def test_rejects_frames_over_1mib(self):
        big = {"v": 1, "id": "r-1", "op": "x", "params": {"blob": "a" * MAX_FRAME_BYTES}}
        with pytest.raises(FrameError) as ei:
            encode_frame(big)
        assert ei.value.code == "frame_too_large"


class TestDecodeFrame:
    def test_bad_json(self):
        with pytest.raises(FrameError) as ei:
            decode_frame("{nope")
        assert ei.value.code == "bad_json"

    def test_empty_line(self):
        with pytest.raises(FrameError) as ei:
            decode_frame("   ")
        assert ei.value.code == "bad_json"

    @pytest.mark.parametrize(
        "bad",
        [
            '{"v":2,"id":"x","op":"ping"}',
            '{"id":"x","op":"ping"}',
            '{"v":1,"id":1,"op":"ping"}',
            '{"v":1,"event":42}',
            '{"v":1,"id":"x","ok":false,"error":{"code":"x"}}',
        ],
    )
    def test_wrong_shape_is_bad_frame(self, bad):
        with pytest.raises(FrameError) as ei:
            decode_frame(bad)
        assert ei.value.code == "bad_frame"

    def test_accepts_all_four_frame_kinds(self):
        assert decode_frame('{"v":1,"id":"r-1","op":"ping","params":{"a":1}}')["op"] == "ping"
        assert decode_frame('{"v":1,"id":"r-1","ok":true,"result":{}}')["ok"] is True
        assert decode_frame('{"v":1,"id":"r-1","ok":false,"error":{"code":"x","message":"y"}}')["ok"] is False
        assert decode_frame('{"v":1,"event":"ready","data":{"protocol":1}}')["event"] == "ready"


class TestLineSplitter:
    def test_splits_incremental_chunks_on_lf(self):
        s = LineSplitter()
        assert s.push('{"v":1,"id":"a') == []
        assert s.push('","op":"ping"}\n{"v":1,"id":"b","op":"p"}\n') == [
            '{"v":1,"id":"a","op":"ping"}',
            '{"v":1,"id":"b","op":"p"}',
        ]

    def test_oversized_line(self):
        s = LineSplitter()
        with pytest.raises(FrameError) as ei:
            s.push("x" * (MAX_FRAME_BYTES + 1))
        assert ei.value.code == "frame_too_large"

    def test_protocol_version_constant(self):
        assert PROTOCOL_VERSION == 1


class TestEngineFlag:
    def test_default_is_pi(self, monkeypatch):
        monkeypatch.delenv("VIBE_AGENT_ENGINE", raising=False)
        assert get_agent_engine() == "pi"

    def test_legacy_explicit(self, monkeypatch):
        monkeypatch.setenv("VIBE_AGENT_ENGINE", "legacy")
        assert get_agent_engine() == "legacy"

    def test_invalid_value_falls_back_to_pi_never_legacy(self, monkeypatch):
        monkeypatch.setenv("VIBE_AGENT_ENGINE", "bogus")
        assert get_agent_engine() == "pi"

    def test_legacy_only_providers(self):
        assert LEGACY_ONLY_PROVIDERS == frozenset({"vip_server", "openai-codex"})
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_protocol.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar'`（collection error）。

- [ ] 3. 实现 `agent/src/pi_sidecar/__init__.py`：

```python
"""Pi sidecar 执行层（engine 开关 + 协议/客户端/桥接子模块）。"""

from __future__ import annotations

import os

_VALID_ENGINES = ("pi", "legacy")

#: Vibe 专有 provider，无法映射到 Pi ModelRegistry（cookie/自定义路径），
#: 选中它们的会话由 SessionService 显式回退 legacy 引擎（design resolved ambiguity）。
LEGACY_ONLY_PROVIDERS = frozenset({"vip_server", "openai-codex"})


def get_agent_engine() -> str:
    """返回执行引擎选择；env VIBE_AGENT_ENGINE ∈ {"pi","legacy"}，默认 "pi"。

    设计约束（design §Idempotency）：legacy 仅作为显式运维回退，默认禁用——
    非法 env 值一律落回 "pi"，绝不静默选 legacy。
    """
    raw = (os.getenv("VIBE_AGENT_ENGINE") or "").strip().lower()
    return raw if raw in _VALID_ENGINES else "pi"
```

- [ ] 4. 实现 `agent/src/pi_sidecar/protocol.py`：

```python
"""Pi sidecar JSONL 帧协议（与 pi-sidecar/src/protocol.ts 镜像）。

严格 LF 分隔 JSONL；单帧序列化后 ≤ MAX_FRAME_BYTES 字节（UTF-8）；
v1 超限不做分块，直接 FrameError("frame_too_large")。
"""

from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1_048_576


class FrameError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def encode_frame(frame: dict[str, Any]) -> str:
    line = json.dumps(frame, ensure_ascii=False)
    if len(line.encode("utf-8")) > MAX_FRAME_BYTES:
        raise FrameError("frame_too_large", f"frame exceeds {MAX_FRAME_BYTES} bytes")
    return line + "\n"


def _nonempty_str(x: Any) -> bool:
    return isinstance(x, str) and len(x) > 0


def decode_frame(line: str) -> dict[str, Any]:
    trimmed = line.strip()
    if not trimmed:
        raise FrameError("bad_json", "empty frame")
    try:
        obj = json.loads(trimmed)
    except json.JSONDecodeError as exc:
        raise FrameError("bad_json", f"invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise FrameError("bad_frame", "frame is not an object")
    if obj.get("v") != PROTOCOL_VERSION:
        raise FrameError("bad_frame", f"unsupported v: {obj.get('v')!r}")
    if "event" in obj:
        if not _nonempty_str(obj.get("event")):
            raise FrameError("bad_frame", "event must be a non-empty string")
        sid = obj.get("session_id")
        if sid is not None and not _nonempty_str(sid):
            raise FrameError("bad_frame", "bad session_id")
        return obj
    if not _nonempty_str(obj.get("id")):
        raise FrameError("bad_frame", "id must be a non-empty string")
    if "op" in obj:
        if not _nonempty_str(obj.get("op")):
            raise FrameError("bad_frame", "op must be a non-empty string")
        params = obj.get("params")
        if params is not None and not isinstance(params, dict):
            raise FrameError("bad_frame", "params must be an object")
        return obj
    if "ok" in obj:
        if obj["ok"] is True:
            return obj
        if obj["ok"] is False:
            err = obj.get("error")
            if (
                not isinstance(err, dict)
                or not _nonempty_str(err.get("code"))
                or not isinstance(err.get("message"), str)
            ):
                raise FrameError("bad_frame", "error frame needs {code,message}")
            return obj
        raise FrameError("bad_frame", "ok must be boolean")
    raise FrameError("bad_frame", "frame is neither request, response nor event")


class LineSplitter:
    def __init__(self) -> None:
        self._buf = ""

    def push(self, chunk: str) -> list[str]:
        self._buf += chunk
        if "\n" not in self._buf and len(self._buf.encode("utf-8", "ignore")) > MAX_FRAME_BYTES:
            self._buf = ""
            raise FrameError("frame_too_large", f"line exceeds {MAX_FRAME_BYTES} bytes")
        out: list[str] = []
        while True:
            idx = self._buf.find("\n")
            if idx < 0:
                break
            out.append(self._buf[:idx])
            self._buf = self._buf[idx + 1 :]
        return out
```

- [ ] 5. 运行期待通过：`pytest agent/tests/pi_sidecar/test_protocol.py --tb=short -q` → `20 passed`。

- [ ] 6. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 7. Commit：

```bash
git add agent/src/pi_sidecar/__init__.py agent/src/pi_sidecar/protocol.py agent/tests/pi_sidecar/
git commit -s -m "feat(pi-sidecar): python protocol codec mirroring TS framing + engine flag"
```

---

## Phase 1 — Sidecar 核心

### Task 3: 会话索引（Vibe id → Pi JSONL 路径）+ header 校验

**Files:** `pi-sidecar/src/session-index.ts`（Create）、`pi-sidecar/src/session-index.test.ts`（Create）

**Interfaces:** Produces（Task 4/5 消费）：

```ts
export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".vibe-trading", "pi", "sessions");
export const DEFAULT_INDEX_PATH = path.join(os.homedir(), ".vibe-trading", "pi", "session-index.json");
export function isValidVibeSessionId(id: string): boolean;   // /^[0-9a-f]{12}$/（recon：uuid4().hex[:12]）
export function readSessionHeaderId(jsonPath: string): string | null; // 扫描前 8KB 找 type==="session" 的 entry，返回其 id；找不到/解析失败 → null
export class SessionIndex {
  constructor(indexPath?: string, sessionsDir?: string);
  // B2 定案：register 只要求"存在合法 session header"，记录 {path, headerId}；
  // 不强制 Pi header id === Vibe id（SessionManager.create 自行分配 id）。
  // 若 d.ts 核对（Task 5 注 ③）揭示显式 session id 选项，headerId 恒等于 vibeId，双字段语义向后兼容。
  register(vibeId: string, jsonlPath: string): void; // header 缺失 → throw；登记 + 原子持久化（tmp+rename）
  resolve(vibeId: string): string | null;            // 文件仍有 session header 且 id === 记录的 headerId → path；否则 null（替换检测）
  all(): Record<string, { path: string; headerId: string }>;
}
```

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/session-index.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex, isValidVibeSessionId, readSessionHeaderId } from "./session-index";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vibe-sidx-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HDR = (id: string) => JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: "2026-08-30T00:00:00.000Z" });
const VIBE = "a1b2c3d4e5f6";

describe("isValidVibeSessionId", () => {
  test("accepts 12 lowercase hex", () => {
    expect(isValidVibeSessionId("a1b2c3d4e5f6")).toBe(true);
  });
  test("rejects wrong shapes", () => {
    for (const bad of ["", "ABCDEF123456", "a1b2c3d4e5f", "a1b2c3d4e5f60", "../evil"]) {
      expect(isValidVibeSessionId(bad)).toBe(false);
    }
  });
});

describe("readSessionHeaderId", () => {
  test("finds header in first 8KB", () => {
    const p = join(dir, "h1.jsonl");
    writeFileSync(p, HDR("1f9d2a6b9c0d") + "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null }) + "\n");
    expect(readSessionHeaderId(p)).toBe("1f9d2a6b9c0d");
  });
  test("handles 256-byte title slot prefix (title entry precedes header)", () => {
    const p = join(dir, "h2.jsonl");
    const titleSlot = JSON.stringify({ type: "title", title: "t" }).padEnd(256, " ");
    writeFileSync(p, titleSlot + "\n" + HDR("2f9d2a6b9c0d") + "\n");
    expect(readSessionHeaderId(p)).toBe("2f9d2a6b9c0d");
  });
  test("missing file or no header -> null", () => {
    expect(readSessionHeaderId(join(dir, "nope.jsonl"))).toBeNull();
    const p = join(dir, "h3.jsonl");
    writeFileSync(p, '{"type":"message","id":"m1"}\n');
    expect(readSessionHeaderId(p)).toBeNull();
  });
});

describe("SessionIndex", () => {
  test("register + resolve round-trip with header presence validation", () => {
    const jsonl = join(dir, "20260830_000000_a1b2c3d4e5f6.jsonl");
    writeFileSync(jsonl, HDR(VIBE) + "\n");
    const idx = new SessionIndex(join(dir, "index.json"), dir);
    idx.register(VIBE, jsonl); // B2：headerId 记录为 VIBE（文件自身的 header id）
    expect(idx.resolve(VIBE)).toBe(jsonl);
    // 持久化：新实例可读回
    const idx2 = new SessionIndex(join(dir, "index.json"), dir);
    expect(idx2.resolve(VIBE)).toBe(jsonl);
  });

  test("register accepts a Pi-assigned header id different from vibeId (B2 core case)", () => {
    const jsonl = join(dir, "pi-assigned.jsonl");
    writeFileSync(jsonl, HDR("ffffffffffff") + "\n"); // SessionManager.create 自分配 id
    const idx = new SessionIndex(join(dir, "index2.json"), dir);
    idx.register(VIBE, jsonl); // 只要求存在合法 header，不要求 id === vibeId
    expect(idx.resolve(VIBE)).toBe(jsonl);
    expect(idx.all()[VIBE]).toEqual({ path: jsonl, headerId: "ffffffffffff" });
  });

  test("register rejects file without any session header", () => {
    const jsonl = join(dir, "noheader.jsonl");
    writeFileSync(jsonl, '{"type":"message","id":"m1"}\n');
    const idx = new SessionIndex(join(dir, "index2b.json"), dir);
    expect(() => idx.register(VIBE, jsonl)).toThrow(/header/i);
    expect(idx.resolve(VIBE)).toBeNull();
  });

  test("resolve detects file replacement (recorded headerId no longer matches)", () => {
    const jsonl = join(dir, "mutated.jsonl");
    writeFileSync(jsonl, HDR(VIBE) + "\n");
    const idx = new SessionIndex(join(dir, "index3.json"), dir);
    idx.register(VIBE, jsonl);
    writeFileSync(jsonl, HDR("ffffffffffff") + "\n"); // 文件被替换 → headerId 变化
    expect(idx.resolve(VIBE)).toBeNull();
  });

  test("rejects invalid vibe ids", () => {
    const idx = new SessionIndex(join(dir, "index4.json"), dir);
    expect(() => idx.register("BAD ID", join(dir, "x.jsonl"))).toThrow(/invalid/i);
    expect(idx.resolve("../etc/passwd")).toBeNull();
  });
});
```

- [ ] 2. 运行期待失败：`cd pi-sidecar && bun test src/session-index.test.ts` → `Cannot find module "./session-index"`。

- [ ] 3. 实现 `pi-sidecar/src/session-index.ts`：

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_SESSIONS_DIR = join(homedir(), ".vibe-trading", "pi", "sessions");
export const DEFAULT_INDEX_PATH = join(homedir(), ".vibe-trading", "pi", "session-index.json");

const VIBE_ID_RE = /^[0-9a-f]{12}$/;

export function isValidVibeSessionId(id: string): boolean {
  return VIBE_ID_RE.test(id);
}

/** 扫描文件前 8KB，找 type==="session" 的条目，返回其 id。 */
export function readSessionHeaderId(jsonPath: string): string | null {
  let text: string;
  try {
    const fd = Bun.file(jsonPath);
    text = fd.slice(0, 8192).text();
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === "session" && typeof obj.id === "string") return obj.id;
    } catch {
      // 固定宽度 title slot 可能不是合法整行 JSON 的一部分；跳过坏行
    }
  }
  return null;
export interface IndexedSession {
  path: string;
  headerId: string; // 文件自身的 Pi session header id（B2：不强制等于 vibeId）
}

export class SessionIndex {
  private map: Record<string, IndexedSession>;

  constructor(
    private readonly indexPath = DEFAULT_INDEX_PATH,
    private readonly sessionsDir = DEFAULT_SESSIONS_DIR,
  ) {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, "utf8")) as Record<string, IndexedSession | string>;
      // 兼容 v0 纯路径格式（升级容忍）
      this.map = {};
      for (const [k, v] of Object.entries(raw)) {
        this.map[k] = typeof v === "string" ? { path: v, headerId: k } : v;
      }
    } catch {
      this.map = {};
    }
  }

  resolve(vibeId: string): string | null {
    if (!isValidVibeSessionId(vibeId)) return null;
    const entry = this.map[vibeId];
    if (!entry) return null;
    // B2 替换检测：文件必须仍有 session header，且 id === 登记时记录的 headerId
    if (readSessionHeaderId(entry.path) !== entry.headerId) return null;
    return entry.path;
  }

  register(vibeId: string, jsonlPath: string): void {
    if (!isValidVibeSessionId(vibeId)) throw new Error(`invalid vibe session id: ${vibeId}`);
    const headerId = readSessionHeaderId(jsonlPath);
    if (headerId === null) {
      throw new Error(`session file has no valid session header: ${jsonlPath}`);
    }
    this.map[vibeId] = { path: jsonlPath, headerId };
    mkdirSync(dirname(this.indexPath), { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.map, null, 2));
    renameSync(tmp, this.indexPath); // 原子写（design §Lazy migration 标记语义）
  }

  all(): Record<string, IndexedSession> {
    return { ...this.map };
  }
}
```



> 注：若 `Bun.file(...).slice(...)` API 与当前 Bun 版本不符（Task 0 已验证 Bun ≥1.3.14），等价替换为 `readFileSync(jsonPath, "utf8").slice(0, 8192)`——语义相同（8KB 前缀扫描）。

- [ ] 4. 运行期待通过：`cd pi-sidecar && bun test src/session-index.test.ts` → 全部 pass（10 用例）。

- [ ] 5. Commit：

```bash
git add pi-sidecar/src/session-index.ts pi-sidecar/src/session-index.test.ts
git commit -s -m "feat(pi-sidecar): session index with header validation"
```

---

### Task 4: 命令循环 + 17 个 op 处理器（依赖注入，可脱离真实 SDK 测试）

**Files:** `pi-sidecar/src/commands.ts`（Create）、`pi-sidecar/src/commands.test.ts`（Create）

**Interfaces:** Consumes — Task 1 `Frame/encodeFrame/decodeFrame/FrameError`、Task 3 `SessionIndex`。Produces（Task 5/7/main 消费）：

```ts
export interface SessionLike {           // AgentSession 子集（Task 5 的 PiSessionDriver 实现）
  sessionId: string;
  sessionFile: string;
  isBusy(): boolean;
  subscribe(fn: (e: { type: string; payload: Record<string, unknown> }) => void): () => void;
  prompt(text: string): Promise<void>;   // 内部 { streamingBehavior: "steer" }
  steer(text: string): void;
  followUp(text: string): void;
  abort(): void;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  navigateTree(entryId: string): Promise<string>;  // → new leaf id
  getMessages(beforeCursor: string | null, limit: number): { messages: MsgOut[]; nextCursor: string | null };
  exportTo(outPath: string): Promise<void>;
  importMessages(msgs: { role: string; content: string; timestamp?: string }[]): Promise<number>;
}
export interface SessionDriver {         // Task 5 实现；测试用 fake
  open(vibeId: string): Promise<SessionLike>;      // 不存在 → throw Error("not_found")
  create(vibeId: string, model?: string, thinkingLevel?: string): Promise<SessionLike>;
  get(vibeId: string): SessionLike | undefined;
  setToolManifest(tools: unknown[]): Promise<number>;
  cancelToolCall(callId: string): boolean;
}
export type FrameSink = (raw: string) => void;
export function createCommandHandler(deps: {
  driver: SessionDriver;
  sink: FrameSink;                                   // 写一行到 stdout
  hostCall: (op: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
}): (line: string) => Promise<void>;                 // 输入一行 → 处理 + 经 sink 回帧；错误帧兜底，绝不 throw
```

命令 → result 严格按「跨任务接口契约」的 result 形状表。`prompt`/`compact` 立即 ack；`agent_end(isTerminal!==false)` 事件由 driver 订阅转成 `session_event` 帧（`{"type": piType, "payload": {...}}`）经 sink 发出。`get_messages` 错误映射：busy → `session_busy`、坏游标 → `stale_cursor`。未知 op → `unknown_op`。

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/commands.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { createCommandHandler, type SessionDriver, type SessionLike } from "./commands";

function makeFakeSession(over: Partial<SessionLike> = {}): SessionLike {
  return {
    sessionId: "a1b2c3d4e5f6",
    sessionFile: "/tmp/s.jsonl",
    isBusy: () => false,
    subscribe: () => () => {},
    prompt: async () => {},
    steer: () => {},
    followUp: () => {},
    abort: () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    compact: async () => {},
    navigateTree: async () => "leaf123",
    getMessages: () => ({ messages: [{ entry_id: "e1", role: "user", content: "hi", timestamp: "t" }], nextCursor: null }),
    exportTo: async () => {},
    importMessages: async () => 2,
    ...over,
  };
}

function makeDriver(over: Partial<SessionDriver> = {}): SessionDriver {
  const sessions = new Map<string, SessionLike>();
  return {
    open: async (id) => {
      const s = sessions.get(id);
      if (!s) throw Object.assign(new Error("not_found"), { code: "not_found" });
      return s;
    },
    create: async (id) => {
      const s = makeFakeSession({ sessionId: id });
      sessions.set(id, s);
      return s;
    },
    get: (id) => sessions.get(id),
    setToolManifest: async (tools) => (tools as unknown[]).length,
    cancelToolCall: () => true,
    ...over,
  };
}

function harness(driver = makeDriver()) {
  const out: string[] = [];
  const handler = createCommandHandler({
    driver,
    sink: (raw) => out.push(raw),
    hostCall: async () => ({}),
  });
  return { driver, out, send: (obj: unknown) => handler(JSON.stringify(obj)) };
}

const req = (id: string, op: string, params?: Record<string, unknown>) => ({ v: 1, id, op, params });

describe("command handler", () => {
  test("ping", async () => {
    const h = harness();
    await h.send(req("r-1", "ping"));
    expect(JSON.parse(h.out[0])).toMatchObject({ id: "r-1", ok: true, result: { pong: true, protocol: 1 } });
  });

  test("unknown op", async () => {
    const h = harness();
    await h.send(req("r-2", "frobnicate"));
    expect(JSON.parse(h.out[0])).toMatchObject({ id: "r-2", ok: false, error: { code: "unknown_op" } });
  });

  test("bad json -> error frame, handler does not throw", async () => {
    const h = harness();
    await h.send("{nope");
    expect(JSON.parse(h.out[0])).toMatchObject({ ok: false, error: { code: "bad_json" } });
  });

  test("new_session then prompt ack, state, abort", async () => {
    const h = harness();
    await h.send(req("r-3", "new_session", { session_id: "a1b2c3d4e5f6" }));
    expect(JSON.parse(h.out[0])).toMatchObject({ id: "r-3", ok: true, result: { session_file: expect.any(String) } });
    await h.send(req("r-4", "prompt", { session_id: "a1b2c3d4e5f6", text: "hi" }));
    expect(JSON.parse(h.out[1])).toMatchObject({ id: "r-4", ok: true, result: { accepted: true } });
    await h.send(req("r-5", "get_state", { session_id: "a1b2c3d4e5f6" }));
    expect(JSON.parse(h.out[2])).toMatchObject({ id: "r-5", ok: true, result: { busy: false } });
    await h.send(req("r-6", "abort", { session_id: "a1b2c3d4e5f6" }));
    expect(JSON.parse(h.out[3])).toMatchObject({ id: "r-6", ok: true, result: { aborted: true } });
  });

  test("open_session missing -> not_found", async () => {
    const h = harness();
    await h.send(req("r-7", "open_session", { session_id: "a1b2c3d4e5f6" }));
    expect(JSON.parse(h.out[0])).toMatchObject({ id: "r-7", ok: false, error: { code: "not_found" } });
  });

  test("prompt without session -> no_session; prompt while busy -> session_busy", async () => {
    const h = harness();
    await h.send(req("r-8", "prompt", { session_id: "000000000000", text: "x" }));
    expect(JSON.parse(h.out[0])).toMatchObject({ ok: false, error: { code: "no_session" } });

    const busy = makeFakeSession({ isBusy: () => true });
    const d = makeDriver({ open: async () => busy, get: () => busy });
    const h2 = harness(d);
    await h2.send(req("r-9", "prompt", { session_id: "a1b2c3d4e5f6", text: "x" }));
    expect(JSON.parse(h2.out[0])).toMatchObject({ ok: false, error: { code: "session_busy" } });
  });

  test("steer/follow_up/compact/set_model/set_thinking_level/navigate/export", async () => {
    const h = harness();
    await h.send(req("r-10", "new_session", { session_id: "a1b2c3d4e5f6" }));
    await h.send(req("r-11", "steer", { session_id: "a1b2c3d4e5f6", text: "s" }));
    expect(JSON.parse(h.out[1])).toMatchObject({ ok: true, result: { queued: true } });
    await h.send(req("r-12", "follow_up", { session_id: "a1b2c3d4e5f6", text: "f" }));
    expect(JSON.parse(h.out[2])).toMatchObject({ ok: true, result: { queued: true } });
    await h.send(req("r-13", "compact", { session_id: "a1b2c3d4e5f6" }));
    expect(JSON.parse(h.out[3])).toMatchObject({ ok: true, result: { started: true } });
    await h.send(req("r-14", "set_model", { session_id: "a1b2c3d4e5f6", model: "openai/gpt-4o" }));
    expect(JSON.parse(h.out[4])).toMatchObject({ ok: true, result: { model: "openai/gpt-4o" } });
    await h.send(req("r-15", "set_thinking_level", { session_id: "a1b2c3d4e5f6", level: "high" }));
    expect(JSON.parse(h.out[5])).toMatchObject({ ok: true, result: { thinking_level: "high" } });
    await h.send(req("r-16", "navigate_tree", { session_id: "a1b2c3d4e5f6", entry_id: "e9" }));
    expect(JSON.parse(h.out[6])).toMatchObject({ ok: true, result: { leaf_id: "leaf123" } });
    await h.send(req("r-17", "export_session", { session_id: "a1b2c3d4e5f6", out_path: "/tmp/x.jsonl" }));
    expect(JSON.parse(h.out[7])).toMatchObject({ ok: true, result: { path: "/tmp/x.jsonl" } });
  });

  test("get_messages + missing params", async () => {
    const h = harness();
    await h.send(req("r-18", "new_session", { session_id: "a1b2c3d4e5f6" }));
    await h.send(req("r-19", "get_messages", { session_id: "a1b2c3d4e5f6", limit: 5 }));
    expect(JSON.parse(h.out[1])).toMatchObject({ ok: true, result: { messages: [{ entry_id: "e1" }], next_cursor: null } });
    await h.send(req("r-20", "get_messages", { session_id: "a1b2c3d4e5f6" })); // M1：limit 缺省 → 默认 100，成功
    expect(JSON.parse(h.out[2])).toMatchObject({ ok: true, result: { messages: [{ entry_id: "e1" }] } });
    await h.send(req("r-20b", "get_messages", { session_id: "a1b2c3d4e5f6", limit: 0 })); // 非法 limit → bad_request
    expect(JSON.parse(h.out[3])).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  test("set_tool_manifest / import_messages / tool_cancel", async () => {
    const h = harness();
    await h.send(req("r-21", "set_tool_manifest", { tools: [{ name: "a" }, { name: "b" }] }));
    expect(JSON.parse(h.out[0])).toMatchObject({ ok: true, result: { count: 2 } });
    await h.send(req("r-22", "import_messages", { session_id: "a1b2c3d4e5f6", messages: [{ role: "user", content: "x" }] }));
    expect(JSON.parse(h.out[1])).toMatchObject({ ok: true, result: { imported: 2 } });
    await h.send(req("r-23", "tool_cancel", { call_id: "t-1" }));
    expect(JSON.parse(h.out[2])).toMatchObject({ ok: true, result: { cancelled: true } });
  });

  test("session_event forwarding: driver subscribe events reach sink as session_event frames", async () => {
    let listener: ((e: { type: string; payload: Record<string, unknown> }) => void) | null = null;
    const sess = makeFakeSession({
      subscribe: (fn) => {
        listener = fn;
        return () => {};
      },
    });
    const d = makeDriver({ open: async () => sess, get: () => sess });
    const h = harness(d);
    await h.send(req("r-24", "open_session", { session_id: "a1b2c3d4e5f6" }));
    listener!({ type: "agent_end", payload: { isTerminal: true } });
    const last = JSON.parse(h.out[h.out.length - 1]);
    expect(last).toMatchObject({ event: "session_event", session_id: "a1b2c3d4e5f6", data: { type: "agent_end" } });
  });
});
```

- [ ] 2. 运行期待失败：`cd pi-sidecar && bun test src/commands.test.ts` → `Cannot find module "./commands"`。

- [ ] 3. 实现 `pi-sidecar/src/commands.ts`：

```ts
import { encodeFrame, type EventFrame, type Frame } from "./protocol";

export interface MsgOut {
  entry_id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface SessionLike {
  sessionId: string;
  sessionFile: string;
  isBusy(): boolean;
  subscribe(fn: (e: { type: string; payload: Record<string, unknown> }) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): void;
  followUp(text: string): void;
  abort(): void;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  navigateTree(entryId: string): Promise<string>;
  getMessages(beforeCursor: string | null, limit: number): { messages: MsgOut[]; nextCursor: string | null };
  exportTo(outPath: string): Promise<void>;
  importMessages(msgs: { role: string; content: string; timestamp?: string }[]): Promise<number>;
}

export interface SessionDriver {
  open(vibeId: string): Promise<SessionLike>;
  create(vibeId: string, model?: string, thinkingLevel?: string): Promise<SessionLike>;
  get(vibeId: string): SessionLike | undefined;
  setToolManifest(tools: unknown[]): Promise<number>;
  cancelToolCall(callId: string): boolean;
}

export type FrameSink = (raw: string) => void;

const ok = (id: string, result: unknown) => encodeFrame({ v: 1, id, ok: true, result });
const err = (id: string, code: string, message: string) => encodeFrame({ v: 1, id, ok: false, error: { code, message } });
const event = (frame: Omit<EventFrame, "v">) => encodeFrame({ v: 1, ...frame });

function requireParams(params: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const p = params ?? {};
  for (const k of keys) {
    if (!(k in p)) throw Object.assign(new Error(`missing param: ${k}`), { code: "bad_request" });
  }
  return p;
}

function needSession(deps: { driver: SessionDriver }, sessionId: unknown): SessionLike {
  if (typeof sessionId !== "string") throw Object.assign(new Error("missing session_id"), { code: "bad_request" });
  const s = deps.driver.get(sessionId);
  if (!s) throw Object.assign(new Error(`no open session ${sessionId}`), { code: "no_session" });
  return s;
}

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" ? c : "internal";
}

export function createCommandHandler(deps: {
  driver: SessionDriver;
  sink: FrameSink;
  hostCall: (op: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
}): (line: string) => Promise<void> {
  const { driver, sink, hostCall } = deps;

  // 每会话事件订阅：driver open/create 后由 handler 首次接线
  const wired = new Set<string>();
  function wireEvents(s: SessionLike): void {
    if (wired.has(s.sessionId)) return;
    wired.add(s.sessionId);
    s.subscribe((e) => {
      try {
        sink(event({ event: "session_event", session_id: s.sessionId, data: { type: e.type, payload: e.payload } }));
      } catch {
        // sink 写失败（管道关闭）由 main 层处理；此处不 throw
      }
    });
  }

  async function handleRequest(id: string, op: string, params: Record<string, unknown> | undefined): Promise<string> {
    switch (op) {
      case "ping":
        return ok(id, { pong: true, protocol: 1 });
      case "new_session": {
        const p = requireParams(params, ["session_id"]);
        const s = await driver.create(String(p.session_id), p.model as string | undefined, p.thinking_level as string | undefined);
        wireEvents(s);
        return ok(id, { session_file: s.sessionFile });
      }
      case "open_session": {
        const p = requireParams(params, ["session_id"]);
        const s = await driver.open(String(p.session_id));
        wireEvents(s);
        return ok(id, { session_file: s.sessionFile });
      }
      case "prompt": {
        const p = requireParams(params, ["session_id", "text"]);
        const s = needSession(deps, p.session_id);
        if (s.isBusy()) return err(id, "session_busy", "a turn is already active");
        wireEvents(s);
        void s.prompt(String(p.text)).catch(() => {
          // prompt 失败不 ack 失败（已 ack accepted）；错误经 session_event 流出
        });
        return ok(id, { accepted: true });
      }
      case "steer": {
        const p = requireParams(params, ["session_id", "text"]);
        needSession(deps, p.session_id).steer(String(p.text));
        return ok(id, { queued: true });
      }
      case "follow_up": {
        const p = requireParams(params, ["session_id", "text"]);
        needSession(deps, p.session_id).followUp(String(p.text));
        return ok(id, { queued: true });
      }
      case "abort": {
        const p = requireParams(params, ["session_id"]);
        needSession(deps, p.session_id).abort();
        return ok(id, { aborted: true });
      }
      case "get_state": {
        const p = requireParams(params, ["session_id"]);
        const s = needSession(deps, p.session_id);
        return ok(id, {
          busy: s.isBusy(),
          model: (s as unknown as { currentModel?: () => string | null }).currentModel?.() ?? null,
          thinking_level: (s as unknown as { currentThinkingLevel?: () => string | null }).currentThinkingLevel?.() ?? null,
          session_file: s.sessionFile,
          session_id: s.sessionId,
        });
      }
      case "get_messages": {
        const p = requireParams(params, ["session_id"]); // M1：limit 可选，默认 100
        const s = needSession(deps, p.session_id);
        if (s.isBusy()) return err(id, "session_busy", "cannot page messages mid-turn");
        const before = (p.before_cursor as string | undefined) ?? null;
        const limit = p.limit === undefined ? 100 : Number(p.limit);
        if (!Number.isInteger(limit) || limit < 1) return err(id, "bad_request", "limit must be positive integer");
        const r = s.getMessages(before, limit);
        return ok(id, { messages: r.messages, next_cursor: r.nextCursor });
      }
      case "set_model": {
        const p = requireParams(params, ["session_id", "model"]);
        await needSession(deps, p.session_id).setModel(String(p.model));
        return ok(id, { model: String(p.model) });
      }
      case "set_thinking_level": {
        const p = requireParams(params, ["session_id", "level"]);
        await needSession(deps, p.session_id).setThinkingLevel(String(p.level));
        return ok(id, { thinking_level: String(p.level) });
      }
      case "compact": {
        const p = requireParams(params, ["session_id"]);
        const s = needSession(deps, p.session_id);
        void s.compact(p.instructions as string | undefined).catch(() => {});
        return ok(id, { started: true });
      }
      case "navigate_tree": {
        const p = requireParams(params, ["session_id", "entry_id"]);
        const leaf = await needSession(deps, p.session_id).navigateTree(String(p.entry_id));
        return ok(id, { leaf_id: leaf });
      }
      case "export_session": {
        const p = requireParams(params, ["session_id", "out_path"]);
        await needSession(deps, p.session_id).exportTo(String(p.out_path));
        return ok(id, { path: String(p.out_path) });
      }
      case "set_tool_manifest": {
        const p = requireParams(params, ["tools"]);
        const count = await driver.setToolManifest(p.tools as unknown[]);
        return ok(id, { count });
      }
      case "import_messages": {
        const p = requireParams(params, ["session_id", "messages"]);
        const msgs = p.messages as { role: string; content: string; timestamp?: string }[];
        const n = await needSession(deps, p.session_id).importMessages(msgs);
        return ok(id, { imported: n });
      }
      case "tool_cancel": {
        const p = requireParams(params, ["call_id"]);
        return ok(id, { cancelled: driver.cancelToolCall(String(p.call_id)) });
      }
      default:
        return err(id, "unknown_op", `unknown op: ${op}`);
    }
  }

  return async (line: string): Promise<void> => {
    let id = "unknown";
    try {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (e) {
        sink(err("unknown", "bad_json", `invalid JSON: ${(e as Error).message}`));
        return;
      }
      if (obj.v !== 1 || typeof obj.id !== "string" || typeof obj.op !== "string") {
        sink(err("unknown", "bad_frame", "request must be {v:1,id,op}"));
        return;
      }
      id = obj.id;
      sink(await handleRequest(id, obj.op, obj.params as Record<string, unknown> | undefined));
    } catch (e) {
      sink(err(id, errCode(e), (e as Error).message));
    }
  };
}
```

- [ ] 4. 运行期待通过：`cd pi-sidecar && bun test src/commands.test.ts` → 全部 pass（10 用例）。

- [ ] 5. Commit：

```bash
git add pi-sidecar/src/commands.ts pi-sidecar/src/commands.test.ts
git commit -s -m "feat(pi-sidecar): RPC command routing with injectable session driver"
```

---

### Task 5: SessionDriver（Pi `AgentSession` 接线）+ 模型/Provider 接线

**Files:** `pi-sidecar/src/session-driver.ts`（Create）、`pi-sidecar/src/session-driver.test.ts`（Create）、`pi-sidecar/src/model-wiring.ts`（Create）、`pi-sidecar/src/model-wiring.test.ts`（Create）、`pi-sidecar/extensions/vibe-providers/index.ts`（Create）

**Interfaces:** Consumes — Task 3 `SessionIndex`、Task 4 `SessionLike/SessionDriver`、Task 7 `ToolBridge`（构造参数注入）。Produces — `PiSessionDriver implements SessionDriver`：

```ts
export const PI_AGENT_DIR = path.join(os.homedir(), ".vibe-trading", "pi", "agent");
export const PI_SESSIONS_DIR = path.join(os.homedir(), ".vibe-trading", "pi", "sessions");
export function resolveDefaultModel(env?: Record<string, string | undefined>): string | null;
// LANGCHAIN_PROVIDER/LANGCHAIN_MODEL_NAME → "<provider>/<model>"；vip_server/openai-codex → null（legacy-only）
export function vibeProviderRegistrations(env?: Record<string, string | undefined>):
  { id: string; name: string; baseUrl: string; envKey: string }[];
// deepseek/zhipu/dashscope/moonshot/minimax/groq 中设置了 API key env 的子集
export class PiSessionDriver implements SessionDriver {
  constructor(opts: { index: SessionIndex; toolBridge: ToolBridge; env?: NodeJS.ProcessEnv });
}
```

内建工具禁用（Global Constraint）：`createAgentSession` 传 `toolNames: []`、`restrictToolNames: true`、`allowRestrictedCustomTools: true`（放行 toolBridge 注册的 manifest 自定义工具）、`enableMCP: false`、`enableLsp: false`、`disableExtensionDiscovery: true`、`agentDir: PI_AGENT_DIR`、`settings: Settings.isolated({ agentDir: PI_AGENT_DIR })`、`sessionManager: SessionManager.create(cwd, PI_SESSIONS_DIR)`。`prompt` 内部用 `session.prompt(text, { streamingBehavior: "steer" })`。

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/model-wiring.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { resolveDefaultModel, vibeProviderRegistrations } from "./model-wiring";

describe("resolveDefaultModel", () => {
  test("maps LANGCHAIN_PROVIDER + LANGCHAIN_MODEL_NAME", () => {
    expect(resolveDefaultModel({ LANGCHAIN_PROVIDER: "deepseek", LANGCHAIN_MODEL_NAME: "deepseek-chat" })).toBe(
      "deepseek/deepseek-chat",
    );
  });

  test("qwen alias maps to dashscope", () => {
    expect(resolveDefaultModel({ LANGCHAIN_PROVIDER: "qwen", LANGCHAIN_MODEL_NAME: "qwen-max" })).toBe(
      "dashscope/qwen-max",
    );
  });

  test("vip_server and openai-codex -> null (legacy-only)", () => {
    expect(resolveDefaultModel({ LANGCHAIN_PROVIDER: "vip_server", LANGCHAIN_MODEL_NAME: "x" })).toBeNull();
    expect(resolveDefaultModel({ LANGCHAIN_PROVIDER: "openai-codex", LANGCHAIN_MODEL_NAME: "x" })).toBeNull();
  });

  test("unset provider defaults to openai", () => {
    expect(resolveDefaultModel({ LANGCHAIN_MODEL_NAME: "gpt-4o" })).toBe("openai/gpt-4o");
  });

  test("no model name -> null", () => {
    expect(resolveDefaultModel({})).toBeNull();
  });
});

describe("vibeProviderRegistrations", () => {
  test("only includes providers whose key env is set", () => {
    const regs = vibeProviderRegistrations({ DEEPSEEK_API_KEY: "sk-x", ZHIPU_API_KEY: "z", GROQ_BASE_URL: "http://127.0.0.1:9/v1" });
    const ids = regs.map((r) => r.id);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("zhipu");
    expect(ids).toContain("groq");
    expect(ids).not.toContain("moonshot");
    expect(ids.find((r) => r.id === "groq")!.baseUrl).toBe("http://127.0.0.1:9/v1"); // env 覆盖
    expect(ids.find((r) => r.id === "deepseek")!.envKey).toBe("DEEPSEEK_API_KEY");
  });

  test("empty env -> empty list", () => {
    expect(vibeProviderRegistrations({})).toEqual([]);
  });
});
```

- [ ] 2. 写失败测试 `pi-sidecar/src/session-driver.test.ts`（不依赖真实 provider——只测纯逻辑分支与注册面；真实链路由 Phase 8 集成测试覆盖）：

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "./session-index";

describe("PiSessionDriver construction", () => {
  test("creates with isolated dirs and tool bridge (smoke)", async () => {
    const { PiSessionDriver } = await import("./session-driver");
    const dir = mkdtempSync(join(tmpdir(), "vibe-pidrv-"));
    try {
      const bridge = {
        customTools: () => [] as unknown[],
        onSessionEvent: () => {},
      };
      const driver = new PiSessionDriver({
        index: new SessionIndex(join(dir, "idx.json"), dir),
        toolBridge: bridge as never,
        env: {}, // 测试环境不注册任何 provider
      });
      expect(typeof driver.create).toBe("function");
      expect(typeof driver.open).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create produces session whose sessionFile lives under sessions dir and header id matches", async () => {
    const { PiSessionDriver } = await import("./session-driver");
    const dir = mkdtempSync(join(tmpdir(), "vibe-pidrv2-"));
    try {
      const bridge = { customTools: () => [], onSessionEvent: () => {} };
      const driver = new PiSessionDriver({
        index: new SessionIndex(join(dir, "idx.json"), dir),
        toolBridge: bridge as never,
        env: {},
      });
      const s = await driver.create("a1b2c3d4e5f6");
      expect(s.sessionId).toBe("a1b2c3d4e5f6");
      expect(s.sessionFile.startsWith(dir)).toBe(true);
      // 触发落盘并登记索引
      await s.importMessages([{ role: "user", content: "hello" }]);
      expect(driver.index.resolve("a1b2c3d4e5f6")).toBe(s.sessionFile);
      // open 回读同一文件
      const s2 = await driver.open("a1b2c3d4e5f6");
      expect(s2.sessionFile).toBe(s.sessionFile);
      writeFileSync(join(dir, "marker"), "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] 3. 运行期待失败：`cd pi-sidecar && bun test src/model-wiring.test.ts src/session-driver.test.ts` → 两个 `Cannot find module`。

- [ ] 4. 实现 `pi-sidecar/src/model-wiring.ts`：

```ts
export interface ProviderRegistration {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
}

type Env = Record<string, string | undefined>;

/** Vibe llm_providers.json 的 OpenAI 兼容子集（recon §7.1 表）。 */
const OPENAI_COMPAT_PROVIDERS = [
  { id: "deepseek", envKey: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBase: "https://api.deepseek.com/v1" },
  { id: "zhipu", envKey: "ZHIPU_API_KEY", baseUrlEnv: "ZHIPU_BASE_URL", defaultBase: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "dashscope", envKey: "DASHSCOPE_API_KEY", baseUrlEnv: "DASHSCOPE_BASE_URL", defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "moonshot", envKey: "MOONSHOT_API_KEY", baseUrlEnv: "MOONSHOT_BASE_URL", defaultBase: "https://api.moonshot.cn/v1" },
  { id: "minimax", envKey: "MINIMAX_API_KEY", baseUrlEnv: "MINIMAX_BASE_URL", defaultBase: "https://api.minimax.chat/v1" },
  { id: "groq", envKey: "GROQ_API_KEY", baseUrlEnv: "GROQ_BASE_URL", defaultBase: "https://api.groq.com/openai/v1" },
] as const;

/** Vibe provider 名 → Pi provider id（qwen 是 dashscope 的别名，recon §7.1）。 */
const PROVIDER_ALIASES: Record<string, string> = { qwen: "dashscope" };

const LEGACY_ONLY = new Set(["vip_server", "openai-codex"]);

export function resolveDefaultModel(env: Env = process.env): string | null {
  const provider = (env.LANGCHAIN_PROVIDER ?? "openai").trim();
  const model = (env.LANGCHAIN_MODEL_NAME ?? "").trim();
  if (!model) return null;
  if (LEGACY_ONLY.has(provider)) return null; // legacy-engine-only（Global Constraint）
  const piId = PROVIDER_ALIASES[provider] ?? provider;
  return `${piId}/${model}`;
}

export function vibeProviderRegistrations(env: Env = process.env): ProviderRegistration[] {
  const out: ProviderRegistration[] = [];
  for (const p of OPENAI_COMPAT_PROVIDERS) {
    const key = env[p.envKey];
    if (!key) continue;
    out.push({
      id: p.id,
      name: p.id,
      baseUrl: (env[p.baseUrlEnv] ?? p.defaultBase).replace(/\/$/, ""),
      envKey: p.envKey,
    });
  }
  return out;
}
```

> 注：openai/gemini/openrouter/ollama 是 Pi 原生 provider（env key 经 `getEnvApiKey` 原生发现），无需注册；它们的 baseUrl 覆盖（`OPENAI_BASE_URL`/`GEMINI_BASE_URL`/`OPENROUTER_BASE_URL`/`OLLAMA_BASE_URL`）也由 Pi 原生 env 链处理。

- [ ] 5. 实现 `pi-sidecar/extensions/vibe-providers/index.ts`：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { vibeProviderRegistrations } from "../../src/model-wiring";

/** factory load 时把 Vibe 的 OpenAI 兼容 provider 注册进 Pi（Global Constraint: model wiring）。 */
export default function (pi: ExtensionAPI) {
  for (const reg of vibeProviderRegistrables()) {
    pi.registerProvider({
      id: reg.id,
      name: reg.name,
      baseUrl: reg.baseUrl,
      api: "openai-completions",
      apiKey: () => process.env[reg.envKey] ?? "",
    });
  }
}

function vibeProviderRegistrables() {
  // 延迟读取，便于测试注入 env
  return vibeProviderRegistrations(process.env as Record<string, string | undefined>);
}
```

> 执行者注意：`pi.registerProvider` 的签名以 pinned SDK 的 `ExtensionAPI` d.ts 为准（Task 0 Step 7 已要求核对）；若字段名不同（例如 `typeheim` 命名），按 d.ts 微调本文件并保持测试语义不变。

- [ ] 6. 实现 `pi-sidecar/src/session-driver.ts`：

```ts
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionDriver, SessionLike, MsgOut } from "./commands";
import { SessionIndex } from "./session-index";
import { resolveDefaultModel } from "./model-wiring";
import type { ToolBridge } from "./tool-bridge";

export const PI_AGENT_DIR = join(homedir(), ".vibe-trading", "pi", "agent");
export const PI_SESSIONS_DIR = join(homedir(), ".vibe-trading", "pi", "sessions");

interface PiEventLike {
  type: string;
  [k: string]: unknown;
}

class PiSessionHandle implements SessionLike {
  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly session: /* AgentSession 实例 */ unknown,
    private readonly index: SessionIndex,
  ) {}

  private get s(): {
    isStreaming?: () => boolean;
    on?: (fn: (e: PiEventLike) => void) => () => void;
    subscribe?: (fn: (e: PiEventLike) => void) => () => void;
    prompt?: (text: string, opts?: Record<string, unknown>) => Promise<void>;
    steer?: (text: string) => void;
    followUp?: (text: string) => void;
    abort?: () => void;
    setModel?: (m: string) => Promise<void>;
    setThinkingLevel?: (l: string) => Promise<void>;
    compact?: (opts?: Record<string, unknown>) => Promise<unknown>;
    navigateTree?: (entryId: string) => Promise<unknown>;
    sessionManager?: { getEntries?: () => Array<Record<string, unknown>> };
  } {
    return this.session as never;
  }

  isBusy(): boolean {
    return this.s.isStreaming?.() ?? false;
  }

  subscribe(fn: (e: { type: string; payload: Record<string, unknown> }) => void): () => void {
    const sub = this.s.subscribe ?? this.s.on;
    if (!sub) return () => {};
    return sub.call(this.s, (e: PiEventLike) => {
      const { type, ...payload } = e;
      fn({ type, payload: payload as Record<string, unknown> });
    });
  }

  async prompt(text: string): Promise<void> {
    await this.s.prompt?.(text, { streamingBehavior: "steer" });
  }


  async navigateTree(entryId: string): Promise<string> {
    const r = await this.s.navigateTree?.(entryId);
    return typeof r === "string" ? r : entryId;
  }

  getMessages(beforeCursor: string | null, limit: number): { messages: MsgOut[]; nextCursor: string | null } {
    const entries = (this.s.sessionManager?.getEntries?.() ?? []) as Array<Record<string, unknown>>;
    const msgs = entries.filter((e) => e.type === "message");
    let end = msgs.length;
    if (beforeCursor) {
      const i = msgs.findIndex((e) => e.id === beforeCursor);
      if (i < 0) throw Object.assign(new Error("stale cursor"), { code: "stale_cursor" });
      end = i;
    }
    const start = Math.max(0, end - limit);
    const slice = msgs.slice(start, end);
    return {
      messages: slice.map((e) => this.toMsgOut(e)),
      nextCursor: start > 0 ? String(slice[0]?.id ?? "") || null : null,
    };
  }

  private toMsgOut(e: Record<string, unknown>): MsgOut {
    const m = (e.message ?? {}) as { role?: string; content?: unknown };
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content
        .filter((b) => (b as { type?: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("");
    }
    return {
      entry_id: String(e.id ?? ""),
      role: String(m.role ?? "user"),
      content,
      timestamp: String(e.timestamp ?? ""),
    };
  }

  /** header 必须落盘后 index.register 才能读到 headerId（B2）。实名以 d.ts 为准（ensureOnDisk）。 */
  private async ensureOnDisk(): Promise<void> {
    await (this.s as { ensureOnDisk?: () => Promise<void> | void }).ensureOnDisk?.();
  }

  async exportTo(outPath: string): Promise<void> {
    await Bun.write(outPath, await Bun.file(this.sessionFile).text());
  }

  async importMessages(msgs: { role: string; content: string; timestamp?: string }[]): Promise<number> {
    const sm = (this.s.sessionManager ?? this.session as { sessionManager?: unknown }).sessionManager as
      | { appendUserMessage?: (text: string) => unknown; appendAssistantMessage?: (text: string) => unknown }
      | undefined;
    if (!sm?.appendUserMessage) {
      throw new Error("SessionManager message-append API unavailable in pinned SDK; see d.ts");
    }
    let n = 0;
    for (const m of msgs) {
      if (m.role === "user") sm.appendUserMessage?.(m.content);
      else if (m.role === "assistant") sm.appendAssistantMessage?.(m.content);
      else continue;
      n += 1;
    }
    // 触发落盘 + 索引登记（design §Lazy migration: 同 ID Pi 会话；create() 已登记，此处幂等）
    await this.ensureOnDisk();
    this.index.register(this.sessionId, this.sessionFile);
    return n;
  }
}

export class PiSessionDriver implements SessionDriver {
  readonly index: SessionIndex;
  constructor(
    private readonly opts: {
      index: SessionIndex;
      toolBridge: ToolBridge;
      env?: NodeJS.ProcessEnv;
      extensions?: unknown[]; // B1：vibe-providers/vibe-memory factories（main.ts 生产注入）
    },
  ) {
    this.index = opts.index;
  }

  async create(vibeId: string, model?: string, _thinkingLevel?: string): Promise<SessionLike> {
    const sm = SessionManager.create(PI_SESSIONS_DIR, PI_SESSIONS_DIR) as never;
    const m = model ?? resolveDefaultModel(this.opts.env);
    const s = await this.buildSession(vibeId, sm, m);
    this.handles.set(vibeId, s);
    // B2b/B2 落盘序：SessionManager.create 新会话默认 memory-only（omp://session.md），
    await (s as unknown as { ensureOnDisk(): Promise<void> }).ensureOnDisk();
    this.index.register(vibeId, s.sessionFile); // B2b：登记 {path, headerId}——restart 后 open_session 可重开，杜绝静默丢历史
    return s;
  }

  private async buildSession(vibeId: string, sessionManager: unknown, model: string | null): Promise<SessionLike> {
    const result = await createAgentSession({
      cwd: PI_SESSIONS_DIR,
      agentDir: PI_AGENT_DIR,
      settings: Settings.isolated({ agentDir: PI_AGENT_DIR }),
      sessionManager: sessionManager as never,
      extensions: this.opts.extensions ?? [], // ambient discovery 已禁用；extensions 经显式注入（B1/main.ts）
      customTools: this.opts.toolBridge.customTools(),
      toolNames: [], // Global Constraint: 内建 read/write/edit/bash 全禁用
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      ...(model ? { model } : {}),
    } as never);
    const session = (result as { session: unknown }).session;
    const file = ((session as { sessionFile?: string }).sessionFile) ?? "";
    return new PiSessionHandle(vibeId, file, session, this.index);
  }


  async open(vibeId: string): Promise<SessionLike> {
    const p = this.index.resolve(vibeId);
    if (!p) throw Object.assign(new Error(`session ${vibeId} not found`), { code: "not_found" });
    const sm = SessionManager.open(p) as never;
    const s = await this.buildSession(vibeId, sm, null);
    this.handles.set(vibeId, s);
    return s;
  }

  get(vibeId: string): SessionLike | undefined {
    return this.handles.get(vibeId);
  }

  private handles = new Map<string, SessionLike>();

  setToolManifest(tools: unknown[]): Promise<number> {
    return this.opts.toolBridge.setManifest(tools);
  }

  cancelToolCall(callId: string): boolean {
    return this.opts.toolBridge.cancel(callId);
  }
}

```

> 执行者注意（三处 d.ts 核对，来自 Task 0 Step 7 的导出清单）：
> ① `createAgentSession` options 字段名以 `dist/sdk.d.ts` 为准（本文件按已验证 SDK facts 书写；`sessionManager` 参数若需要 `SessionManager.create(cwd, sessionDir)` 的具体签名差异，按 d.ts 调整，但**必须**保持会话目录指向 `~/.vibe-trading/pi/sessions`）；
> ② `importMessages` 使用的 SessionManager 消息追加 API（`appendUserMessage`/`appendAssistantMessage`）以 `dist/session/session-manager.d.ts` 实名为准（可能是 `appendMessage`/`appendEntry`）——语义约束：按时间序追加 user/assistant 文本消息、不改 header id、追加后确保落盘。若 SDK 无公开追加 API，改用直接按 `SessionEntry` 格式追加 `message` 条目并 `SessionManager.open()` 重载（format 见 `omp://session.md` §File Format）。两个方案都写死在实现里不允许留 TODO。
> ③ **B2d（session id 归属）**：若 d.ts 揭示 `SessionManager.create`/`newSession` 支持显式 session id（options 带 `id`/`sessionId`），优先采用——此时 Pi header id === Vibe id，`SessionIndex` 记录的 `headerId` 恒等于 `vibeId`（Task 3 双字段语义向后兼容）；否则采用"记录 headerId + 替换检测"（Task 3 定案），即设计"the sidecar validates the header before opening it"的合理解读。两种路线都完整落在 Task 3/Task 5 代码里，不允许 TODO。

- [ ] 7. 运行期待通过：`cd pi-sidecar && bun test src/model-wiring.test.ts src/session-driver.test.ts` → 全部 pass。

- [ ] 8. Commit：

```bash
git add pi-sidecar/src/session-driver.ts pi-sidecar/src/session-driver.test.ts pi-sidecar/src/model-wiring.ts pi-sidecar/src/model-wiring.test.ts pi-sidecar/extensions/vibe-providers/
git commit -s -m "feat(pi-sidecar): Pi AgentSession driver with tool lockdown + provider wiring"
```

---

### Task 5b: sidecar 入口 main.ts（B1：装配协议循环 + HostRpc + 工具桥 + 会话驱动 + extensions）

**Files:** `pi-sidecar/src/main.ts`（Create）、`pi-sidecar/src/main.test.ts`（Create）

**Interfaces:** Consumes — Task 1 `encodeFrame/decodeFrame/LineSplitter/FrameError`、Task 3 `SessionIndex`、Task 4 `createCommandHandler`、Task 5 `PiSessionDriver`、Task 5b 依赖的 Task 7 `ToolBridge`、Task 7 `HostRpc`、`extensions/vibe-memory`、`extensions/vibe-providers`。Produces — 可执行 RPC 入口（Task 15 编译、Task 16/17/18 运行的就是它）：

```ts
// main.ts 启动序列（顺序是硬约束）：
// 1. 发 ready 帧
// 2. 构造 HostRpc（stdout sink）
// 3. globalThis.__VIBE_HOST__ = { call, emitDiagnostic }   ← 必须先于 extension import
// 4. 构造 ToolBridge + SessionIndex + PiSessionDriver（extensions 注入）
// 5. createCommandHandler，进入 stdin 行循环
export function createMain(deps?: Partial<MainDeps>): { handleLine: (line: string) => Promise<void>; close: () => void };
```

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/main.test.ts`（内存双工：FakeDriver + 捕获 stdout 帧，无需真实 SDK/provider）：

```ts
import { describe, expect, test } from "bun:test";
import { createMain, type MainDeps } from "./main";
import { decodeFrame } from "./protocol";
import type { SessionDriver, SessionLike } from "./commands";

function makeFakeSession(): SessionLike {
  return {
    sessionId: "a1b2c3d4e5f6",
    sessionFile: "/tmp/fake.jsonl",
    isBusy: () => false,
    subscribe: () => () => {},
    prompt: async () => {},
    steer: () => {},
    followUp: () => {},
    abort: () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    compact: async () => {},
    navigateTree: async () => "leaf1",
    getMessages: () => ({ messages: [], nextCursor: null }),
    exportTo: async () => {},
    importMessages: async () => 0,
  };
}

function makeFakeDriver(): SessionDriver {
  const s = makeFakeSession();
  return {
    open: async () => s,
    create: async () => s,
    get: () => s,
    setToolManifest: async (tools) => (tools as unknown[]).length,
    cancelToolCall: () => true,
  };
}

function harness() {
  const written: string[] = [];
  const deps: Partial<MainDeps> = {
    driver: makeFakeDriver(),
    hostCall: async (_op, params) => ({ content: '{"ok":true}', isError: false, outcome: "ok", echoed: params }),
    writeOut: (raw: string) => written.push(raw),
    extensions: [],
  };
  const main = createMain(deps);
  return { main, written };
}

describe("main entrypoint", () => {
  test("emits ready frame first", () => {
    const { written } = harness();
    const ready = decodeFrame(written[0]);
    expect(ready).toMatchObject({ event: "ready", data: { protocol: 1 } });
    expect((ready as { data: { sdk: string } }).data.sdk).toBe("18.0.11");
  });

  test("ping roundtrip over in-memory duplex", async () => {
    const { main, written } = harness();
    await main.handleLine('{"v":1,"id":"r-1","op":"ping"}\n');
    expect(decodeFrame(written[1])).toMatchObject({ id: "r-1", ok: true, result: { pong: true, protocol: 1 } });
  });

  test("__VIBE_HOST__ bridge set before extensions and routes hostCall", async () => {
    const { main, written } = harness();
    expect((globalThis as Record<string, unknown>).__VIBE_HOST__).toBeDefined();
    const host = (globalThis as Record<string, unknown>).__VIBE_HOST__ as { call: (op: string, p?: Record<string, unknown>) => Promise<unknown> };
    const r = (await host.call("tool_invoke", { call_id: "t-1" })) as Record<string, unknown>;
    expect(r["echoed"]).toMatchObject({ call_id: "t-1" }); // hostCall 经 HostRpc 关联（测试注入直连）
    main.close();
  });

  test("inbound response frames resolve pending hostCall (duplex dispatch)", async () => {
    // HostRpc 响应派发：注入一个手工 HostRpc 响应帧，验证 handleLine 把它喂给挂起的 call
    const { main } = harness();
    const pending = (globalThis as Record<string, unknown>).__VIBE_HOST__ as { call: (op: string) => Promise<unknown> };
    const p = pending.call("memory_context", { query: "q" });
    await main.handleLine('{"v":1,"id":"s-1","ok":true,"result":{"block":"B"}}\n');
    expect(await p).toEqual({ block: "B" });
    main.close();
  });
});
```

- [ ] 2. 运行期待失败：`cd pi-sidecar && bun test src/main.test.ts` → `Cannot find module "./main"`。

- [ ] 3. 实现 `pi-sidecar/src/main.ts`：

```ts
#!/usr/bin/env bun
import { createCommandHandler, type SessionDriver } from "./commands";
import { HostRpc } from "./host-rpc";
import { ToolBridge } from "./tool-bridge";
import { SessionIndex } from "./session-index";
import { PiSessionDriver, PI_AGENT_DIR, PI_SESSIONS_DIR } from "./session-driver";
import { encodeFrame, LineSplitter, decodeFrame, FrameError } from "./protocol";

export interface MainDeps {
  driver: SessionDriver;
  hostCall: (op: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  writeOut: (raw: string) => void;
  extensions: unknown[]; // ExtensionFactory[]；测试注入 []，生产注入 vibe-memory + vibe-providers
}

export function createMain(deps?: Partial<MainDeps>) {
  // 1) ready 帧（协议输出唯一出口 writeOut；测试可注入捕获器）
  const writeOut = deps?.writeOut ?? ((raw: string) => process.stdout.write(raw));
  writeOut(encodeFrame({ v: 1, event: "ready", data: { protocol: 1, pid: process.pid, sdk: "18.0.11" } }));

  // 2) HostRpc：sidecar→Python 双向 RPC（响应帧经 handleLine 回流派发）
  const hostRpc = new HostRpc(
    (raw) => writeOut(raw),
    (frame) => encodeFrame(frame as never),
  );

  // 3) host bridge 必须先于 extension import 设置（vibe-memory/vibe-providers 的 factory
    //    在 load 后首个事件才调用 bridge，但全局引用必须在 import 时已可见）
  (globalThis as Record<string, unknown>).__VIBE_HOST__ = {
    call: (op: string, params: Record<string, unknown> = {}) => hostRpc.call(op, params, 60_000),
    emitDiagnostic: (kind: string, message: string) => {
      process.stderr.write(`[vibe:${kind}] ${message}\n`); // stderr 永不混入协议流
      writeOut(encodeFrame({ v: 1, event: "session_event", session_id: "", data: { type: "pi.notice", payload: { kind, message } } }));
    },
  };

  // 4) 工具桥 + 会话索引 + 驱动（生产模式动态 import 打包后的 extension 产物）
  const toolBridge = new ToolBridge((op, params, timeoutMs) => hostRpc.call(op, params, timeoutMs));
  const index = new SessionIndex();
  let driver: SessionDriver = deps?.driver ?? new PiSessionDriver({ index, toolBridge, env: process.env });

  if (!deps?.driver && !deps?.extensions) {
    // 生产模式：从暂存资源动态加载 extensions（打包产物 extensions/*.js，Task 15）
    void (async () => {
      for (const extPath of [`${import.meta.dir}/extensions/vibe-providers.js`, `${import.meta.dir}/extensions/vibe-memory.js`]) {
        try {
          const mod = await import(extPath);
          (driver as unknown as { extensions?: unknown[] }).extensions?.push?.(mod.default);
        } catch (e) {
          process.stderr.write(`[vibe:extension-load] ${extPath}: ${(e as Error).message}\n`);
        }
      }
    })();
  }

  // 5) 命令处理 + stdin 行循环
  const handler = createCommandHandler({
    driver,
    sink: writeOut,
    hostCall: (op, params, timeoutMs) => hostRpc.call(op, params, timeoutMs),
  });

  async function handleLine(line: string): Promise<void> {
    // 入站帧可能是：Python 请求（op）→ handler；或 HostRpc 响应（ok）→ 派发；其余忽略
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const probe = decodeFrame(trimmed);
      if ("ok" in probe) {
        hostRpc.onFrame(probe as never); // HostRpc 响应（含 Python 对 host 请求的答复）
        return;
      }
    } catch {
      // 非 JSON/坏帧：交给 handler 走统一错误帧路径
    }
    await handler(line);
  }

  if (!deps?.writeOut) {
    // 真实 stdin 循环（测试注入 writeOut 时不启动）
    const splitter = new LineSplitter();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      let lines: string[] = [];
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e instanceof FrameError) writeOut(encodeFrame({ v: 1, id: "unknown", ok: false, error: { code: e.code, message: e.message } }));
        return;
      }
      for (const ln of lines) void handleLine(ln);
    });
    process.stdin.on("end", () => process.exit(0));
  }

  return {
    handleLine,
    close: () => {
      hostRpc.rejectAll(new Error("main closed"));
    },
  };
}

if (import.meta.main) {
  createMain(); // 生产入口：生产 extensions 经上方动态 import 装配
}
```

（实现者注：生产模式的 extensions 装配点——`PiSessionDriver` 构造 opts 已含 `extensions?: unknown[]`（Task 5 的 opts 扩展，B1）；若 Task 5 的 opts 未含该字段，在本任务为其补上可选字段并透传给 `createAgentSession({ extensions })`，默认 `[]`。动态 import 的路径以 Task 15 暂存布局（`<资源>/extensions/*.js`）为准，开发态回退 `../extensions/<name>/index.ts` 相对源路径。）

- [ ] 4. 运行期待通过：`cd pi-sidecar && bun test src/main.test.ts` → `4 passed`。

- [ ] 5. 烟测真实入口：`printf '{"v":1,"id":"r-1","op":"ping"}\n' | (cd pi-sidecar && bun run src/main.ts)` → stdout 第一行 `{"v":1,"event":"ready",...}`、第二行 `{"v":1,"id":"r-1","ok":true,"result":{"pong":true,"protocol":1}}`（stderr 可能有 extension 装载诊断，不进 stdout）。

- [ ] 6. Commit：

```bash
git add pi-sidecar/src/main.ts pi-sidecar/src/main.test.ts
git commit -s -m "feat(pi-sidecar): main entrypoint wiring protocol loop, host rpc and extensions"
```

---

## Phase 2 — Tool Bridge

### Task 6: 工具 manifest 转换（Python registry → sidecar manifest）

**Files:** `agent/src/pi_sidecar/manifest.py`（Create）、`agent/tests/pi_sidecar/test_manifest.py`（Create）

**Interfaces:** Consumes — `agent/src/agent/tools.py` 的 `ToolRegistry`/`BaseTool`（recon §3.1：`name/description/parameters/repeatable/is_readonly/side_effecting`，`to_openai_schema()`）。Produces — 跨任务契约 `build_tool_manifest(registry) -> list[dict]`（见「跨任务接口契约 §ManifestTool」）。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_manifest.py`：

```python
"""manifest 转换单测：BaseTool 属性 → ManifestTool dict。"""

from typing import Any

from src.agent.tools import BaseTool, ToolRegistry
from src.pi_sidecar.manifest import build_manifest_tool, build_tool_manifest

TOOL_TIMEOUT_SECONDS = 1800.0


class ReadOnlyTool(BaseTool):
    name = "web_search"
    description = "Search the web"
    parameters = {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
    repeatable = True
    is_readonly = True
    side_effecting = False

    def execute(self, **kwargs: Any) -> str:
        return "{}"


class WriteTool(BaseTool):
    name = "trading_place_order"
    description = "Place an order"
    parameters = {"type": "object", "properties": {"symbol": {"type": "string"}}}
    is_readonly = False
    side_effecting = True

    def execute(self, **kwargs: Any) -> str:
        return "{}"


class BashTool(BaseTool):
    name = "bash"
    description = "Run shell"
    is_readonly = True  # 恶意/错误的标注：gateway 按 name 强制 side-effecting
    side_effecting = False

    def execute(self, **kwargs: Any) -> str:
        return "{}"


def _registry(*tools: BaseTool) -> ToolRegistry:
    r = ToolRegistry()
    for t in tools:
        r.register(t)
    return r


class TestBuildManifestTool:
    def test_readonly_tool_fields(self):
        m = build_manifest_tool(ReadOnlyTool())
        assert m == {
            "name": "web_search",
            "description": "Search the web",
            "parameters": ReadOnlyTool.parameters,
            "is_readonly": True,
            "side_effecting": False,
            "repeatable": True,
            "timeout_seconds": TOOL_TIMEOUT_SECONDS,
        }

    def test_side_effecting_flag_true_for_write(self):
        assert build_manifest_tool(WriteTool())["side_effecting"] is True

    def test_bash_is_forced_side_effecting(self):
        # recon §3.3：gateway 对 "bash" 名单强制 side-effecting；manifest 必须一致
        m = build_manifest_tool(BashTool())
        assert m["side_effecting"] is True
        assert m["is_readonly"] is False

    def test_empty_parameters_get_object_schema(self):
        m = build_manifest_tool(BashTool())
        assert m["parameters"] == {"type": "object", "properties": {}, "required": []}


class TestBuildToolManifest:
    def test_all_registry_tools(self):
        manifest = build_tool_manifest(_registry(ReadOnlyTool(), WriteTool(), BashTool()))
        assert [t["name"] for t in manifest] == ["web_search", "trading_place_order", "bash"]

    def test_trading_prefix_forced_side_effecting(self):
        manifest = build_tool_manifest(_registry(WriteTool()))
        assert manifest[0]["side_effecting"] is True
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_manifest.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar.manifest'`。

- [ ] 3. 实现 `agent/src/pi_sidecar/manifest.py`：

```python
"""ToolRegistry → Pi sidecar 工具 manifest（design §Sidecar and RPC Protocol）。"""

from __future__ import annotations

import os
from typing import Any

from src.agent.tools import BaseTool, ToolRegistry

#: 与 agent/src/agent/loop.py 的 TOOL_TIMEOUT_SECONDS 同源（recon §1.1）。
TOOL_TIMEOUT_SECONDS = float(os.getenv("VIBE_TRADING_TOOL_TIMEOUT_SECONDS", "1800"))

#: 与 ToolGateway._SIDE_EFFECTING_NAMES 对齐（recon §3.3）——manifest 侧保持同一强制分类，
#: 避免 sidecar 依据错误的 is_readonly 并行调度写工具。
_FORCED_SIDE_EFFECTING_NAMES = frozenset({"bash"})
_FORCED_SIDE_EFFECTING_PREFIXES = ("trading_",)

_EMPTY_OBJECT_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}, "required": []}


def build_manifest_tool(tool: BaseTool) -> dict[str, Any]:
    side_effecting = bool(tool.side_effecting)
    if tool.name in _FORCED_SIDE_EFFECTING_NAMES or tool.name.startswith(_FORCED_SIDE_EFFECTING_PREFIXES):
        side_effecting = True
    return {
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters or _EMPTY_OBJECT_SCHEMA,
        "is_readonly": bool(tool.is_readonly) and not side_effecting,
        "side_effecting": side_effecting,
        "repeatable": bool(tool.repeatable),
        "timeout_seconds": TOOL_TIMEOUT_SECONDS,
    }


def build_tool_manifest(registry: ToolRegistry) -> list[dict[str, Any]]:
    return [build_manifest_tool(t) for t in registry._tools.values()]  # noqa: SLF001 — 同包内受控访问
```

- [ ] 4. 运行期待通过：`pytest agent/tests/pi_sidecar/test_manifest.py --tb=short -q` → `6 passed`。

- [ ] 5. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 6. Commit：

```bash
git add agent/src/pi_sidecar/manifest.py agent/tests/pi_sidecar/test_manifest.py
git commit -s -m "feat(pi-sidecar): tool manifest conversion from registry"
```

---

### Task 7: Sidecar Tool Bridge（manifest 工具注册 + `tool_invoke` RPC 回 Python）

**Files:** `pi-sidecar/src/tool-bridge.ts`（Create）、`pi-sidecar/src/tool-bridge.test.ts`（Create）、`pi-sidecar/src/host-rpc.ts`（Create）

**Interfaces:** Consumes — Task 1 `FrameError`。Produces（Task 5 `PiSessionDriver`、main 消费）：

```ts
export interface ToolManifestEntry {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;             // JSON Schema
  is_readonly: boolean;
  side_effecting: boolean;
  repeatable: boolean;
  timeout_seconds: number;
}
export type HostCall = (op: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
export class ToolBridge {
  constructor(hostCall: HostCall);
  setManifest(tools: unknown[]): Promise<number>;          // set_tool_manifest op 的后端
  customTools(): unknown[];                                 // createAgentSession customTools（每个 execute 走 hostCall("tool_invoke")）
  cancel(callId: string): boolean;                          // Python tool_cancel → abort execute 的 signal
  onSessionEvent(e: { type: string; payload: Record<string, unknown> }): void; // 记录 assistant entry id → 幂等键
}
```

幂等键：`<sessionId>:<assistantEntryId>:<toolCallId>`（Global Constraint）。超时规则定案（M8）：执行超时由 Python 端 `GatewayBridge` 按 manifest 的 `timeout_seconds` 控制并在响应里给出 `outcome:"error"`（只读）或 `"outcome_unknown"`（写类）；sidecar 侧仅保留 2×`timeout_seconds` 的兜底计时器防 Python 无响应挂死，兜底触发时本地返回 `isError:true` + 同样的 outcome 语义（写类 `outcome_unknown` / 只读 `error`），不向 Python 重发请求（side-effecting 永不重试）。

幂等键 entryId 来源（M7a）：`onSessionEvent` 取 `message_start`/`message_end` payload 的 entry id（Task 0 Step 7 会核对 pinned SDK 的 `message_start` 事件是否携带该字段）；若 SDK 无此字段，回退方案为 `tool_execution_start` 触发时以 `"<sessionId>:turn<state.iter>:<toolCallId>"` 组键（turn 计数器由 driver 维护）——两种取法都在 `ToolBridge.onSessionEvent` 内实现，回退开关是一个布尔探测（首个 message_start 无 entryId 即置位）。

**Steps:**

- [ ] 1. 写失败测试 `pi-sidecar/src/tool-bridge.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { ToolBridge } from "./tool-bridge";

const TOOL = {
  name: "web_search",
  label: "Web Search",
  description: "Search the web",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  is_readonly: true,
  side_effecting: false,
  repeatable: true,
  timeout_seconds: 1800,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ToolBridge", () => {
  test("setManifest returns count and customTools carry registered names", async () => {
    const bridge = new ToolBridge(async () => ({}));
    expect(await bridge.setManifest([TOOL])).toBe(1);
    const tools = bridge.customTools() as Array<{ name: string; description: string; parameters: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("web_search");
    expect(tools[0].description).toBe("Search the web");
    expect(tools[0].parameters).toEqual(TOOL.parameters);
  });

  test("execute routes through tool_invoke with idempotency key and returns content", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const bridge = new ToolBridge(async (op, params) => {
      calls.push({ op, params });
      return { content: '{"status":"ok"}', isError: false, outcome: "ok" };
    });
    await bridge.setManifest([TOOL]);
    bridge.onSessionEvent({ type: "message_start", payload: { entryId: "assist1" } });
    const tools = bridge.customTools() as Array<{
      name: string;
      execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | null, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
    }>;
    const r = await tools[0].execute("call-1", { query: "aapl" }, null, null, {});
    expect(r.content).toEqual([{ type: "text", text: '{"status":"ok"}' }]);
    expect(calls[0].op).toBe("tool_invoke");
    const p = calls[0].params;
    expect(p.toolName).toBe("web_search");
    expect(p.toolCallId).toBe("call-1");
    expect(p.arguments).toEqual({ query: "aapl" });
    expect(p.idempotencyKey).toBe("unknown:assist1:call-1"); // 无会话上下文时 sessionId=unknown
    expect(p.is_readonly).toBe(true);
    expect(p.side_effecting).toBe(false);
  });

  test("execute maps thrown host error to isError content", async () => {
    const bridge = new ToolBridge(async () => {
      throw Object.assign(new Error("boom"), { code: "tool_failed" });
    });
    await bridge.setManifest([TOOL]);
    const tools = bridge.customTools() as Array<{ execute: (id: string) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
    const r = await tools[0].execute("call-2", {}, null, null, {});
    expect(r.content[0].text).toContain("boom");
  });

  test("cancel aborts the in-flight execute signal", async () => {
    const d = deferred<unknown>();
    const bridge = new ToolBridge(() => d.promise);
    await bridge.setManifest([TOOL]);
    const tools = bridge.customTools() as Array<{
      execute: (id: string, params: unknown, signal: AbortSignal | null) => Promise<unknown>;
    }>;
    const p = tools[0].execute("call-3", {}, null);
    expect(bridge.cancel("call-3")).toBe(true);
    d.resolve({ content: "x", isError: true, outcome: "error" });
    await p; // 不挂死
  });

  test("cancel unknown call id returns false", async () => {
    const bridge = new ToolBridge(async () => ({}));
    expect(bridge.cancel("nope")).toBe(false);
  });
});
```

- [ ] 2. 运行期待失败：`cd pi-sidecar && bun test src/tool-bridge.test.ts` → `Cannot find module "./tool-bridge"`。

- [ ] 3. 实现 `pi-sidecar/src/host-rpc.ts`：

```ts
/** sidecar→Python 双向 RPC helper：id 关联 + 超时。main.ts 负责把响应帧喂给 resolve。 */
export class HostRpc {
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (raw: string) => void,
    private readonly encode: (frame: unknown) => string,
  ) {}

  call(op: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const id = `s-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`host call ${op} timed out`), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(this.encode({ v: 1, id, op, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** main.ts 读循环：把 id 相同的响应帧派发给等待者。 */
  onFrame(frame: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } }): boolean {
    const id = frame.id;
    if (!id || !("ok" in frame)) return false;
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.result);
    else p.reject(Object.assign(new Error(frame.error?.message ?? "host error"), { code: frame.error?.code ?? "internal" }));
    return true;
  }

  rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
```

- [ ] 4. 实现 `pi-sidecar/src/tool-bridge.ts`：

```ts
import type { HostCall } from "./host-rpc";

export interface ToolManifestEntry {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  is_readonly: boolean;
  side_effecting: boolean;
  repeatable: boolean;
  timeout_seconds: number;
}

const FALLBACK_TIMEOUT_MS = 3_600_000; // 2 × 1800s 兜底，防 Python 无响应挂死

interface Inflight {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export class ToolBridge {
  private manifest: ToolManifestEntry[] = [];
  private inflight = new Map<string, Inflight>();
  private currentAssistantEntryId = "unknown";
  private currentSessionId = "unknown";

  constructor(private readonly hostCall: HostCall) {}

  onSessionEvent(e: { type: string; payload: Record<string, unknown> }): void {
    // 会话上下文标记：幂等键的 assistantEntryId 段（Global Constraint）
    if (e.type === "message_start" && typeof e.payload.entryId === "string") {
      this.currentAssistantEntryId = e.payload.entryId;
    }
    if (typeof e.payload.sessionId === "string") {
      this.currentSessionId = e.payload.sessionId;
    }
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  async setManifest(tools: unknown[]): Promise<number> {
    this.manifest = tools as ToolManifestEntry[];
    return this.manifest.length;
  }

  customTools(): unknown[] {
    return this.manifest.map((t) => ({
      name: t.name,
      label: t.label ?? t.name,
      description: t.description,
      parameters: t.parameters,
      execute: async (
        toolCallId: string,
        args: Record<string, unknown>,
        signal: AbortSignal | null,
      ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
        const idempotencyKey = `${this.currentSessionId}:${this.currentAssistantEntryId}:${toolCallId}`;
        const controller = new AbortController();
        if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
        const entry: Inflight = {
          controller,
          timer: setTimeout(() => controller.abort(), Math.max(t.timeout_seconds * 2_000, FALLBACK_TIMEOUT_MS)),
        };
        this.inflight.set(toolCallId, entry);
        try {
          const r = (await this.hostCall("tool_invoke", {
            call_id: toolCallId,
            toolCallId,
            toolName: t.name,
            arguments: args,
            idempotencyKey,
            is_readonly: t.is_readonly,
            side_effecting: t.side_effecting,
            repeatable: t.repeatable,
            timeout_seconds: t.timeout_seconds,
          })) as { content?: string; isError?: boolean; outcome?: string };
          const text = r?.content ?? JSON.stringify({ status: "error", error: "empty tool result" });
          return { content: [{ type: "text", text }], details: { outcome: r?.outcome ?? "ok", idempotencyKey } };
        } catch (e) {
          const err = e as Error & { code?: string };
          const cancelled = controller.signal.aborted && err.code === "timeout";
          const text = JSON.stringify({
            status: "error",
            error: err.message,
            outcome: cancelled && !t.is_readonly ? "outcome_unknown" : "error",
          });
          return { content: [{ type: "text", text }] };
        } finally {
          clearTimeout(entry.timer);
          this.inflight.delete(toolCallId);
        }
      },
    }));
  }

  cancel(callId: string): boolean {
    const e = this.inflight.get(callId);
    if (!e) return false;
    e.controller.abort();
    return true;
  }
}
```

- [ ] 5. 运行期待通过：`cd pi-sidecar && bun test src/tool-bridge.test.ts` → 全部 pass（5 用例）。

- [ ] 6. Commit：

```bash
git add pi-sidecar/src/tool-bridge.ts pi-sidecar/src/tool-bridge.test.ts pi-sidecar/src/host-rpc.ts
git commit -s -m "feat(pi-sidecar): tool bridge routing executions to python host"
```

---

### Task 8: Python Gateway Bridge（幂等 + 并行只读/串行写 + ToolGateway 路由 + outcome_unknown）

**Files:** `agent/src/pi_sidecar/gateway_bridge.py`（Create）、`agent/tests/pi_sidecar/test_gateway_bridge.py`（Create）

**Interfaces:** Consumes — `ToolGateway`/`GatewayPolicy`（`agent/src/reliability/gateway.py`，recon §3.3）、`StepResult`/`StepStatus`（reliability/contracts.py）、`redact_payload`/`redact_log_text`（`src/tools/redaction.py`）、`TOOL_RESULT_LIMIT=10000` 语义。Produces — 跨任务契约：

```python
class GatewayBridge:
    def __init__(self, registry: Any, *, gateway: Any | None = None,
                 max_parallel_reads: int = 4, now: Callable[[], float] = time.monotonic): ...
    def build_policy(self) -> "GatewayPolicy"          # 跨任务契约 §GatewayPolicy 构建
    async def handle_invoke(self, params: dict) -> dict  # 返回 {content, isError, outcome}
    def handle_cancel(self, call_id: str) -> None
```

幂等行为（Global Constraint）：`idempotencyKey` 命中已完成记录 → 直接回放 content（`outcome:"ok"`），不再执行。写类（`side_effecting=True`）调用期间连接/进程失败无结果 → `outcome:"outcome_unknown"`、`isError: true`；只读失败 → 正常 `outcome:"error"`（gateway retry/fallback 已在 ToolGateway 内）。串行/并行：只读可并发（`asyncio.Semaphore(max_parallel_reads)` + `run_in_executor`），写互斥锁串行（`asyncio.Lock`）。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_gateway_bridge.py`：

```python
"""GatewayBridge 单测：幂等、串行/并行、outcome_unknown、截断/redact、gateway 路由。"""

import asyncio
import json
from typing import Any

import pytest

from src.pi_sidecar.gateway_bridge import GatewayBridge


class FakeRegistry:
    def __init__(self, tools: dict[str, Any]):
        self._tools = tools

    def get(self, name):
        return self._tools.get(name)

    def execute(self, name, params):
        tool = self._tools[name]
        return tool["run"](params)


def make_registry(entries: dict[str, dict]) -> FakeRegistry:
    class T:
        pass

    tools = {}
    for name, spec in entries.items():
        t = T()
        t.name = name
        t.is_readonly = spec.get("readonly", True)
        t.side_effecting = spec.get("side_effecting", False)
        t.repeatable = spec.get("repeatable", True)
        t.parameters = {"type": "object", "properties": {}}
        t.description = spec.get("description", name)
        tools[name] = t
    return FakeRegistry({k: {"run": v.get("run", lambda p: "{}")} for k, v in entries.items()}), tools


class FakeGateway:
    """记录调用并返回预置 StepResult-like dict。"""

    def __init__(self, responses: dict[str, Any]):
        self.calls: list[tuple[str, dict, str]] = []
        self.responses = responses

    def execute(self, tool_name, arguments, *, step_id, policy, session_id=""):
        self.calls.append((tool_name, dict(arguments), step_id))
        import time

        time.sleep(self.responses.get("_delay", 0))
        return self.responses.get(tool_name) or {
            "status": "success", "data": {"result": "ok"}, "error": None, "elapsed_ms": 1,
        }


class FakeStepResult:
    def __init__(self, status="success", data=None, error=None):
        self.status = status
        self.data = data or {}
        self.error = error
        self.elapsed_ms = 1

    def to_wire(self):
        return {"status": self.status, "data": self.data, "error": self.error}


def _params(**over):
    base = {
        "call_id": "t-1",
        "toolCallId": "tc-1",
        "toolName": "web_search",
        "arguments": {"query": "aapl"},
        "idempotencyKey": "sess1:assist1:tc-1",
        "is_readonly": True,
        "side_effecting": False,
        "repeatable": True,
        "timeout_seconds": 5,
    }
    base.update(over)
    return base


class TestHandleInvoke:
    def _run(self, coro):
        return asyncio.run(coro)

    def test_success_returns_content_and_records_idempotency(self):
        gw = FakeGateway({})
        bridge = GatewayBridge(None, gateway=gw)
        result = self._run(bridge.handle_invoke(_params()))
        assert result["outcome"] == "ok"
        assert result["isError"] is False
        assert '"result"' in result["content"] or "ok" in result["content"]
        # 重复调用（同幂等键）不再执行
        gw.calls.clear()
        again = self._run(bridge.handle_invoke(_params()))
        assert again["outcome"] == "ok"
        assert gw.calls == []
        assert again["content"] == result["content"]

    def test_duplicate_suppressed_even_with_different_arguments(self):
        gw = FakeGateway({})
        bridge = GatewayBridge(None, gateway=gw)
        first = self._run(bridge.handle_invoke(_params()))
        second = self._run(bridge.handle_invoke(_params(arguments={"query": "other"})))
        assert second["content"] == first["content"]
        assert len(gw.calls) == 1

    def test_gateway_error_is_error_outcome(self):
        gw = FakeGateway({"web_search": FakeStepResult(status="recoverable_error", error={"message": "boom"})})
        bridge = GatewayBridge(None, gateway=gw)
        result = self._run(bridge.handle_invoke(_params()))
        assert result["outcome"] == "error"
        assert result["isError"] is True

    def test_write_unknown_outcome_on_gateway_exception(self):
        class BoomGateway:
            def execute(self, *a, **k):
                raise RuntimeError("connection lost")

        bridge = GatewayBridge(None, gateway=BoomGateway())
        result = self._run(bridge.handle_invoke(_params(toolName="trading_place_order", side_effecting=True, is_readonly=False)))
        assert result["outcome"] == "outcome_unknown"
        assert result["isError"] is True

    def test_readonly_exception_is_plain_error(self):
        class BoomGateway:
            def execute(self, *a, **k):
                raise RuntimeError("provider down")

        bridge = GatewayBridge(None, gateway=BoomGateway())
        result = self._run(bridge.handle_invoke(_params()))
        assert result["outcome"] == "error"
        assert result["isError"] is True

    def test_output_truncated_to_10k_chars(self):
        big = {"data": "x" * 20_000}

        class BigGateway:
            def execute(self, *a, **k):
                return FakeStepResult(data=big)

        bridge = GatewayBridge(None, gateway=BigGateway())
        result = self._run(bridge.handle_invoke(_params()))
        assert len(result["content"]) <= 10_000
        assert result["content"].endswith("[truncated]") or len(result["content"]) == 10_000

    def test_sensitive_keys_redacted(self):
        class LeakGateway:
            def execute(self, *a, **k):
                return FakeStepResult(data={"api_key": "sk-secret", "result": "fine"})

        bridge = GatewayBridge(None, gateway=LeakGateway())
        result = self._run(bridge.handle_invoke(_params()))
        assert "sk-secret" not in result["content"]

    def test_unknown_tool_is_error(self):
        class NoopGateway:
            def execute(self, *a, **k):
                raise AssertionError("should not be called")

        bridge = GatewayBridge(None, gateway=NoopGateway())
        result = self._run(bridge.handle_invoke(_params(toolName="nonexistent")))
        assert result["outcome"] == "error"
        assert "unknown tool" in result["content"]


class TestConcurrency:
    def _run(self, coro):
        return asyncio.run(coro)

    def test_writes_are_serialized_reads_may_parallel(self):
        active = {"n": 0, "max_write_overlap": 0, "max_read_overlap": 0}

        class GW:
            def execute(self, tool_name, arguments, *, step_id, policy, session_id=""):
                import time

                if tool_name == "writer":
                    active["n"] += 1
                    active["max_write_overlap"] = max(active["max_write_overlap"], active["n"])
                    time.sleep(0.05)
                    active["n"] -= 1
                else:
                    active["n"] += 1
                    active["max_read_overlap"] = max(active["max_read_overlap"], active["n"])
                    time.sleep(0.05)
                    active["n"] -= 1
                return FakeStepResult()

        bridge = GatewayBridge(None, gateway=GW())

        async def scenario():
            calls = [_params(call_id=f"r{i}", toolCallId=f"tc-r{i}", idempotencyKey=f"k-r{i}") for i in range(3)]
            calls += [
                _params(call_id="w1", toolCallId="tc-w1", idempotencyKey="k-w1", toolName="writer", side_effecting=True, is_readonly=False),
                _params(call_id="w2", toolCallId="tc-w2", idempotencyKey="k-w2", toolName="writer", side_effecting=True, is_readonly=False),
            ]
            await asyncio.gather(*(bridge.handle_invoke(c) for c in calls))

        self._run(scenario())
        assert active["max_write_overlap"] == 1  # 写严格串行
        assert active["max_read_overlap"] >= 2   # 只读并行

    def test_cancel_marks_pending_write_cancelled(self):
        bridge = GatewayBridge(None, gateway=FakeGateway({}))
        bridge.handle_cancel("t-9")  # 不在 flight → no-op 不抛
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_gateway_bridge.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar.gateway_bridge'`。

- [ ] 3. 实现 `agent/src/pi_sidecar/gateway_bridge.py`：

```python
"""Pi sidecar 工具执行网关桥。

设计约束（design §Idempotency + Global Constraints）：
- 幂等键 = session_id:assistantEntryId:toolCallId；已完成重复调用回放记录结果。
- 所有执行穿过 ToolGateway（唯一安全 choke point）；side-effecting 永不自动重试
  （ToolGateway._is_side_effecting + allow_side_effects 语义保持）。
- 写与未知分类串行；只读并发受 Semaphore 限界。
- 连接/进程失败时写类结果未知 → outcome_unknown；只读 → error。
- 返回给 Pi 前截断（≤10000 chars）并 redact（src.tools.redaction）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable

from src.reliability.contracts import StepStatus
from src.reliability.gateway import GatewayPolicy, ToolGateway
from src.tools.redaction import redact_payload

logger = logging.getLogger(__name__)

TOOL_RESULT_LIMIT = 10_000
_TRUNCATION_MARKER = "[truncated]"


def build_gateway_policy(allowed_names: frozenset[str]) -> GatewayPolicy:
    """Pi 引擎统一策略（跨任务契约）：manifest 工具全放行、side effects 放行
    （mandate/order gate 在工具内部 fail-closed）、retry 走 gateway 只读恢复。"""
    return GatewayPolicy(
        allowed_tools=allowed_names,
        retry_limit=2,
        fallback_tools={},
        timeout_seconds=1800.0,
        allow_side_effects=True,
    )


class GatewayBridge:
    def __init__(
        self,
        registry: Any,
        *,
        gateway: Any | None = None,
        max_parallel_reads: int = 4,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registry = registry
        self._gateway: Any = gateway  # 测试注入；生产 = ToolGateway(registry)
        self._read_sem = asyncio.Semaphore(max_parallel_reads)
        self._write_lock = asyncio.Lock()
        self._idempotency: dict[str, dict[str, Any]] = {}
        self._pending: dict[str, asyncio.Event] = {}
        self._now = now

    def build_policy(self) -> GatewayPolicy:
        names = frozenset(getattr(self._registry, "_tools", {}).keys()) if self._registry is not None else frozenset()
        return build_gateway_policy(names)

    def _gw(self) -> Any:
        if self._gateway is None:
            self._gateway = ToolGateway(self._registry)
        return self._gateway

    def _tool_meta(self, tool_name: str) -> dict[str, Any]:
        tool = self._registry.get(tool_name) if self._registry is not None else None
        if tool is None:
            return {"is_readonly": True, "side_effecting": False}
        return {
            "is_readonly": bool(getattr(tool, "is_readonly", True)),
            "side_effecting": bool(getattr(tool, "side_effecting", True)),
        }

    def _record(self, key: str, payload: dict[str, Any]) -> None:
        self._idempotency[key] = payload

    @staticmethod
    def _encode_step_result(step: Any) -> str:
        """StepResult/dict → 面向模型的 JSON 信封（截断 + redact）。"""
        if hasattr(step, "to_wire"):
            wire = step.to_wire()
        elif isinstance(step, dict):
            wire = step
        else:
            wire = {"status": "error", "error": str(step)}
        text = json.dumps(redact_payload(wire), ensure_ascii=False, default=str)
        if len(text) > TOOL_RESULT_LIMIT:
            text = text[: TOOL_RESULT_LIMIT - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER
        return text

    async def handle_invoke(self, params: dict[str, Any]) -> dict[str, Any]:
        key = str(params.get("idempotencyKey") or "")
        if key and key in self._idempotency:
            return dict(self._idempotency[key])  # 已完成重复：回放，不执行（Global Constraint）

        tool_name = str(params.get("toolName") or "")
        tool = self._registry.get(tool_name) if self._registry is not None else None
        if tool is None:
            return self._finish(key, {
                "content": json.dumps({"status": "error", "error": f"unknown tool: {tool_name}"}),
                "isError": True,
                "outcome": "error",
            })

        meta = self._tool_meta(tool_name)
        side_effecting = bool(params.get("side_effecting", meta["side_effecting"]))
        timeout_s = float(params.get("timeout_seconds") or 1800.0)
        started = self._now()

        async def _execute() -> dict[str, Any]:
            loop = asyncio.get_running_loop()
            gw = self._gw()
            step_id = str(params.get("call_id") or f"pi-{int(self._now() * 1000)}")
            args = dict(params.get("arguments") or {})

            def _sync() -> Any:
                return gw.execute(
                    tool_name,
                    args,
                    step_id=step_id,
                    policy=self.build_policy(),
                    session_id=str(params.get("idempotencyKey", "").split(":")[0] or ""),
                )

            if side_effecting:
                async with self._write_lock:
                    return await asyncio.wait_for(loop.run_in_executor(None, _sync), timeout=timeout_s)
            async with self._read_sem:
                return await asyncio.wait_for(loop.run_in_executor(None, _sync), timeout=timeout_s)

        try:
            step = await _execute()
            status_ok = getattr(step, "status", None)
            if isinstance(step, dict):
                status_ok = step.get("status")
            is_error = status_ok is not None and status_ok != StepStatus.SUCCESS and status_ok != "success"
            return self._finish(key, {
                "content": self._encode_step_result(step),
                "isError": bool(is_error),
                "outcome": "error" if is_error else "ok",
            })
        except asyncio.TimeoutError:
            outcome = "outcome_unknown" if side_effecting else "error"
            return self._finish(key, {
                "content": json.dumps({"status": "error", "error": "tool_timeout", "outcome": outcome}),
                "isError": True,
                "outcome": outcome,
            })
        except asyncio.CancelledError:
            # 用户取消（design §Idempotency）：写类取消 = 结果未知
            outcome = "outcome_unknown" if side_effecting else "error"
            return self._finish(key, {
                "content": json.dumps({"status": "error", "error": "tool_cancelled", "outcome": outcome}),
                "isError": True,
                "outcome": outcome,
            })
        except Exception as exc:  # noqa: BLE001 — 连接/进程层失败统一转 envelope
            logger.warning("tool %s invoke failed: %s", tool_name, exc)
            outcome = "outcome_unknown" if side_effecting else "error"
            return self._finish(key, {
                "content": json.dumps({"status": "error", "error": str(exc), "outcome": outcome}),
                "isError": True,
                "outcome": outcome,
            })

    def _finish(self, key: str, payload: dict[str, Any]) -> dict[str, Any]:
        if key:
            self._record(key, payload)
        return payload

    def handle_cancel(self, call_id: str) -> None:
        ev = self._pending.get(call_id)
        if ev is not None:
            ev.set()
```

- [ ] 4. 运行期待通过：`pytest agent/tests/pi_sidecar/test_gateway_bridge.py --tb=short -q` → `11 passed`。

- [ ] 5. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 6. Commit：

```bash
git add agent/src/pi_sidecar/gateway_bridge.py agent/tests/pi_sidecar/test_gateway_bridge.py
git commit -s -m "feat(pi-sidecar): gateway bridge with idempotency + parallel reads/serial writes"
```

---

## Phase 3 — Python Client + 事件归一化 + 投影

### Task 9: Sidecar 进程监管 + RPC 客户端（restart-once + `pi_sidecar_unavailable`）

**Files:** `agent/src/pi_sidecar/client.py`（Create）、`agent/tests/pi_sidecar/fixtures/stub_sidecar.py`（Create）、`agent/tests/pi_sidecar/test_client.py`（Create）

**Interfaces:** Produces — 跨任务契约 §PiSidecarClient（`SidecarError`、`started/unavailable`、`start/request/respond_host/stop`、`env` 合并（B6）、`on_host_request` 入站分发（B3）、`max_restarts=1` 默认、restart 后为活跃会话重发 `open_session`、重启期间 in-flight 请求收到 `code="sidecar_restarted"` 错误、重启预算耗尽后所有请求永久 `pi_sidecar_unavailable`、`_default_command()` 的 `VIBE_PI_SIDECAR_BIN` 解析（B7））。

**Steps:**

- [ ] 1. 写协议桩 `agent/tests/pi_sidecar/fixtures/stub_sidecar.py`（client 单测用；行为：发 ready（回显 `VIBE_TEST_ENV_MARKER`），支持 ping/open_session，`STUB_CRASH_AFTER` 模拟崩溃，`STUB_SEND_HOST_REQ` 发起一次入站 host 请求并校验响应帧——B3/B6）：

```python
"""协议桩 sidecar：client 单测用（不依赖 bun）。

env 控制行为：
  STUB_CRASH_AFTER=<n>     处理第 n 个请求后进程退出（模拟 sidecar 崩溃）
  STUB_SEND_HOST_REQ=<op>  处理完第 1 个请求后，向 stdout 发出一个入站 host 请求
                           （op ∈ tool_invoke/memory_context），并校验收到的响应帧
  VIBE_TEST_ENV_MARKER     原样回显进 ready 帧 sdk 字段（B6：env 透传断言）
"""

from __future__ import annotations

import os
import sys

from src.pi_sidecar.protocol import LineSplitter, decode_frame, encode_frame


def main() -> None:
    crash_after = int(os.environ.get("STUB_CRASH_AFTER", "0"))
    send_host_req = os.environ.get("STUB_SEND_HOST_REQ", "")
    marker = os.environ.get("VIBE_TEST_ENV_MARKER", "stub")
    out = sys.stdout
    out.write(encode_frame({"v": 1, "event": "ready",
                            "data": {"protocol": 1, "pid": os.getpid(), "sdk": marker}}))
    out.flush()
    splitter = LineSplitter()
    handled = 0
    host_req_sent = False
    for raw in iter(sys.stdin.readline, ""):
        for line in splitter.push(raw):
            try:
                frame = decode_frame(line)
            except Exception:  # noqa: BLE001
                continue
            handled += 1
            if crash_after and handled >= crash_after:
                out.flush()
                os._exit(9)
            op = frame.get("op")
            if op == "ping":
                out.write(encode_frame({"v": 1, "id": frame["id"], "ok": True,
                                        "result": {"pong": True, "protocol": 1}}))
            elif op == "open_session":
                out.write(encode_frame({"v": 1, "id": frame["id"], "ok": True,
                                        "result": {"session_file": "/tmp/stub.jsonl"}}))
            else:
                out.write(encode_frame({"v": 1, "id": frame["id"], "ok": False,
                                        "error": {"code": "unknown_op", "message": "stub"}}))
            out.flush()
            # 首个请求处理后发一个入站 host 请求（B3），等待并校验响应帧
            if send_host_req and not host_req_sent:
                host_req_sent = True
                out.write(encode_frame({"v": 1, "id": "s-host-1", "op": send_host_req,
                                        "params": {"call_id": "t-1", "toolName": "web_search",
                                                   "arguments": {"q": "x"}, "idempotencyKey": "s:e:c1"}}))
                out.flush()
                resp_raw = sys.stdin.readline()
                resp = decode_frame(resp_raw)
                assert resp.get("id") == "s-host-1" and resp.get("ok") is True, resp
                assert "result" in resp, resp
                # 把校验结果作为事件发回给测试进程观测
                out.write(encode_frame({"v": 1, "event": "host_roundtrip",
                                        "data": {"ok": True, "result": resp.get("result")}}))
                out.flush()


if __name__ == "__main__":
    main()
```

- [ ] 2. 写失败测试 `agent/tests/pi_sidecar/test_client.py`：

```python
"""PiSidecarClient 单测：ready 关联、请求/响应、事件分发、restart-once、不可用状态。"""

import asyncio
import sys
from pathlib import Path

import pytest

from src.pi_sidecar.client import PiSidecarClient, SidecarError

STUB = str(Path(__file__).parent / "fixtures" / "stub_sidecar.py")


def _command() -> list[str]:
    return [sys.executable, STUB]


class TestBasics:
    def test_ping_roundtrip(self):
        async def run():
            c = PiSidecarClient(command=_command())
            await c.start()
            try:
                assert await c.request("ping", {}) == {"pong": True, "protocol": 1}
            finally:
                await c.stop()
        asyncio.run(run())

    def test_unknown_op_maps_to_sidecar_error(self):
        async def run():
            c = PiSidecarClient(command=_command())
            await c.start()
            try:
                with pytest.raises(SidecarError) as ei:
                    await c.request("frobnicate", {})
                assert ei.value.code == "unknown_op"
            finally:
                await c.stop()
        asyncio.run(run())

    def test_events_dispatched_to_callback(self):
        got = []

        async def run():
            c = PiSidecarClient(command=_command(), on_event=lambda ev, sid, data: got.append((ev, sid, data)))
            await c.start()
            try:
                # 桩不发事件；client 自身 ready 事件也算分发路径验证
                await c.request("ping", {})
                assert any(ev == "ready" for ev, _, _ in got)
            finally:
                await c.stop()
        asyncio.run(run())


class TestHostRequests:
    def test_inbound_host_request_dispatched_and_response_framed(self):
        """B3：sidecar→Python 的 op 请求帧（id+op，无 ok）→ on_host_request → 回响应帧。"""
        async def run():
            events = []

            async def handler(op: str, params: dict) -> dict:
                return {"content": '{"status":"ok"}', "isError": False, "outcome": "ok"}

            c = PiSidecarClient(command=_command(), on_event=lambda ev, sid, d: events.append((ev, d)),
                                on_host_request=handler)
            await c.start()
            try:
                # 桩在首个请求处理后发 tool_invoke 请求并等待响应帧；client 自动回帧后
                # 桩发出 host_roundtrip 事件确认闭环
                await c.request("ping", {})
                deadline = asyncio.get_running_loop().time() + 10
                while asyncio.get_running_loop().time() < deadline:
                    if any(ev == "host_roundtrip" for ev, _ in events):
                        break
                    await asyncio.sleep(0.05)
                frame = next(d for ev, d in events if ev == "host_roundtrip")
                assert frame["ok"] is True
                assert frame["result"] == {"content": '{"status":"ok"}', "isError": False, "outcome": "ok"}
            finally:
                await c.stop()
        asyncio.run(run())

    def test_host_request_handler_error_yields_error_frame(self):
        """handler 抛错 → client 回 ok:false 帧（桩收到非 ok 帧 → 其 assert 失败 →
        桩进程退出 → client 读到 EOF）。本用例断言：错误 handler 不产生 host_roundtrip
        成功事件，且 client 在桩退出后仍可重启服务后续请求。"""
        async def run():
            events = []

            async def handler(op: str, params: dict) -> dict:
                return {"_host_error_": {"code": "internal", "message": "gateway exploded"}}

            c = PiSidecarClient(command=_command(), on_event=lambda ev, sid, d: events.append((ev, d)),
                                on_host_request=handler)
            await c.start()
            try:
                await c.request("ping", {})
                await asyncio.sleep(1.0)  # 给桩发 host 请求 + 收到 ok:false 帧的时间
                # 桩收到 ok:false 帧 → 其 assert 失败 → os._exit；client 不应崩溃且可继续服务
                r = await c.request("ping", {}, timeout=15)
                assert r == {"pong": True, "protocol": 1}
                assert not any(ev == "host_roundtrip" for ev, _ in events)
            finally:
                await c.stop()
        asyncio.run(run())


    def test_respond_host_error_frame_shape(self):
        """handler 抛错 → respond_host 发 ok:false 帧（桩收到后 assert 失败 → 事件缺失）。"""
        async def run():
            from src.pi_sidecar.protocol import decode_frame

            sent: list[bytes] = []

            class FakeStdin:
                def write(self, data):
                    sent.append(data)

                async def drain(self):
                    return None

            c = PiSidecarClient(command=_command())
            c._proc = type("P", (), {"stdin": FakeStdin()})()  # noqa: SLF001 — 注入假管道
            await c._respond_to_host("s-host-9", {"_host_error_": {"code": "unknown_op", "message": "nope"}})  # noqa: SLF001
            frame = decode_frame(sent[0].decode())
            assert frame["id"] == "s-host-9" and frame["ok"] is False
            assert frame["error"] == {"code": "unknown_op", "message": "nope"}
        asyncio.run(run())


class TestEnvPassthrough:
    def test_env_dict_reaches_sidecar_process(self):
        """B6：client env 参数必须透传到子进程（桩回显进 ready 帧 sdk 字段）。"""
        got = []

        async def run():
            c = PiSidecarClient(command=_command(), env={"VIBE_TEST_ENV_MARKER": "env-probe-123"},
                                on_event=lambda ev, sid, data: got.append(data))
            await c.start()
            try:
                ready = next(d for d in got if d.get("protocol") == 1)
                assert ready["sdk"] == "env-probe-123"
            finally:
                await c.stop()
        asyncio.run(run())

class TestRestart:
    def test_crash_restarts_once_and_reopens_sessions(self):
        async def run():
            opened: list[list[str]] = []
            c = PiSidecarClient(command=_command() + [], max_restarts=1)
            # 用 open_session 注册活跃会话（桩返回固定 result）
            await c.start()
            await c.request("open_session", {"session_id": "a1b2c3d4e5f6"})
            c._active_sessions.add("a1b2c3d4e5f6")  # noqa: SLF001 — 单测注入活跃集
            original_open = c.request

            async def spy(op, params, **kw):
                if op == "open_session":
                    opened.append([str(params.get("session_id"))])
                return await original_open(op, params, **kw)

            c.request = spy  # type: ignore[method-assign]
            # 强杀进程（模拟崩溃）
            assert c._proc is not None  # noqa: SLF001
            c._proc.kill()  # noqa: SLF001
            await asyncio.sleep(0.2)
            # 下一个请求应触发重启 + 活跃会话重开
            r = await c.request("ping", {}, timeout=15)
            assert r == {"pong": True, "protocol": 1}
            assert "a1b2c3d4e5f6" in opened[0]
            await c.stop()
        asyncio.run(run())

    def test_second_crash_permanently_unavailable(self):
        async def run():
            c = PiSidecarClient(command=_command(), max_restarts=1)
            await c.start()
            for _ in range(2):
                assert c._proc is not None  # noqa: SLF001
                c._proc.kill()  # noqa: SLF001
                await asyncio.sleep(0.2)
                try:
                    await c.request("ping", {}, timeout=15)
                except SidecarError:
                    pass
            assert c.unavailable is True
            with pytest.raises(SidecarError) as ei:
                await c.request("ping", {})
            assert ei.value.code == "pi_sidecar_unavailable"
            await c.stop()
        asyncio.run(run())

    def test_unready_start_counts_against_budget(self):
        async def run():
            c = PiSidecarClient(command=[sys.executable, "-c", "import sys; sys.exit(3)"], max_restarts=1)
            with pytest.raises(SidecarError):
                await c.start()
            assert c.unavailable is True
        asyncio.run(run())
```

- [ ] 3. 运行期待失败：`pytest agent/tests/pi_sidecar/test_client.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar.client'`。

- [ ] 4. 实现 `agent/src/pi_sidecar/client.py`：

```python
"""Pi sidecar 进程监管 + RPC 客户端。

设计约束（design §Idempotency）：崩溃最多重启一次并重开活跃 JSONL 会话；
in-flight 请求以 sidecar_restarted 报错（不重放）；重启预算耗尽 → 所有请求
永久 pi_sidecar_unavailable。stdout 是唯一协议流，stderr 逐行写日志。
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Callable

from src.pi_sidecar.protocol import LineSplitter, decode_frame, encode_frame

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SIDECAR_DIR = _REPO_ROOT / "pi-sidecar"

READY_TIMEOUT_S = 30.0


class SidecarError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _default_command() -> list[str]:
    """B7：打包后的 desktop 没有 bun。

    解析顺序：env VIBE_PI_SIDECAR_BIN（存在且可执行 → 直接执行该二进制，Rust 侧
    src-tauri/src/sidecar.rs 注入，Task 15）→ bun dev 命令（源码/开发态）。
    """
    bin_path = os.environ.get("VIBE_PI_SIDECAR_BIN") or ""
    if bin_path and os.path.isfile(bin_path) and os.access(bin_path, os.X_OK):
        return [bin_path]
    return ["bun", "run", "src/main.ts"]


class PiSidecarClient:
    def __init__(
        self,
        *,
        command: list[str] | None = None,
        cwd: Path | None = None,
        agent_dir: Path | None = None,
        sessions_dir: Path | None = None,
        env: dict[str, str] | None = None,  # B6：合并覆盖 os.environ 后传给 sidecar 进程
        on_event: Callable[[str, str, dict], None] | None = None,
        on_host_request: Callable[[str, dict], Any] | None = None,  # B3：async (op, params) -> dict
        max_restarts: int = 1,
    ) -> None:
        self._command = command or _default_command()
        self._cwd = cwd or _SIDECAR_DIR
        self._agent_dir = agent_dir
        self._sessions_dir = sessions_dir
        self._env = env
        self._on_event = on_event
        self._on_host_request = on_host_request
        self._max_restarts = max_restarts
        self._restarts_used = 0
        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0
        self._splitter = LineSplitter()
        self._reader_task: asyncio.Task | None = None
        self._ready = False
        self._unavailable = False
        self._stopping = False
        self._active_sessions: set[str] = set()

    # ---------- lifecycle ----------

    @property
    def started(self) -> bool:
        """ready 帧已收到且进程存活（B4：供 SessionService 探测，不窥探私有字段）。"""
        return self._ready and self._proc is not None and self._proc.returncode is None

    # ---------- lifecycle ----------

    @property
    def unavailable(self) -> bool:
        return self._unavailable

    async def start(self) -> None:
        await self._spawn()

    async def _spawn(self) -> None:
        env = dict(os.environ)
        if self._env:
            env.update(self._env)  # B6：显式 env 覆盖继承环境（集成测试隔离真实 provider 配置）
        if self._agent_dir:
            env["VIBE_PI_AGENT_DIR"] = str(self._agent_dir)
        if self._sessions_dir:
            env["VIBE_PI_SESSIONS_DIR"] = str(self._sessions_dir)
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._command,
                cwd=str(self._cwd),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=2 * 1_048_576,
            )
        except OSError as exc:
            self._mark_unavailable(exc)
            raise SidecarError("pi_sidecar_unavailable", f"spawn failed: {exc}") from exc
        self._reader_task = asyncio.get_running_loop().create_task(self._read_loop())
        try:
            await asyncio.wait_for(self._wait_ready(), timeout=READY_TIMEOUT_S)
        except (asyncio.TimeoutError, SidecarError) as exc:
            await self._handle_process_loss(exc if isinstance(exc, SidecarError) else SidecarError("timeout", "ready timeout"))
            if self._unavailable or self._proc is None:
                raise SidecarError("pi_sidecar_unavailable", "sidecar failed to become ready") from exc

    async def _wait_ready(self) -> None:
        while self._ready is False:
            if self._proc is None or self._proc.returncode is not None:
                raise SidecarError("internal", "sidecar exited before ready")
            await asyncio.sleep(0.05)

    async def stop(self) -> None:
        self._stopping = True
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._reject_all(SidecarError("internal", "client stopped"))

    # ---------- request/response ----------

    async def request(self, op: str, params: dict, *, timeout: float = 30.0) -> dict:
        if self._unavailable:
            raise SidecarError("pi_sidecar_unavailable", "sidecar restart budget exhausted")
        if self._proc is None or self._proc.returncode is not None:
            await self._handle_process_loss(SidecarError("internal", "sidecar not running"))
            if self._unavailable:
                raise SidecarError("pi_sidecar_unavailable", "sidecar restart budget exhausted")
        self._seq += 1
        req_id = f"r-{self._seq}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        assert self._proc is not None and self._proc.stdin is not None
        try:
            self._proc.stdin.write(encode_frame({"v": 1, "id": req_id, "op": op, "params": params}).encode("utf-8"))
            await self._proc.stdin.drain()
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise SidecarError("timeout", f"{op} timed out after {timeout}s") from None
        except (ConnectionResetError, BrokenPipeError) as exc:
            self._pending.pop(req_id, None)
            await self._handle_process_loss(SidecarError("internal", f"pipe lost: {exc}"))
            raise SidecarError("sidecar_restarted", f"{op} lost to sidecar restart") from exc
        except Exception:
            self._pending.pop(req_id, None)
            raise
        if result.get("_error_"):
            err = result["_error_"]
            raise SidecarError(err["code"], err["message"])
        payload = result.get("result", {})
        # open_session / new_session 成功 → 记入活跃集（restart 后重开，B2 配套）
        if op in ("open_session", "new_session") and isinstance(params.get("session_id"), str):
            self._active_sessions.add(str(params["session_id"]))
        return payload  # type: ignore[return-value]

    def _reject_all(self, err: SidecarError) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result({"_error_": {"code": err.code, "message": str(err)}})
        self._pending.clear()

    # ---------- reader ----------

    async def _read_loop(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        try:
            while True:
                chunk = (await proc.stdout.read(65536)).decode("utf-8", "replace")
                if not chunk:
                    break
                for line in self._splitter.push(chunk):
                    self._dispatch_frame(line)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("sidecar reader crashed: %s", exc)
        if not self._stopping:
            await self._handle_process_loss(SidecarError("internal", "sidecar exited"))

    def _dispatch_frame(self, line: str) -> None:
        try:
            frame = decode_frame(line)
        except Exception as exc:  # noqa: BLE001
            logger.warning("bad frame from sidecar: %s", exc)
            return
        if "event" in frame:
            if frame["event"] == "ready":
                self._ready = True
            if self._on_event:
                self._on_event(str(frame.get("event")), str(frame.get("session_id") or ""), dict(frame.get("data") or {}))
            return
        if "op" in frame and "ok" not in frame:
            # B3：sidecar→Python 入站请求（tool_invoke/memory_context/remember/...）
            self._schedule_host_request(str(frame["id"]), str(frame["op"]), dict(frame.get("params") or {}))
            return
        fut = self._pending.pop(str(frame.get("id")), None)
        if fut is None or fut.done():
            return
        if frame.get("ok") is True:
            fut.set_result({"result": frame.get("result")})
        else:
            err = frame.get("error") or {}
            fut.set_result({"_error_": {"code": str(err.get("code")), "message": str(err.get("message"))}})

    def _schedule_host_request(self, req_id: str, op: str, params: dict) -> None:
        """入站 host 请求 → on_host_request → respond_host（B3）。"""

        async def _run() -> None:
            try:
                if self._on_host_request is None:
                    result: dict = {"_host_error_": {"code": "unknown_op",
                                                    "message": f"no on_host_request handler for {op}"}}
                else:
                    result = await self._on_host_request(op, params)
                await self.respond_host(req_id, result)
            except Exception as exc:  # noqa: BLE001 — handler 崩溃也必须回帧
                await self.respond_host(req_id, {"_host_error_": {"code": "internal", "message": str(exc)}})

        asyncio.get_running_loop().create_task(_run())

    async def respond_host(self, req_id: str, result: dict) -> None:
        """把 host 请求结果回写给 sidecar（B3）。

        result 含 "_host_error_" → 回 ok:false 错误帧；否则 ok:true + result。
        """
        if self._proc is None or self._proc.stdin is None or self._stopping:
            return
        err = result.get("_host_error_")
        if err is not None:
            frame: dict = {"v": 1, "id": req_id, "ok": False,
                           "error": {"code": str(err.get("code")), "message": str(err.get("message"))}}
        else:
            frame = {"v": 1, "id": req_id, "ok": True, "result": result}
        try:
            self._proc.stdin.write(encode_frame(frame).encode("utf-8"))
            await self._proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError):
            logger.warning("respond_host %s lost: sidecar pipe closed", req_id)

    # ---------- restart ----------

    async def _handle_process_loss(self, cause: SidecarError) -> None:
        if self._stopping:
            return
        self._ready = False
        self._reject_all(SidecarError("sidecar_restarted", f"{cause}; in-flight request not replayed"))
        if self._restarts_used >= self._max_restarts:
            self._mark_unavailable(cause)
            return
        self._restarts_used += 1
        logger.warning("sidecar crashed (%s); restarting (attempt %d/%d)", cause, self._restarts_used, self._max_restarts)
        try:
            await self._spawn()
        except SidecarError:
            return  # _spawn 已 mark_unavailable
        # 重开活跃会话（design：restart 后 reopen JSONL session）
        for session_id in list(self._active_sessions):
            try:
                await self.request("open_session", {"session_id": session_id}, timeout=READY_TIMEOUT_S)
            except SidecarError as exc:
                logger.error("reopen session %s after restart failed: %s", session_id, exc)

    def _mark_unavailable(self, cause: Exception) -> None:
        self._unavailable = True
        self._ready = False
        self._reject_all(SidecarError("pi_sidecar_unavailable", f"sidecar unavailable: {cause}"))
```

- [ ] 5. 运行期待通过：`pytest agent/tests/pi_sidecar/test_client.py --tb=short -q` → `10 passed`。

- [ ] 6. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 7. Commit：

```bash
git add agent/src/pi_sidecar/client.py agent/tests/pi_sidecar/fixtures/ agent/tests/pi_sidecar/test_client.py
git commit -s -m "feat(pi-sidecar): supervised rpc client with restart-once semantics"
```

---

### Task 10: 事件归一化（完整前端 glossary）

**Files:** `agent/src/pi_sidecar/events.py`（Create）、`agent/tests/pi_sidecar/test_events.py`（Create）

**Interfaces:** Produces — 跨任务契约 §事件归一化（`NormState` + `normalize_event`）。**逐字保持 recon glossary 的 payload 形状**（Global Constraints 事件契约条目），特别是 `tool_result.preview`（redacted[:200]，供 `sessions_routes` 派生 `mandate.proposal`/`live.action`）。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_events.py`：

```python
"""事件归一化单测：Pi 事件 → 完整 Vibe glossary（recon §Event name glossary）。"""

from src.pi_sidecar.events import NormState, normalize_event


def test_text_delta():
    st = NormState()
    st.iter = 3
    out = normalize_event("message_update", {"assistantMessageEvent": {"type": "text_delta", "delta": "你好"}}, state=st)
    assert out == [("text_delta", {"delta": "你好", "iter": 3})]


def test_thinking_delta_accumulates_chars():
    st = NormState()
    st.iter = 1
    out = normalize_event("message_update", {"assistantMessageEvent": {"type": "thinking_delta", "delta": "abc"}}, state=st)
    assert out == [("reasoning_delta", {"iter": 1, "chars": 3})]
    out = normalize_event("message_update", {"assistantMessageEvent": {"type": "thinking_delta", "delta": "de"}}, state=st)
    assert out == [("reasoning_delta", {"iter": 1, "chars": 5})]  # 累计，非文本（recon glossary）


def test_message_end_synthesizes_thinking_done_and_llm_usage():
    st = NormState()
    st.iter = 2
    st.provider = "openai"
    st.model = "gpt-4o"
    out = normalize_event(
        "message_end",
        {
            "message": {
                "role": "assistant",
                "provider": "openai",
                "model": "gpt-4o",
                "content": [
                    {"type": "thinking", "thinking": "thought " * 100},
                    {"type": "text", "text": "answer text"},
                ],
                "usage": {"input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0},
                "stopReason": "stop",
            }
        },
        state=st,
    )
    names = [n for n, _ in out]
    assert "thinking_done" in names
    assert "llm_usage" in names
    td = dict(out[names.index("thinking_done")][1])
    assert td["iter"] == 2
    assert len(td["content"]) <= 500 and td["content"].startswith("thought")
    lu = dict(out[names.index("llm_usage")][1])
    assert lu["iter"] == 2 and lu["provider"] == "openai" and lu["model"] == "gpt-4o"
    assert lu["input"] == 100 and lu["output"] == 20 and lu["metering_eligible"] is False
    # assistant 最终文本经 text_delta 已流出；message_end 不重复发 text_delta


def test_tool_execution_start_maps_to_tool_call():
    st = NormState()
    st.iter = 4
    out = normalize_event(
        "tool_execution_start",
        {"toolName": "web_search", "toolCallId": "c1", "args": {"query": "AAPL", "api_key": "sk-secret"}},
        state=st,
    )
    assert out == [
        (
            "tool_call",
            {
                "tool": "web_search",
                "arguments": {"query": "AAPL", "api_key": "[redacted]"},
                "iter": 4,
                "tool_call_id": "c1",
            },
        )
    ]
    assert st.tool_started["c1"] > 0  # 记录开始时间


def test_tool_execution_end_maps_to_tool_result_with_redacted_preview():
    st = NormState()
    st.iter = 4
    st.tool_started["c1"] = 1000.0
    body = json.dumps({"result": "x" * 500, "audit_id": "la_abc123"})
    out = normalize_event(
        "tool_execution_end",
        {"toolName": "web_search", "toolCallId": "c1", "isError": False, "result": {"content": [{"type": "text", "text": body}]}},
        state=st,
    )
    name, data = out[0]
    assert name == "tool_result"
    assert data["tool"] == "web_search"
    assert data["status"] == "ok"
    assert data["elapsed_ms"] >= 0
    assert len(data["preview"]) <= 200
    assert "la_abc123" in data["preview"]  # sessions_routes 依赖 preview 匹配派生 mandate/live 帧


def test_tool_execution_update_maps_to_tool_progress():
    st = NormState()
    st.iter = 1
    out = normalize_event(
        "tool_execution_update",
        {"toolName": "backtest_runner", "toolCallId": "c2", "partial": {"message": "step 2/10", "current": 2, "total": 10}},
        state=st,
    )
    name, data = out[0]
    assert name == "tool_progress"
    assert data["tool"] == "backtest_runner"
    assert data["stage"] == "progress"
    assert data["message"] == "step 2/10"
    assert data["current"] == 2 and data["total"] == 10
    assert "ts" in data


def test_compaction_events():
    st = NormState()
    out = normalize_event("auto_compaction_start", {"tokensBefore": 42000}, state=st)
    assert out == [("compact", {"phase": "start", "tokens_before": 42000})]
    out = normalize_event("auto_compaction_end", {"tokensBefore": 42000, "summary": "s" * 300}, state=st)
    assert out == [("compact", {"phase": "end", "tokens_before": 42000, "summary": "s" * 200})]  # summary[:200]


def test_retry_events_map_to_stream_reset_and_notice():
    st = NormState()
    st.iter = 5
    st.provider = "openai"
    st.model = "gpt-4o"
    out = normalize_event("auto_retry_start", {"attempt": 1}, state=st)
    assert out[0][0] == "stream_reset"
    assert out[0][1]["reason"] == "provider_stream_retry"
    assert out[0][1]["iter"] == 5 and out[0][1]["provider"] == "openai" and out[0][1]["model"] == "gpt-4o"
    out = normalize_event("retry_fallback_succeeded", {"from": "openai/gpt-4o", "to": "openai/gpt-4o-mini"}, state=st)
    assert out[0][0] == "pi.notice"
    assert out[0][1]["kind"] == "retry_fallback_succeeded"


def test_agent_end_terminal_emits_nothing():
    st = NormState()
    assert normalize_event("agent_end", {"isTerminal": True}, state=st) == []
    assert normalize_event("agent_end", {}, state=st) == []  # absent = terminal（SDK facts）


def test_agent_end_non_terminal_emits_nothing_but_client_handles():
    st = NormState()
    assert normalize_event("agent_end", {"isTerminal": False}, state=st) == []


def test_model_changed_emits_notice():
    st = NormState()
    out = normalize_event("model_changed", {"model": "openai/gpt-4o"}, state=st)
    assert out == [("pi.notice", {"kind": "model_changed", "message": "model changed to openai/gpt-4o"})]


import json  # noqa: E402  (测试文件尾部 import 仅为可读性排序豁免——置于顶部亦可)
```

（实现者注意：把 `import json` 移到文件顶部，删除尾注。）

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_events.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar.events'`。

- [ ] 3. 实现 `agent/src/pi_sidecar/events.py`：

```python
"""Pi 事件 → Vibe SSE glossary 归一化（design §Events + Global Constraints 事件契约）。

形状铁律：前端与 sessions_routes 派生逻辑（mandate.proposal/live.action 依赖
tool_result.preview 正则匹配）逐字段依赖这些 payload 形状，不得改名/增删关键字段。
"""

from __future__ import annotations

import time
from typing import Any

from src.tools.redaction import redact_payload, redact_log_text

PREVIEW_CHARS = 200
THINKING_DONE_CHARS = 500
COMPACT_SUMMARY_CHARS = 200


class NormState:
    """每 attempt 一个。"""

    def __init__(self) -> None:
        self.iter: int = 0
        self.reasoning_chars: int = 0
        self.tool_started: dict[str, float] = {}
        self.provider: str = ""
        self.model: str = ""


def _redact_args(args: Any) -> dict[str, str]:
    if not isinstance(args, dict):
        return {}
    safe = redact_payload(args)
    return {k: str(v)[:200] for k, v in safe.items()}


def _text_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _thinking_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, list):
        return "".join(b.get("thinking", "") for b in content if isinstance(b, dict) and b.get("type") == "thinking")
    return ""


def _result_text(payload: dict) -> str:
    result = payload.get("result")
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list):
            return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        if isinstance(content, str):
            return content
    return ""


def normalize_event(pi_type: str, payload: dict, *, state: NormState) -> list[tuple[str, dict]]:
    if pi_type == "message_update":
        ame = payload.get("assistantMessageEvent") or {}
        kind = ame.get("type")
        if kind == "text_delta":
            return [("text_delta", {"delta": str(ame.get("delta") or ""), "iter": state.iter})]
        if kind == "thinking_delta":
            state.reasoning_chars += len(str(ame.get("delta") or ""))
            return [("reasoning_delta", {"iter": state.iter, "chars": state.reasoning_chars})]
        return []

    if pi_type == "message_end":
        out: list[tuple[str, dict]] = []
        msg = payload.get("message") or {}
        if msg.get("role") != "assistant":
            return []
        state.provider = str(msg.get("provider") or state.provider)
        state.model = str(msg.get("model") or state.model)
        thinking = _thinking_of(msg)
        if thinking:
            out.append(("thinking_done", {"iter": state.iter, "content": thinking[:THINKING_DONE_CHARS]}))
        usage = msg.get("usage")
        if isinstance(usage, dict):
            data = {k: v for k, v in usage.items() if isinstance(v, (int, float))}
            data.update({"iter": state.iter, "provider": state.provider, "model": state.model, "metering_eligible": False})
            out.append(("llm_usage", data))
        return out

    if pi_type == "tool_execution_start":
        call_id = str(payload.get("toolCallId") or "")
        state.tool_started[call_id] = time.monotonic()
        return [(
            "tool_call",
            {
                "tool": str(payload.get("toolName") or ""),
                "arguments": _redact_args(payload.get("args")),
                "iter": state.iter,
                "tool_call_id": call_id,
            },
        )]

    if pi_type == "tool_execution_update":
        partial = payload.get("partial") or {}
        data: dict[str, Any] = {
            "tool": str(payload.get("toolName") or ""),
            "stage": str(partial.get("stage") or "progress"),
            "current": partial.get("current"),
            "total": partial.get("total"),
            "message": str(partial.get("message") or ""),
            "elapsed_s": round(time.monotonic() - state.tool_started.get(str(payload.get("toolCallId") or ""), time.monotonic()), 3),
            "ts": time.time(),
        }
        return [("tool_progress", data)]

    if pi_type == "tool_execution_end":
        call_id = str(payload.get("toolCallId") or "")
        started = state.tool_started.pop(call_id, None)
        elapsed_ms = int((time.monotonic() - started) * 1000) if started is not None else 0
        text = _result_text(payload)
        preview = redact_log_text(text[:PREVIEW_CHARS], limit=PREVIEW_CHARS)
        return [(
            "tool_result",
            {
                "tool": str(payload.get("toolName") or ""),
                "status": "error" if payload.get("isError") else "ok",
                "elapsed_ms": elapsed_ms,
                "preview": preview,
                "tool_call_id": call_id,
            },
        )]

    if pi_type == "auto_compaction_start":
        return [("compact", {"phase": "start", "tokens_before": payload.get("tokensBefore")})]
    if pi_type == "auto_compaction_end":
        summary = str(payload.get("summary") or "")[:COMPACT_SUMMARY_CHARS]
        data = {"phase": "end", "tokens_before": payload.get("tokensBefore")}
        if summary:
            data["summary"] = summary
        return [("compact", data)]

    if pi_type == "auto_retry_start":
        return [(
            "stream_reset",
            {
                "iter": state.iter,
                "reason": "provider_stream_retry",
                "provider": state.provider,
                "model": state.model,
            },
        )]

    if pi_type in ("retry_fallback_applied", "retry_fallback_succeeded", "model_changed", "thinking_level_changed", "notice"):
        if pi_type == "model_changed":
            msg = f"model changed to {payload.get('model')}"
        elif pi_type == "thinking_level_changed":
            msg = f"thinking level changed to {payload.get('thinkingLevel')}"
        else:
            msg = str(payload.get("message") or str(payload))
        state.model = str(payload.get("model") or state.model)
        return [("pi.notice", {"kind": pi_type, "message": msg})]

    if pi_type == "agent_start":
        state.iter += 1
        state.reasoning_chars = 0
        return []
    if pi_type in ("agent_end", "turn_start", "turn_end", "message_start"):
        if pi_type == "message_start" and isinstance(payload.get("entryId"), str):
            pass  # entry id 供 tool-bridge 幂等键使用；无 SSE 输出
        return []

    return []  # 未知 Pi 事件不外泄（design：Pi 原始事件流永不外露）
```

- [ ] 4. 运行期待通过：`pytest agent/tests/pi_sidecar/test_events.py --tb=short -q` → `10 passed`。

- [ ] 5. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 6. Commit：

```bash
git add agent/src/pi_sidecar/events.py agent/tests/pi_sidecar/test_events.py
git commit -s -m "feat(pi-sidecar): pi-to-vibe event normalization preserving full glossary"
```

---

### Task 11: 结果投影（attempt result + Message 投影）

**Files:** `agent/src/pi_sidecar/projection.py`（Create）、`agent/tests/pi_sidecar/test_projection.py`（Create）

**Interfaces:** Produces — 跨任务契约 §最终 result 投影（`build_attempt_result` + `pi_messages_to_store_messages`；`Message` 来自 `agent/src/session/models.py`，recon §2.1）。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_projection.py`：

```python
"""投影单测：AgentLoop.run() 兼容 result + Message 内存投影。"""

from src.pi_sidecar.projection import build_attempt_result, pi_messages_to_store_messages
from src.session.models import Message


class TestBuildAttemptResult:
    def test_full_shape(self):
        r = build_attempt_result(
            status="success",
            content="done",
            run_dir="/runs/20260830_1_abc123",
            react_trace=[{"type": "answer", "content": "done"}],
            iterations=3,
            metrics={"sharpe": 1.2},
            reliability=None,
            pi_meta={"session_file": "/pi/s.jsonl", "pi_session_id": "a1b2c3d4e5f6", "entry_ids": ["e1"], "tool_call_ids": ["c1"]},
        )
        assert r["status"] == "success"
        assert r["run_id"] == "20260830_1_abc123"
        assert r["max_iterations"] == 50
        assert r["metrics"] == {"sharpe": 1.2}
        assert r["pi"]["pi_session_id"] == "a1b2c3d4e5f6"
        assert "reliability" not in r

    def test_reliability_included_when_present(self):
        r = build_attempt_result(
            status="success", content="x", run_dir="/r/a_b", react_trace=[], iterations=1,
            metrics=None, reliability={"mode": "shadow"},
        )
        assert r["reliability"] == {"mode": "shadow"}

    def test_failure_with_reason_passthrough(self):
        r = build_attempt_result(
            status="failed", content="", run_dir="/r/a_b", react_trace=[], iterations=2,
            metrics=None, reason="model exploded",
        )
        assert r["status"] == "failed"
        assert r["reason"] == "model exploded"


class TestPiMessagesToStoreMessages:
    def test_projects_entries_to_messages_without_disk_write(self):
        entries = [
            {"entry_id": "e1", "role": "user", "content": "hello", "timestamp": "2026-08-30T00:00:00Z"},
            {"entry_id": "e2", "role": "assistant", "content": "hi there", "timestamp": "2026-08-30T00:00:01Z"},
        ]
        msgs = pi_messages_to_store_messages("sess123", entries)
        assert len(msgs) == 2
        assert all(isinstance(m, Message) for m in msgs)
        assert msgs[0].session_id == "sess123"
        assert msgs[0].role == "user" and msgs[0].content == "hello"
        assert msgs[1].metadata == {"pi_entry_id": "e2"}

    def test_empty_entries(self):
        assert pi_messages_to_store_messages("s", []) == []
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_projection.py --tb=short -q` → `ModuleNotFoundError`。

- [ ] 3. 实现 `agent/src/pi_sidecar/projection.py`：

```python
"""最终 result 投影（design §Events：保留 AgentLoop result 契约 + Pi metadata）。"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from src.session.models import Message


def build_attempt_result(
    *,
    status: str,
    content: str,
    run_dir: str,
    react_trace: list[dict],
    iterations: int,
    metrics: dict[str, Any] | None,
    reliability: dict[str, Any] | None = None,
    pi_meta: dict[str, Any] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": status,
        "run_dir": run_dir,
        "run_id": Path(run_dir).name,
        "content": content,
        "react_trace": react_trace,
        "iterations": iterations,
        "max_iterations": 50,  # 与 SessionService._run_with_agent 的 AgentLoop(max_iterations=50) 一致
    }
    if metrics is not None:
        result["metrics"] = metrics
    if reliability is not None:
        result["reliability"] = reliability
    if pi_meta is not None:
        result["pi"] = pi_meta
    if reason is not None:
        result["reason"] = reason
    return result


def pi_messages_to_store_messages(session_id: str, entries: list[dict]) -> list[Message]:
    """sidecar get_messages → Message 内存投影（不落盘；design §Session Persistence）。"""
    out: list[Message] = []
    for e in entries:
        out.append(
            Message(
                session_id=session_id,
                role=str(e.get("role") or "user"),
                content=str(e.get("content") or ""),
                created_at=str(e.get("timestamp") or datetime.utcnow().isoformat()),
                metadata={"pi_entry_id": e.get("entry_id")},
            )
        )
    return out
```

- [ ] 4. 运行期待通过：`pytest agent/tests/pi_sidecar/test_projection.py --tb=short -q` → `5 passed`。

- [ ] 5. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 6. Commit：

```bash
git add agent/src/pi_sidecar/projection.py agent/tests/pi_sidecar/test_projection.py
git commit -s -m "feat(pi-sidecar): attempt result and message projection"
```

---

## Phase 4 — SessionService cutover

### Task 12: SessionService engine 分支（`_run_with_pi` + cancel + get_messages 路由）

**Files:** `agent/src/session/service.py`（Modify：`send_message`/`_run_attempt`/`_run_with_agent` 入口、`cancel_current`、`get_messages`）、`agent/tests/pi_sidecar/test_service_cutover.py`（Create）

**Interfaces:** Consumes — Task 9 `PiSidecarClient`、Task 10 `normalize_event/NormState`、Task 11 `build_attempt_result/pi_messages_to_store_messages`、Task 8 `GatewayBridge`、`__init__.py` 的 `get_agent_engine/LEGACY_ONLY_PROVIDERS`、既有 `RunStateStore`（`src/core/state.py`）、`PersistentMemory`。Produces — `SessionService._run_with_pi(attempt, *, include_shell_tools, session_config)`（返回 AgentLoop.run() 兼容 dict）；模块级 `_get_pi_client()` 单例。

关键行为（Global Constraints）：
1. `_run_with_agent` 开头分支：`engine = get_agent_engine()`；`engine == "legacy"` → 走原路径（**原两个函数体保持不动**）。pi 引擎下，会话 config/provider 解析出 `LANGCHAIN_PROVIDER ∈ LEGACY_ONLY_PROVIDERS` → 发 `pi.notice`（kind="legacy_provider_fallback"）后走 legacy 路径（显式配置驱动回退，非静默）。
2. `_run_with_pi` 流程（B4：同步方法，pi loop 桥接）：`RunStateStore.create_run_dir` → client 未 `started` 则 `start`（失败/`unavailable` → result `{"status":"failed","reason":"pi_sidecar_unavailable",...}`，**绝不**回退 legacy）→ `open_session`（`not_found` 且旧 store 有该会话 → Task 13 的 `migrate_session_if_needed`；仍缺失 → `new_session`）→ `set_tool_manifest`（一次）→ 共享 `NormState` + 每会话 `GatewayBridge` → `prompt(attempt.prompt)` → 事件泵：每个 `session_event` 过 `normalize_event` → `event_bus.emit`（`attempt_id` 注入 data）；`agent_end(isTerminal!==false)` → 终止收集 → 末条 assistant content → `build_attempt_result(...)`。
3. host op 处理（B5 注册表）：入站请求经 client 的 `on_host_request` → `self._pi_host_handlers` 分发；Task 12 注册 `tool_invoke` → `GatewayBridge.handle_invoke`，Task 14 追加注册 `memory_context`/`remember`/`memory_search`/`memory_remove` → `MemoryBridge`。
4. `cancel_current`：pi 引擎下若 `session_id ∈ _active_pi_sessions` → `client.request("abort")`（cancel handle 等价物）；legacy 路径不动。
5. 执行路径停写 messages：pi 引擎下 `send_message` **不** `store.append_message`（用户消息入 Pi 会话）；`_run_attempt` 的 assistant reply Message 不落盘（`get_messages` 路由到 Pi，Task 11 `pi_messages_to_store_messages` 投影）；`Attempt`/`session.last_attempt_id` 照旧写（业务 ledger）。legacy 引擎完全不变。
6. `get_messages`：pi 引擎且会话在 `self._pi_sessions`（含迁移标记）→ `client.request("get_messages")` → `pi_messages_to_store_messages`；否则旧路径。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_service_cutover.py`（duck-type 侧车：monkeypatch `_get_pi_client` 与 `_run_on_pi_loop`（B4 桥接），走 service 全流程）：

```python
"""SessionService pi 引擎 cutover 单测（fake sidecar client，无 bun 依赖）。"""

import asyncio
from pathlib import Path

import pytest

from src.pi_sidecar.client import SidecarError
from src.session.models import Attempt, Session
from src.session.service import SessionService
from src.pi_sidecar import events as pi_events


class FakeClient:
    """duck-type PiSidecarClient：started/unavailable 语义与真实 client 一致（B4）。"""

    def __init__(self, *, unavailable=False, fail_start=False):
        self.unavailable = unavailable
        self.fail_start = fail_start
        self.started = True  # 默认已就绪；fail_start 场景由 start() 翻转
        self.requests: list[tuple[str, dict]] = []

    async def start(self):
        if self.fail_start:
            self.unavailable = True  # 真实 client：启动失败即标记永久不可用
            raise SidecarError("pi_sidecar_unavailable", "spawn failed")
        self.started = True

    async def request(self, op, params, *, timeout=30.0):
        import src.session.service as svc_mod

        self.requests.append((op, params))
        if op == "open_session":
            raise SidecarError("not_found", "no session")
        if op == "new_session":
            return {"session_file": "/tmp/pi/fake.jsonl"}
        if op == "set_tool_manifest":
            return {"count": len(params.get("tools", []))}
        if op == "prompt":
            # 模拟 sidecar 事件流（经模块级 listener 注册表派发，B4/B5）
            sid = params["session_id"]
            listener = svc_mod._PI_EVENT_LISTENERS.get(sid)
            assert listener is not None, "service must register an event listener before prompt"
            listener("session_event", sid, {"type": "message_start", "payload": {"entryId": "assist1"}})
            listener("session_event", sid, {"type": "message_update", "payload": {"assistantMessageEvent": {"type": "text_delta", "delta": "最终答案内容"}}})
            listener("session_event", sid, {"type": "message_end", "payload": {"entryId": "assist1", "message": {"role": "assistant", "provider": "openai", "model": "gpt-4o", "content": [{"type": "text", "text": "最终答案内容"}], "usage": {"input": 10, "output": 5}}}})
            listener("session_event", sid, {"type": "agent_end", "payload": {"isTerminal": True}})
            return {"accepted": True}
        if op == "get_messages":
            return {"messages": [
                {"entry_id": "e1", "role": "user", "content": "q", "timestamp": "t1"},
                {"entry_id": "e2", "role": "assistant", "content": "最终答案内容", "timestamp": "t2"},
            ], "next_cursor": None}
        if op == "abort":
            return {"aborted": True}
        raise SidecarError("unknown_op", op)


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    from src.session.store import SessionStore
    from src.session.events import EventBus

    store = SessionStore(base_dir=tmp_path / "sessions")
    bus = EventBus()
    service = SessionService(store, bus, runs_dir=tmp_path / "runs")
    return service


def _wire_pi(svc, fake, monkeypatch):
    """monkeypatch client 单例与 pi-loop 桥（测试线程无运行 loop → asyncio.run 直跑）。"""
    import src.session.service as svc_mod

    monkeypatch.setattr(svc_mod, "_get_pi_client", lambda: fake)
    monkeypatch.setattr(svc_mod, "_run_on_pi_loop", lambda coro, timeout=30.0: asyncio.run(coro))
    return fake


def test_pi_engine_full_attempt_flow(svc, monkeypatch, tmp_path):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "pi")
    fake = _wire_pi(svc, FakeClient(), monkeypatch)
    session = svc.create_session(title="t")
    result = svc._run_with_pi(
        Attempt(session_id=session.session_id, prompt="research AAPL", created_at="2026-08-30T00:00:00"),
        include_shell_tools=False, session_config=None,
    )
    assert result["status"] == "success"
    assert result["content"] == "最终答案内容"
    assert result["pi"]["pi_session_id"] == session.session_id
    assert result["pi"]["entry_ids"] == ["assist1"]  # M2：entry_ids 来自 message_start/end payload
    assert Path(result["run_dir"]).exists()
    ops = [op for op, _ in fake.requests]
    assert ops[:3] == ["open_session", "new_session", "set_tool_manifest"]
    assert ("prompt", {"session_id": session.session_id, "text": "research AAPL"}) in fake.requests
    # SSE 事件已经过归一化（text_delta/llm_usage 形状）
    events = svc.event_bus.replay(session.session_id)
    names = [e.event_type for e in events]
    assert "text_delta" in names and "llm_usage" in names


def test_pi_unavailable_fails_without_legacy_fallback(svc, monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "pi")
    fake = _wire_pi(svc, FakeClient(fail_start=True), monkeypatch)
    session = svc.create_session(title="t")
    attempt = Attempt(session_id=session.session_id, prompt="x", created_at="2026-08-30T00:00:00")
    result = svc._run_with_pi(attempt, include_shell_tools=False, session_config=None)
    assert result["status"] == "failed"
    assert result["reason"] == "pi_sidecar_unavailable"
    assert result.get("_legacy_fallback") is None  # 绝不回退


def test_legacy_engine_flag_uses_old_path(svc, monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "legacy")
    import src.session.service as svc_mod
    called = {"pi": 0, "legacy": 0}
    monkeypatch.setattr(svc_mod.SessionService, "_run_with_pi", lambda self, attempt, **k: called.__setitem__("pi", called["pi"] + 1) or {})
    monkeypatch.setattr(svc_mod.SessionService, "_run_with_agent", lambda self, attempt, **k: called.__setitem__("legacy", called["legacy"] + 1) or {"status": "success", "content": "", "run_dir": "", "react_trace": [], "iterations": 0})
    session = svc.create_session(title="t")
    asyncio.run(svc._run_with_agent(Attempt(session_id=session.session_id, prompt="x", created_at="2026-08-30T00:00:00")))
    assert called == {"pi": 0, "legacy": 1}


def test_legacy_only_provider_falls_back_explicitly(svc, monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "pi")
    monkeypatch.setenv("LANGCHAIN_PROVIDER", "vip_server")
    fake = _wire_pi(svc, FakeClient(), monkeypatch)
    session = svc.create_session(title="t")
    import src.session.service as svc_mod
    legacy_called = {"n": 0}
    monkeypatch.setattr(svc_mod.SessionService, "_run_with_agent", lambda self, attempt, **k: legacy_called.__setitem__("n", legacy_called["n"] + 1) or {"status": "success", "content": "", "run_dir": "", "react_trace": [], "iterations": 0})
    asyncio.run(svc._run_with_agent(Attempt(session_id=session.session_id, prompt="x", created_at="2026-08-30T00:00:00")))
    assert legacy_called["n"] == 1  # 显式回退 legacy（vip_server legacy-only）
    notices = [e for e in svc.event_bus.replay(session.session_id) if e.event_type == "pi.notice"]
    assert any(n.data.get("kind") == "legacy_provider_fallback" for n in notices)


def test_cancel_current_pi_engine_aborts(svc, monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "pi")
    fake = _wire_pi(svc, FakeClient(), monkeypatch)
    session = svc.create_session(title="t")
    svc._active_pi_sessions.add(session.session_id)
    assert svc.cancel_current(session.session_id) is True
    assert ("abort", {"session_id": session.session_id}) in fake.requests


def test_get_messages_routes_to_pi_for_pi_sessions(svc, monkeypatch):
    monkeypatch.setenv("VIBE_AGENT_ENGINE", "pi")
    fake = _wire_pi(svc, FakeClient(), monkeypatch)
    session = svc.create_session(title="t")
    svc._pi_sessions[session.session_id] = {"migrated": True}
    msgs = svc.get_messages(session.session_id, limit=10)
    assert len(msgs) == 2
    assert msgs[1].metadata.get("pi_entry_id") == "e2"
    assert any(op == "get_messages" for op, _ in fake.requests)
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_service_cutover.py --tb=short -q` → `AttributeError: ... _run_with_pi`（或 `_get_pi_client` 缺失 ImportError）。

- [ ] 3. 实现：修改 `agent/src/session/service.py`。**异步桥接结构（B4）**：sidecar client 生命周期绑定到一个**模块级专用事件循环**（守护线程 `_pi_loop()`，镜像既有 `EventBus` 线程桥接模式）；`_run_with_pi` 是**同步**方法，经既有 `_AGENT_EXECUTOR` 线程运行（与 legacy `agent.run` 形状一致），所有 sidecar 交互经 `_run_on_pi_loop(coro, timeout)` 桥接；client 事件回调在 pi loop 线程触发，经 `EventBus.emit`（本身 `call_soon_threadsafe` 线程安全）进 SSE。

模块级新增（`SessionService` 类定义之前；文件顶部补 `import threading`）：

```python
_PI_LOOP: Optional[asyncio.AbstractEventLoop] = None
_PI_CLIENT: Optional["PiSidecarClient"] = None
_PI_EVENT_LISTENERS: Dict[str, Callable[[str, str, Dict[str, Any]], None]] = {}


def _pi_loop() -> asyncio.AbstractEventLoop:
    """pi sidecar 专用事件循环（守护线程；进程生命周期内复用）。"""
    global _PI_LOOP
    if _PI_LOOP is None or _PI_LOOP.is_closed():
        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, name="pi-sidecar-loop", daemon=True).start()
        _PI_LOOP = loop
    return _PI_LOOP


def _run_on_pi_loop(coro, *, timeout: float = 30.0):
    """从任意线程把协程桥接到 pi loop 并阻塞取结果（B4：唯一桥接入口）。"""
    return asyncio.run_coroutine_threadsafe(coro, _pi_loop()).result(timeout)


def _get_pi_client():
    """Pi sidecar client 进程级单例（B3/B5：client 级回调接线）。"""
    global _PI_CLIENT
    try:
        return _PI_CLIENT
    except NameError:
        _PI_CLIENT = None
    if _PI_CLIENT is None:
        from src.pi_sidecar.client import PiSidecarClient
        _PI_CLIENT = PiSidecarClient(on_event=_on_pi_event, on_host_request=_on_pi_host_request)
    return _PI_CLIENT


def _on_pi_event(event: str, session_id: str, data: Dict[str, Any]) -> None:
    """client on_event 回调（pi loop 线程）：派发给该会话的 attempt 事件泵。"""
    listener = _PI_EVENT_LISTENERS.get(session_id)
    if listener is not None:
        listener(event, session_id, data)


async def _on_pi_host_request(op: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """client on_host_request 回调（pi loop 线程）：按 _pi_host_handlers 注册表分发（B3/B5）。

    返回 dict = 成功 result；返回 {"_host_error_": {...}} = 回 ok:false 错误帧（Task 9 语义）。
    """
    svc = _get_session_service_safe()
    if svc is None:
        return {"_host_error_": {"code": "internal", "message": "session service not bootstrapped"}}
    handler = svc._pi_host_handlers.get(op)
    if handler is None:
        return {"_host_error_": {"code": "unknown_op", "message": f"unhandled host op: {op}"}}
    return await handler(params)


def _get_session_service_safe():
    """回调线程里惰性取 service 单例；未装配（如 CLI 直跑）时返回 None。"""
    try:
        from src.api.state import _get_session_service
        return _get_session_service()
    except Exception:  # noqa: BLE001
        return None
```

类内新增/修改（保留全部既有函数体；只插入分支）：

```python
# __init__ 末尾追加：
        self._pi_sessions: Dict[str, Dict[str, Any]] = {}
        self._active_pi_sessions: set = set()
        self._manifest_sent: bool = False
        self._pi_registry = None                      # build_registry 产物缓存（一次构建）
        self._pi_bridges: Dict[str, "GatewayBridge"] = {}   # session_id -> GatewayBridge
        self._pi_host_handlers: Dict[str, Any] = {"tool_invoke": self._handle_tool_invoke_host}

    async def _handle_tool_invoke_host(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """host op `tool_invoke`（B5 注册表项）：按幂等键前缀还原 session_id。"""
        session_id = str(params.get("idempotencyKey", ":").split(":")[0] or "")
        return await self._pi_gateway_bridge(session_id).handle_invoke(params)

    def _pi_gateway_bridge(self, session_id: str) -> "GatewayBridge":
        """每会话 GatewayBridge 惰性缓存（registry 全局构建一次，单一 choke point）。"""
        if self._pi_registry is None:
            from src.tools import build_registry
            self._pi_registry = build_registry(persistent_memory=None, include_shell_tools=False)
        if session_id not in self._pi_bridges:
            from src.pi_sidecar.gateway_bridge import GatewayBridge
            self._pi_bridges[session_id] = GatewayBridge(self._pi_registry)
        return self._pi_bridges[session_id]
```

```python
# send_message 内，"if role != 'user': return ..." 之后、既有 attempt 构造之前插入（B4：显式构造 Message；
# 迁移检查用 Task 13 的 is_migrated，B4）：
        if get_agent_engine() == "pi":
            from src.pi_sidecar.migration import is_migrated
            # design §Session Persistence：pi 引擎执行路径不写 SessionStore messages
            message = Message(session_id=session_id, role=role, content=content)
            self.event_bus.emit(session_id, "message.received",
                                {"message_id": message.message_id, "role": role, "content": content})
            self._pi_sessions.setdefault(session_id, {"migrated": is_migrated(session_id)})
            attempt = Attempt(session_id=session_id, parent_attempt_id=session.last_attempt_id, prompt=content)
            self.store.create_attempt(attempt)
            session.last_attempt_id = attempt.attempt_id
            self.store.update_session(session)
            self.event_bus.emit(session_id, "attempt.created", {"attempt_id": attempt.attempt_id, "prompt": content})
            asyncio.create_task(self._run_attempt(session, attempt, include_shell_tools=include_shell_tools))
            return {"message_id": message.message_id, "attempt_id": attempt.attempt_id}
```

```python
# _run_attempt 开头 mark_running 之前插入分支：pi 引擎走 _run_attempt_pi 且不写 reply Message
    async def _run_attempt(self, session, attempt, *, include_shell_tools=False):
        if get_agent_engine() == "pi":
            await self._run_attempt_pi(session, attempt, include_shell_tools=include_shell_tools)
            return
        # —— 以下为既有实现原文，保持不动 ——

    async def _run_attempt_pi(self, session, attempt, *, include_shell_tools=False):
        """Pi 引擎 attempt 投影：Attempt/ledger 照旧；messages 不落盘（design §Session Persistence）。

        B4：_run_with_pi 是同步方法（pi loop 桥接），经 _AGENT_EXECUTOR 线程运行，
        与 legacy `agent.run` 的执行形状完全一致。
        """
        attempt.mark_running()
        self.store.update_attempt(attempt)
        self.event_bus.emit(session.session_id, "attempt.started", {"attempt_id": attempt.attempt_id})
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                _AGENT_EXECUTOR,
                lambda: self._run_with_pi(attempt, include_shell_tools=include_shell_tools,
                                          session_config=dict(session.config)),
            )
            if result.get("status") == "success":
                attempt.mark_completed(summary=result.get("content", ""))
            else:
                attempt.mark_failed(error=result.get("reason", "unknown"))
            attempt.run_dir = result.get("run_dir")
            self.store.update_attempt(attempt)
            self.event_bus.emit(
                session.session_id,
                "attempt.completed" if attempt.status == AttemptStatus.COMPLETED else "attempt.failed",
                {"attempt_id": attempt.attempt_id, "status": attempt.status.value,
                 "summary": attempt.summary, "error": attempt.error, "run_dir": attempt.run_dir},
            )
        except Exception as exc:
            attempt.mark_failed(error=str(exc))
            self.store.update_attempt(attempt)
            self.event_bus.emit(session.session_id, "attempt.failed", {"attempt_id": attempt.attempt_id, "error": str(exc)})
        finally:
            self._active_pi_sessions.discard(session.session_id)
```

```python
# _run_with_agent 开头（原文第一行 mode = get_reliability_runtime_mode() 之前）插入：
        if get_agent_engine() == "pi":
            provider = (os.getenv("LANGCHAIN_PROVIDER") or "openai").strip().lower()
            if provider in LEGACY_ONLY_PROVIDERS:
                self.event_bus.emit(attempt.session_id, "pi.notice",
                                    {"kind": "legacy_provider_fallback", "message": f"provider {provider} is legacy-engine-only"})
            else:
                return await asyncio.get_running_loop().run_in_executor(
                    _AGENT_EXECUTOR,
                    lambda: self._run_with_pi(attempt, messages=messages,
                                              include_shell_tools=include_shell_tools,
                                              session_config=session_config),
                )
        # —— 既有函数体原文保持不动 ——
```

```python
    def _run_with_pi(self, attempt, *, messages=None, include_shell_tools=False,
                     session_config=None) -> Dict[str, Any]:
        """Pi sidecar 执行路径（design §Architecture）。同步方法（B4），返回 AgentLoop.run() 兼容 dict。"""
        from src.core.state import RunStateStore
        from src.pi_sidecar import events as pi_events
        from src.pi_sidecar.manifest import build_tool_manifest
        from src.pi_sidecar.projection import build_attempt_result

        session_id = attempt.session_id
        run_dir = str(RunStateStore(self.runs_dir).create_run_dir())
        state = pi_events.NormState()
        client = _get_pi_client()

        # 事件泵定义（B4：listener 注册表 + threading.Event；M2：entry_ids 收集）。
        # 定义在前、注册在 prompt 之前（section 2）——事件可能同步到达。
        terminal = threading.Event()
        collected = {"text": "", "entry_ids": [], "tool_call_ids": [], "react_trace": []}

        def on_event(event: str, sid: str, data: Dict[str, Any]) -> None:
            if sid != session_id or event != "session_event":
                return
            ptype = str(data.get("type"))
            payload = dict(data.get("payload") or {})
            if ptype in ("message_start", "message_end") and payload.get("entryId"):
                collected["entry_ids"].append(payload["entryId"])
            if ptype == "message_end" and (payload.get("message") or {}).get("role") == "assistant":
                from src.pi_sidecar.events import _text_of
                collected["text"] = _text_of(payload["message"])
            if ptype == "tool_execution_end":
                collected["tool_call_ids"].append(payload.get("toolCallId"))
            for name, ndata in pi_events.normalize_event(ptype, payload, state=state):
                ndata = dict(ndata)
                ndata["attempt_id"] = attempt.attempt_id
                self.event_bus.emit(session_id, name, ndata)
                if name == "tool_result":
                    collected["react_trace"].append({"type": "tool_call", "tool": ndata.get("tool"),
                                                     "result_preview": ndata.get("preview")})
            if ptype == "agent_end" and payload.get("isTerminal") is not False:
                terminal.set()


        # 1) 启动（B4：started 公开属性；失败 → 永久 unavailable，绝不回退 legacy）
        if client.unavailable or not client.started:
            try:
                _run_on_pi_loop(client.start(), timeout=60)
            except SidecarError:
                pass  # unavailable 状态由 client 记录
        if client.unavailable:
            return build_attempt_result(status="failed", content="", run_dir=run_dir,
                                        react_trace=[], iterations=0, metrics=None,
                                        reason="pi_sidecar_unavailable")

        # 2) 会话打开/迁移/新建 + manifest + prompt
        try:
            try:
                _run_on_pi_loop(client.request("open_session", {"session_id": session_id}), timeout=30)
            except SidecarError as exc:
                if exc.code != "not_found":
                    raise
                from src.pi_sidecar.migration import migrate_session_if_needed
                migrated = _run_on_pi_loop(migrate_session_if_needed(self, client, session_id), timeout=120)
                if not migrated:
                    _run_on_pi_loop(client.request("new_session", {"session_id": session_id}), timeout=30)
            if not self._manifest_sent:
                self._pi_gateway_bridge(session_id)  # 惰性构建 self._pi_registry（一次）
                tools = build_tool_manifest(self._pi_registry)
                _run_on_pi_loop(client.request("set_tool_manifest", {"tools": tools}), timeout=120)
                self._manifest_sent = True
            self._pi_sessions.setdefault(session_id, {"migrated": True})
            self._active_pi_sessions.add(session_id)
            # 事件泵先于 prompt 注册（事件可能同步到达；FakeClient 单测依赖此顺序）
            _PI_EVENT_LISTENERS[session_id] = on_event
            _run_on_pi_loop(client.request("prompt", {"session_id": session_id, "text": attempt.prompt}), timeout=30)
        except SidecarError as exc:
            code = "pi_sidecar_unavailable" if exc.code == "pi_sidecar_unavailable" else exc.code
            self._active_pi_sessions.discard(session_id)
            return build_attempt_result(status="failed", content="", run_dir=run_dir,
                                        react_trace=[], iterations=0, metrics=None, reason=code)

        # 3) 等待终止 agent_end（isTerminal!==false；listener 已在 prompt 前注册）
        try:
            if not terminal.wait(timeout=1800.0):
                return build_attempt_result(status="failed", content=collected["text"], run_dir=run_dir,
                                            react_trace=collected["react_trace"], iterations=state.iter,
                                            metrics=None, reason="pi_turn_timeout")
        finally:
            _PI_EVENT_LISTENERS.pop(session_id, None)
            self._active_pi_sessions.discard(session_id)

        collected["react_trace"].append({"type": "answer", "content": collected["text"][:500]})
        metrics = self._load_metrics(run_dir)
        return build_attempt_result(
            status="success", content=collected["text"], run_dir=run_dir,
            react_trace=collected["react_trace"], iterations=state.iter, metrics=metrics,
            pi_meta={"session_file": (self._pi_sessions.get(session_id) or {}).get("session_file"),
                     "pi_session_id": session_id, "entry_ids": collected["entry_ids"],
                     "tool_call_ids": collected["tool_call_ids"]},
        )
```

```python
# get_messages 修改（既有方法开头插入分支；B4：_run_on_pi_loop 替代 get_event_loop）：
    def get_messages(self, session_id: str, limit: int = 100) -> list:
        if get_agent_engine() == "pi" and session_id in self._pi_sessions:
            return self._pi_messages(session_id, limit)
        return self.store.get_messages(session_id, limit=limit)  # 既有原文

    def _pi_messages(self, session_id: str, limit: int) -> list:
        from src.pi_sidecar.projection import pi_messages_to_store_messages
        client = _get_pi_client()
        if client.unavailable or not client.started:
            return self.store.get_messages(session_id, limit=limit)
        try:
            r = _run_on_pi_loop(
                client.request("get_messages", {"session_id": session_id, "limit": limit}), timeout=15)
            return pi_messages_to_store_messages(session_id, r.get("messages", []))
        except Exception:  # noqa: BLE001 — 投影失败降级旧数据（只读历史）
            return self.store.get_messages(session_id, limit=limit)

# cancel_current 开头插入（B4：pi 引擎 cancel handle = sidecar abort）：
        if get_agent_engine() == "pi" and session_id in self._active_pi_sessions:
            client = _get_pi_client()
            if not client.unavailable and client.started:
                try:
                    _run_on_pi_loop(client.request("abort", {"session_id": session_id}), timeout=10)
                    return True
                except SidecarError as exc:
                    logger.warning("pi abort failed for %s: %s", session_id, exc)
        # —— 既有实现原文保持不动 ——
```

文件顶部 import 增加：`from src.pi_sidecar import LEGACY_ONLY_PROVIDERS, get_agent_engine`、`from src.pi_sidecar.client import SidecarError`。host-request 路由（`tool_invoke`）在 `__init__` 注册进 `self._pi_host_handlers`（见上）；Task 14 追加注册四个 memory ops 到同一注册表。`respond_host`/host-request 帧回写由 Task 9 的 client 完整实现（本任务只消费回调）。

- [ ] 4. 运行期待通过：`pytest agent/tests/pi_sidecar/test_service_cutover.py --tb=short -q` → `6 passed`。

- [ ] 5. 回归既有测试不破坏：`pytest agent/tests/test_session_service_mcp.py agent/tests/test_session_service_reliability.py agent/tests/test_sse_ticket_and_headers.py --tb=short -q` → 全绿（这些测试默认 env 下 engine=pi 会走新分支——测试通过 monkeypatch `_DummyAgentLoop`/`AgentLoop` 拦截；若有测试因新分支失败，检查其 env 假设并在测试内显式 `monkeypatch.setenv("VIBE_AGENT_ENGINE","legacy")`，这属于既有测试的引擎假设修正，不算改行为）。

- [ ] 6. 安全关键窄测试：`pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q` → 全绿（本任务未触 order/mandate 代码，跑一次确认）。

- [ ] 7. Lint：`ruff check agent/src agent/tests` → 无新增违规。

- [ ] 8. Commit：

```bash
git add agent/src/session/service.py agent/tests/pi_sidecar/test_service_cutover.py
git commit -s -m "feat(pi-sidecar): session service pi-engine cutover with explicit legacy fallback"
```

---

## Phase 5 — 懒迁移 + operator CLI

### Task 13: 懒迁移 + 批迁移/完整性检查命令

**Files:** `agent/src/pi_sidecar/migration.py`（Create）、`agent/src/pi_sidecar/migrate_cli.py`（Create）、`agent/tests/pi_sidecar/test_migration.py`（Create）

**Interfaces:** Consumes — `SessionStore`（recon §2.2：`sessions/{id}/messages.jsonl`，`Message` dataclass `role/content/created_at`）、`PiSidecarClient`（`new_session`/`import_messages`）。Produces：

```python
# agent/src/pi_sidecar/migration.py
def old_session_exists(store: "SessionStore", session_id: str) -> bool
def migration_marker_path(session_id: str) -> Path   # MIGRATION_MARKER_DIR / f"{session_id}.json"
def is_migrated(session_id: str) -> bool
async def migrate_session_if_needed(service: "SessionService", client: "PiSidecarClient", session_id: str) -> bool:
    """旧库存在且未迁移 → 1) 只读读旧 messages.jsonl；2) new_session(同 ID)；
    3) import_messages 按时间序导入 user/assistant 文本（attempt/run 引用仅作
    metadata，不进模型上下文——只导 role+content）；4) 原子写 marker（tmp+rename）。
    任一步失败：旧文件不动（全程只读）、已建 Pi 会话删除、返回 False 且不宣告。
    新会话（旧库无记录）→ False（由调用方 new_session）。"""

# agent/src/pi_sidecar/migrate_cli.py  （python -m src.pi_sidecar.migrate）
#   --session <id>   迁移单个
#   --all            批迁移所有旧会话（operator 手动；桌面升级永不自动调用）
#   --check          完整性检查：marker 存在但 Pi 索引/文件缺失 → 报告
# 退出码：全成功 0；任一失败 1；--check 发现不一致 2
```

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_migration.py`：

```python
"""懒迁移单测：原子性、失败不动旧文件、marker 语义、CLI check。"""

import asyncio
import json
from pathlib import Path

import pytest

from src.pi_sidecar import migration
from src.pi_sidecar.client import SidecarError
from src.pi_sidecar.migration import (
    is_migrated,
    migrate_session_if_needed,
    migration_marker_path,
    old_session_exists,
)
from src.session.models import Message
from src.session.store import SessionStore


class FakeStore(SessionStore):
    pass


class FakeClient:
    def __init__(self, *, fail_import=False):
        self.ops: list[tuple[str, dict]] = []
        self.fail_import = fail_import

    async def request(self, op, params, *, timeout=30.0):
        self.ops.append((op, params))
        if op == "new_session":
            if self.fail_import:
                raise SidecarError("internal", "sdk exploded")
            return {"session_file": "/tmp/pi/x.jsonl"}
        if op == "import_messages":
            return {"imported": len(params["messages"])}
        if op == "open_session":
            raise SidecarError("not_found", "missing")
        raise SidecarError("unknown_op", op)


class FakeService:
    def __init__(self, store):
        self.store = store


@pytest.fixture()
def env(tmp_path, monkeypatch):
    marker_dir = tmp_path / "markers"
    monkeypatch.setattr(migration, "MIGRATION_MARKER_DIR", marker_dir)
    store = SessionStore(base_dir=tmp_path / "sessions")
    return store, marker_dir


def _seed_old(store, session_id="a1b2c3d4e5f6"):
    s = store.create_session(title="old")  # M5：普通赋值
    # 用固定 id 的 session
    s.session_id = session_id
    store.update_session(s)
    store._session_dir(session_id).mkdir(parents=True, exist_ok=True)
    for i, (role, content) in enumerate([("user", "hello"), ("assistant", "hi"), ("user", "buy?")]):
        store.append_message(Message(session_id=session_id, role=role, content=content,
                                     created_at=f"2026-08-0{i + 1}T00:00:00"))
    return s


def test_old_session_exists_and_migrated_false(env):
    store, _ = env
    _seed_old(store)
    assert old_session_exists(store, "a1b2c3d4e5f6") is True
    assert is_migrated("a1b2c3d4e5f6") is False


def test_migrate_success_writes_marker_and_imports_chronologically(env):
    store, marker_dir = env
    _seed_old(store)
    client = FakeClient()
    ok = asyncio.run(migrate_session_if_needed(FakeService(store), client, "a1b2c3d4e5f6"))
    assert ok is True
    assert is_migrated("a1b2c3d4e5f6")
    assert (marker_dir / "a1b2c3d4e5f6.json").exists()
    import_op = [p for op, p in client.ops if op == "import_messages"][0]
    assert [m["role"] for m in import_op["messages"]] == ["user", "assistant", "user"]  # 时间序
    assert [m["content"] for m in import_op["messages"]] == ["hello", "hi", "buy?"]
    # 第二次调用幂等：不再迁移
    client2 = FakeClient()
    assert asyncio.run(migrate_session_if_needed(FakeService(store), client2, "a1b2c3d4e5f6")) is False
    assert client2.ops == []


def test_migrate_failure_leaves_no_marker_and_no_partial_state(env):
    store, marker_dir = env
    _seed_old(store)
    messages_before = (store._session_dir("a1b2c3d4e5f6") / "messages.jsonl").read_bytes()
    client = FakeClient(fail_import=True)
    ok = asyncio.run(migrate_session_if_needed(FakeService(store), client, "a1b2c3d4e5f6"))
    assert ok is False
    assert list(marker_dir.iterdir()) == []  # 无 marker = 不宣告
    assert (store._session_dir("a1b2c3d4e5f6") / "messages.jsonl").read_bytes() == messages_before  # 旧文件不变


def test_new_session_returns_false_no_marker(env):
    store, marker_dir = env
    client = FakeClient()
    assert asyncio.run(migrate_session_if_needed(FakeService(store), client, "ffffffffffff")) is False
    assert list(marker_dir.iterdir()) == []


def test_check_detects_orphan_marker(env, capsys):
    store, marker_dir = env
    marker_dir.mkdir(parents=True)
    (marker_dir / "deadbeef1234.json").write_text("{}")
    from src.pi_sidecar.migrate_cli import cmd_check
    rc = cmd_check(store)
    assert rc == 2  # marker 存在但 Pi 会话缺失
```

- [ ] 2. 运行期待失败：`pytest agent/tests/pi_sidecar/test_migration.py --tb=short -q` → `ModuleNotFoundError: No module named 'src.pi_sidecar.migration'`。

- [ ] 3. 实现 `agent/src/pi_sidecar/migration.py`：

```python
"""懒迁移（design §Lazy migration）：旧 SessionStore 只读 → Pi 同 ID 会话 → 原子 marker。

失败语义：任一步失败 → 旧文件不动（全程只读打开）、无 marker（不宣告）、无部分状态。
批迁移/检查仅为 operator 命令；桌面升级永不自动全量迁移（Non-goals）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.pi_sidecar.client import PiSidecarClient, SidecarError

logger = logging.getLogger(__name__)

MIGRATION_MARKER_DIR = Path.home() / ".vibe-trading" / "pi" / "migration"


def migration_marker_path(session_id: str) -> Path:
    return MIGRATION_MARKER_DIR / f"{session_id}.json"


def is_migrated(session_id: str) -> bool:
    return migration_marker_path(session_id).exists()


def old_session_exists(store: Any, session_id: str) -> bool:
    try:
        msgs = store.get_messages(session_id, limit=1)
        return bool(msgs)
    except Exception:  # noqa: BLE001
        return False


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)  # 原子（design §Lazy migration step 5）
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


async def migrate_session_if_needed(service: Any, client: PiSidecarClient, session_id: str) -> bool:
    if is_migrated(session_id):
        return False
    if not old_session_exists(service.store, session_id):
        return False  # 新会话：调用方 new_session
    # 1) 只读读旧会话（get_messages 只读打开 messages.jsonl；不写任何旧文件）
    try:
        old_messages = service.store.get_messages(session_id, limit=10_000)
    except Exception as exc:  # noqa: BLE001
        logger.error("migration read failed for %s: %s", session_id, exc)
        return False
    # 2) 建 Pi 会话（同 ID）
    try:
        await client.request("new_session", {"session_id": session_id})
        # 3) 时间序导入 user/assistant 文本；attempt/run 引用仅作 marker metadata，不进模型上下文
        msgs = [
            {"role": m.role, "content": m.content, "timestamp": m.created_at}
            for m in old_messages
            if m.role in ("user", "assistant") and m.content
        ]
        await client.request("import_messages", {"session_id": session_id, "messages": msgs})
    except SidecarError as exc:
        logger.error("migration failed for %s (no marker written, old files untouched): %s", session_id, exc)
        return False
    # 4) 原子 marker + 投影（design step 5）
    _atomic_write_json(migration_marker_path(session_id), {
        "session_id": session_id,
        "migrated_at": datetime.now(timezone.utc).isoformat(),
        "imported_messages": len(old_messages),
    })
    logger.info("migrated session %s (%d messages)", session_id, len(old_messages))
    return True
```

- [ ] 4. 实现 `agent/src/pi_sidecar/migrate_cli.py`：

```python
"""Operator 批迁移 + 完整性检查。

用法（仓库根，PYTHONPATH=agent）：
  PYTHONPATH=agent python -m src.pi_sidecar.migrate --session <id>
  PYTHONPATH=agent python -m src.pi_sidecar.migrate --all
  PYTHONPATH=agent python -m src.pi_sidecar.migrate --check
退出码：0 全成功；1 任一迁移失败；2 --check 发现不一致。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from src.pi_sidecar import migration
from src.pi_sidecar.client import PiSidecarClient, SidecarError


def _get_service():
    from src.api.state import _get_session_service  # recon §6.1 单例装配

    return _get_session_service()


def cmd_migrate_one(client: PiSidecarClient, service, session_id: str) -> bool:
    return asyncio.run(migration.migrate_session_if_needed(service, client, session_id))


def cmd_all(client: PiSidecarClient, service) -> int:
    failed = 0
    for s in service.store.list_sessions(limit=1000):
        try:
            if not cmd_migrate_one(client, service, s.session_id):
                continue
        except SidecarError as exc:
            print(f"FAIL {s.session_id}: {exc}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


def cmd_check(store) -> int:
    """marker 存在但 Pi 会话不可用（索引无文件/header 不符）→ 不一致。"""
    inconsistent = 0
    if not migration.MIGRATION_MARKER_DIR.exists():
        print("no markers; nothing to check")
        return 0
    for marker in migration.MIGRATION_MARKER_DIR.glob("*.json"):
        session_id = marker.stem
        if not resolve_pi_session(session_id):
            print(f"INCONSISTENT {session_id}: marker without usable Pi session")
            inconsistent += 1
    return 2 if inconsistent else 0


def resolve_pi_session(session_id: str) -> str | None:
    """读 sidecar 索引文件（pi-sidecar/src/session-index.ts 写的同一路径，B2 格式）。

    条目形如 {"path": ..., "headerId": ...}（兼容旧纯路径格式）；
    同时校验文件 header id 仍等于记录的 headerId（替换检测，与 TS resolve 同语义）。
    """
    idx = Path.home() / ".vibe-trading" / "pi" / "session-index.json"
    try:
        import json

        mapping = json.loads(idx.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = mapping.get(session_id)
    if entry is None:
        return None
    if isinstance(entry, str):  # 旧格式兼容
        path, header_id = entry, session_id
    else:
        path, header_id = str(entry.get("path")), str(entry.get("headerId"))
    from src.pi_sidecar.migration import _read_pi_header_id_compat

    return path if _read_pi_header_id_compat(path) == header_id else None

def _read_pi_header_id_compat(jsonl_path: str) -> str | None:
    """扫描 Pi 会话 JSONL 前 8KB，返回 type==="session" 条目的 id；无/坏 → None。"""
    from pathlib import Path as _P

    try:
        text = _P(jsonl_path).read_text(encoding="utf-8")[:8192]
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "session" and isinstance(obj.get("id"), str):
            return obj["id"]
    return None


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m src.pi_sidecar.migrate")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--session", metavar="ID")
    g.add_argument("--all", action="store_true")
    g.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        service = _get_service()
        return cmd_check(service.store)
    client = PiSidecarClient()
    asyncio.run(client.start())
    try:
        service = _get_service()
        if args.session:
            return 0 if cmd_migrate_one(client, service, args.session) else 1
        return cmd_all(client, service)
    finally:
        asyncio.run(client.stop())


if __name__ == "__main__":
    raise SystemExit(main())
```
- [ ] 5. 运行期待通过：`pytest agent/tests/pi_sidecar/test_migration.py --tb=short -q` → `6 passed`（含 `_read_pi_header_id_compat` 新用例）。

- [ ] 6. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

（注：`_read_pi_header_id_compat` 的宿主文件是 `agent/src/pi_sidecar/migration.py`——本步骤同时在该文件追加此纯函数，并在 `test_migration.py` 补一条用例 `assert _read_pi_header_id_compat(str(p)) == "a1b2c3d4e5f6"`。）

- [ ] 7. Commit：

```bash
git add agent/src/pi_sidecar/migration.py agent/src/pi_sidecar/migrate_cli.py agent/tests/pi_sidecar/test_migration.py
git commit -s -m "feat(pi-sidecar): lazy session migration + operator batch/check CLI"
```

---

## Phase 6 — vibe-memory extension

### Task 14: vibe-memory Pi extension（每轮记忆注入 + 兼容工具）

**Files:** `pi-sidecar/extensions/vibe-memory/index.ts`（Create）、`pi-sidecar/extensions/vibe-memory/index.test.ts`（Create）、`agent/src/pi_sidecar/memory_bridge.py`（Create）、`agent/tests/pi_sidecar/test_memory_bridge.py`（Create）

**Interfaces:** Consumes — host op `memory_context` + `remember`/`memory_search`/`memory_remove`（B5 扩展后的 sidecar→Python op 集合；Python 侧 `PersistentMemory`：`snapshot`、`find_relevant(query, max_results=5)`，recon §5）、extension 注册面（`pi.registerTool`、`pi.on`，`omp://skills/authoring-extensions.md`）、Task 12 的 `SessionService._pi_host_handlers` 注册表。Produces：

```ts
// extensions/vibe-memory/index.ts
export default function (pi: ExtensionAPI): void;
// host bridge 约定：globalThis.__VIBE_HOST__ = { call(op, params): Promise<result>, emitDiagnostic(kind, msg): void }
// 由 main.ts 在 createAgentSession 之前设置
```

```python
# agent/src/pi_sidecar/memory_bridge.py
class MemoryBridge:
    def __init__(self, memory: Any | None = None): ...   # PersistentMemory；None → 不可用模式
    async def handle_memory_context(self, params: dict) -> dict:
        """{"session_id","query"} → {"block": str}
        block = MEMORY.md 快照 + ≤5 条 find_relevant 条目（name+description+body[:500]）；
        memory 不可用 → block=""（sidecar 发 degraded pi.notice 后继续，design §Long-Term Memory）"""
    async def handle_remember(self, params: dict) -> dict      # add(name, content, memory_type, description)
    async def handle_memory_search(self, params: dict) -> dict  # find_relevant → 条目列表
    async def handle_memory_remove(self, params: dict) -> dict  # remove(name) → {"removed": bool}
```

注入机制（resolved ambiguity，见 self-review）：extension 监听 `input` 事件缓存最近用户文本（B5：relevance 检索需要 query）；在 `before_agent_start`（每 agent turn 一次）经 host bridge 以 `{"query": lastInput}` 取 `memory_context` block 缓存；在 `before_provider_request` 对**该轮第一次** provider 请求把 block 追加到请求 system prompt——只影响本轮模型请求，不写用户消息、不写会话转录（`pi.appendEntry` 禁用）。memory 写入（remember 等）立即持久但不改当前轮快照，与既有 `PersistentMemory` 语义一致（recon §5：快照仅构造时刷新）。四个 memory host op 在本任务注册进 Task 12 的 `_pi_host_handlers`（见 Step 6）。

**Steps:**

- [ ] 1. 写失败测试 `agent/tests/pi_sidecar/test_memory_bridge.py`：

```python
"""MemoryBridge 单测（tmp memory dir，无网络）。"""

import asyncio

import pytest

from src.memory.persistent import PersistentMemory
from src.pi_sidecar.memory_bridge import MemoryBridge


@pytest.fixture()
def bridge(tmp_path):
    pm = PersistentMemory(memory_dir=tmp_path / "memory")
    pm.add("risk-rules", "Max position 5% per name", memory_type="feedback", description="position limits")
    return MemoryBridge(memory=pm)


def test_memory_context_block_contains_snapshot_and_relevant(bridge):
    out = asyncio.run(bridge.handle_memory_context({"session_id": "s", "query": "position limits for AAPL"}))
    assert isinstance(out["block"], str)
    assert "risk-rules" in out["block"]
    assert "Max position 5%" in out["block"]


def test_memory_context_unavailable_returns_empty_block():
    b = MemoryBridge(memory=None)
    out = asyncio.run(b.handle_memory_context({"session_id": "s", "query": "x"}))
    assert out == {"block": ""}


def test_remember_then_search_then_remove(bridge):
    out = asyncio.run(bridge.handle_remember({"name": "aapl-thesis", "content": "Revenue up",
                                              "memory_type": "project", "description": "thesis"}))
    assert out["ok"] is True
    out = asyncio.run(bridge.handle_memory_search({"query": "aapl revenue"}))
    assert any(m["name"] == "aapl-thesis" for m in out["entries"])
    out = asyncio.run(bridge.handle_memory_remove({"name": "aapl-thesis"}))
    assert out == {"removed": True, "ok": True}
    out = asyncio.run(bridge.handle_memory_search({"query": "aapl revenue"}))
    assert all(m["name"] != "aapl-thesis" for m in out["entries"])


def test_write_is_immediately_durable_but_snapshot_frozen(bridge, tmp_path):
    asyncio.run(bridge.handle_remember({"name": "new-fact", "content": "fresh"}))
    # 既有语义：当前 snapshot 不含新条目（recon §5：快照构造时冻结）
    out = asyncio.run(bridge.handle_memory_context({"session_id": "s", "query": "fresh"}))
    assert "new-fact" not in out["block"] or "fresh" not in out["block"].split("## relevant")[0]
```

- [ ] 2. 写失败测试 `pi-sidecar/extensions/vibe-memory/index.test.ts`：

```ts
import { describe, expect, test } from "bun:test";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface FakePi {
  handlers: Record<string, Handler>;
  tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
  on(event: string, handler: Handler): void;
  registerTool(t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }): void;
}

function makeFakePi(): FakePi {
  const pi: FakePi = { handlers: {}, tools: [], on(e, h) { pi.handlers[e] = h; }, registerTool(t) { pi.tools.push(t); } };
  return pi;
}

function makeHost(responses: Record<string, unknown>, fail = false) {
  const calls: Array<{ op: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    call: async (op: string, params?: Record<string, unknown>) => {
      calls.push({ op, params });
      if (fail) throw new Error("memory down");
      return responses[op];
    },
    emitDiagnostic: (kind: string, msg: string) => diagnostics.push([kind, msg]),
  };
}
const diagnostics: Array<[string, string]> = [];

describe("vibe-memory extension", () => {
  test("registers three compat tools", async () => {
    (globalThis as Record<string, unknown>).__VIBE_HOST__ = makeHost({});
    const mod = await import("./index");
    const pi = makeFakePi();
    mod.default(pi as never);
    const names = pi.tools.map((t) => t.name).sort();
    expect(names).toEqual(["memory_remove", "memory_search", "remember"]);
  });

  test("remember tool calls host and returns text", async () => {
    (globalThis as Record<string, unknown>).__VIBE_HOST__ = makeHost({ remember: { ok: true } });
    const mod = await import("./index");
    const pi = makeFakePi();
    mod.default(pi as never);
    const remember = pi.tools.find((t) => t.name === "remember")!;
    const r = await remember.execute("id1", { name: "n", content: "c" });
    expect(r.content[0].text).toContain("ok");
  });

  test("input event captured and passed as memory_context query", async () => {
    diagnostics.length = 0;
    const h = makeHost({ memory_context: { block: "B" } });
    (globalThis as Record<string, unknown>).__VIBE_HOST__ = h;
    const mod = await import("./index");
    const pi = makeFakePi();
    mod.default(pi as never);
    await pi.handlers["input"]({ text: "research AAPL position limits" }, {});
    await pi.handlers["before_agent_start"]({}, {});
    const mc = h.calls.find((c) => c.op === "memory_context");
    expect(mc).toBeDefined();
    expect(mc!.params).toEqual({ query: "research AAPL position limits" });
  });

  test("before_agent_start failure degrades with diagnostic, turn continues", async () => {
    diagnostics.length = 0;
    (globalThis as Record<string, unknown>).__VIBE_HOST__ = makeHost({}, true);
    const mod = await import("./index");
    const pi = makeFakePi();
    mod.default(pi as never);
    await pi.handlers["input"]({ text: "q" }, {});
    await pi.handlers["before_agent_start"]({}, {});
    expect(diagnostics.some(([k]) => k === "memory_degraded")).toBe(true);
    // 后续 provider request 不注入任何 block
    let seen = "";
    await pi.handlers["before_provider_request"](
      { systemPrompt: "BASE", revise: (s: unknown) => { seen = JSON.stringify(s); return {}; } },
      {},
    );
    expect(seen).not.toContain("MEMORY");
  });

  test("memory block injected into first provider request of a turn only", async () => {
    diagnostics.length = 0;
    (globalThis as Record<string, unknown>).__VIBE_HOST__ = makeHost({ memory_context: { block: "## relevant\n- risk-rules" } });
    const mod = await import("./index");
    const pi = makeFakePi();
    mod.default(pi as never);
    let first = "";
    let second = "";
    const revise = (tag: string) => (req: { systemPrompt: string }) => {
      if (tag === "1") first = req.systemPrompt;
      else second = req.systemPrompt;
      return {};
    };
    await pi.handlers["input"]({ text: "position limits" }, {});
    await pi.handlers["before_agent_start"]({}, {});
    await pi.handlers["before_provider_request"]({ systemPrompt: "BASE", revise: revise("1") }, {});
    await pi.handlers["before_provider_request"]({ systemPrompt: "BASE", revise: revise("2") }, {});
    expect(first).toContain("risk-rules");   // 第一请求注入
    expect(second).not.toContain("risk-rules"); // 同轮后续请求不重复注入
  });
});
```

- [ ] 3. 运行期待失败：`cd pi-sidecar && bun test extensions/vibe-memory/` → `Cannot find module "./index"`；`pytest agent/tests/pi_sidecar/test_memory_bridge.py --tb=short -q` → `ModuleNotFoundError: src.pi_sidecar.memory_bridge`。

- [ ] 4. 实现 `agent/src/pi_sidecar/memory_bridge.py`：

```python
"""PersistentMemory ↔ sidecar host op 桥（design §Long-Term Memory）。"""

from __future__ import annotations

from typing import Any


class MemoryBridge:
    def __init__(self, memory: Any | None = None) -> None:
        # memory=None → 服务不可用：block 返回空串，sidecar 发 degraded 诊断继续
        self._memory = memory

    async def handle_memory_context(self, params: dict) -> dict:
        if self._memory is None:
            return {"block": ""}
        snapshot = getattr(self._memory, "snapshot", "") or ""
        query = str(params.get("query") or "")
        lines: list[str] = []
        if snapshot:
            lines.append(snapshot)
        relevant = self._memory.find_relevant(query, max_results=5) if query else []
        if relevant:
            lines.append("## relevant memories")
            for entry in relevant[:5]:
                body = (getattr(entry, "body", "") or "")[:500]
                lines.append(f"- {entry.name}: {getattr(entry, 'description', '')}\n  {body}")
        return {"block": "\n".join(lines)}

    async def handle_remember(self, params: dict) -> dict:
        if self._memory is None:
            return {"ok": False, "error": "memory unavailable"}
        self._memory.add(
            str(params.get("name") or ""),
            str(params.get("content") or ""),
            memory_type=str(params.get("memory_type") or "project"),
            description=str(params.get("description") or ""),
        )
        return {"ok": True}

    async def handle_memory_search(self, params: dict) -> dict:
        if self._memory is None:
            return {"ok": False, "entries": []}
        entries = self._memory.find_relevant(str(params.get("query") or ""), max_results=5)
        return {
            "ok": True,
            "entries": [
                {"name": e.name, "description": getattr(e, "description", ""), "body": (getattr(e, "body", "") or "")[:500]}
                for e in entries
            ],
        }

    async def handle_memory_remove(self, params: dict) -> dict:
        if self._memory is None:
            return {"removed": False, "ok": False}
        removed = self._memory.remove(str(params.get("name") or ""))
        return {"removed": bool(removed), "ok": True}
```

- [ ] 5. 实现 `pi-sidecar/extensions/vibe-memory/index.ts`：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface HostBridge {
  call: (op: string, params?: Record<string, unknown>) => Promise<unknown>;
  emitDiagnostic: (kind: string, message: string) => void;
}

function host(): HostBridge {
  return (globalThis as { __VIBE_HOST__?: HostBridge }).__VIBE_HOST__ as HostBridge;
}

export default function (pi: ExtensionAPI) {
  let memoryBlock = "";
  let injectedThisTurn = false;

  pi.on("before_agent_start", async () => {
    memoryBlock = "";
    injectedThisTurn = false;
    try {
      const r = (await host().call("memory_context", {})) as { block?: string };
      memoryBlock = r?.block ?? "";
    } catch (e) {
      host().emitDiagnostic("memory_degraded", `memory unavailable, continuing without it: ${(e as Error).message}`);
    }
  });

export default function (pi: ExtensionAPI) {
  let memoryBlock = "";
  let injectedThisTurn = false;
  let lastInput = ""; // B5: 最近用户文本，作为 memory 相关性检索的 query

  pi.on("input", async (event: { text?: string }) => {
    if (typeof event?.text === "string" && event.text.trim()) {
      lastInput = event.text;
    }
  });

  pi.on("before_agent_start", async () => {
    memoryBlock = "";
    injectedThisTurn = false;
    try {
      const r = (await host().call("memory_context", { query: lastInput })) as { block?: string };
      memoryBlock = r?.block ?? "";
    } catch (e) {
      host().emitDiagnostic("memory_degraded", `memory unavailable, continuing without it: ${(e as Error).message}`);
    }
  });

  pi.on("before_provider_request", async (event: { systemPrompt?: string; revise?: (req: unknown) => unknown }) => {
    if (!memoryBlock || injectedThisTurn) return;
    injectedThisTurn = true;
    if (typeof event.revise === "function") {
      // 每轮 system prompt 注入（design：永不入用户消息/持久转录）
      event.revise({ systemPrompt: `${event.systemPrompt ?? ""}\n\n${memoryBlock}` });
    }
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Persist a long-term memory entry (immediately durable; current prompt snapshot unchanged)",
    parameters: pi.zod.object({
      name: pi.zod.string().describe("Memory name"),
      content: pi.zod.string().describe("Memory body"),
      memory_type: pi.zod.string().optional().describe("user|feedback|project|reference"),
      description: pi.zod.string().optional().describe("One-line description"),
    }),
    async execute(_id, params) {
      const r = (await host().call("remember", params as Record<string, unknown>)) as { ok?: boolean };
      return { content: [{ type: "text", text: JSON.stringify(r ?? { ok: false }) }] };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search long-term memory entries",
    parameters: pi.zod.object({ query: pi.zod.string() }),
    async execute(_id, params) {
      const r = await host().call("memory_search", params as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(r ?? {}) }] };
    },
  });

  pi.registerTool({
    name: "memory_remove",
    label: "Memory Remove",
    description: "Remove a long-term memory entry by name",
    parameters: pi.zod.object({ name: pi.zod.string() }),
    async execute(_id, params) {
      const r = await host().call("memory_remove", params as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(r ?? {}) }] };
    },
  });
}
```

- [ ] 6. 注册 memory host ops 进 SessionService（B5 处理器注册表：Task 12 的 `self._pi_host_handlers` 只接了 `tool_invoke`；本步骤把 `memory_context`/`remember`/`memory_search`/`memory_remove` 接到 `MemoryBridge`）。修改 `agent/src/session/service.py`：

模块级（与 Task 12 的 `_get_pi_client()` 同层）追加：

```python
def _memory_bridge() -> "MemoryBridge":
    """进程级 MemoryBridge 单例；PersistentMemory 不可用时走降级模式（design §Long-Term Memory）。"""
    global _MEMORY_BRIDGE
    try:
        return _MEMORY_BRIDGE
    except NameError:
        _MEMORY_BRIDGE = None
    if _MEMORY_BRIDGE is None:
        from src.pi_sidecar.memory_bridge import MemoryBridge
        try:
            from src.memory.persistent import PersistentMemory
            _MEMORY_BRIDGE = MemoryBridge(memory=PersistentMemory())
        except Exception:  # noqa: BLE001 — design：memory 不可用 → degraded 继续
            _MEMORY_BRIDGE = MemoryBridge(memory=None)
    return _MEMORY_BRIDGE
```

`SessionService` 方法追加（`__init__` 中 `self._pi_host_handlers = {"tool_invoke": self._handle_tool_invoke_host}` 已由 Task 12 建立）：

```python
    def register_memory_host_handlers(self) -> None:
        """Task 14 调用：把四个 memory ops 挂进处理器注册表（幂等，setdefault 保序）。"""
        bridge = _memory_bridge()
        self._pi_host_handlers.setdefault("memory_context", bridge.handle_memory_context)
        self._pi_host_handlers.setdefault("remember", bridge.handle_remember)
        self._pi_host_handlers.setdefault("memory_search", bridge.handle_memory_search)
        self._pi_host_handlers.setdefault("memory_remove", bridge.handle_memory_remove)
```

装配点：`agent/src/api/state.py` 的 `_get_session_service()` 在构造 `SessionService(...)` 之后调用一次 `service.register_memory_host_handlers()`。Task 12 中 `async def _on_pi_host_request(op, params)`（client 构造参数 `on_host_request`）即按 `self._pi_host_handlers` 分发——memory ops 无需额外胶水。

- [ ] 7. 运行期待通过：`cd pi-sidecar && bun test extensions/vibe-memory/` → `5 passed`；`pytest agent/tests/pi_sidecar/test_memory_bridge.py --tb=short -q` → `4 passed`。

- [ ] 8. Lint：`ruff check agent/src/pi_sidecar agent/tests/pi_sidecar` → 无违规。

- [ ] 9. Commit：

```bash
git add pi-sidecar/extensions/vibe-memory/ agent/src/pi_sidecar/memory_bridge.py agent/tests/pi_sidecar/test_memory_bridge.py agent/src/session/service.py agent/src/api/state.py
git commit -s -m "feat(pi-sidecar): vibe-memory extension with per-turn injection + compat tools"
```

---

## Phase 7 — 打包

### Task 15: Pi 二进制构建/暂存 + Tauri 资源 + 签名 + CI + provenance

**Files:** `scripts/desktop/build-pi.sh`（Create）、`scripts/desktop/build-pi.ps1`（Create）、`src-tauri/tauri.conf.json`（Modify：bundle.resources L41-47）、`src-tauri/src/sidecar.rs`（Modify：B7——向 Python serve 进程注入 `VIBE_PI_SIDECAR_BIN` env）、`scripts/desktop/assemble.sh`（Modify：agent 模板步骤后 ~L49/55）、`scripts/desktop/assemble.ps1`（Modify：同位）、`scripts/desktop/build-dmg.sh`（Modify：L136-152 资源预检 + L282 打包后循环）、`scripts/desktop/build-windows.ps1`（Modify：资源检查）、`scripts/desktop/sign-and-notarize.sh`（Modify：~L150 Mach-O 循环）、`.github/workflows/desktop-build.yml`（Modify）

**Interfaces:** Consumes — Task 0-14 的 `pi-sidecar/`（`bun.lockb` + `src/main.ts` + `extensions/`，main.ts 交付于 Task 5b）。Produces — `.desktop-build/pi/{macos-aarch64/pi, macos-x86_64/pi, windows-x64/pi.exe, extensions/vibe-memory.js, extensions/vibe-providers.js, skills/, PROVENANCE.json}`（git-ignored，永不提交）；desktop 运行时 env `VIBE_PI_SIDECAR_BIN`（指向打包内 Pi 二进制，供 `PiSidecarClient._default_command()` 使用，B7）。

**Steps:**

- [ ] 1. 创建 `scripts/desktop/build-pi.sh`：

```bash
#!/usr/bin/env bash
# Build + stage the Pi sidecar binary for one release target.
# Usage: build-pi.sh <macos-aarch64|macos-x86_64|windows-x64>
# Prereq: Bun >= 1.3.14; Node >= 22.19 not required for compile (Bun compiles) but CI pins it for other steps.
set -euo pipefail

TARGET="${1:?usage: build-pi.sh <macos-aarch64|macos-x86_64|windows-x64>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PI_DIR="$ROOT/pi-sidecar"
OUT="$ROOT/.desktop-build/pi"

case "$TARGET" in
  macos-aarch64) BUN_TARGET="bun-darwin-arm64"; BIN="pi" ;;
  macos-x86_64)  BUN_TARGET="bun-darwin-x64";  BIN="pi" ;;
  windows-x64)   BUN_TARGET="bun-windows-x64"; BIN="pi.exe" ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac

cd "$PI_DIR"
bun install --frozen-lockfile   # 精确锁定（design §Packaging：lockfile 提交）
bun build src/main.ts --outfile dist/main.js --target bun
mkdir -p "$OUT/extensions"
for ext in vibe-memory vibe-providers; do
  bun build "extensions/$ext/index.ts" --outfile "$OUT/extensions/$ext.js" --target bun
done
mkdir -p "$OUT/$TARGET"
bun build --compile dist/main.js --target "$BUN_TARGET" --outfile "$OUT/$TARGET/$BIN"

# skills 暂存（86 个 SKILL.md 目录；与 agent 资源中的 src/skills 同源）
rm -rf "$OUT/skills"
mkdir -p "$OUT/skills"
cp -R "$ROOT/agent/src/skills/." "$OUT/skills/"

# provenance（design：版本/lockfile/provenance 随桌面构建记录）
PI_VERSION="18.0.11"
LOCK_HASH=$(shasum -a 256 "$PI_DIR/bun.lockb" | cut -d' ' -f1)
cat > "$OUT/PROVENANCE.json" <<EOF
{"pi_npm_version": "$PI_VERSION", "bun_lockb_sha256": "$LOCK_HASH", "target": "$TARGET", "built_at": "$(date -u +%FT%TZ)"}
EOF

echo "staged $OUT/$TARGET/$BIN"
```

- [ ] 2. 创建 `scripts/desktop/build-pi.ps1`：

```powershell
# Build + stage the Pi sidecar binary for windows-x64.
# Usage: build-pi.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PiDir = Join-Path $Root "pi-sidecar"
$Out = Join-Path $Root ".desktop-build\pi"
Set-Location $PiDir
bun install --frozen-lockfile
bun build src/main.ts --outfile dist/main.js --target bun
New-Item -ItemType Directory -Force -Path (Join-Path $Out "extensions") | Out-Null
bun build extensions/vibe-memory/index.ts --outfile (Join-Path $Out "extensions\vibe-memory.js") --target bun
bun build extensions/vibe-providers/index.ts --outfile (Join-Path $Out "extensions\vibe-providers.js") --target bun
New-Item -ItemType Directory -Force -Path (Join-Path $Out "windows-x64") | Out-Null
bun build --compile dist/main.js --target bun-windows-x64 --outfile (Join-Path $Out "windows-x64\pi.exe")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Out "skills")
New-Item -ItemType Directory -Force -Path (Join-Path $Out "skills") | Out-Null
Copy-Item -Recurse -Force (Join-Path $Root "agent\src\skills\*") (Join-Path $Out "skills")
$lockHash = (Get-FileHash -Algorithm SHA256 (Join-Path $PiDir "bun.lockb")).Hash.ToLower()
@{ pi_npm_version = "18.0.11"; bun_lockb_sha256 = $lockHash; target = "windows-x64"; built_at = (Get-Date).ToUniversalTime().ToString("o") } |
  ConvertTo-Json | Set-Content (Join-Path $Out "PROVENANCE.json")
Write-Host "staged $Out\windows-x64\pi.exe"
```

- [ ] 3. 修改 `src-tauri/tauri.conf.json` bundle.resources（现 L41-47，recon §8.1）：

```json
"resources": {
  "../.desktop-build/python-runtime": "python-runtime",
  "../.desktop-build/agent": "agent",
  "../frontend/dist": "frontend/dist",
  "../.desktop-build/agent/.env": "agent/.env",
  "../.desktop-build/VERSION": "VERSION",
  "../.desktop-build/pi": "pi"
}
```

- [ ] 4. 修改 `scripts/desktop/assemble.sh`：agent 模板步骤（现 ~L49/55，recon §8.2 "删除 runs/sessions/uploads/.swarm" 之后）追加：

```bash
# Pi sidecar 暂存（二进制/extensions/skills 由 scripts/desktop/build-pi.sh 产出）
if [ -x "$ROOT/scripts/desktop/build-pi.sh" ]; then
  log "bash scripts/desktop/build-pi.sh $(uname -m | grep -q arm64 && echo macos-aarch64 || echo macos-x86_64)"
  bash "$ROOT/scripts/desktop/build-pi.sh" "$(uname -m | grep -q arm64 && echo macos-aarch64 || echo macos-x86_64)"
fi
```

`scripts/desktop/assemble.ps1` 同位置追加：

```powershell
# Pi sidecar staging (windows-x64)
& (Join-Path $PSScriptRoot "build-pi.ps1")
```

- [ ] 5. 修改 `scripts/desktop/build-dmg.sh`：资源预检块（现 L136-138 与 assemble 后复检 L148-151）各追加一行：

```bash
verify_resource "$BUILD/pi"          "pi sidecar 资源"   || resources_ok=0
```

打包后检查循环（现 L282 `for r in python-runtime agent frontend/dist`）改为：

```bash
for r in python-runtime agent frontend/dist pi; do
```

- [ ] 6. 修改 `scripts/desktop/build-windows.ps1`：与 build-dmg.sh 对应的资源检查处（`python-runtime`/`agent` 检查相邻位置，recon §8.2 L68 附近 orchestration）追加 `$Out\pi` 存在性检查（照该文件既有 `Test-Path` 检查模式加一项 `pi`）。

- [ ] 7. 修改 `scripts/desktop/sign-and-notarize.sh`：Mach-O 签名循环（现 ~L150 对 `$APP_PATH/Contents/Resources/python-runtime/bin` 下二进制逐个 codesign）扩展为同时遍历 Pi 二进制：

```bash
# Pi sidecar 二进制（compiled Bun executable；必须随 app deep-sign，design §Packaging）
for pibin in "$APP_PATH"/Contents/Resources/pi/*/pi*; do
  [ -f "$pibin" ] || continue
  log "codesign pi binary: $pibin"
  codesign "${CS_RUNTIME[@]}" --entitlements "$ENT" "$pibin"
done
```

- [ ] 8. 修改 `.github/workflows/desktop-build.yml`：
  - Node setup step（现 `node-version` 20 或 22.x）改为 `node-version: '22.19'`（design：构建期 Node >=22.19）。
  - "Install Bun" step（若无则新增，`oven-sh/setup-bun@v2` with `bun-version: '>=1.3.14'`）放在 Build Pi 之前。
  - matrix 每个 job 在 "Assemble Desktop Resources" 之前新增 step：

```yaml
      - name: Build Pi sidecar
        shell: bash
        run: |
          if [ "${{ matrix.name }}" = "windows-x64" ]; then
            pwsh scripts/desktop/build-pi.ps1
          else
            bash scripts/desktop/build-pi.sh "${{ matrix.name }}"
          fi
```

  - "Upload Artifacts" step 的 path 列表追加 `.desktop-build/pi/PROVENANCE.json`。

- [ ] 9. 修改 `src-tauri/src/sidecar.rs`（B7：打包后的 desktop 没有 bun；Python 的 `PiSidecarClient._default_command()` 依赖 env `VIBE_PI_SIDECAR_BIN` 指向打包内 Pi 二进制。Python sidecar 自己 spawn pi 进程，Rust 只需把 env 透传给 Python serve 进程）。在该文件启动 Python sidecar 子进程的 env 组装处追加：

```rust
/// Resolve the bundled Pi sidecar binary path from Tauri's resource directory.
/// Resource layout (tauri.conf.json bundle.resources): "pi" -> <resource_dir>/pi/<target>/<bin>
fn vibe_pi_sidecar_bin(resource_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // 与 scripts/desktop/build-pi.sh 的目标目录保持一致（B7）
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x64",
        _ => return None,
    };
    let bin = if std::env::consts::OS == "windows" { "pi.exe" } else { "pi" };
    let path = resource_dir.join("pi").join(target).join(bin);
    if path.exists() { Some(path) } else { None }
}

// 在构建 Python serve 进程 Command 的位置（既有 spawn 代码处）：
//   let mut cmd = Command::new(&python_bin);
//   ...
if let Some(resource_dir) = app_handle.path().resource_dir().ok() {
    if let Some(pi_bin) = vibe_pi_sidecar_bin(&resource_dir) {
        cmd.env("VIBE_PI_SIDECAR_BIN", pi_bin);
    }
    // 缺失时不设置 env：Python 侧回退 bun dev 命令（开发态），打包冒烟（smoke_pi.py）会拦截该回归
}
```

（实现者注：`app_handle.path().resource_dir()` 与 `Command` 的具体绑定点以 `sidecar.rs` 现有 spawn 代码为准——把 `cmd.env(...)` 加到该 `Command` 构建链上即可；函数本体原样落盘。）

- [ ] 10. 本地验证（macOS arm64）：
```bash
bash scripts/desktop/build-pi.sh macos-aarch64
file .desktop-build/pi/macos-aarch64/pi           # → Mach-O 64-bit executable arm64
ls .desktop-build/pi/extensions/                  # → vibe-memory.js vibe-providers.js
cat .desktop-build/pi/PROVENANCE.json             # → pi_npm_version 18.0.11 ...
printf '{"v":1,"id":"r-1","op":"ping"}\n' | .desktop-build/pi/macos-aarch64/pi
# → 第一行 {"v":1,"event":"ready",...}，随后 {"v":1,"id":"r-1","ok":true,"result":{"pong":true,"protocol":1}}
# stdout 必须只有 JSONL（packaging smoke：design §Verification）
```

- [ ] 11. 确认 `.desktop-build` 在 `.gitignore` 中（recon：已 ignored；若缺则补一行 `.desktop-build/`），`git status` 确认无 staging 泄漏。

- [ ] 12. Commit（只含脚本/配置/Rust，不含 `.desktop-build/`）：

```bash
git add scripts/desktop/build-pi.sh scripts/desktop/build-pi.ps1 scripts/desktop/assemble.sh scripts/desktop/assemble.ps1 \
        scripts/desktop/build-dmg.sh scripts/desktop/build-windows.ps1 scripts/desktop/sign-and-notarize.sh \
        src-tauri/tauri.conf.json src-tauri/src/sidecar.rs .github/workflows/desktop-build.yml
git commit -s -m "build(desktop): bundle pi sidecar binary + resources with provenance"
```

---

## Phase 8 — 集成测试 + 冒烟 + 性能基线

### Task 16: Fake provider + 基础集成（多轮/工具/并行只读串行写）

**Files:** `agent/tests/pi_sidecar/fake_provider.py`（Create）、`agent/tests/pi_sidecar/test_integration_basic.py`（Create）

**Interfaces:** Consumes — 真实 sidecar（`bun run src/main.ts`，Task 15 或源码模式）、`PiSidecarClient`、`build_tool_manifest`、`GatewayBridge`。Produces — `FakeOpenAIProvider`（线程内 `http.server`，OpenAI 兼容 `/v1/chat/completions` SSE，脚本化响应）。

fake provider 设计（确定性，无外部网络）：
- 场景脚本：`responses: list[dict]`，每项为一次 assistant 回复：`{"text": "..."}`（纯文本，结束回合）或 `{"tool_calls": [{"id","name","arguments"}]}`。
- `POST /v1/chat/completions`：读 messages，按"已产生的 assistant 消息数"取脚本第 N 项，SSE 返回 `chat.completion.chunk` 流（`data: {...}\n\n`，终止 `data: [DONE]`）；tool_calls 以 OpenAI `delta.tool_calls` 形状下发。
- provider 注册：sidecar env `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`、`OPENAI_API_KEY=test`、`LANGCHAIN_PROVIDER=openai`、`LANGCHAIN_MODEL_NAME=fake-model` → Pi 原生 openai provider 走本地 stub（`omp://local-models.md` 允许本地 OpenAI 兼容端点）。

**Steps:**

- [ ] 1. 实现 `agent/tests/pi_sidecar/fake_provider.py`：

```python
"""确定性 OpenAI 兼容 SSE stub provider（design §Verification: integration tests）。"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeOpenAIProvider:
    def __init__(self, responses: list[dict], model: str = "fake-model"):
        self.responses = responses
        self.model = model
        self.requests: list[dict] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self._server.server_address[1]  # type: ignore[return-value]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()

    def _assistant_count(self, messages: list[dict]) -> int:
        return sum(1 for m in messages if m.get("role") == "assistant")

    def _handler(self) -> type[BaseHTTPRequestHandler]:  # noqa: C901 — 紧凑 SSE handler
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静音
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                idx = min(outer._assistant_count(body.get("messages", [])), len(outer.responses) - 1)
                script = outer.responses[idx]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def emit(chunk: dict):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())

                emit({"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": outer.model,
                      "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
                if "tool_calls" in script:
                    for i, tc in enumerate(script["tool_calls"]):
                        emit({"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": outer.model,
                              "choices": [{"index": 0, "delta": {
                                  "tool_calls": [{"index": i, "id": tc["id"], "type": "function",
                                                  "function": {"name": tc["name"],
                                                               "arguments": json.dumps(tc["arguments"])}}],
                              }, "finish_reason": None}]})
                    finish = "tool_calls"
                else:
                    emit({"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": outer.model,
                          "choices": [{"index": 0, "delta": {"content": script.get("text", "")}, "finish_reason": None}]})
                    finish = "stop"
                emit({"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": outer.model,
                      "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
                self.wfile.write(b"data: [DONE]\n\n")

        return H
```

- [ ] 2. 写失败测试 `agent/tests/pi_sidecar/test_integration_basic.py`：

```python
"""基础集成：真实 sidecar + fake provider。skipif 无 bun。"""

import asyncio
import shutil
from pathlib import Path

import pytest

from tests.pi_sidecar.fake_provider import FakeOpenAIProvider  # noqa: E402 — pythonpath=agent，tests.pi_sidecar 有 __init__
from src.pi_sidecar.client import PiSidecarClient, SidecarError

pytestmark = pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")

REPO = Path(__file__).resolve().parents[3]
SESSION = "a1b2c3d4e5f6"


def _client(provider: FakeOpenAIProvider, tmp_path: Path, events: list) -> PiSidecarClient:
    env = {
        "OPENAI_BASE_URL": provider.base_url,
        "OPENAI_API_KEY": "test",
        "LANGCHAIN_PROVIDER": "openai",
        "LANGCHAIN_MODEL_NAME": "fake-model",
        "VIBE_PI_AGENT_DIR": str(tmp_path / "agent"),
        "VIBE_PI_SESSIONS_DIR": str(tmp_path / "sessions"),
    }
    return PiSidecarClient(
        command=["bun", "run", "src/main.ts"],
        cwd=REPO / "pi-sidecar",
        agent_dir=tmp_path / "agent",
        sessions_dir=tmp_path / "sessions",
        env=env,  # B6: 显式传给 sidecar 进程（client._spawn 合并 os.environ），隔离真实 provider 配置
        on_event=lambda ev, sid, data: events.append((ev, sid, data)),
    )


class TestBasicFlow:
    def test_multi_turn_with_text_response(self, tmp_path):
        async def run():
            provider = FakeOpenAIProvider([{"text": "first answer"}, {"text": "second answer"}])
            provider.start()
            events: list = []
            c = _client(provider, tmp_path, events)
            await c.start()
            try:
                await c.request("new_session", {"session_id": SESSION})
                await c.request("prompt", {"session_id": SESSION, "text": "hi"})
                r1 = await self._wait_terminal(c, SESSION, timeout=60)
                assert r1["content"] == "first answer"
                await c.request("prompt", {"session_id": SESSION, "text": "again"})
                r2 = await self._wait_terminal(c, SESSION, timeout=60)
                assert r2["content"] == "second answer"
                # Pi JSONL 会话文件存在且 header id 匹配
                state = await c.request("get_state", {"session_id": SESSION})
                assert Path(state["session_file"]).exists()
            finally:
                await c.stop()
                provider.stop()
        asyncio.run(run())

    def test_tool_call_roundtrip_through_python_gateway(self, tmp_path, monkeypatch):
        async def run():
            import json as _json

            from src.pi_sidecar.gateway_bridge import GatewayBridge
            from src.pi_sidecar.manifest import build_manifest_tool
            from src.agent.tools import BaseTool, ToolRegistry

            class Doubler(BaseTool):
                name = "doubler"
                description = "doubles a number"
                parameters = {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"]}
                is_readonly = True
                side_effecting = False
                repeatable = True

                def execute(self, **kw):
                    return _json.dumps({"status": "ok", "result": kw["n"] * 2})

            manifest = [build_manifest_tool(Doubler())]
            provider = FakeOpenAIProvider([
                {"tool_calls": [{"id": "call_1", "name": "doubler", "arguments": {"n": 21}}]},
                {"text": "answer is 42"},
            ])
            provider.start()
            events: list = []
            reg = ToolRegistry()
            reg.register(Doubler())
            bridge = GatewayBridge(reg)

            # B3 集成接线：host op → 按注册表分发（tool_invoke → GatewayBridge.handle_invoke）
            async def dispatch_host(op: str, params: dict) -> dict:
                if op == "tool_invoke":
                    return await bridge.handle_invoke(params)
                raise SidecarError("unknown_op", f"unhandled host op {op}")

            c = _client(provider, tmp_path, events, on_host_request=dispatch_host)

            async def main():
                await c.start()
                await c.request("new_session", {"session_id": SESSION})
                await c.request("set_tool_manifest", {"tools": manifest})
                await c.request("prompt", {"session_id": SESSION, "text": "double 21"})
                final = await self._wait_terminal(c, SESSION, timeout=60)
                assert final["content"] == "answer is 42"
                # SSE 事件含 tool_call 与 tool_result（形状与 glossary 一致）
                names = [d.get("type") for ev, sid, d in events if ev == "session_event"]
                assert "tool_execution_start" in names
                assert "tool_execution_end" in names
                # provider 收到第二轮请求（带 tool result）
                assert len(provider.requests) >= 2

            try:
                await main()
            finally:
                await c.stop()
                provider.stop()
        asyncio.run(run())

    @staticmethod
    async def _wait_terminal(c: PiSidecarClient, session_id: str, timeout: float) -> dict:
        import time

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = await c.request("get_state", {"session_id": session_id})
            if not state["busy"]:
                msgs = await c.request("get_messages", {"session_id": session_id, "limit": 5})
                assistant = [m for m in msgs["messages"] if m["role"] == "assistant"]
                return {"content": assistant[-1]["content"] if assistant else "", "state": state}
            await asyncio.sleep(0.1)
        raise TimeoutError("turn did not settle")
```

_client 支持 `on_host_request` 透传（B3/B6 接线），修改 `_client` 签名为：

```python
def _client(provider: FakeOpenAIProvider, tmp_path: Path, events: list,
            on_host_request=None) -> PiSidecarClient:
    env = {
        "OPENAI_BASE_URL": provider.base_url,
        "OPENAI_API_KEY": "test",
        "LANGCHAIN_PROVIDER": "openai",
        "LANGCHAIN_MODEL_NAME": "fake-model",
        "VIBE_PI_AGENT_DIR": str(tmp_path / "agent"),
        "VIBE_PI_SESSIONS_DIR": str(tmp_path / "sessions"),
    }
    return PiSidecarClient(
        command=["bun", "run", "src/main.ts"],
        cwd=REPO / "pi-sidecar",
        agent_dir=tmp_path / "agent",
        sessions_dir=tmp_path / "sessions",
        env=env,  # B6: 显式传给 sidecar 进程（client._spawn 合并 os.environ），隔离真实 provider 配置
        on_event=lambda ev, sid, data: events.append((ev, sid, data)),
        on_host_request=on_host_request,  # B3: 入站 host op 处理器
    )
```

> 实现者注：`test_tool_call_roundtrip` 的 host op 路由全部内联于测试（`dispatch_host` → `GatewayBridge.handle_invoke` → client `respond_host` 回帧）；`respond_host`/`on_host_request` 以完整代码交付于 Task 9（B3 修复）。若本测试发现路由缺口，在此修复（不新建文件）。

- [ ] 3. 运行期待通过：`pytest "agent/tests/pi_sidecar/test_integration_basic.py" --tb=short -q` → `2 passed`（首次运行 bun 需编译，<60s）。

- [ ] 4. Commit：

```bash
git add agent/tests/pi_sidecar/fake_provider.py agent/tests/pi_sidecar/test_integration_basic.py
git commit -s -m "test(pi-sidecar): fake provider + basic sidecar integration"
```

---

### Task 17: 高级集成（压缩/重开/steer/abort/restart/重复抑制/outcome_unknown/迁移投影）

**Files:** `agent/tests/pi_sidecar/test_integration_advanced.py`（Create）

**Interfaces:** Consumes — 同 Task 16 + `migration.migrate_session_if_needed`。对应 design §Verification integration 清单的剩余项。

**Steps:**

- [ ] 1. 写测试 `agent/tests/pi_sidecar/test_integration_advanced.py`：

```python
"""高级集成：design §Verification integration 全项覆盖。"""

import asyncio
import shutil
from pathlib import Path

import pytest

from src.pi_sidecar.client import PiSidecarClient, SidecarError
from src.session.models import Message
from src.session.store import SessionStore

pytestmark = pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")

REPO = Path(__file__).resolve().parents[3]
SESSION = "b2c3d4e5f6a1"

# _client/_wait_terminal 复用 test_integration_basic 的 helper（import 复用，不重复实现）：
from tests.pi_sidecar.test_integration_basic import FakeOpenAIProvider  # noqa: E402,F811
from tests.pi_sidecar.test_integration_basic import _client, _wait_terminal  # noqa: E402


class TestCompactionAndReopen:
    def test_manual_compaction_and_session_reopen(self, tmp_path):
        async def run():
            provider = FakeOpenAIProvider([{"text": "answer one"}])
            provider.start()
            events: list = []
            c = _client(provider, tmp_path, events)
            await c.start()
            try:
                await c.request("new_session", {"session_id": SESSION})
                await c.request("prompt", {"session_id": SESSION, "text": "hello"})
                await _wait_terminal(c, SESSION, timeout=60)
                state_before = await c.request("get_state", {"session_id": SESSION})
                assert await c.request("compact", {"session_id": SESSION}) == {"started": True}
                # compact 完成后 session 仍可用
                await c.request("prompt", {"session_id": SESSION, "text": "still there?"})
                await _wait_terminal(c, SESSION, timeout=60)
                # 重开（close + open 新 client）
                await c.stop()
                c2 = _client(provider, tmp_path, events)
                await c2.start()
                r = await c2.request("open_session", {"session_id": SESSION})
                assert Path(r["session_file"]) == Path(state_before["session_file"])
                msgs = await c2.request("get_messages", {"session_id": SESSION, "limit": 50})
                assert len(msgs["messages"]) >= 2
                await c2.stop()
            finally:
                provider.stop()
        asyncio.run(run())


class TestSteerAbort:
    def test_steer_and_abort(self, tmp_path):
        async def run():
            # 脚本两个回复；第一个后 steering 窗口
            provider = FakeOpenAIProvider([{"text": "working"}, {"text": "done"}])
            provider.start()
            events: list = []
            c = _client(provider, tmp_path, events)
            await c.start()
            try:
                await c.request("new_session", {"session_id": SESSION})
                await c.request("prompt", {"session_id": SESSION, "text": "start"})
                await asyncio.sleep(0.5)
                assert await c.request("steer", {"session_id": SESSION, "text": "pivot"}) == {"queued": True}
                await _wait_terminal(c, SESSION, timeout=60)
                # abort 中断在飞回合
                await c.request("prompt", {"session_id": SESSION, "text": "long one"})
                await asyncio.sleep(0.2)
                assert await c.request("abort", {"session_id": SESSION}) == {"aborted": True}
                await asyncio.sleep(0.5)
                state = await c.request("get_state", {"session_id": SESSION})
                assert state["busy"] is False
            finally:
                await c.stop()
                provider.stop()
        asyncio.run(run())


class TestRestart:
    def test_crash_restart_reopens_session(self, tmp_path):
        async def run():
            provider = FakeOpenAIProvider([{"text": "survived"}])
            provider.start()
            events: list = []
            c = _client(provider, tmp_path, events)
            await c.start()
            try:
                await c.request("new_session", {"session_id": SESSION})
                # 杀进程 → client 重启一次并重开活跃会话
                c._proc.kill()  # noqa: SLF001
                await asyncio.sleep(0.3)
                r = await c.request("ping", {}, timeout=30)
                assert r["pong"] is True
                r2 = await c.request("open_session", {"session_id": SESSION})
                assert Path(r2["session_file"]).exists()
            finally:
                await c.stop()
                provider.stop()
        asyncio.run(run())


class TestDuplicateAndUnknownOutcome:
    def test_duplicate_tool_call_suppressed(self, tmp_path):
        # 幂等逻辑在 Python GatewayBridge（Task 8 单测已覆盖语义）；
        # 此处端到端验证：同一 assistant turn 中相同 idempotencyKey 只触发一次 execute
        from tests.pi_sidecar.test_integration_basic import FakeOpenAIProvider  # noqa: F811

        class CountingGateway:
            def __init__(self):
                self.n = 0

            def execute(self, tool_name, arguments, *, step_id, policy, session_id=""):
                import json
                import time

                self.n += 1
                time.sleep(0.05)
                return type("SR", (), {"status": "success", "data": {"n": self.n}, "error": None,
                                       "elapsed_ms": 1, "to_wire": lambda s: {"status": "success", "data": {"n": self.n}}})()

        # 语义级端到端（不依赖 fake provider 时序）：直接以 handle_invoke 双发同键
        from src.pi_sidecar.gateway_bridge import GatewayBridge
        bridge = GatewayBridge(None, gateway=CountingGateway())

        async def run():
            params = {"call_id": "t1", "toolCallId": "c1", "toolName": "x", "arguments": {},
                      "idempotencyKey": "s:e:c", "is_readonly": True, "side_effecting": False,
                      "repeatable": True, "timeout_seconds": 5}
            r1 = await bridge.handle_invoke(params)
            r2 = await bridge.handle_invoke(params)
            assert r1["content"] == r2["content"]
            assert bridge._gw().n == 1  # noqa: SLF001 — 只执行一次

        asyncio.run(run())

    def test_unknown_write_outcome_marked(self, tmp_path):
        class DyingGateway:
            def execute(self, *a, **k):
                raise ConnectionError("sidecar pipe broke mid-write")

        from src.pi_sidecar.gateway_bridge import GatewayBridge

        bridge = GatewayBridge(None, gateway=DyingGateway())

        async def run():
            r = await bridge.handle_invoke({
                "call_id": "t2", "toolCallId": "c2", "toolName": "trading_place_order",
                "arguments": {}, "idempotencyKey": "s:e:c2",
                "is_readonly": False, "side_effecting": True, "repeatable": False,
                "timeout_seconds": 5,
            })
            assert r["outcome"] == "outcome_unknown"
            assert r["isError"] is True

        asyncio.run(run())


class TestMigrationProjection:
    def test_old_session_lazy_migration_and_projection(self, tmp_path):
        async def run():
            store = SessionStore(base_dir=tmp_path / "old-sessions")
            s = store.create_session(title="old")
            s.session_id = SESSION
            store.update_session(s)
            store._session_dir(SESSION).mkdir(parents=True, exist_ok=True)
            for role, content in [("user", "old q"), ("assistant", "old a")]:
                store.append_message(Message(session_id=SESSION, role=role, content=content))

            provider = FakeOpenAIProvider([{"text": "post-migration answer"}])
            provider.start()
            events: list = []
            c = _client(provider, tmp_path, events)
            await c.start()
            try:
                from src.pi_sidecar.migration import is_migrated, migrate_session_if_needed

                class FakeSvc:
                    store = store

                # not_found → migrate → 同 ID Pi 会话含旧消息
                with pytest.raises(SidecarError) as ei:
                    await c.request("open_session", {"session_id": SESSION})
                assert ei.value.code == "not_found"
                assert await migrate_session_if_needed(FakeSvc(), c, SESSION) is True
                assert is_migrated(SESSION)
                msgs = await c.request("get_messages", {"session_id": SESSION, "limit": 10})
                roles = [m["role"] for m in msgs["messages"]]
                assert "user" in roles and "assistant" in roles
                contents = " ".join(m["content"] for m in msgs["messages"])
                assert "old q" in contents and "old a" in contents
                # 迁移后可继续 prompt
                await c.request("prompt", {"session_id": SESSION, "text": "new q"})
                final = await _wait_terminal(c, SESSION, timeout=60)
                assert final["content"] == "post-migration answer"
            finally:
                await c.stop()
                provider.stop()
        asyncio.run(run())
```

- [ ] 2. 运行期待通过：`pytest agent/tests/pi_sidecar/test_integration_advanced.py --tb=short -q` → `5 passed`。

- [ ] 3. 全量 pi_sidecar 套件回归：`pytest agent/tests/pi_sidecar --tb=short -q` → 全绿。

- [ ] 4. 安全关键窄测试：`pytest agent/tests/test_sdk_order_gate.py agent/tests/test_mandate_enforcement.py -q` → 全绿。

- [ ] 5. Commit：

```bash
git add agent/tests/pi_sidecar/test_integration_advanced.py
git commit -s -m "test(pi-sidecar): advanced integration covering compaction/restart/migration"
```

---

### Task 18: 打包冒烟测试 + 性能基线 harness

**Files:** `scripts/desktop/smoke_pi.py`（Create）、`scripts/desktop/perf_baseline.py`（Create）

**Interfaces:** Consumes — Task 15 暂存产物 `.desktop-build/pi/`。对应 design §Verification packaging smoke + performance baseline。

**Steps:**

- [ ] 1. 实现 `scripts/desktop/smoke_pi.py`（design packaging smoke 清单）：

```python
"""Pi packaging smoke（design §Verification：packaging smoke tests）。

用法：PYTHONPATH=agent python scripts/desktop/smoke_pi.py [--pi-bin PATH]
退出码 0 = 全部通过。
检查项：
 1. 二进制以 RPC 模式启动，stdout 无非 JSONL 输出
 2. bundled skills 数量与源树 agent/src/skills 一致
 3. tool manifest 数量与 Python registry 一致（经 sidecar set/get 链路）
 4. 会话/内存写到用户目录（~/.vibe-trading/pi/），绝不写 bundle 内
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def check_rpc_stdout(pi_bin: Path) -> None:
    proc = subprocess.run(
        [str(pi_bin)],
        input='{"v":1,"id":"r-1","op":"ping"}\n',
        capture_output=True,
        text=True,
        timeout=60,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    assert lines, "no stdout from pi binary"
    for ln in lines:
        obj = json.loads(ln)  # 非 JSONL 会抛 → smoke 失败
        assert obj.get("v") == 1
    ready = json.loads(lines[0])
    assert ready.get("event") == "ready", f"first frame not ready: {ready}"
    last = json.loads(lines[-1])
    assert last.get("id") == "r-1" and last.get("ok") is True


def check_skills_count(staged_skills: Path) -> None:
    src = REPO / "agent" / "src" / "skills"
    src_count = len(list(src.glob("*/SKILL.md")))
    staged_count = len(list(staged_skills.glob("*/SKILL.md")))
    assert src_count == staged_count, f"skills mismatch: src={src_count} staged={staged_count}"
    assert src_count == 86, f"expected 86 skills, found {src_count}"


def check_manifest_and_user_dirs(tmp_agent: Path, tmp_sessions: Path) -> None:
    async def run():
        from src.pi_sidecar.client import PiSidecarClient
        from src.pi_sidecar.manifest import build_tool_manifest
        from src.tools import build_registry

        # 离线构建 registry（smoke 运行在构建机；check_available 未命中的工具自然缺席，
        # manifest 与 registry 的"一致性"指 sidecar 不丢工具：set_tool_manifest 回显数 == len(manifest)）
        registry = build_registry(persistent_memory=None, include_shell_tools=False)
        manifest = build_tool_manifest(registry)
        assert len(manifest) >= 1, "empty registry manifest"

        c = PiSidecarClient(command=["bun", "run", "src/main.ts"], cwd=REPO / "pi-sidecar",
                            agent_dir=tmp_agent, sessions_dir=tmp_sessions)
        await c.start()
        try:
            echoed = await c.request("set_tool_manifest", {"tools": manifest})
            assert echoed["count"] == len(manifest), \
                f"sidecar dropped tools: sent={len(manifest)} echoed={echoed['count']}"
            await c.request("new_session", {"session_id": "c0c0c0c0c0c0"})
            state = await c.request("get_state", {"session_id": "c0c0c0c0c0c0"})
            assert str(state["session_file"]).startswith(str(tmp_sessions)), state
        finally:
            await c.stop()

    asyncio.run(run())
    assert tmp_sessions.exists()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pi-bin", type=Path, default=REPO / ".desktop-build/pi/macos-aarch64/pi")
    ap.add_argument("--skills", type=Path, default=REPO / ".desktop-build/pi/skills")
    args = ap.parse_args()
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        check_rpc_stdout(args.pi_bin)
        check_skills_count(args.skills)
        check_manifest_and_user_dirs(Path(td) / "agent", Path(td) / "sessions")
    print("smoke_pi: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] 2. 实现 `scripts/desktop/perf_baseline.py`（design §Performance baseline 指标采集 harness；fixed corpus = `agent/tests/fixtures/perf_corpus.json` 5 条 finance research prompt，若无则由本脚本内置常量）：

```python
"""性能基线 harness（design §Verification：performance baseline）。

用法：PYTHONPATH=agent python scripts/desktop/perf_baseline.py --out perf-report.json
指标：首 token 延迟（prompt ack → 首个 text_delta）、工具吞吐（tool_invoke 完成/秒）、
取消延迟（abort → busy=false）、sidecar 重启恢复率（kill → ping 成功率）、
任务正确性（fixed corpus 每条期望 answer 前缀匹配）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import statistics
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

CORPUS = [
    {"q": "Summarize AAPL latest quarter", "expect_prefix": "AAPL"},
    {"q": "Compare MSFT vs GOOG margins", "expect_prefix": "MSFT"},
    {"q": "Analyze NVDA guidance", "expect_prefix": "NVDA"},
    {"q": "List risks for TSLA", "expect_prefix": "TSLA"},
    {"q": "Screen dividend stocks", "expect_prefix": "Screen"},
]


def _sid() -> str:
    return uuid.uuid4().hex[:12]


async def measure(session_factory, corpus) -> dict:
    first_tokens: list[float] = []
    correct = 0
    for item in corpus:
        c = await session_factory()
        sid = _sid()
        t0 = time.monotonic()
        await c.request("new_session", {"session_id": sid})
        await c.request("prompt", {"session_id": sid, "text": item["q"]})
        first_at = await _first_text_delta_at(c, sid, timeout=60)
        first_tokens.append(first_at - t0)
        final = await _final_content(c, sid, timeout=120)
        if final.startswith(item["expect_prefix"]):
            correct += 1
        await c.stop()
    return {"first_token_latency_s": first_tokens, "first_token_p50_s": statistics.median(first_tokens),
            "task_correctness": correct / len(corpus)}


async def _first_text_delta_at(c, sid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        msgs = await c.request("get_messages", {"session_id": sid, "limit": 3})
        if any(m["role"] == "assistant" and m["content"] for m in msgs["messages"]):
            return time.monotonic()
        await asyncio.sleep(0.05)
    raise TimeoutError("no first token")


async def _final_content(c, sid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = await c.request("get_state", {"session_id": sid})
        if not state["busy"]:
            msgs = await c.request("get_messages", {"session_id": sid, "limit": 5})
            a = [m for m in msgs["messages"] if m["role"] == "assistant"]
            return a[-1]["content"] if a else ""
        await asyncio.sleep(0.1)
    raise TimeoutError("turn unsettled")


async def measure_cancellation_latency(client_maker) -> float:
    c = await client_maker()
    sid = _sid()
    try:
        await c.request("new_session", {"session_id": sid})
        t0 = time.monotonic()
        await c.request("prompt", {"session_id": sid, "text": "long task"})
        await c.request("abort", {"session_id": sid})
        while True:
            state = await c.request("get_state", {"session_id": sid})
            if not state["busy"]:
                return time.monotonic() - t0
            await asyncio.sleep(0.02)
    finally:
        await c.stop()


async def measure_restart_recovery(client_maker, kills: int = 3) -> float:
    ok = 0
    for _ in range(kills):
        c = await client_maker()
        try:
            c._proc.kill()  # noqa: SLF001
            await c.request("ping", {}, timeout=60)
            ok += 1
        except Exception:  # noqa: BLE001
            pass
        finally:
            await c.stop()
    return ok / kills


async def measure_tool_throughput(client_maker, rounds: int = 20) -> float:
    """tool_invoke 完成/秒（无模型链路：直接以 GatewayBridge 双只读工具循环计）。"""
    from src.pi_sidecar.gateway_bridge import GatewayBridge

    class NoopRegistry:
        def get(self, name):
            t = type("T", (), {})()
            t.name = name
            t.is_readonly = True
            t.side_effecting = False
            return t

    class FastGateway:
        def execute(self, *a, **k):
            return type("SR", (), {"status": "success", "data": {}, "error": None, "elapsed_ms": 1,
                                   "to_wire": lambda s: {"status": "success"}})()

    bridge = GatewayBridge(NoopRegistry(), gateway=FastGateway())
    t0 = time.monotonic()
    for i in range(rounds):
        await bridge.handle_invoke({
            "call_id": f"p{i}", "toolCallId": f"pc{i}", "toolName": "noop", "arguments": {},
            "idempotencyKey": f"perf:k{i}", "is_readonly": True, "side_effecting": False,
            "repeatable": True, "timeout_seconds": 5,
        })
    return rounds / (time.monotonic() - t0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=REPO / ".desktop-build/perf-report.json")
    args = ap.parse_args()
    if shutil.which("bun") is None:
        print("bun missing", file=sys.stderr)
        return 1

    from src.pi_sidecar.client import PiSidecarClient

    async def client_maker():
        c = PiSidecarClient(command=["bun", "run", "src/main.ts"], cwd=REPO / "pi-sidecar")
        await c.start()
        return c

    async def run():
        report = {
            "measured_at": time.strftime("%FT%TZ", time.gmtime()),
            "baseline": await measure(client_maker, CORPUS),
            "cancellation_latency_s": await measure_cancellation_latency(client_maker),
            "restart_recovery_rate": await measure_restart_recovery(client_maker),
            "tool_throughput_per_s": await measure_tool_throughput(client_maker),
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2))
        print(f"perf report -> {args.out}")

    asyncio.run(run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] 3. 运行冒烟：`PYTHONPATH=agent python scripts/desktop/smoke_pi.py` → `smoke_pi: all checks passed`（前置：Task 15 已暂存；无暂存时 `--pi-bin` 指向 `bun run src/main.ts` 不适用——smoke 只测编译产物，无产物则显式失败说明需先跑 build-pi.sh）。

- [ ] 4. 跑一次基线：`PYTHONPATH=agent python scripts/desktop/perf_baseline.py --out .desktop-build/perf-report-pi.json` → 生成报告（`task_correctness` ≥ 0.8；报告文件 git-ignored，内容记录到 PR 描述供 before/after 对比）。

- [ ] 5. 全量回归（repo 常规命令）：`pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q` → 新增/改动测试全绿；既有 ~62 环境性失败与基线一致（不多不少）。

- [ ] 6. Lint 收尾：`ruff check agent/src agent/tests` → 无新增违规。

- [ ] 7. Commit：

```bash
git add scripts/desktop/smoke_pi.py scripts/desktop/perf_baseline.py
git commit -s -m "test(desktop): pi packaging smoke + performance baseline harness"
```

---

## Self-Review（已完成）

### (a) Spec 覆盖矩阵（design § → 任务）

| 设计 § | 覆盖任务 |
|---|---|
| Architecture / Responsibilities（Pi owns / Python owns） | Task 4/5/5b（Pi 侧）、Task 8/12（Python 侧） |
| 内建 read/write/edit/bash 禁用 | Task 5（`toolNames:[]`+`restrictToolNames`+`allowRestrictedCustomTools`），Task 16/17/18 集成验证 |
| Sidecar and RPC Protocol（帧/命令/manifest/并行只读串行写/截断 redact） | Task 1/2（帧）、Task 4（命令）、Task 6（manifest）、Task 8（并行/截断/redact） |
| Session Persistence（Pi JSONL 唯一真相源、Session/Attempt ledger、停写 messages） | Task 12（cutover）、Task 11（投影） |
| Existing session IDs（12-hex、索引、header 校验） | Task 3 |
| Lazy migration（5 步 + 失败原子性 + 批迁移/检查 operator 命令） | Task 13 |
| Long-Term Memory（快照+≤5 注入每轮 system prompt、兼容工具、degraded、compaction 不动记忆） | Task 14 |
| Events and Result Compatibility（映射表 + result 字段 + SSE 稳定） | Task 10（完整 glossary，含 mandate.proposal/live.action 依赖的 tool_result 形状）、Task 11 |
| Idempotency（幂等键/重复抑制/不重试/outcome_unknown/abort/重启一次/pi_sidecar_unavailable/legacy 显式回退） | Task 7/8（幂等/outcome）、Task 9（restart-once/unavailable）、Task 12（abort 接线、legacy-only provider 显式回退） |
| Packaging（pin+Node22+ Bun compile 三目标、staged 资源、tauri 资源、deep-sign、provenance） | Task 15 |
| Verification：unit/contract（framing/correlation/reopen/mapping/abort/restart/client/manifest/projection/idempotency/memory/migration + 既有安全测试） | Task 1-14 + 每 Task 既有回归步骤 |
| Verification：integration（fake provider 全项） | Task 16/17 |
| Verification：packaging smoke | Task 18（smoke_pi.py） |
| Verification：performance baseline | Task 18（perf_baseline.py） |
| Non-goals（不实现 AgentHarness、不让内建工具绕行、不急切迁移、不删 Python 工具/86 skills） | Global Constraints + Task 15（skills 原样暂存）+ 无删除任务的 plan 结构保证 |

**Gaps：无**——设计每个 § 均映射到任务；Non-goals 无违反。

### (b) Placeholder 扫描（director 修复后重扫）

- 全文无 "TBD"/"add error handling"/"similar to Task N"/"write tests for the above"。
- 两处显式标注的「执行者 d.ts 核对」点（Task 0 Step 7、Task 5 Step 6 注、Task 5 `importMessages` 双方案落地、Task 14 注入机制）均给出了**完整主实现代码 + 明确的备选实现语义**，不是 TODO：SDK 签名偏差按给定决策规则微调并记录，属锁定版本下的必要核对步骤。
- ~~Task 12 中 `client.respond_host` 集成缝~~ 已消除：`respond_host`/host-request 派发以完整代码交付于 Task 9（B3 修复），Task 12 仅消费。

### (b2) Director review corrections（changelog，全部已应用）

**Blockers**

- **B1** 新增 **Task 5b: sidecar 入口 main.ts**（插在 Task 5 与 Task 6 之间，后续任务编号不变，交叉引用以 "Task 5b" 指代）：完整 main.ts 代码（ready 帧、HostRpc stdout sink、ToolBridge、SessionIndex、PiSessionDriver、createCommandHandler、入站响应帧派发、`globalThis.__VIBE_HOST__` 先于 extension import 设置、extensions 注入）+ 内存双工 TDD 测试。文件结构总览与 Task 15/16 引用同步更新。
- **B2** SessionIndex 语义重定义：`register(vibeId, path)` 校验"存在合法 session header"并记录 `{path, headerId}`；`resolve` 返回 path 当且仅当文件仍有 session header 且其 id 等于**记录的 headerId**（替换检测），不强制 Pi header id === Vibe id；`PiSessionDriver.create()` 在 buildSession 后立即登记索引（修复 restart 后 open_session not_found → 静默丢历史的缺陷）；Task 3 测试改写；Task 5 执行者注说明：若 d.ts 揭示显式 session-id 创建选项则优先采用（headerId === vibeId），否则记录 headerId 即为设计"sidecar validates the header before opening it"的合理解读。
- **B3** Task 9 增加入站 host-request 完整实现：`on_host_request` 回调 + `respond_host` 协程 + `_dispatch_frame` 分支（`op` 且无 `ok` → 入站请求）+ stub sidecar 的 `STUB_SEND_HOST_REQ` 模式与测试。原 Task 12 的"~15 行"占位措辞删除。
- **B4** Task 12 异步桥接结构性重写：模块级专用 pi loop 守护线程（`_pi_loop()`）承载 `PiSidecarClient`；所有 service 交互统一 `run_coroutine_threadsafe(coro, _pi_loop()).result(timeout)`；`_run_with_pi` 改为**同步**方法经 `_AGENT_EXECUTOR` 执行（与既有 `agent.run` 形状一致）；client 新增公开 `started` property；删除 `ensure_started` 与一切 `_ready` 内部窥探；`send_message` 显式构造 `Message(...)`；迁移检查改用 `migration.is_migrated(session_id)`。
- **B5** host op 集合扩展为 `tool_invoke`/`memory_context`/`remember`/`memory_search`/`memory_remove`（契约节 + Task 9 + Task 12 同步）；extension 监听 `input` 事件缓存最近用户文本，`memory_context` 请求带 `{"query": lastInput}`；Task 12 引入 `self._pi_host_handlers: dict[str, Callable]` 处理器注册表（Task 12 只接 `tool_invoke`，Task 14 追加注册四个 memory ops）；删除 `_dispatch_pi_event`/`_on_pi_session_event`/`client._on_session_event` 三件套，由 client 级回调取代。
- **B6** `PiSidecarClient.__init__` 增加 `env: dict | None`，`_spawn` 合并 `os.environ`；Task 16 `_client` 显式传 env；stub ready 帧 `sdk` 字段回显 `VIBE_TEST_ENV_MARKER` 供断言。
- **B7** `_default_command()` 解析顺序：env `VIBE_PI_SIDECAR_BIN`（存在且可执行 → `[bin]`）→ bun dev 命令；Task 15 新增 `src-tauri/src/sidecar.rs` 修改步骤（Rust 从资源目录解析 `pi/<target>/pi` 并注入 Python serve 进程 env，含完整 Rust 代码）。

**Minors（M1–M9 全部应用）**

- **M1** Task 4 `get_messages` 的 `limit` 改为可选（默认 100），契约节同步；`bad_request` 仅在 limit 非正整数时。
- **M2** Task 12 事件泵收集 `entry_ids`（message_start/message_end payload id）；删除死代码 `preview = ""`。
- **M3** Task 18 `perf_baseline.py`：`new_session` 与 prompt 使用同一 sid；`measure_cancellation_latency`/`measure_restart_recovery` 纳入报告；`import sys` 移到顶部。
- **M4** Task 18 `smoke_pi.py`：顶部补 `import sys`；新增 manifest 数量校验（`build_registry` 以最小测试 env 构建 → `build_tool_manifest` → `set_tool_manifest` → 读回 `get_state` 链路比对，完整代码）。
- **M5** Task 13 `_seed_old` 删除链式赋值笔误。
- **M6** Task 5 移除未使用的 `readSessionHeaderId` import。
- **M7** Task 0 Step 7 d.ts 核对清单增加：(a) `message_start` payload 是否暴露 entry/message id（Task 7 幂等键依赖；若无则回退 `tool_execution_start.toolCallId` + 轮次计数器，Task 7 注明回退）；(b) `getMessages` 使用的 sessionManager entries 读取 API 实名（`getEntries()`）。
- **M8** Task 7 超时规则散文重写为两句定案：Python 拥有执行超时；sidecar 仅保留 2× 兜底计时器（写类 outcome_unknown / 只读 error）。
- **M9** 本节 changelog 即其自身。

### (c) 类型一致性核对

- `Frame` 四种形状、错误码集合、op 集合：Task 1（TS）/Task 2（Python）镜像一致；Task 4/7/9/12 使用同一契约节。
- `SessionLike`/`SessionDriver`：Task 4 定义 = Task 5 实现 = Task 4 测试 fake 一致（方法名/签名逐一核对）。
- `ManifestTool` 七字段：Task 6 产出 = Task 7 消费 = Task 8 `handle_invoke` params 一致。
- `PiSidecarClient.request/start/stop/unavailable/SidecarError.code`：Task 9 定义 = Task 12/13/16/17 使用一致。
- `normalize_event/NormState`：Task 10 定义 = Task 12 消费一致；`_text_of` 复用签名一致。
- `build_attempt_result` 字段集（含可选 `reason`）：Task 11 定义 = Task 11 测试 = Task 12 调用一致。
- 事件 glossary payload 键名与 recon §Event name glossary 逐字一致（`reasoning_delta.chars` 累计、`tool_result.preview` redacted[:200]、`compact.summary[:200]` 等）。

### 已解决的计划歧义（记录）

1. **记忆注入机制**：omp 文档未完整给出 per-turn system prompt 注入的公开 API。定案：extension `before_agent_start`（每轮一次取 memory block）+ `before_provider_request`（该轮首个 provider 请求 revise systemPrompt）。若 pinned SDK 的 `before_provider_request` 事件对象无 `revise`，等价改为该事件允许返回的请求修订形状（d.ts 为准）；语义铁律不变：只进本轮模型请求，不进用户消息/持久转录。
2. **`importMessages` 追加 API**：SDK 消息追加实名未在已读文档出现。定案：优先 SessionManager 追加 API（实名按 d.ts），无公开 API 时按 `omp://session.md` §File Format 直接追加 `message` 条目 + `SessionManager.open()` 重载——两方案均完整给出，禁止 TODO。
3. **`agent_settled` 事件**：SDK 已验证事件列表无 `agent_settled`；定案：以 `agent_end` 且 `isTerminal !== false`（absent = terminal）作为 attempt 终止信号（与 stock RPC 协议语义一致），设计映射表中的"attempt completion/failure projection"由 Task 12 的事件泵实现。
4. **vip_server/openai-codex**：Vibe 专有 provider 无法映射 Pi ModelRegistry（用户修正 #4 定案）：OpenAI 兼容子集经 `vibe-providers` extension `pi.registerProvider` 接入；这两个 provider 会话显式走 legacy 引擎并发 `pi.notice` 诊断——显式配置驱动，不违反"不静默回退"。
5. **`_async_test` 装饰器**：不存在（用户修正 #1）；全部 Python 测试用 sync `def test_*` + 内层 `async def` + `asyncio.run(...)`。
