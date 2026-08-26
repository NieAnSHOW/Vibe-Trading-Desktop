# 产品独立化与 Agent 执行层替换设计

- 日期：2026-08-26
- 状态：待用户复核
- 范围：将当前 Vibe Trading Desktop 作为独立产品演进，并为后续 Pi Agent 接入定义边界、契约与迁移策略。

## 1. 背景与问题

当前仓库已经与上游 HKUDS/Vibe-Trading 发生产品和架构分化。仓库同时保留 `origin`（当前产品仓库）与 `upstream`（上游仓库）两个 remote；桌面 Tauri 壳、控制台、用户 API、运行时目录、依赖 bootstrap、发布脚本、会话/运行记录、报告、Alpha Zoo、研究目标、可靠性和安全模块均已经形成当前产品的独立能力。

产品定位也已改变：不是通用的上游 Web Agent，而是面向个人投资者的本地优先金融研究桌面产品。当前 Agent 执行逻辑仍大量依赖上游 ReAct/AgentLoop 方向，但 `agent/src/agent/loop.py` 已同时承担上下文管理、流式输出、工具调用、重试、取消、目标续跑、用量统计、运行 trace 和失败处理等职责。继续把上游 Agent loop 作为长期主架构，会让产品路线受上游抽象和演进节奏约束，也难以系统改善执行效率和准确度。

本设计不假设 Pi Agent 必然更好。先建立当前实现基线，再用同一产品契约和能力集合比较 Legacy Agent 与 Pi Agent。

## 2. 目标

### 2.1 必须实现

1. 当前项目在产品身份、路线和架构上独立演进。
2. 上游代码变成选择性移植来源，不再是默认同步主线。
3. 保留现有用户数据、前端页面和 API/SSE 契约，避免大爆炸迁移。
4. 保留现有金融工具、数据源、回测、Alpha、报告和安全能力。
5. 允许 Agent 执行内核替换：当前实现作为 `LegacyExecutor`，新增 `PiExecutor`。
6. 用固定任务集和可重复指标比较两种执行器。
7. Agent 内核不能绕过产品的持久化、事件、权限和实盘安全边界。

### 2.2 非目标

1. 本阶段不重写整个后端、前端或 Tauri 壳。
2. 本阶段不迁移 Session、Run、Artifact 或已有用户数据格式。
3. 本阶段不复制或重写全部金融工具。
4. 本阶段不向最终用户暴露 Agent 实现选择。
5. 本阶段不直接决定 Pi Agent 的进程形态；同进程、子进程或本地协议应在接入阶段依据实际 SDK 和运行时约束决定。
6. 本阶段不让任何 Agent 实现直接执行实盘订单。

## 3. 产品与上游边界

当前仓库成为产品唯一主线。`upstream` 可以暂时保留用于人工查阅、问题对照和选择性移植，但不再作为默认 merge 来源。

### 3.1 当前产品拥有的边界

```text
Product Kernel
├── Session / Message / Attempt
├── Run / Artifact / Report
├── REST / SSE / canonical event contract
├── Tool capability and gateway contract
├── Market data and provider contract
├── Backtest and alpha contract
├── Evidence / grounding contract
├── Reliability / cancellation / recovery contract
├── Mandate / halt / order-gate safety contract
└── Desktop runtime / bootstrap / lifecycle contract
```

这些模块的接口、持久化、事件语义和安全约束由当前产品维护，不因上游变化而自动变化。

### 3.2 上游的剩余角色

上游只保留以下角色：

- 参考实现；
- 可选择移植的工具、算法或修复来源；
- 需要按许可证保留来源信息的代码来源。

每次吸收上游代码必须是显式移植任务，至少记录来源 commit、文件范围、许可证和本项目改造内容。禁止通过长期无审计的整仓 merge 重新引入上游架构耦合。

## 4. 执行层架构

HTTP/Session Service 不直接依赖具体 Agent 实现，而依赖产品定义的 `ProductTurnExecutor` 协议。

```text
HTTP / Session Service
        │
        ▼
ProductTurnExecutor
        │
        ├── LegacyExecutor  ← 当前 AgentLoop，迁移期 fallback
        └── PiExecutor      ← 新 Pi Agent 适配层
        │
        ▼
Product Tool Gateway
        │
        ├── 市场数据
        ├── 新闻 / 搜索
        ├── 回测
        ├── Alpha Zoo
        ├── 报告 / 文件
        ├── 研究目标与证据
        └── 后台任务
```

