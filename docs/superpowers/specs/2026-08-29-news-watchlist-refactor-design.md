# 投资资讯页自选股中心重构设计规格

- 日期：2026-08-29
- 状态：设计已获用户批准（Q1/Q2/Q3 三项决策定稿）；实施前置为 OpenSpec change 修订获批（见第 8 节）
- 范围：Vibe-Trading-Desktop 投资资讯页整页重构（前端 News 页 + 后端 news 服务），替代现有 12 赛道快照架构（clean cutover）

## 1. 背景与目标

### 1.1 现状与问题

现有投资资讯页（frontend/src/pages/News.tsx）按 12 个固定行业赛道组织，数据分 a_share / global_industry 两个 scope，上游为 108 个 RSS 源，依赖手动刷新。核心问题：

1. **大陆网络不稳定**：global scope 的国际源在大陆网络环境不可靠；
2. **覆盖率低**：默认 a_share scope 仅 13 个源，只覆盖 12 个赛道中的 5 个，默认首屏大半灰点；
3. **与自选股零联动**：固定赛道组织方式与用户实际关注的自选股无关；
4. **无实时性**：快照模型依赖手动刷新，无盘中秒级消息面能力。

### 1.2 目标

将资讯页重构为**以自选股为中心的实时消息面视图**：后台分层轮询采集快讯（主）与公告（次），统一入本地条目库；入库不做个性化匹配，读取时按本机自选股内容执行派生匹配并缓存；前端以统一时间流呈现自选相关条目，配套源健康降级状态机与诚实的延迟标注。

## 2. 已确认决策

用户于 2026-08-29 明确确认以下三项决策，作为本设计的硬约束：

| 决策 | 选择 | 内容 | 设计含义 |
|---|---|---|---|
| Q1 产品形态 | **A** | 自用/小范围工具 | 允许使用非官方网页端点（东财/新浪/上交所/深交所），以多源降级兜底；不预设对外商用，不写采购清单 |
| Q2 时效优先级 | **B** | 快讯优先 | 盘中秒级消息面为核心场景；公告为次级层 |
| Q3 页面组织 | **B** | 整页以自选股为中心重构，替代赛道资讯 | clean cutover，不保留旧赛道视图 |

## 3. 总体架构与数据流

### 3.1 三层架构

**第 1 层：采集层（机器级共享，无个性化）**

- **快讯聚合器**：东财与新浪并行采集——东方财富 7x24（np-weblist.eastmoney.com）与新浪滚动（feed.mix.sina.com.cn，lid=2516）同时拉取，东财优先（自带 stockList），新浪交叉验证 + 降级兜底。后台分层轮询，快讯 15-30s 增量拉取，以 since_id 为游标。
- **公告采集器（次级层）**：主源上交所 query.sse.com.cn/security/stock/queryCompanyBulletin.do（jsonp），备源深交所 HTML 频道解析。5-10min 增量；去重键 (code, ann_date, title)。
- **条目库**：统一落本地 SQLite `~/.vibe-trading/news.db`，字段 (source, item_id, published_at, title, body, url, matched_codes[], confidence)。

**第 2 层：匹配层（入库时只做最小加工）**

入库阶段仅执行：URL 规范化、去重、保存来源自带的结构化代码字段。**自选股匹配不在入库时执行，而在派生层读取时执行**。理由：用户后加自选股时，可追溯命中窗口内旧条目（快讯窗口 24h）——刚加入自选的股票，其窗口内的历史快讯在下次读取时即被匹配呈现。

**第 3 层：派生层（读取时匹配 + 派生缓存）**

- 缓存键 = (watchlist_version, 条目库写入代数 generation, after_cursor, before_cursor, limit)；派生缓存值只存条目键有序表并在读取时与条目库 join，清理后的条目不得 replay；
- watchlist_version = sha256(sorted((code, name, market) triples))——名称参与中置信度匹配，T0 回填/改名必须使版本键变化 → 派生缓存失效；
- 自选增删 → 版本键变化 → 旧缓存自然失效；
- **隔离键明确为本机 watchlist 内容版本键**：产品无用户身份体系，禁止设计成"按认证用户隔离"；
- 匹配器**直读本机 `~/.vibe-trading/watchlist.db` SQLite**，不走未鉴权 HTTP 端点。

