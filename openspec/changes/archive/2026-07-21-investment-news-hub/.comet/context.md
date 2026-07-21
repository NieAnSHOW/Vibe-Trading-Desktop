# Comet Design Handoff

- Change: investment-news-hub
- Phase: design
- Mode: compact
- Context hash: 61aa03e1c87def6297486c1440203c5c2febf2a8fe69a802760f33bd8d31ded9

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/investment-news-hub/proposal.md

- Source: openspec/changes/investment-news-hub/proposal.md
- Lines: 1-30
- SHA256: b944ed958a3f4edccca7b712e38ecb18e81dbecfb7531c54b66518e5bbe7dcea

```md
## Why

当前产品缺少一个能在应用内按投资赛道聚合资讯并快速提炼每日重点的入口，用户需要在多个外部来源间切换，难以形成连续的研究工作流。引入免费的“投资资讯”模块，可在不增加登录、付费或第二套运行时的前提下，将经过验证的多源资讯聚合能力原生接入现有桌面产品。

## What Changes

- 新增 `/news` 页面及侧栏“投资资讯”入口，支持在 12 个投资赛道之间切换，并展示中文标题、短摘要、来源、发布时间和原文链接。
- 原生移植 `https://github.com/simonlin1212/investment-news` 上游提交 `d98aa603228f4839fb48859812c63a58ca10cead` 的 108 个 RSS/Atom 赛道来源映射（106 个唯一 feed 端点）、赛道分类、过滤规则与摘要思路，并保留其 MIT 版权和许可声明；不嵌入或启动上游服务。
- 为每个赛道新增 3–5 条中文 AI 要点，直接复用项目现有 `build_llm()` 及 Provider/环境变量配置，不复制或生成 `llm.config.json`；LLM 不可用时仍提供原始资讯，并明确标记对应赛道的 AI 摘要不可用。
- 新增手动后台刷新与进度查询。刷新期间继续展示上一次成功快照；单个来源失败与其他来源隔离；整体刷新失败不得覆盖旧快照。
- 磁盘仅保存最新组合快照；当前刷新任务状态只驻留进程内存，不抓取或重新发布媒体全文。
- 该模块作为免费功能提供，不新增登录、会员、付费权益或功能门控。

## Capabilities

### New Capabilities

- `investment-news-hub`: 覆盖多来源投资资讯聚合、12 赛道浏览、每赛道 AI 要点、后台刷新状态、失败降级、数据与许可边界，以及免费访问体验。

### Modified Capabilities

无。

## Impact

- 后端：在现有 FastAPI sidecar 内新增资讯采集、标准化、摘要、快照持久化、刷新协调和 `/news-api/...` 接口；沿用现有本地/远程 API 鉴权边界。
- 前端：新增 `/news` 路由、侧栏入口、资讯页面、API 客户端状态与国际化文案，并覆盖刷新中、陈旧快照、部分来源失败和摘要不可用状态。
- 运行时数据：在用户运行时数据目录只保存原子 JSON 最新快照；当前刷新任务状态仅驻留进程内，不引入历史数据库。
- 依赖与合规：纳入固定上游提交的来源配置和必要 MIT notices，并验证声明实际进入桌面发布物；RSS/Atom 内容仅保留标题、短摘要、来源、时间及经过 HTTP(S) 协议校验的原文 URL。
- 不包含：历史浏览、搜索、分页、收藏、已读状态、定时刷新、消息推送、全文抓取，以及独立新闻服务。

```

## openspec/changes/investment-news-hub/design.md

- Source: openspec/changes/investment-news-hub/design.md
- Lines: 1-145
- SHA256: dc1009ca62b4c34b8ee28e64d0ce661c7d5e257002492bfcb19eed3d61edb55b

[TRUNCATED]

```md
## Context

Vibe Trading Desktop 由单个 FastAPI sidecar 和 React SPA 组成，已有统一的 LLM Provider 配置、`build_llm()` 构造入口、API 鉴权依赖、用户运行时数据目录以及前端路由与国际化体系。当前没有通用资讯聚合服务，也没有适合保存资讯历史的数据库。

本变更要把 `https://github.com/simonlin1212/investment-news` 上游提交 `d98aa603228f4839fb48859812c63a58ca10cead` 的 108 个 RSS/Atom 赛道来源映射（106 个唯一 feed 端点）、12 个赛道、过滤规则与摘要思路移植进现有架构。上游材料是设计输入和固定来源，不作为第二个进程、Web 应用或运行时依赖启动。相关 MIT 版权与许可声明必须随移植材料进入源码、Python 分发物及桌面应用资源。