### 4.1 执行器输入

执行器接收：

- `session_id`；
- 用户消息；
- 历史消息；
- 当前研究目标（如有）；
- 产品暴露的工具描述；
- 本次运行配置、取消信号和预算信息。

### 4.2 执行器输出

执行器输出产品可消费的内部事件或结果：

- 文本增量；
- 推理阶段状态；
- 工具调用；
- 工具结果；
- 进度和心跳；
- 证据与 artifact 引用；
- LLM 用量；
- 完成、失败、取消状态。

### 4.3 执行器禁止拥有的责任

执行器不得直接：

- 写入 Session 或 Run 持久化文件；
- 自行设计或绕过 SSE 事件协议；
- 直接修改前端状态；
- 绕过 Tool Gateway 调用受保护能力；
- 直接执行实盘订单；
- 决定 mandate、halt 或 order gate 的最终结果。

Agent 可以提出研究动作或交易意图，但最终权限和写操作始终由产品服务及安全模块决定。

## 5. Canonical Event 兼容层

Pi Agent 的内部事件不能直接暴露给前端。所有执行器输出都经过产品统一事件层：

```text
Executor Event
      │
      ▼
Canonical Product Event
      │
      ├── session message
      ├── run trace
      ├── SSE replay
      └── frontend AgentMessage
```

现有前端继续使用 `AgentMessage` 和现有 SSE 事件，例如：

- `text_delta`；
- `reasoning_delta`；
- `tool_call`；
- `tool_heartbeat`；
- `tool_progress`；
- `tool_result`；
- `llm_usage`；
- `done`；
- 现有 swarm、goal、mandate 和 live 事件。

Pi Agent 内部即使使用不同的事件命名，也必须转换为这些 canonical 事件。这样可以先替换执行内核，不同步重写 React 页面、SSE hook、消息组件和历史记录。

## 6. Context、Run 和能力责任

当前 AgentLoop 中混合的职责在长期架构上按以下逻辑分层，但不要求第一阶段一次性拆出大量新文件：

```text
Context Policy
├── 历史消息选择
├── 研究目标上下文注入
├── 工具结果裁剪和长文本折叠
└── token / budget 限制

Execution Engine
├── 推理
├── 工具选择
├── 工具结果消费
└── 最终回答

Run Recorder
├── canonical event 记录
├── artifact 记录
├── 用量记录
└── 错误 / 取消 / 重试记录
```

第一阶段只建立足够小的 `ProductTurnExecutor` 边界，复用已有 Session Service、RunStateStore、TraceWriter 和 Tool Gateway。只有在 LegacyExecutor 与 PiExecutor 出现真实重复时，才提取 Context Policy 或 Run Recorder，避免为了抽象而抽象。

## 7. 评测基线

Pi Agent 接入前，先固定 LegacyExecutor 的可重复结果。评测任务使用相同输入、相同数据条件、相同工具集合和相同模型配置。

### 7.1 任务集

1. 单股票行情与技术分析；
2. 多股票横向比较；
3. 基本面研究；
4. 新闻与事件分析；
5. 回测策略配置生成；
6. 回测结果解释；
7. Alpha 查询与筛选；
8. 研究目标与证据闭环；
9. 数据缺失、歧义请求和工具失败；
10. 涉及交易意图的安全边界处理。

### 7.2 指标

#### 效率

- 首次有用输出延迟；
- 完整答案延迟；
- 工具调用次数；
- 重复工具调用次数；
- LLM token 消耗。

#### 准确性

- 工具选择是否正确；
- 工具参数和时间范围是否正确；
- 数据源和数据新鲜度是否表达正确；
- 结论是否有证据支持；
- 回测配置是否可执行；
- 是否发生未来数据泄漏。

#### 可靠性

- 空响应率；
- 超时率；
- 重试率；
- 取消是否生效；
- SSE 重连后是否完整；
- Run 和 artifact 是否可恢复。

#### 安全性

- 是否绕过权限检查；
- 是否错误执行敏感操作；
- 是否正确要求用户确认；
- mandate、halt、order gate 是否始终生效。

“准确”不以回答文字是否相似作为唯一判断，而以可验证事实、正确工具、正确时间范围、来源、证据一致性和回测安全为准。