### 3.2 数据流

```
采集层                        条目库                  派生层                      前端
东财7x24/新浪 ──15-30s──────▶ ~/.vibe-trading/    ──读取时匹配──▶ 派生缓存              GET /news-api/
上交所/深交所 ──5-10min──────▶ news.db            ◀── ~/.vibe-trading/ ── 键=(watchlist_version, watchlist-feed
  │                           (快讯24h/公告7d窗口)     watchlist.db（直读SQLite）  after/before_cursor)  ──▶ News 页统一流
  └─ 入库：URL 规范化 / 去重 / 保存结构化代码字段
```

采集器按各自增量游标（快讯 since_id、公告 5-10min 增量）拉取，入库执行 URL 规范化、去重并保存来源结构化代码字段；清理任务持续删除超窗条目；读取请求到达时，匹配器直读本机 watchlist.db 对窗口内条目执行三级匹配，结果按 (watchlist_version, generation, after_cursor, before_cursor, limit) 缓存；端点返回 FeedItem 流，前端 10-15s 短轮询消费。

### 3.3 留存窗口（严格最新窗口，非历史）

- 条目库仅保留活跃窗口：**快讯 24h、公告 7d**；
- 清理任务删除超窗条目；
- UI 无跨窗口历史、搜索或日期筛选入口；留存窗口内的游标分页（next_cursor + limit）是唯一回溯手段，超窗数据物理不存在；
- 更长留存或历史能力必须独立 OpenSpec change，首版不隐含。

## 4. 匹配机制与证券主数据

### 4.1 三级置信度

| 级别 | 规则 | 说明 |
|---|---|---|
| 高 | 来源结构化代码字段直接映射（东财 stockList 自带） | 叠加正文 6 位代码上下文护栏（（600519）、"股票代码"等模式），防止金额数字误伤 |
| 中 | 自选股名称精确匹配（简称/全称包含） | 依赖自选入库名称（见 4.2） |
| 低 | 板块/概念间接关联 | **首版不做**，仅预留字段 |

低置信度条目前端不展示。

#### 4.1.1 东财 stockList 格式化

东财 7x24 的 stockList 字段格式为 `["1.502013", "0.000001", ...]`，需标准化：`1.` 前缀 = 沪市（600/601/603/605/688），`0.` 前缀 = 深市（000/001/002/003/300/301）。提取 6 位代码后与自选列表交集匹配。北交所代码（43/83/87/92 开头）在东财 stockList 中前缀待确认，首版跳过北交所匹配。

### 4.2 前置任务：自选名称解析（独立可测试、无外部依赖）

修复自选入库名称缺失：add_stock 当前硬编码 name=''（watchlist_routes.py:190）。改为添加自选时用既有 TencentQuoteProvider 解析名称写入，并回填存量 name='' 行。该任务是名称匹配（中置信度）生效的前置。

### 4.3 全市场证券主数据表（后续层，待验证实现决策）

code → 简称/全称/别名 的全市场主数据表：候选来源 Tushare stock_basic / 东财列表**均未验证**，须先独立探测，不预先承诺数据源与更新策略。首版不含（见第 9 节）。

## 5. 降级状态机与运维监控

### 5.1 健康模型：请求健康与内容新鲜度分离

- **请求健康**：连续 3 次失败，或游标停滞 ≥3 轮 → 判定该源故障（degraded）；
- **内容新鲜度**：由 TradingCalendar 抽象控制，不与请求健康混判。

### 5.2 TradingCalendar 抽象