关键约束如下：

- 模块免费开放，不引入产品登录、会员或付费门控，但仍遵守现有 FastAPI 的本地/远程网络鉴权。
- 手动刷新可能需要访问大量外部来源并调用 LLM，不能占用请求生命周期。
- 任一刷新失败都不能破坏最后一次成功快照；部分来源失败不能拖垮其他来源。
- LLM 配置只有一个事实源，即现有 `build_llm()` 和项目环境配置。
- 只处理 feed 提供的有限元数据，不抓取媒体全文；首版不保存历史。

## Goals / Non-Goals

**Goals:**

- 在现有 FastAPI 和 React 应用内交付 `/news` 资讯工作区及 `/news-api/...` 后端接口。
- 可重复地导入固定上游提交中的来源目录、赛道和过滤规则，并保留许可归属。
- 提供有界、可观测、单任务的后台手动刷新，支持部分成功和旧快照回退。
- 提供中文标题和每赛道 3–5 条 AI 要点，同时在 LLM 不可用或输出无效时保留原始资讯可读性。
- 使快照、API、日志和错误状态均不泄露项目或 LLM 凭据。
- 用后端单元/API 测试和前端交互测试覆盖关键成功与降级路径。

**Non-Goals:**

- 资讯历史、搜索、分页、收藏、已读状态、定时刷新和消息推送。
- 抓取、存储或重新发布原文网页正文。
- 为新闻模块建立独立服务、独立 LLM 配置、独立账户或付费系统。
- 运行时自动同步上游分支，或允许运行时提交任意 feed URL。

## Decisions

### 1. 原生模块化集成到现有 sidecar

在 `agent/src/` 下建立独立资讯领域模块，分离固定来源配置、模型、采集/过滤、LLM 处理、快照存储和刷新协调；由 `agent/src/api/` 下的新闻路由适配层注册到现有 `agent/api_server.py`。不启动子服务，也不导入上游 Web 入口。

前端增加懒加载 `/news` 页面、现有 Layout 的侧栏入口、类型化 API 调用和现有 locale 目录中的文案。`/news-api` 与 SPA `/news` 使用不同前缀，避免静态回退与 API 路由冲突。

备选方案是将上游应用作为独立 sidecar 或 iframe 嵌入。该方案会重复端口、鉴权、配置、打包和生命周期管理，且无法可靠复用现有 LLM，因此不采用。

### 2. 固定上游来源清单并保留可审计元数据

将固定提交的 108 个赛道来源映射、12 个稳定赛道 ID、展示名称、feed URL 和过滤参数转换为仓库内静态结构化配置。上游实际包含 106 个唯一网络端点，其中 `https://sspai.com/feed` 与 `https://www.engadget.com/rss.xml` 各自映射到两个赛道；采集器按规范 URL 合并请求并把结果分发到对应映射。配置包含规范仓库 URL、完整 `upstream_commit` 和 schema 版本，并生成覆盖 URL、赛道映射及过滤参数的 golden manifest/hash；测试同时断言 108 个唯一 `(track_id, url)` 映射、106 个唯一端点、12 个赛道、唯一映射 ID、完整映射及 manifest/hash。MIT 声明放入随资讯包一起分发的第三方 notices 路径，并通过桌面 assemble 资源与 Python sdist/wheel 检查证明其进入发布物。

运行时不从 GitHub 或其他控制面更新来源清单，也不接受用户提供的 URL。来源调整应作为后续代码变更审查，以保持供应链和 SSRF 边界可追溯。

备选方案是运行时拉取上游 `main`。它不可复现，并会绕过发布审查，因此不采用。

### 3. 有界并发采集与来源级故障隔离

采集器使用项目已有 HTTP 能力请求静态配置中的 RSS/Atom URL，并使用明确禁用 DTD、外部实体和实体扩展的安全 RSS/Atom 解析器解析结构化 feed；如需新增轻量解析依赖，必须同步 Python 项目依赖、桌面 Tier 0 清单和许可证材料并运行 Tier 0 smoke。采集约束集中为可测试常量：连接/读取超时、响应体上限、重定向上限、全局并发数、每源最大条目数、允许发布时间窗口和最终每赛道条目上限。