## 8. 迁移流程

```text
A. 建立基线
   LegacyExecutor 默认运行，固定任务集记录结果

B. 接入 PiExecutor
   只增加执行器适配，不改前端、持久化和 canonical API

C. 离线对比
   相同输入、工具、模型和数据条件下比较 legacy / pi

D. 灰度切换
   Pi 成为默认路径，LegacyExecutor 作为后端回滚开关

E. 稳定后清理
   删除无用兼容代码、旧执行逻辑和上游专属依赖
```

内部可以使用配置项切换，例如 `VIBE_AGENT_EXECUTOR=legacy|pi`，但不在前端提供实现选择。双执行器是迁移期回滚机制，不是长期对用户暴露的双产品模式。

### 8.1 Pi 默认切换门槛

Pi Agent 只有在以下条件全部满足时才能成为默认实现：

- 关键任务准确度不低于 LegacyExecutor；
- 工具选择错误率不高于 LegacyExecutor；
- 证据链、回测安全和数据边界不回退；
- 取消、重连、失败恢复通过现有契约检查；
- 实盘相关安全测试全部通过；
- 关键任务的延迟或 token 消耗有明确改善。

如果 Pi 仅在特定任务类别更好，应按能力定位问题，不以全量重写掩盖局部退化。Pi 不满足门槛时保持 Legacy 默认，不删除旧实现。

## 9. 错误与安全处理

- Provider 流式失败、空响应、工具超时和取消必须转换成 canonical 产品事件，并写入 run trace。
- SSE 重连必须继续使用现有 Last-Event-ID/replay 语义，避免 Pi 内部事件导致重复消息。
- Tool Gateway 统一执行参数校验、超时、心跳、取消、重复成功处理和错误封装。
- Agent 只能申请受控 capability；金融数据写入、mandate、halt 和订单路径继续由已有安全模块处理。
- 普通研究任务失败不能损坏 session 或已完成 artifact；运行记录必须能标记 partial、failed 或 cancelled。
- Routine validation 永远不能触发 broker write 或真实交易。

## 10. 许可证与来源治理

当前仓库为 MIT，并在 `NOTICE` 中声明包含 HKUDS 软件；Alpha Zoo 还包含 Qlib Apache-2.0 内容及论文公式等独立来源。独立产品化不等于删除来源义务。

在正式切断上游依赖前应完成一次来源清单：

```text
每个待保留模块
├── 当前项目原创
├── HKUDS 上游修改而来
├── 其他第三方代码
└── 数学公式 / 数据 / 文档来源
```

对保留或移植的上游代码：

- 保留适用的版权和许可证文本；
- 更新 `NOTICE` 或模块级来源说明；
- 记录来源仓库、commit、文件范围和改造范围；
- 审核依赖的再分发条件；
- 不把未经审计的上游代码整体重新标记为当前项目原创。

## 11. 第一阶段交付边界

第一阶段只完成：

1. Agent 评测任务集和结果记录格式；
2. LegacyExecutor 的基线运行；
3. 产品 canonical event / executor contract 的最小定义；
4. Pi Agent 的接入方案验证；
5. 一个不改变现有前端和持久化的 PiExecutor 纵向切片；
6. 针对该切片的离线比较。

第一阶段不承诺 Pi Agent 全面替换、删除所有上游痕迹或重写全部 Agent 能力。是否扩大范围由基线结果决定。

## 12. 验收标准

设计进入实施前，必须满足：

- 当前产品与上游的职责边界明确；
- LegacyExecutor 和 PiExecutor 共享同一产品契约；
- 前端无需知道执行器具体实现；
- 现有 session、run、artifact 和 SSE 行为保持兼容；
- Tool Gateway 和 live safety boundary 不被执行器绕过；
- 有固定任务集和效率、准确性、可靠性、安全性指标；
- Pi 只有在明确门槛达标后才成为默认执行器；
- 上游移植有来源和许可证记录。

## 13. 结论

当前项目可以、也应当逐步脱离上游仓库。正确切法不是立即重写整仓，而是现在就独立产品身份和架构主线，同时保留金融能力层和产品数据契约；之后通过 `ProductTurnExecutor` 将 Pi Agent 接入为可替换执行器，用基线评测决定是否切换默认实现。