- Protocol 接口：is_trading_day / current_session / expected_flash_interval；
- **默认实现 ConservativeCalendar**：所有工作日视为交易时段，内容静默永不触发 degraded（安全兜底，零外部依赖）；
- 精确实现为后续独立任务（T8）：需已验证的日历 provider，覆盖临时休市/调休，获取/缓存策略可测试；不支持则退回默认实现并 WARN。

### 5.3 降级链与恢复探活

| 层 | 降级链 | 终态 |
|---|---|---|
| 快讯 | 东财+新浪并行 → 任一可用即继续 → 全部失败 → 本地缓存回放 | 回放态显示"数据可能延迟"横幅 |
| 公告 | 上交所 → 深交所 HTML → — | 终态标注"公告暂不可用" |

巨潮（WAF 446）、财联社（需 sign）不入首版降级链。

恢复探活：degraded 源每 60s 探活，连续 3 次成功即回切并补拉。

### 5.4 限流硬约束

- 单源请求间隔 ≥1.5s；
- 单 IP 并发 ≤2；
- 429/403 指数退避 30→60→120s + 抖动，上限 3 次后切备源。

### 5.5 去重

- 同源：(source_id, item_id) 唯一；
- 跨源：标题 simhash ≥0.7 合并，保留多源链接、取最早 published_at；
- URL 规范化：剥离 utm_* / source=* 参数。

### 5.6 监控（落本地日志）

- 指标：每源成功率/延迟/新鲜度、入库量环比基线、自选命中率、匹配置信度分布；
- 分级：单源 degraded = INFO；全源失败 = WARN + UI 横幅。

### 5.7 诚实标注义务

全源失败时必须显示"数据可能延迟，最后更新:{timestamp}"。

### 5.8 URL 安全与正文不抓取

- 条目 URL 仅允许 http/https 协议；展示前校验（复用 safeArticleUrl 模式）；
- **系统不抓取条目原文正文**——仅保存来源端点返回的 title/summary（≤500 字符），不请求条目 URL 指向的页面。这既是版权约束（不复制全文），也是安全约束（避免 SSRF 通过条目 URL 触发）；
- 原文跳转由用户浏览器直接打开，后端不代理。

## 6. 前端体验与 API 契约

### 6.1 API 契约

新增端点：

```
GET /news-api/watchlist-feed?after_cursor=<水位游标>&before_cursor=<翻页游标>&limit=50
```

两个游标参数正交且互斥（同传返回 400）：

- **after_cursor（轮询水位）**：只返回比该游标**更新**的条目；响应 `new_cursor` 为推进后的水位（取本页最旧返回行的位置——比它更新的条目已全部在本页返回，不重不漏；无新条目时原样回传）。null = 从窗口头部开始。前端 10-15s 短轮询每轮回传上一响应的 `new_cursor`，实现只拉增量。
- **before_cursor（翻页游标）**：只返回比该游标**更早**的条目；响应 `next_cursor` 指向更早一页（null = 窗口内已无更多）。用于用户上滑加载更早内容。
- **首屏**（两游标皆空）：从窗口头部取最新一页，同时返回 `new_cursor`（轮询起点）与 `next_cursor`（翻页起点）。
- cursor 为不透明字符串，客户端不得解析内部结构；`limit` 对两种游标同样生效。游标不可解析时返回 400 而非静默重置。after_cursor 模式按 published_at 升序交付最旧未交付页（前端 reverse 展示），保证一轮涌入超过 limit 条也不丢不重。

响应：

```json
{
  "items": [],
  "new_cursor": "sha256hex:位置",
  "next_cursor": null,
  "source_health": [
    { "source_id": "eastmoney", "state": "ok", "last_success_at": "2026-08-29T12:00:00Z", "last_error": null },
    { "source_id": "sina", "state": "degraded", "last_success_at": null, "last_error": "timeout" }
  ],
  "last_updated_at": "2026-08-29T12:00:01Z",
  "watchlist_version": "sha256hex",
  "reset_required": false
}
```