每个来源独立返回成功结果或归一化的非敏感失败。协调器使用有界并发收集全部结果，不因单个异常取消其他来源。静态来源只允许 HTTP(S)，重定向目标同样校验协议并拒绝回环、私网、链路本地和保留地址。解析前先限制响应大小；条目内容转为纯文本并限制长度，前端不使用 `dangerouslySetInnerHTML`。

条目仅在标题非空且原文 URL 为合法 HTTP(S) 时进入候选；短摘要或发布时间缺失时保留显式空值，由 UI 展示稳定占位。条目按规范化 URL 与稳定内容指纹去重，之后应用固定过滤规则和时间/数量上限。一次刷新始终采集全部 12 个赛道，并按赛道判定是否获得本次可用新条目：有新条目的赛道生成新数据；无新条目的赛道复用旧数据并标记 stale，首次无旧数据则标记 unavailable。只有至少一个赛道得到更新时才允许提交组合快照；12 个赛道均未更新时任务失败并保留原快照。

备选方案是顺序抓取，易被慢源放大延迟；无限并发则会造成资源峰值和来源压力，均不采用。

### 4. 版本化的单一 JSON 快照与原子提交

唯一持久化文件位于 `get_data_dir() / "news" / "latest.json"`。快照使用 Pydantic 模型校验，顶层至少包含：

- `schema_version`、`generated_at`、`upstream_commit`；
- 来源成功/失败计数及经过清理的失败摘要；
- 12 个赛道及其标准化条目，每赛道包含 `generated_at`、`stale` 和可用状态；
- 每赛道 AI 状态、生成时间和 3–5 条要点；
- 组合快照版本和用于诊断的非敏感采集元数据；刷新任务运行状态不写入磁盘。

条目包含稳定 ID、赛道 ID、原始标题、可选中文标题、短摘要、来源、发布时间和原文 URL；不含全文。写入流程为同目录临时文件、序列化后重新读取/校验、flush/fsync、`os.replace`，并在支持的平台尽力 fsync 目录。临时文件和最终文件使用仅当前用户可读写权限。进程启动或读取时若快照无效，接口返回明确的不可用状态并记录非敏感诊断，不把半成品当作成功数据。

磁盘不保存按日期命名的快照或任务历史。未来 schema 变化通过 `schema_version` 显式处理；首版没有旧数据迁移。

备选方案是 SQLite。首版只有整体替换和整体读取，不需要查询或历史，JSON 原子快照更简单且更容易检查；若未来引入搜索/历史，应另开 change 重新评估数据库。

### 5. 进程内单刷新协调器

使用进程级 `NewsRefreshCoordinator` 保存一个 `asyncio.Task`、一个保护创建/状态变更的锁，以及当前任务的不可变状态快照。`POST /news-api/refresh` 在无任务运行时创建 UUID 任务并通过 `asyncio.create_task` 启动，返回 `202`；已有任务运行时返回该任务，不创建第二个。阻塞解析或同步 LLM 调用通过 `asyncio.to_thread` 移出事件循环。


```

Full source: openspec/changes/investment-news-hub/design.md

## openspec/changes/investment-news-hub/tasks.md

- Source: openspec/changes/investment-news-hub/tasks.md
- Lines: 1-48
- SHA256: 611157e2ccef9b845fa7affd31912304f4066571d8860cc03c9c65c96c6c8a67

```md
## 1. 上游来源与基础结构

- [ ] 1.1 从 `https://github.com/simonlin1212/investment-news` 提交 `d98aa603228f4839fb48859812c63a58ca10cead` 导入 108 个 RSS/Atom 赛道来源映射、106 个唯一 feed 端点、12 个稳定赛道 ID 和过滤规则，并记录规范仓库 URL 与完整提交元数据
- [ ] 1.2 生成覆盖 URL、赛道映射和过滤参数的 golden manifest/hash，并添加配置不变量测试，验证 108 个唯一 `(track_id, url)` 映射、106 个唯一网络端点、12 个赛道、映射 ID 唯一性、两个已知跨赛道复用 URL、映射完整性及固定提交标识
- [ ] 1.3 将上游 MIT 版权与许可声明放入随资讯模块分发的 notices 路径，验证源码、Python sdist/wheel 与桌面 assemble 资源均包含声明；若采用新的 RSS/Atom 解析依赖，同步项目依赖、桌面 Tier 0 清单和第三方许可材料并运行 Tier 0 smoke
- [ ] 1.4 建立资讯领域模块与 Pydantic 模型，定义版本化组合快照、标准化条目、每赛道 `generated_at`/`stale`/可用状态、AI 状态、来源结果和仅驻内存的刷新任务状态