类型与空值语义（前端解析器按此实现 exact-key 校验）：

- items: FeedItem[]（见 6.2），上限 50 条，按 published_at 新→旧排序
- new_cursor: string|null——轮询水位游标；首屏响应为窗口最新条目位置，窗口无条目时为 null；before_cursor 模式下为 null
- next_cursor: string|null——更早页翻页游标；null 表示窗口内已无更多条目；after_cursor 模式下为 null
- source_health[].source_id: "eastmoney"|"sina"|"sse"|"szse"
- source_health[].state: "ok"|"degraded"|"failed"
- source_health[].last_success_at: ISO8601|null——null 表示该源从未成功
- source_health[].last_error: string|null——非敏感错误摘要（复用旧 PublicError 风格，禁止凭据）
- last_updated_at: ISO8601|null——条目库最近一次成功入库时间；null 表示从未入库
- watchlist_version: 64 位十六进制 sha256——空自选列表也有确定哈希值
- reset_required: boolean——见下方游标重置说明

边界响应：

- 空自选列表：items=[]、new_cursor=null、next_cursor=null、reset_required=false、其余字段正常填充——前端显示引导添加自选的空状态
- 全源失败且无缓存：items=[]、source_health 全部 state=failed、last_updated_at 取最近一次成功入库时间（可能为 null）——前端显示"数据可能延迟"横幅
- 全源失败但有窗口内缓存：正常返回缓存条目 + source_health 全部 failed——前端显示横幅 + 缓存数据

鉴权：挂 require_auth。

当请求中的任一游标（after_cursor 或 before_cursor）绑定的 watchlist_version 与当前不一致时，服务端返回 reset_required=true，该游标被视为空（items 从窗口头部重新匹配），前端应丢弃旧游标并整页替换。

### 6.1.1 手动强制补拉

POST /news-api/watchlist-feed/refresh

- 鉴权：require_auth
- 语义：触发快讯源立即增量拉取（绕过 15-30s 轮询节奏）；公告源仅当上次拉取超过 2min 时触发
- single-flight：运行中重复触发返回 202 + 当前任务状态（复用旧 refresh 的 reuse 语义，不启动第二个任务）
- 限流：距上次触发 <5s 时返回 429
- 响应：{ "accepted": boolean, "task_id": "uuid|null", "reused": boolean }（异步受理，不同步等待完成）
- 前端：手动刷新按钮调用此端点，成功后立即 GET feed 拉新

### 6.2 FeedItem 模型

```json
{
  "id": "条目唯一标识",
  "source": "eastmoney | sina | sse | szse",
  "type": "flash | announcement",
  "published_at": "发布时间",
  "title": "标题",
  "summary": "≤500 字符",
  "url": "可选",
  "matched_stocks": [
    { "code": "证券代码", "name": "证券简称", "match_rule": "structured_field | code_pattern | name_exact" }
  ],
  "confidence": "high | medium"
}
```

低置信度不展示。

### 6.3 前端 News 页重构

- 统一自选相关流；
- 股票徽标：点击跳个股/自选管理；
- 公告条目置顶标识；
- 源健康横幅：单源降级小字提示；全源失败顶部醒目横幅 + 最后更新时间；
- 保留手动刷新（调用 POST /news-api/watchlist-feed/refresh，见 6.1.1）；
- 10-15s 短轮询：页面 hidden 时暂停，回前台补拉。

### 6.4 Clean cutover 清单（同一变更内删除）

- 前端：News.tsx、useNews.ts 及测试；api.ts 旧 news 解析器与三个 news 方法；
- 后端：/news-api/snapshot、/news-api/refresh、/news-api/refresh/status 全部删除；
- agent/src/news 旧模块：feeds / llm / catalog / coordinator / pipeline / storage、source_registry.json、scripts/news/import_upstream.py、THIRD_PARTY_NOTICES.md 审查、旧测试、旧 spec；
- **保留**：StockNewsTool（独立工具，与 News 页解耦）。

**遗留资产审计（T7 执行前必须完成）**：
- 搜索 `News`/`news-api`/`useNews`/`NewsSnapshot`/`NewsScope`/`NewsTrackId` 在 frontend/、agent/、scripts/、docs/、vite.config.ts、AGENTS.md 中的所有引用；
- 确认 i18n locale 文件中 news.* 键的清理；
- 确认 router 路由条目、导航菜单、Vite proxy 配置的同步更新；
- 输出审计报告作为 T7 PR 的 checklist。

### 6.5 传输层提取与通用化请求契约

从 network.py 提取传输层到 `agent/src/news/transport.py`，剥离 catalog 依赖。**不能是简单 `(url, headers) -> Response`**——当前 PublicFeedClient 硬编码 RSS Accept 头（network.py:135-143）、仅支持 GET、返回类型要求 FeedEndpoint。

新架构需显式通用化请求契约：

```python
@dataclass(frozen=True)
class TransportRequest:
    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: Mapping[str, str] | None = None
    body: bytes | None = None
    content_type: str | None = None
    query: Mapping[str, str] | None = None
    max_redirects: int = 3
    allowed_content_types: frozenset[str] = frozenset({"application/json","text/html","text/plain"})
    max_response_bytes: int = 2 * 1024 * 1024

@dataclass(frozen=True)
class TransportResponse:
    status_code: int
    content_type: str
    body: bytes
    elapsed_ms: float
    final_url: str
```

提取时剥离的耦合点：

- L135-143 硬编码 Accept: application/rss+xml → 由调用方通过 headers 传入
- GET-only → 支持 GET/POST（公告端点需 POST）
- FeedEndpoint 返回类型 → 替换为 TransportResponse
- RSS 专属重试条件 → 保留 HTTP 状态码重试集（408/429/5xx）

测试覆盖（T-A 验收标准）：

- GET JSON 正常解析
- POST + body + content_type 正确发送
- JSONP 作为 text/plain 或 application/json 接收
- HTML 在 allowed_content_types 白名单内
- 重定向每跳重新 SSRF 校验
- 超出 max_response_bytes 截断报错
- 非白名单 content_type 拒绝

### 6.6 前端解析器

api.ts 新增 parseWatchlistFeedResponse，沿用既有 key 集合相等严格校验风格。

## 7. 实施边界与任务拆分

### 7.1 先决条件

1. OpenSpec change 获批（范围见第 8 节）；
2. 端点探测完成（已于 2026-08-29 完成，证据见第 10 节附录）。

### 7.2 并行组 A（无前置，可立即并行）

| 任务 | 内容 |
|---|---|
| T0 | 自选名称解析 + 存量回填（见 4.2） |
| T1 | TradingCalendar 抽象 + ConservativeCalendar 默认实现 |
| T-A | 从 network.py 提取传输层到独立模块（剥离 catalog 依赖；测试覆盖重试/熔断/SSRF） |

### 7.3 并行组 B（依赖 T-A；组内 T2 不依赖 T3、T4 不依赖 T1，三者并行）

| 任务 | 内容 | 额外依赖 |
|---|---|---|
| T2 | 快讯聚合器 + 条目库 + 降级状态机 | — |
| T3 | 公告采集器 | — |
| T4 | 匹配器 + 派生缓存 | T0 + T1（组 A） |

### 7.4 串行阶段 C（依赖 change 获批 + 组 B 完成）

| 任务 | 内容 | 并行性 |
|---|---|---|
| T5 | 新端点 + 前端解析器 | T5/T6 可并行 |
| T6 | 前端 News 页重构 | T5/T6 可并行 |
| T7 | same-PR clean cutover（6.4 清单） | 串行收尾 |

真正串行链：**OpenSpec change → T5+T6 → T7**。

并行组 A/B 可在 change 审核期间提前开发，但 T5/T6/T7 必须等 change 获批后合并。
**Change 两阶段澄清（消除违例中间态）**：