## 2. 快照存储

- [ ] 2.1 先编写快照存储测试，覆盖用户数据目录、schema 校验、0600 权限、临时文件清理、原子替换、写入故障和损坏快照读取
- [ ] 2.2 实现 `get_data_dir()/news/latest.json` 单快照存储，以同目录临时文件、校验、fsync 和 `os.replace` 原子提交
- [ ] 2.3 验证磁盘快照只含允许的 feed 字段、必要元数据和非敏感错误摘要，不保存全文、历史或任何凭据

## 3. Feed 采集与标准化

- [ ] 3.1 使用本地 RSS 2.0/Atom fixtures 先编写采集测试，覆盖格式解析、DTD/XXE/实体扩展拒绝、纯文本化、字段/响应上限、标题/URL 必需字段、摘要/时间缺失、恶意链接协议、时间过滤、去重和 12 赛道归类
- [ ] 3.2 实现固定来源的安全 XML 解析与有界并发采集，加入超时、响应大小、重定向、协议和非公网目标限制；仅接受 HTTP(S) 条目原文 URL，且不请求条目原文页面
- [ ] 3.3 实现端点级异常隔离、向赛道映射分发和非敏感失败统计，测试部分端点失败仍可更新赛道、单赛道无有效条目时 stale/unavailable，以及 12 个赛道均无有效条目时拒绝提交

## 4. LLM 本地化与每赛道要点

- [ ] 4.1 先编写 LLM 管线测试，覆盖每次刷新只构建一个模型实例、每个有新数据的赛道一次结构化调用、每赛道最多 16 条候选、总并发上限 3、字符上限、原中文标题不翻译、本地化 ID/非空/长度/中文字符校验、未知 ID、畸形 JSON、超长字段、提示注入文本和调用异常
- [ ] 4.2 通过现有 `build_llm()` 实现有界的标题本地化与每赛道 3–5 条中文要点，在同一次赛道结构化调用中返回标题映射和要点，使用 Pydantic 验证输出且不引入 `llm.config.json`
- [ ] 4.3 实现标题回退和按赛道 AI 摘要不可用状态，验证单赛道或全部 LLM 调用失败时原始资讯仍可形成有效快照

## 5. 后台刷新与 API

- [ ] 5.1 先编写刷新协调器测试，覆盖一次任务刷新全部 12 个赛道、快速启动、阶段进度、单进程单任务、并发请求复用、赛道级 stale 回退、首次 unavailable、12 赛道均无更新时不写盘、取消、重启后 idle 和失败时保留旧快照
- [ ] 5.2 实现进程内 `NewsRefreshCoordinator`，以仅驻内存的异步任务编排全部 12 个赛道的采集、标准化、本地化、摘要、赛道级新旧合并和原子提交，并将阻塞工作移出事件循环
- [ ] 5.3 先编写 `/news-api/snapshot`、`/news-api/refresh` 和 `/news-api/refresh/status` 的响应、`202`、陈旧回退、空状态及 SPA 路由隔离测试
- [ ] 5.4 在现有 FastAPI sidecar 注册 `/news-api/...` 路由，复用 `require_auth` 的本地回环与远程 `API_AUTH_KEY` 策略，不启动第二服务
- [ ] 5.5 添加安全测试，确认未授权远程请求被拒绝，且 API 响应、快照、任务状态与日志不包含 LLM/API 凭据或原始 Provider 异常内容

## 6. React 投资资讯页面

- [ ] 6.1 扩展前端类型化 API 客户端并为 Vite 开发服务器配置 `/news-api` 代理，支持读取快照、启动/复用刷新和查询任务状态，并为响应解析、代理与错误处理添加测试
- [ ] 6.2 先编写页面交互测试，覆盖 `/news` 路由、侧栏入口、12 赛道切换及对应要点、缺失摘要/时间、条目字段、非 HTTP(S) 链接拒绝与安全属性、无快照和按赛道 AI 不可用状态
- [ ] 6.3 实现懒加载 `/news` 页面与侧栏“投资资讯”入口，显示当前赛道 3–5 条要点、中文标题优先的资讯列表、来源、时间及 HTTP(S) 原文跳转
- [ ] 6.4 实现仅在任务运行期间的状态轮询和进度 UI，覆盖刷新期间保留旧快照、完成后重载、整体失败、陈旧快照和部分来源失败提示
- [ ] 6.5 将页面、12 赛道和状态文案接入现有 i18n locale 与回退策略，并验证窄屏/桌面布局无溢出或控件重排

## 7. 集成验证与独立审查

- [ ] 7.1 运行资讯后端目标测试、API 安全与 SPA fallback 测试，确认测试不访问真实网络或真实 LLM
- [ ] 7.2 运行前端 Vitest 目标测试和 `npm run build`，修复类型、路由、开发代理、国际化与生产构建问题
- [ ] 7.3 使用临时用户数据目录完成端到端降级验证：无快照、部分来源失败、LLM 不可用、刷新失败保留旧快照和进程重启
- [ ] 7.4 验证 MIT notice 实际进入 Python sdist/wheel 与桌面 assemble 资源；新增解析依赖时运行 Tier 0 smoke
- [ ] 7.5 由独立 reviewer/verifier 对照 spec 检查免费范围、108 映射/106 端点/12 赛道配置与 manifest、单服务、鉴权、XML/链接协议、密钥边界、每赛道要点、无全文/无历史和 MIT notices，并处理所有阻塞发现

```

## openspec/changes/investment-news-hub/specs/investment-news-hub/spec.md

- Source: openspec/changes/investment-news-hub/specs/investment-news-hub/spec.md
- Lines: 1-179
- SHA256: 8ef60f45fe46264dc24e11602fb4a2c8024b9a1f03a5bf0a09ab5de482aebb25

[TRUNCATED]

```md
## ADDED Requirements

### Requirement: 免费的投资资讯入口
系统 SHALL 在侧栏提供“投资资讯”入口，并在 `/news` 路由提供无需产品登录、会员身份或付费权益即可使用的资讯页面。该页面 SHALL 支持在固定的 12 个投资赛道之间切换。

#### Scenario: 访问投资资讯页面
- **WHEN** 用户从侧栏选择“投资资讯”
- **THEN** 系统导航至 `/news`，显示 12 个赛道及当前赛道的最新可用资讯，且不触发任何登录或付费门控

#### Scenario: 切换赛道
- **WHEN** 用户在投资资讯页面选择另一个赛道
- **THEN** 系统在同一页面显示该赛道的资讯，并保持其他赛道可继续选择

### Requirement: 固定且可追溯的来源目录
系统 SHALL 原生纳入 `https://github.com/simonlin1212/investment-news` 上游提交 `d98aa603228f4839fb48859812c63a58ca10cead` 的 108 个 RSS/Atom 赛道来源映射（对应 106 个唯一 feed 网络端点）、12 个赛道及过滤规则，并 SHALL 通过可重复校验的清单证明移植内容与该固定版本一致。系统 SHALL 保留对应的 MIT 版权与许可声明，且 MUST NOT 通过嵌入或启动上游应用来提供此能力。

#### Scenario: 使用固定来源版本刷新
- **WHEN** 系统启动一次资讯刷新
- **THEN** 系统使用仓库内源自提交 `d98aa603228f4839fb48859812c63a58ca10cead` 的固定来源目录和赛道映射执行采集，而不在运行时跟随上游分支变化

#### Scenario: 检查第三方归属
- **WHEN** 发布物包含移植的来源配置或相关实现
- **THEN** 源码分发物、Python 分发物及桌面应用资源中同时包含适用于这些材料的 MIT 版权与许可声明

### Requirement: 受限的 RSS 与 Atom 内容采集
系统 SHALL 仅从配置的 RSS/Atom feed 获取并标准化标题、短摘要、来源、发布时间和原文 URL，应用移植的过滤规则，并对重复资讯去重。标题和合法的 HTTP(S) 原文 URL SHALL 是条目进入结果的必需字段；短摘要或发布时间缺失时 SHALL 使用显式空值，不得伪造内容或时间。系统 SHALL 使用禁用 DTD、外部实体及实体扩展的安全 XML 解析方式，并 MUST NOT 为生成列表或摘要而抓取原文链接指向的媒体全文。