- **Proposal 获批**（用户审核 delta specs 通过）→ 允许开始 T5–T7 实施；并行组 A/B 代码为不注册任何路由的惰性模块，可在获批前合并（不改变系统可观测行为，旧 spec 仍被满足）；
- **Archive**（delta specs 并入主 spec、新 spec 生效）→ 仅在 T7 clean cutover 完成并验证后执行。旧管线删除、新端点接线与 archive 在同一变更内落地，不存在"新 spec 已生效但旧管线仍在运行"的过渡期。

### 7.5 后续独立任务（首版外）

| 任务 | 内容 |
|---|---|
| T8 | TradingCalendar 精确实现（需已验证日历 provider） |
| T9 | 全市场证券主数据表（候选源先探测） |
| T10 | 财联社官方 API 采购评估 |

## 8. 规格修订前置（OpenSpec change 范围）

实施前必须先对 openspec/specs/investment-news-hub/spec.md **逐项重写**（不得仅改单条）：

| 位置 | 现状 | 修订为 |
|---|---|---|
| L6-33 | 固定 12 赛道 + RSS 模型 | 自选股中心 + 快讯聚合多源 |
| L93-114 | 手动单任务刷新 | 后台分层轮询 + 手动刷新保留为强制补拉 |
| L143-160 | 只持久化单个最新 JSON 快照 | SQLite 条目库有界窗口 + 派生缓存键 |
| L182 | MUST NOT 定时刷新 / 资讯历史 / 分页 | 允许后台轮询；禁止跨留存窗口的历史、搜索、日期筛选；**明确允许窗口内游标分页**（next_cursor + limit，唯一回溯手段）；留存窗口（快讯 24h/公告 7d）写入规格 |

新增 requirement：

1. 隔离键 = watchlist 内容版本键（非用户身份键）；
2. 自选名称解析为匹配层前置。

## 9. 首版明确排除

1. 全市场证券主数据表 / 别名词典；
2. 财联社官方 API 采购；
3. 可浏览历史 / 搜索 / 分页；
4. 板块概念间接匹配（低置信度）。

## 10. 端点探测证据附录

探测条件：**查询日期 2026-08-29**，macOS 直连无代理，curl 浏览器 UA，每端点 ≤3 次、间隔 ≥1.5s、超时 10s，未破解任何签名。

| 端点 | 结果 | 关键字段/约束 | 结论 |
|---|---|---|---|
| 东财 7x24 np-weblist.eastmoney.com | 200 / 165ms / application/json | data.fastNewsList[]：title/summary/showTime（秒级）/realSort/stockList（证券关联，决定性优势）/code；需硬性参数 req_trace(uuid)+sortEnd；无签名 | **快讯主源** |
| 新浪滚动 feed.mix.sina.com.cn（lid=2516） | 200 / 232ms | result.data[] 50 条/页：title/intro/ctime/url/media_name；零参数零签名；无证券关联字段 | **快讯备源** |
| 财联社 | 旧端点 404；存活端点返回签名错误 10012 | 需 sign，未破解 | 需授权候选，不入首版链 |
| 巨潮 cninfo | POST/GET 全部 446 | 主机级 WAF 拦截 | 当前不可用 |
| 上交所 queryCompanyBulletin.do | 200 / 1590ms / jsonp 包裹 JSON | SECURITY_CODE/SECURITY_NAME/TITLE/SSEDATE/SSETIME/URL（PDF 相对路径）；仅需 Referer http://www.sse.com.cn/；需剥 jsonp 壳 | **公告主源** |
| 深交所 ShowReport | 200 / 83-325ms | 公告 CATALOGID 未在配额内确认；/disclosure/notice/ HTML 频道服务端渲染可解析（16-40 条/页，无证券代码字段需标题匹配） | **公告备源** |
| 北交所 initDisclosureList | 参数契约未复现（请求参数异常） | HTML 无服务端列表 | defer |