#### Scenario: 标准化有效条目
- **WHEN** 来源返回包含必要字段的有效 RSS/Atom 条目
- **THEN** 系统将条目标准化到所属赛道，从 feed 持久化的原始字段仅限标题、短摘要、来源、发布时间和原文 URL，并只额外保存经过校验的中文标题、赛道 AI 要点及必要的非内容元数据

#### Scenario: 不抓取媒体全文
- **WHEN** feed 条目包含一个指向媒体页面的原文 URL
- **THEN** 系统保留该 URL 供用户跳转，但不请求或持久化该媒体页面的正文

#### Scenario: 拒绝非 Web 原文链接
- **WHEN** feed 条目提供 `javascript:`、`data:`、`file:` 或其他非 HTTP(S) 原文 URL
- **THEN** 系统拒绝该条目，不持久化也不向页面提供该链接

#### Scenario: 安全解析不可信 XML
- **WHEN** feed 包含 DTD、外部实体或实体扩展声明
- **THEN** 系统不解析或展开这些声明，并将该来源作为隔离失败处理

#### Scenario: 可选字段缺失
- **WHEN** 有效条目包含标题和合法原文 URL，但缺少短摘要或发布时间
- **THEN** 系统保留该条目并将缺失字段表示为显式空值，页面使用稳定的“暂无摘要”或“时间未知”状态

#### Scenario: 过滤和去重
- **WHEN** 同一刷新中出现不符合过滤规则的条目或重复条目
- **THEN** 系统排除不合格条目，并只在结果中保留一份等价资讯

### Requirement: 可浏览的资讯条目与中文标题
页面 SHALL 为每条资讯显示标题、可选短摘要、来源、可选发布时间和可访问的 HTTP(S) 原文链接。原始标题包含中文字符时 SHALL 原样展示且不调用标题本地化；非中文标题的本地化结果仅在条目 ID 匹配、非空、长度未超限且包含中文字符时视为有效。有效中文标题 SHALL 优先显示；本地化不可用时 SHALL 回退显示原始标题而不得隐藏该条目。

#### Scenario: 展示完整条目字段
- **WHEN** 用户浏览包含有效条目的赛道
- **THEN** 每条资讯显示标题、短摘要、来源和发布时间，并提供打开原始来源 URL 的操作

#### Scenario: 优先展示中文标题
- **WHEN** 条目具有经过验证的中文标题
- **THEN** 页面将中文标题作为主标题展示，并保留原文链接指向原始来源

#### Scenario: 标题本地化不可用
- **WHEN** 非中文条目未能生成有效中文标题
- **THEN** 页面显示原始标题并继续提供该条目的其余字段和原文链接

### Requirement: 每赛道 AI 要点使用项目 LLM 配置
系统 SHALL 基于每个有新数据的赛道在本次刷新中选出的最新候选资讯，分别生成 3–5 条中文 AI 要点；“每日”仅是当前最新刷新快照的产品标签，不表示自然日归档或历史窗口。系统 MUST 在每次刷新中通过现有 `build_llm()` 只构建一个模型实例，使用项目当前 Provider、模型、Base URL 和凭据配置，并为每个有新数据的赛道执行一次结构化调用，同时返回该赛道的有效中文标题映射和 AI 要点。每赛道最多向模型提交 16 条候选资讯，所有赛道的模型调用并发 MUST 不超过 3。系统 MUST NOT 读取、复制、生成或维护独立的 `llm.config.json`。单条内容长度 SHALL 有明确上限，模型输出 SHALL 经过结构和字段校验后才能进入快照。

#### Scenario: 使用当前 Provider 生成要点
- **WHEN** 用户已配置可用的项目 LLM Provider 且刷新进入摘要阶段
- **THEN** 系统为本次刷新调用一次 `build_llm()`，并使用该实例为各个有新数据的赛道分别执行一次结构化调用，生成 3–5 条中文要点和需要的中文标题，不要求新闻模块另行配置凭据

#### Scenario: 切换赛道展示对应要点
- **WHEN** 用户从一个赛道切换到另一个赛道
- **THEN** 页面展示新赛道独立的 AI 要点与资讯列表，不复用其他赛道的要点

#### Scenario: 限制模型输入
- **WHEN** 待摘要资讯超过配置的候选数量或单条文本长度上限
- **THEN** 系统先按确定性规则将每赛道候选截取至最多 16 条并截断字段，再以总并发不超过 3 的方式调用 LLM，且不把媒体全文加入提示词

```

Full source: openspec/changes/investment-news-hub/specs/investment-news-hub/spec.md
