# 投资资讯自选股中心重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans。步骤用 - [ ] 复选框。

**Goal:** 将投资资讯页从 12 赛道 RSS 快照架构整页重构为以本机自选股为中心的实时快讯/公告聚合（东财+新浪并行快讯、上交所+深交所公告），SQLite 条目库有界窗口，读取时按 watchlist 内容版本键派生匹配并缓存，clean cutover 删除全部旧管线。

**Architecture:** 三层——采集层（机器级共享：transport → flash/announcements 采集器 → news.db 条目库 + health 状态机）、匹配层（入库仅规范化/去重）、派生层（读取时直读 watchlist.db → 三级匹配 → (watchlist_version, after_cursor, before_cursor) 派生缓存）。前端统一流 + 10-15s 短轮询（hidden 暂停）。唯一真相源：`docs/superpowers/specs/2026-08-29-news-watchlist-refactor-design.md`（commit c4c0d6ea）。

**Tech Stack:** Python 3.11 + FastAPI + httpx + sqlite3（agent/）；React 19 + TypeScript + Vitest（frontend/）；OpenSpec change（openspec/）。

## Global Constraints（从规格 §3-§8 提取，每个任务隐式包含）

- 留存窗口：快讯 24h、公告 7d，超窗条目物理删除（§3.3）；窗口内游标分页（next_cursor + limit）是唯一回溯手段。
- 限流硬约束（§5.4）：单源请求间隔 ≥1.5s；单 IP 并发 ≤2；429/403 指数退避 30→60→120s + 抖动，上限 3 次后切备源。
- 隔离键 = 本机 watchlist 内容版本键：`watchlist_version = sha256(sorted((code, name, market) triples)，名称参与匹配，回填/改名必须使缓存失效`；禁止"按认证用户隔离"，禁止引入用户身份体系（§3.1）。
- 匹配器直读本机 `~/.vibe-trading/watchlist.db` SQLite，不走未鉴权 HTTP 端点（§3.1）。
- 系统不抓取条目原文正文：仅保存来源端点返回的 title/summary（≤500 字符）；条目 URL 仅允许 http/https，展示前校验（§5.8）。
- 低置信度条目不展示；items 上限 50 条，按 published_at 新→旧排序（§4.1/§6.1）。
- 测试必须 mock 全部外部网络（FakeTransport/FakeResolver/stub service），不得依赖真实端点。pytest 无 pytest-asyncio，异步测试用 `_async_test` 装饰器（`asyncio.run` 包装，惯例见 agent/tests/news/test_network.py:198-203）。
- Python 全套测试命令：`pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q`（仓库根执行；pyproject 已配 `testpaths=["agent/tests"]`、`pythonpath=["agent"]`）。
- Ruff：`select = ["E", "F", "W"]`，line-length 120，target py311（repo 根 pyproject.toml [tool.ruff]）。每个 Python 任务收尾跑 `ruff check agent/src agent/tests`。
- 前端测试：`cd frontend && npx vitest run src/...`；全量既有失败基线 Rail×1 + SettingsPage×3 为既有失败与本工作无关（console-app 基线）；本工作新增/改动的测试必须全绿。
- 提交：每个任务用 `git commit -s`（DCO Signed-off-by 必需），Conventional Commits，禁止任何 AI attribution trailer。
- 任务顺序与依赖照规格 §7：组 A（T0/T1/T-A，即本计划 Task 0/1/2/3）可并行；组 B（Task 4/5/6）依赖 Task 3，其中 Task 6 还依赖 Task 1/2；串行 C（Task 7/8/9）须等 OpenSpec change proposal 获批（§7.4）。

## 文件结构总览

| 路径 | 动作 | 职责 |
|---|---|---|
| openspec/changes/2026-08-29-news-watchlist-refactor/{.openspec.yaml,proposal.md} | Create | OpenSpec change |
| openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub/spec.md | Create | delta spec（§8 四段重写 + 新增） |
| agent/src/api/watchlist_routes.py | Modify | T0 名称解析 + 回填 |
| agent/src/news/calendar.py | Create | TradingCalendar + ConservativeCalendar |
| agent/src/news/transport.py | Create | 通用化 SSRF 加固传输层 |
| agent/src/news/store.py | Create | news.db 条目库（有界窗口/去重/URL 规范化） |
| agent/src/news/health.py | Create | 源健康降级状态机 |
| agent/src/news/flash/service.py | Create | 东财+新浪快讯聚合器 |
| agent/src/news/announcements/collector.py | Create | 上交所+深交所公告采集 |
| agent/src/news/refresh.py | Create | 手动强制补拉协调（single-flight + 5s 限流） |
| agent/src/news/matcher.py | Create | 版本键/三级匹配/派生缓存/读取服务 |
| agent/src/api/watchlist_feed_routes.py | Create | GET/POST /news-api/watchlist-feed |
| agent/api_server.py | Modify | 新路由注册 + 后台轮询接线 |
| frontend/src/lib/api.ts | Modify | feed 类型 + parseWatchlistFeedResponse + api 方法 |
| frontend/src/hooks/useWatchlistFeed.ts | Create | 短轮询 hook（hidden 暂停） |
| frontend/src/pages/News.tsx | Rewrite | 自选股中心统一流 |
| frontend/src/i18n/locales/*.json + newsLocales.test.ts | Modify | news.* 键替换 |

---

## 跨任务接口契约（单一事实来源；各任务 Interfaces 节重复声明）

```python
# Task 3 定义，Task 4/5 消费
@dataclass(frozen=True)
class TransportRequest:
    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: Mapping[str, str] | None = None
    body: bytes | None = None
    content_type: str | None = None
    query: Mapping[str, str] | None = None
    max_redirects: int = 3
    allowed_content_types: frozenset[str] = frozenset({"application/json", "text/html", "text/plain"})
    max_response_bytes: int = 2 * 1024 * 1024

@dataclass(frozen=True)
class TransportResponse:
    status_code: int
    content_type: str
    body: bytes
    elapsed_ms: float
    final_url: str

class TransportError(Exception):
    code: str  # invalid_url|unsupported_scheme|dns_failed|unsafe_target|too_many_redirects|
               # invalid_redirect|rate_limited(429)|forbidden(403)|http_status|response_too_large|
               # unsupported_content_type|timeout|network_error|circuit_open

class TransportClient:
    def __init__(self, resolver=None, transport=None, sleep=asyncio.sleep, now=time.monotonic): ...
    async def fetch(self, request: TransportRequest) -> TransportResponse:  # 失败抛 TransportError
```

```python
# Task 4 定义，Task 5/6 消费
@dataclass(frozen=True)
class StoredEntry:
    source: str                 # "eastmoney"|"sina"|"sse"|"szse"
    item_id: str                # 源内唯一（东财 code / 新浪 url / 公告 sha1(code|date|title)）
    type: str                   # "flash" | "announcement"
    published_at: str           # ISO-8601 UTC
    title: str
    summary: str                # ≤500 字符
    url: str                    # 规范化后；无链接为 ""
    structured_codes: tuple[str, ...]   # 原始结构化代码（东财 stockList 原样 / 公告 6 位代码）
    extra_urls: tuple[str, ...] = ()    # 跨源合并保留的多源链接

class EntryStore:  # agent/src/news/store.py, DB: ~/.vibe-trading/news.db
    def __init__(self, db_path: Path | None = None): ...
    def upsert_entries(self, entries: Iterable[StoredEntry], now: datetime | None = None) -> int: ...
    def window_merged(self, limit: int = 50, now: datetime | None = None,
                      after_published_at: str | None = None, after_item_id: str | None = None,
                      before_published_at: str | None = None, before_item_id: str | None = None) -> list[StoredEntry]: ...
    def purge_expired(self, now: datetime | None = None) -> None: ...
    def last_updated_at(self) -> str | None: ...

class HealthTracker:  # agent/src/news/health.py
    def __init__(self, calendar: TradingCalendar, now: Callable[[], datetime] | None = None): ...
    def record_success(self, source_id: str, *, advanced: bool) -> None: ...
    def record_failure(self, source_id: str, error: str) -> None: ...
    def state_of(self, source_id: str) -> str: ...            # "ok"|"degraded"|"failed"
    def snapshot(self) -> list[SourceHealth]: ...
```

```python
# Task 6 定义，Task 7 消费
@dataclass(frozen=True)
class WatchlistEntry:
    code: str; name: str; market: str

def load_watchlist(db_path: Path | None = None) -> list[WatchlistEntry]: ...
def compute_watchlist_version(entries: Sequence[WatchlistEntry]) -> str: ...  # sha256 hex
def normalize_stocklist_code(raw: str) -> str | None: ...  # "1.600519"→"600519"；北交所→None
def encode_cursor(version: str, published_at: str, item_id: str) -> str: ...
def decode_cursor(cursor: str) -> dict | None: ...          # {"v","t","i"} | None

class WatchlistFeedService:
    def __init__(self, store: EntryStore, health: HealthTracker,
                 cache: DerivedFeedCache | None = None, watchlist_db: Path | None = None): ...
    async def feed(self, after_cursor: str | None, before_cursor: str | None, limit: int = 50) -> dict: ...
    # after_cursor=轮询水位（只返回更新条目，响应 new_cursor 为新水位）；
    # before_cursor=翻页游标（只返回更早条目，响应 next_cursor 指向更早页）；两者互斥（同传 ValueError→400）
    # 返回 dict 精确键: items[], new_cursor, next_cursor, source_health[], last_updated_at,
    #                   watchlist_version, reset_required
    # items[] 元素精确键: id, source, type, published_at, title, summary, url(None|str),
    #                     matched_stocks[{code,name,match_rule}], confidence("high"|"medium")
```

```ts
// Task 7 定义（frontend/src/lib/api.ts），Task 8 消费
export interface WatchlistFeed {
  items: FeedItem[]; new_cursor: string | null; next_cursor: string | null;
  source_health: FeedSourceHealth[];
  last_updated_at: string | null; watchlist_version: string; reset_required: boolean;
}
// api.getWatchlistFeed(after: string | null, before: string | null, limit: number, signal?: AbortSignal): Promise<WatchlistFeed>
// api.refreshWatchlistFeed(signal?: AbortSignal): Promise<FeedRefreshAccepted>
// Task 8: useWatchlistFeed(): { feed, isLoading, isRefreshing, error, refresh, loadMore }
```

---

### Task 0: OpenSpec change 创建（proposal + delta spec）

**Files:**
- Create: `openspec/changes/2026-08-29-news-watchlist-refactor/.openspec.yaml`
- Create: `openspec/changes/2026-08-29-news-watchlist-refactor/proposal.md`
- Create: `openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub/spec.md`

**Interfaces:**
- Consumes: 规格第 8 节（四段逐项重写表 + 两条新增 requirement）、旧 spec `openspec/specs/investment-news-hub/spec.md`（被替换对象）。
- Produces: OpenSpec change 目录，供后续任务实施时引用；主 spec 的归并在 change archive 阶段执行，不在本计划内。

- [ ] **Step 1: 创建 change 目录与 .openspec.yaml**

```bash
mkdir -p openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub
```

写入 `openspec/changes/2026-08-29-news-watchlist-refactor/.openspec.yaml`（沿用 openspec/changes/archive/2026-07-21-investment-news-hub/.openspec.yaml 的格式）：

```yaml
schema: spec-driven
created: 2026-08-29
```

- [ ] **Step 2: 写 proposal.md**

写入 `openspec/changes/2026-08-29-news-watchlist-refactor/proposal.md`：

```markdown
## Why

现有投资资讯页按 12 个固定行业赛道组织，依赖 108 个 RSS 源的手动快照刷新：大陆网络下 global 源不可靠、
a_share 仅 13 源覆盖 5/12 赛道（默认首屏大半灰点），页面与用户自选股零联动，且无盘中实时消息面能力。

## What Changes

- 投资资讯页整页重构为"自选股中心"：统一时间流展示与自选股匹配的实时快讯（东财 7x24 + 新浪滚动并行）
  与公告（上交所主源 + 深交所备源）。
- 后端改为后台分层轮询采集 + 本机 SQLite 条目库（~/.vibe-trading/news.db，快讯 24h / 公告 7d 有界窗口），
  入库不做个性化匹配，读取时按本机 watchlist 内容版本键派生匹配并缓存。
- 新增 GET /news-api/watchlist-feed 与 POST /news-api/watchlist-feed/refresh（挂 require_auth），
  返回统一流、源健康状态、不透明游标与 reset_required 语义。
- 自选添加时通过行情提供者解析证券简称并回填存量空名称（名称匹配前置）。
- 源健康降级状态机：连续失败/游标停滞降级、429/403 指数退避、探活回切、全源失败诚实标注横幅。
- clean cutover：同一变更内删除 12 赛道 RSS 快照管线（feeds/llm/catalog/coordinator/pipeline/storage、
  /news-api/snapshot|refresh|refresh/status、前端旧实现），保留 StockNewsTool。

## Capabilities

### Modified Capabilities

- `investment-news-hub`: 从"12 赛道 RSS 快照 + 手动刷新 + 单快照持久化"改为"自选股中心实时快讯/公告聚合
  + 后台分层轮询 + SQLite 有界窗口条目库 + 派生缓存"。

## Impact

- 后端：agent/src/news 新增 transport/calendar/store/health/flash/announcements/refresh/matcher；
  agent/src/api 新增 watchlist_feed_routes；api_server 启动后台轮询任务；删除旧 news 模块与旧路由。
- 前端：News.tsx 与 useNews.ts 重写为统一流 + 10-15s 短轮询（hidden 暂停）；api.ts 新增
  parseWatchlistFeedResponse、删除旧 news 解析器与三个 news 方法；i18n news.* 键替换。
- 运行时数据：~/.vibe-trading/news.db（条目库）；匹配直读 ~/.vibe-trading/watchlist.db（不走 HTTP）。
- 合规边界：不抓取条目原文正文；条目 URL 仅 http/https；不引入用户身份体系；低置信度不展示；
  财联社（需 sign）与巨潮（WAF 446）不入首版降级链。
```

- [ ] **Step 3: 写 delta spec（§8 四段重写 + 新增 requirement）**

写入 `openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub/spec.md`：

```markdown
# investment-news-hub Delta

按设计规格 §8 对 openspec/specs/investment-news-hub/spec.md 逐项重写（四段）并新增两条 requirement。
rename 语义用 REMOVED+ADDED 表达。

## REMOVED Requirements

### Requirement: 固定且可追溯的来源目录
**Reason**: 12 赛道 108 RSS 源目录模型被东财 7x24 / 新浪滚动 / 上交所 / 深交所直接采集替代。
**Migration**: 采集约束由新增 "受限的多源快讯与公告采集" 承载；RSS 上游 MIT 声明（THIRD_PARTY_NOTICES.md）
随来源目录在 clean cutover 中删除。

### Requirement: 受限的 RSS 与 Atom 内容采集
**Reason**: 采集对象从 RSS/Atom 改为东财/新浪/上交所/深交所 HTTP JSON/HTML 端点。
**Migration**: 由新增 "受限的多源快讯与公告采集" 替代，保留"标题 + 合法 HTTP(S) URL 必需、不抓原文正文、
URL 协议校验"等安全边界。

### Requirement: 可浏览的资讯条目与中文标题
**Reason**: 赛道条目列表与标题本地化模型随旧管线删除；新统一流直接展示来源返回的中文标题。
**Migration**: 展示要求并入 "自选相关统一资讯流接口" 与前端统一流。

### Requirement: 每赛道 AI 要点使用项目 LLM 配置
**Reason**: LLM 摘要层整层删除；快讯优先的实时消息面不再包含每赛道 AI 要点。
**Migration**: 无；llm 模块与相关测试在 clean cutover 中删除。

### Requirement: 来源失败隔离与赛道级刷新判定
**Reason**: 赛道级快照模型删除。
**Migration**: 失败隔离与降级由新增 "源健康降级状态机与诚实标注" 承载。

### Requirement: 手动后台刷新与单任务协调
**Reason**: 手动单任务刷新改为后台分层轮询，手动刷新降级为强制补拉。
**Migration**: 由新增 "后台分层轮询与手动强制补拉" 替代（保留 reuse 语义）。

### Requirement: 最新快照的原子持久化与陈旧回退
**Reason**: 单 JSON 快照模型改为 SQLite 有界窗口条目库 + 读取时派生缓存。
**Migration**: 由新增 "SQLite 条目库有界窗口与派生缓存" 替代。

## ADDED Requirements

### Requirement: 免费的自选股资讯入口
系统 SHALL 在侧栏保留"投资资讯"入口并在 `/news` 路由提供无需产品登录、会员身份或付费权益的资讯页面；
页面 SHALL 以本机自选股为中心组织统一资讯流，MUST NOT 保留 12 赛道视图。

#### Scenario: 访问投资资讯页面
- **WHEN** 用户从侧栏选择"投资资讯"
- **THEN** 系统导航至 `/news`，显示与自选股相关的统一资讯流，且不触发任何登录或付费门控

#### Scenario: 空自选引导
- **WHEN** 本机自选列表为空
- **THEN** 页面显示引导添加自选股的空状态并提供前往自选管理的入口

### Requirement: 受限的多源快讯与公告采集
系统 SHALL 从东方财富 7x24 与新浪滚动并行采集快讯（东财优先，新浪交叉验证与降级兜底），并从上交所
公告接口（主，jsonp）与深交所公告 HTML 频道（备）采集公告。系统 SHALL 仅持久化来源端点返回的标题与
短摘要（≤500 字符），MUST NOT 抓取条目原文正文或由后端代理原文链接；原文跳转由用户浏览器直接打开。
条目 URL SHALL 仅接受 http/https 协议并在展示前校验。同源条目 SHALL 以 (source, item_id) 去重；
跨源标题近似（simhash 相似度 ≥0.7）SHALL 合并，保留多源链接并取最早发布时间。URL 规范化 SHALL
剥离 utm_* / source=* 跟踪参数。

#### Scenario: 快讯并行采集
- **WHEN** 后台轮询执行快讯增量拉取
- **THEN** 东财与新浪并行工作，任一可用即继续入库；全源失败时回放本地缓存并诚实标注

#### Scenario: 公告降级链
- **WHEN** 上交所公告接口失败
- **THEN** 系统切换到深交所公告 HTML 频道采集，并把该状态反映到源健康

#### Scenario: 不抓取原文正文
- **WHEN** 条目携带原文链接
- **THEN** 系统仅保存该链接，不请求或存储页面正文

#### Scenario: 跨源近似合并
- **WHEN** 不同来源的条目标题 simhash 相似度 ≥0.7
- **THEN** 系统合并为一条，保留多源链接并取最早发布时间

### Requirement: 后台分层轮询与手动强制补拉
系统 SHALL 在现有 FastAPI 进程内以后台分层任务轮询快讯源（15-30s，以 since_id 为游标增量拉取）与公告源
（5-10min 增量）。系统 SHALL 保留手动刷新 POST /news-api/watchlist-feed/refresh 作为强制补拉：触发快讯源
立即增量拉取、公告源仅当上次拉取超过 2 分钟时触发；补拉任务运行中重复触发 SHALL 返回 202 与当前任务状态
且不启动第二个任务（reuse 语义）；距上次触发不足 5 秒 SHALL 返回 429；响应为
{ "accepted": boolean, "task_id": "uuid|null", "reused": boolean }，异步受理不同步等待完成。

#### Scenario: 后台自动轮询
- **WHEN** FastAPI sidecar 运行中
- **THEN** 快讯源按 15-30s、公告源按 5-10min 自动增量采集入库，无需用户触发

#### Scenario: 手动强制补拉
- **WHEN** 用户触发手动刷新
- **THEN** 系统立即执行一次快讯增量拉取并快速返回受理结果

#### Scenario: 运行中重复触发
- **WHEN** 补拉任务运行中再次收到刷新请求
- **THEN** 返回 202 与运行中任务状态（reused=true），不启动第二个任务

#### Scenario: 触发过于频繁
- **WHEN** 距上次手动触发不足 5 秒
- **THEN** 返回 429

### Requirement: SQLite 条目库有界窗口与派生缓存
系统 SHALL 将快讯与公告统一持久化到本机 SQLite ~/.vibe-trading/news.db，仅保留活跃窗口：快讯 24 小时、
公告 7 天；清理任务 SHALL 持续删除超窗条目；系统 MUST NOT 提供跨窗口历史。读取时系统 SHALL 按本机自选股
内容执行匹配并按 (watchlist_version, 条目库写入代数 generation, after_cursor, before_cursor, limit) 缓存派生结果；
派生缓存值 SHALL 存条目键有序表并在读取时与条目库 join（清理后的条目不得 replay）；自选增删 SHALL 经内容版本键
变化自然失效缓存。条目字段 SHALL 包含 (source, item_id, published_at, title, summary, url, matched_codes, confidence)，
其中 matched_codes/confidence 为预留字段，入库时保持空值。

#### Scenario: 窗口清理
- **WHEN** 条目超过其类型留存窗口（快讯 24h / 公告 7d）
- **THEN** 清理任务物理删除该条目，任何接口不再返回

#### Scenario: 窗口内游标分页
- **WHEN** 客户端携带 next_cursor 再次读取
- **THEN** 返回窗口内更早的下一页；窗口外数据物理不存在

#### Scenario: 后加自选可追溯窗口内条目
- **WHEN** 用户把新股票加入自选
- **THEN** 下次读取时该股票 24h 快讯窗口内的历史条目即被匹配呈现（匹配在读取时执行，非入库时）

### Requirement: 源健康降级状态机与诚实标注
系统 SHALL 将请求健康与内容新鲜度分离：单源连续 3 次失败或游标停滞 ≥3 轮判定 degraded；429/403 按
30→60→120 秒加抖动指数退避、上限 3 次后切备源；degraded 源每 60 秒探活、连续 3 次成功回切并补拉。
内容新鲜度 SHALL 由 TradingCalendar 抽象控制（is_trading_day / current_session /
expected_flash_interval），默认实现 ConservativeCalendar 将所有工作日视为交易时段、零外部依赖。响应
SHALL 返回每个源的状态（source_id ∈ {eastmoney,sina,sse,szse}，state ∈ {ok,degraded,failed}，
last_success_at ISO8601|null，last_error 非敏感摘要|null）；全源失败时页面 SHALL 显示
"数据可能延迟，最后更新:{timestamp}" 横幅。巨潮（WAF 446）与财联社（需 sign）MUST NOT 进入首版降级链。

#### Scenario: 单源降级
- **WHEN** 某源连续 3 次失败或游标停滞 ≥3 轮
- **THEN** 该源标记 degraded 并以小字提示，其余源不受影响

#### Scenario: 限流退避
- **WHEN** 某源返回 429 或 403
- **THEN** 按 30→60→120 秒加抖动退避，连续 3 次后停止轮询该源并依赖备源

#### Scenario: 探活回切
- **WHEN** degraded 源探活连续 3 次成功
- **THEN** 该源回切为 ok 并补拉

#### Scenario: 全源失败诚实标注
- **WHEN** 全部源失败
- **THEN** source_health 全部为 failed，页面顶部显示横幅与最后更新时间

### Requirement: 自选相关统一资讯流接口
系统 SHALL 提供 GET /news-api/watchlist-feed?after_cursor=<水位游标>&before_cursor=<翻页游标>&limit=50（挂 require_auth）。
两个游标参数正交且互斥（同传 SHALL 返回 400）：after_cursor 为轮询水位，只返回比它更新的条目，响应 new_cursor
为推进后的水位（无新条目时原样回传）；before_cursor 为翻页游标，只返回比它更早的条目，响应 next_cursor 指向
更早一页（null 表示窗口内已无更多）。首屏（两游标皆空）从窗口头部取最新一页并同时返回 new_cursor 与
next_cursor。游标均为不透明字符串，客户端 MUST NOT 解析内部结构；游标不可解析时 SHALL 返回 400 而非静默重置。
after_cursor 模式按 published_at 升序交付最旧未交付页（前端 reverse 展示），一轮涌入超过 limit 条也不丢不重。
items 上限 50 条、按 published_at 新→旧
排序；last_updated_at 为最近一次成功入库时间或 null；watchlist_version 为 64 位十六进制 sha256（空自选也有
确定哈希）。请求中任一游标（after_cursor 或 before_cursor）绑定的 watchlist_version 与当前不一致时 SHALL
返回 reset_required=true，且该游标被视为空（items 从窗口头部重新匹配），前端应丢弃旧游标。FeedItem SHALL 含
id/source/type(flash|announcement)/published_at/title/summary(≤500)/url(可选)/matched_stocks[{
code,name,match_rule ∈ {structured_field,code_pattern,name_exact}}]/confidence(high|medium)。边界响应：空自选
列表返回 items=[]、new_cursor=null、next_cursor=null、reset_required=false 且其余字段正常；全源失败且无缓存
返回 items=[] 且 source_health 全部 failed；全源失败但有窗口内缓存返回缓存条目 + source_health 全部 failed。
三级置信度：高=来源结构化代码字段直接映射（东财 stockList，1. 前缀=沪市 600/601/603/605/688，0. 前缀=深市
000/001/002/003/300/301，北交所前缀未确认首版跳过）叠加正文 6 位代码上下文护栏；中=自选名称精确匹配；
低=板块/概念间接关联首版不做、仅预留字段，低置信度条目 MUST NOT 返回或展示。

#### Scenario: 读取统一流
- **WHEN** 已登录客户端请求 watchlist-feed（不带游标）
- **THEN** 返回窗口头部最新一页与自选匹配的统一流（新→旧），含源健康、内容版本键、new_cursor 与 next_cursor

#### Scenario: 短轮询增量拉取
- **WHEN** 客户端携带 after_cursor=new_cursor 轮询
- **THEN** 只返回比该水位更新的条目，new_cursor 推进到本页最旧返回行；无新条目时 items=[] 且水位原样回传

#### Scenario: 上滑加载更早
- **WHEN** 客户端携带 before_cursor=next_cursor 翻页
- **THEN** 只返回更早的条目，next_cursor 指向更早一页；窗口耗尽时 next_cursor=null

#### Scenario: 自选变化游标重置
- **WHEN** 请求中任一游标绑定的 watchlist_version 与当前不一致
- **THEN** 返回 reset_required=true，该游标视为空且 items 从窗口头部重新匹配

### Requirement: 明确限定首版功能范围
首版系统 MUST NOT 提供跨留存窗口的资讯历史、搜索、日期筛选、收藏、已读状态或消息推送，也 MUST NOT 为
新闻模块启动第二个后端服务或引入独立账户体系。首版 SHALL 允许后台定时轮询，并 SHALL 允许留存窗口内以
next_cursor + limit 游标分页作为唯一回溯手段。

#### Scenario: 使用首版页面
- **WHEN** 用户访问投资资讯模块
- **THEN** 页面只提供窗口内统一流浏览、原文跳转、手动强制补拉、源健康提示与窗口内分页，不提供范围外入口

### Requirement: 隔离键为本机自选内容版本键
系统 SHALL 以本机 watchlist 内容计算隔离键：watchlist_version = sha256(sorted((code, name, market) triples)，名称参与匹配，回填/改名必须使缓存失效。
系统 MUST NOT 引入用户身份体系，MUST NOT 设计为"按认证用户隔离"；匹配器 SHALL 直读本机
~/.vibe-trading/watchlist.db SQLite，MUST NOT 经未鉴权 HTTP 端点获取自选数据。

#### Scenario: 自选增删失效派生
- **WHEN** 用户添加或删除自选股
- **THEN** watchlist_version 变化，旧派生缓存自然失效

#### Scenario: 无身份体系
- **WHEN** 多人共用同一台设备
- **THEN** 资讯隔离仅由自选列表内容决定，与任何账户无关

### Requirement: 自选名称解析为匹配前置
系统 SHALL 在添加自选股时通过既有行情提供者解析证券简称写入本机自选库，并 SHALL 对存量 name 为空的行
执行回填；解析失败时 SHALL 保留空名称且不阻断添加。中置信度名称匹配依赖该名称。

#### Scenario: 添加自选解析名称
- **WHEN** 用户添加自选股 600519
- **THEN** 系统解析证券简称并写入自选库

#### Scenario: 存量回填
- **WHEN** 自选库存在 name 为空的行
- **THEN** 系统批量解析并回填，失败行保持空名称
```

- [ ] **Step 4: 校验并提交**

```bash
grep -c "^### Requirement:" openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub/spec.md
# Expected: 15（7 REMOVED + 8 ADDED）
grep -c "^#### Scenario:" openspec/changes/2026-08-29-news-watchlist-refactor/specs/investment-news-hub/spec.md
# Expected: ≥ 26
git add openspec/changes/2026-08-29-news-watchlist-refactor
git commit -s -m "docs(openspec): propose watchlist-centric news refactor change"
```

---

### Task 1 (T0): 自选名称解析 + 存量回填

**Files:**
- Modify: `agent/src/api/watchlist_routes.py`（`add_stock._insert` :186-196 硬编码 `name=''`；`register_watchlist_routes` :284-286；模块级新增 `name_provider`/`_resolve_names`/`backfill_missing_names`）
- Modify: `agent/api_server.py:378`（导入 backfill）与 `agent/api_server.py:246`（startup 调用回填）
- Test: `agent/tests/test_watchlist_name_resolution.py`（Create）

**Interfaces:**
- Consumes: `TencentQuoteProvider.fetch(codes: list[str]) -> dict[str, dict]`（watchlist_routes.py:50-74，quote 含 `name` 键）；`_get_connection()`/`_init_db()`（:90-120）。
- Produces: 模块属性 `name_provider: QuoteProvider | None`（测试/注册注入点，None=不解析）；`backfill_missing_names(batch_size: int = 50) -> int`（同步，供 executor 调用）；watchlist.db 的 `name` 列被写为证券简称（Task 6 名称匹配数据源）。

- [ ] **Step 1: 写失败测试**

写入 `agent/tests/test_watchlist_name_resolution.py`：

```python
"""TDD：添加自选解析证券名称 + 存量空名称回填（规格 §4.2）。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.watchlist_routes as wm


class FakeProvider:
    market = "a_stock"

    def __init__(self, names: dict[str, str]) -> None:
        self.names = names
        self.calls: list[list[str]] = []

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        self.calls.append(list(codes))
        return {code: {"code": code, "name": self.names.get(code, "")} for code in codes}


class BrokenProvider:
    market = "a_stock"

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        raise RuntimeError("quote source down")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    monkeypatch.setattr(wm, "name_provider", None)
    wm._init_db()
    app = FastAPI()
    app.include_router(wm.router)
    return TestClient(app)


def test_add_stock_resolves_name(client, monkeypatch):
    monkeypatch.setattr(wm, "name_provider", FakeProvider({"600519": "贵州茅台"}))
    assert client.post("/watchlist/stocks", json={"code": "600519"}).json() == {"added": True, "exists": False}
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == "贵州茅台"


def test_add_stock_without_provider_keeps_empty_name(client):
    resp = client.post("/watchlist/stocks", json={"code": "600519"})
    assert resp.json()["added"] is True
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == ""


def test_add_stock_keeps_empty_name_when_provider_fails(client, monkeypatch):
    monkeypatch.setattr(wm, "name_provider", BrokenProvider())
    assert client.post("/watchlist/stocks", json={"code": "600519"}).json()["added"] is True
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == ""


def test_backfill_updates_only_resolved_rows(client, monkeypatch):
    provider = FakeProvider({"000001": "平安银行"})
    monkeypatch.setattr(wm, "name_provider", provider)
    with wm._get_connection() as conn:
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('000001', '', 'a_stock')")
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('600519', '', 'a_stock')")
        conn.commit()

    updated = wm.backfill_missing_names()

    assert updated == 1  # 600519 解析结果为空名 → 保持空名称
    with wm._get_connection() as conn:
        rows = dict(conn.execute("SELECT code, name FROM watchlist").fetchall())
    assert rows == {"000001": "平安银行", "600519": ""}


def test_backfill_no_provider_noop(client, tmp_path):
    with wm._get_connection() as conn:
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('000001', '', 'a_stock')")
        conn.commit()
    assert wm.backfill_missing_names() == 0  # 未注入 provider → 不触网、不改数据


def test_register_injects_default_provider(monkeypatch):
    monkeypatch.setattr(wm, "name_provider", None)
    app = FastAPI()
    wm.register_watchlist_routes(app)
    assert wm.name_provider is wm._DEFAULT_PROVIDER
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/test_watchlist_name_resolution.py -v
```
Expected: FAIL——`AttributeError: module 'src.api.watchlist_routes' has no attribute 'name_provider'`。

- [ ] **Step 3: 最小实现**

修改 `agent/src/api/watchlist_routes.py`：

在 `_DEFAULT_PROVIDER = TencentQuoteProvider()`（:221）附近新增：

```python
# 名称解析注入点：None = 不解析（直连 router 的测试保持离线）；
# 生产路径由 register_watchlist_routes 注入 _DEFAULT_PROVIDER。
name_provider: QuoteProvider | None = None


def _resolve_names(codes: list[str]) -> dict[str, str]:
    """批量解析证券简称；行情源失败返回空映射，不阻断添加/回填。"""
    if name_provider is None:
        return {}
    try:
        quotes = name_provider.fetch(codes)
    except Exception:
        return {}
    return {code: str(quotes.get(code, {}).get("name") or "") for code in codes}


def backfill_missing_names(batch_size: int = 50) -> int:
    """回填存量 name='' 行（规格 §4.2）；返回成功回填数量，失败行保持空名称。"""
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT code FROM watchlist WHERE IFNULL(name, '') = '' LIMIT ?", (batch_size,)
        ).fetchall()
    names = _resolve_names([str(row[0]) for row in rows])
    updated = 0
    with _get_connection() as conn:
        for code, stock_name in names.items():
            if not stock_name:
                continue
            cursor = conn.execute(
                "UPDATE watchlist SET name = ? WHERE code = ? AND IFNULL(name, '') = ''",
                (stock_name, code),
            )
            updated += cursor.rowcount
        conn.commit()
    return updated
```

把 `add_stock._insert`（:186-196）中的 `VALUES (?, '', ?)` 改为解析名：

```python
    def _insert():
        name = _resolve_names([req.code]).get(req.code, "")
        try:
            with _get_connection() as conn:
                conn.execute(
                    "INSERT INTO watchlist(code, name, market) VALUES (?, ?, ?)",
                    (req.code, name, req.market),
                )
                conn.commit()
            return {"added": True, "exists": False}
        except sqlite3.IntegrityError:
            return {"added": False, "exists": True}
```

把 `register_watchlist_routes`（:284-286）改为注入默认 provider：

```python
def register_watchlist_routes(app, require_local_or_auth_dep=None) -> None:
    """挂载 watchlist 路由到 FastAPI app；生产注入默认名称解析 provider。"""
    global name_provider
    if name_provider is None and tencent_quote is not None:
        name_provider = _DEFAULT_PROVIDER
    app.include_router(router)
```

修改 `agent/api_server.py:378` 导入与 `:246` startup：

```python
from src.api.watchlist_routes import (  # noqa: E402
    register_watchlist_routes,
    init_db as _watchlist_init_db,
    backfill_missing_names as _watchlist_backfill_names,
)
```

```python
    await _watchlist_init_db()  # 幂等建表；plan 约束：DB 初始化须在 startup，不在首次请求中建
    await asyncio.get_event_loop().run_in_executor(None, _watchlist_backfill_names)  # 存量空名称回填
```

- [ ] **Step 4: 运行验证 PASS + 回归**

```bash
pytest agent/tests/test_watchlist_name_resolution.py agent/tests/test_watchlist_crud.py agent/tests/test_watchlist_routes_skeleton.py -v
ruff check agent/src/api/watchlist_routes.py
```
Expected: 全部 PASS；ruff 无告警（既有 crud 测试不注入 provider → 离线路径不变）。

- [ ] **Step 5: 提交**

```bash
git add agent/src/api/watchlist_routes.py agent/api_server.py agent/tests/test_watchlist_name_resolution.py
git commit -s -m "feat(watchlist): resolve stock names on add and backfill empty names"
```

---

### Task 2 (T1): TradingCalendar Protocol + ConservativeCalendar

**Files:**
- Create: `agent/src/news/calendar.py`
- Test: `agent/tests/news/test_calendar.py`（Create）

**Interfaces:**
- Consumes: 无（零外部依赖）。
- Produces: `TradingCalendar` Protocol（`is_trading_day(day: date) -> bool`；`current_session(at: datetime) -> str` 返回 `"open"|"closed"`；`expected_flash_interval() -> float` 秒）；`ConservativeCalendar`（周一~周五视为交易时段；周末 closed；expected_flash_interval=30.0）。Task 4 的 `HealthTracker` 消费。

- [ ] **Step 1: 写失败测试**

写入 `agent/tests/news/test_calendar.py`：

```python
"""TDD：TradingCalendar 抽象与 ConservativeCalendar 兜底实现（规格 §5.2）。"""
from __future__ import annotations

from datetime import datetime, timezone

from src.news.calendar import ConservativeCalendar, TradingCalendar

# 2026-08-26 周三（交易时段判定样本）；2026-08-30 周日
WEDNESDAY = datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc)
SUNDAY = datetime(2026, 8, 30, 10, 0, tzinfo=timezone.utc)


def test_protocol_structure():
    calendar: TradingCalendar = ConservativeCalendar()
    assert callable(calendar.is_trading_day)
    assert callable(calendar.current_session)
    assert callable(calendar.expected_flash_interval)


def test_conservative_calendar_treats_weekdays_as_sessions():
    calendar = ConservativeCalendar()
    assert calendar.is_trading_day(WEDNESDAY.date()) is True
    assert calendar.current_session(WEDNESDAY) == "open"


def test_conservative_calendar_closes_weekends():
    calendar = ConservativeCalendar()
    assert calendar.is_trading_day(SUNDAY.date()) is False
    assert calendar.current_session(SUNDAY) == "closed"


def test_expected_flash_interval_is_infinite():
    import math

    assert math.isinf(ConservativeCalendar().expected_flash_interval())  # 静默永不触发 degraded（§5.2）
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_calendar.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.calendar'`。

- [ ] **Step 3: 最小实现**

写入 `agent/src/news/calendar.py`：

```python
"""Trading-calendar abstraction separating content freshness from request health (spec §5.2)."""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Protocol


class TradingCalendar(Protocol):
    """内容新鲜度判定接口：交易时段内的静默才参与游标停滞计数。"""

    def is_trading_day(self, day: date) -> bool:
        """Return True when *day* is a trading day."""
        ...

    def current_session(self, at: datetime) -> str:
        """Return "open" or "closed" for the session containing *at*."""
        ...

    def expected_flash_interval(self) -> float:
        """Return the expected flash cadence in seconds."""
        ...


class ConservativeCalendar:
    """默认兜底实现：所有工作日视为交易时段，内容静默永不触发 degraded（规格 §5.2 安全兜底）。"""

    def is_trading_day(self, day: date) -> bool:
        return day.weekday() < 5

    def current_session(self, at: datetime) -> str:
        return "open" if at.weekday() < 5 else "closed"

    def expected_flash_interval(self) -> float:
        return math.inf  # 期望间隔无穷大 → 停滞判定永不为真（静默永不降级）
```

- [ ] **Step 4: 运行验证 PASS**

```bash
pytest agent/tests/news/test_calendar.py -v
ruff check agent/src/news/calendar.py
```
Expected: 4 PASS。

- [ ] **Step 5: 提交**

```bash
git add agent/src/news/calendar.py agent/tests/news/test_calendar.py
git commit -s -m "feat(news): add TradingCalendar protocol with ConservativeCalendar default"
```

---

### Task 3 (T-A): transport.py 通用化传输层提取

**Files:**
- Create: `agent/src/news/transport.py`
- Test: `agent/tests/news/test_transport.py`（Create）

**Interfaces:**
- Consumes: `agent/src/news/network.py` 的 SSRF 校验/重定向/限流/熔断实现（提取源）；**不导入** `src.news.catalog`（剥离 catalog 依赖）。
- Produces（Task 4/5 消费，字段名照规格 §6.5 逐字）: `TransportRequest`（url, method: Literal["GET","POST"], headers: Mapping[str,str]|None, body: bytes|None, content_type: str|None, query: Mapping[str,str]|None, max_redirects: int=3, allowed_content_types: frozenset[str]=frozenset({"application/json","text/html","text/plain"}), max_response_bytes: int=2*1024*1024）；`TransportResponse`（status_code, content_type, body: bytes, elapsed_ms: float, final_url: str）；`TransportError(Exception)`（`.code` 稳定非敏感错误码）；`TransportClient(resolver=None, transport=None, sleep=asyncio.sleep, now=time.monotonic).fetch(request) -> TransportResponse`。错误码集合：`invalid_url|unsupported_scheme|dns_failed|unsafe_target|too_many_redirects|invalid_redirect|rate_limited|forbidden|http_status|response_too_large|unsupported_content_type|timeout|network_error|circuit_open`。硬编码 RSS Accept 头（network.py:135-143）剥离——headers 由调用方传入；单主机并发上限按规格 §5.4 收紧为 2。

- [ ] **Step 1: 写失败测试（规格 §6.5 七条 + 重试/熔断/SSRF）**

写入 `agent/tests/news/test_transport.py`：

```python
"""TDD：通用化传输层（规格 §6.5 七条验收 + 重试/熔断/SSRF 回归）。"""
from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any, Callable

import httpx
import pytest

from src.news.transport import TransportClient, TransportError, TransportRequest


class FakeResolver:
    def __init__(self, addresses: dict[str, list[str]]) -> None:
        self.addresses = addresses
        self.calls: list[str] = []

    async def resolve(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.addresses.get(host, ["93.184.216.34"])


class FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict[str, httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses[str(request.url)]


class QueuedTransport(httpx.AsyncBaseTransport):
    """按调用次序弹出响应，用于重试/熔断序列。"""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses.pop(0)


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


async def _no_sleep(_seconds: float) -> None:
    return None


def _client(responses: dict[str, httpx.Response], resolver: FakeResolver | None = None) -> tuple[TransportClient, FakeTransport]:
    fake = FakeTransport(responses)
    client = TransportClient(resolver=resolver or FakeResolver({}), transport=fake, sleep=_no_sleep)
    return client, fake


BASE = "https://feeds.example.test"


@_async_test
async def test_get_json_roundtrip():
    client, fake = _client({
        "https://93.184.216.34/json": httpx.Response(200, headers={"content-type": "application/json"}, json={"ok": True}),
    })
    response = await client.fetch(TransportRequest(url=f"{BASE}/json"))
    assert response.status_code == 200
    assert response.content_type == "application/json"
    assert response.body == b'{"ok":true}'
    assert response.final_url == f"{BASE}/json"
    assert response.elapsed_ms >= 0.0
    sent = fake.requests[0]
    assert sent.method == "GET"
    assert sent.extensions["sni_hostname"] == "feeds.example.test"


@_async_test
async def test_post_body_and_content_type_sent():
    client, fake = _client({
        "https://93.184.216.34/post": httpx.Response(200, headers={"content-type": "application/json"}, json={}),
    })
    await client.fetch(TransportRequest(
        url=f"{BASE}/post", method="POST",
        body=b"pageHelp.pageSize=25", content_type="application/x-www-form-urlencoded",
    ))
    sent = fake.requests[0]
    assert sent.method == "POST"
    assert sent.headers["content-type"] == "application/x-www-form-urlencoded"
    assert sent.read() == b"pageHelp.pageSize=25"


@_async_test
async def test_jsonp_received_as_text_plain():
    payload = b'jsonpCallback({"data": []})'
    client, _ = _client({
        "https://93.184.216.34/jsonp": httpx.Response(200, headers={"content-type": "text/plain"}, content=payload),
    })
    response = await client.fetch(TransportRequest(url=f"{BASE}/jsonp"))
    assert response.content_type == "text/plain"
    assert response.body == payload


@_async_test
async def test_html_within_whitelist():
    client, _ = _client({
        "https://93.184.216.34/page": httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=b"<html></html>"),
    })
    response = await client.fetch(TransportRequest(url=f"{BASE}/page"))
    assert response.content_type == "text/html"
    assert response.body == b"<html></html>"


@_async_test
async def test_redirect_hop_revalidates_ssrf():
    resolver = FakeResolver({"feeds.example.test": ["93.184.216.34"], "evil.example.test": ["127.0.0.1"]})
    client, fake = _client({
        "https://93.184.216.34/redir": httpx.Response(302, headers={"location": "http://evil.example.test/x"}),
    }, resolver=resolver)
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/redir"))
    assert excinfo.value.code == "unsafe_target"
    assert len(fake.requests) == 1  # 第二跳在 SSRF 校验处被拒，未发出请求


@_async_test
async def test_oversized_body_rejected():
    client, _ = _client({
        "https://93.184.216.34/big": httpx.Response(200, headers={"content-type": "application/json"}, content=b"x" * 100),
    })
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/big", max_response_bytes=8))
    assert excinfo.value.code == "response_too_large"


@_async_test
async def test_non_whitelisted_content_type_rejected():
    client, _ = _client({
        "https://93.184.216.34/rss": httpx.Response(200, headers={"content-type": "application/xml"}, content=b"<rss/>"),
    })
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/rss"))
    assert excinfo.value.code == "unsupported_content_type"


@_async_test
async def test_retry_on_429_then_success():
    transport = QueuedTransport([
        httpx.Response(429, headers={"retry-after": "0", "content-type": "text/plain"}),
        httpx.Response(200, headers={"content-type": "application/json"}, json={}),
    ])
    client = TransportClient(transport=transport, sleep=_no_sleep)
    response = await client.fetch(TransportRequest(url=f"{BASE}/retry"))
    assert response.status_code == 200
    assert len(transport.requests) == 2


@_async_test
async def test_forbidden_maps_to_stable_code():
    client, _ = _client({
        "https://93.184.216.34/deny": httpx.Response(403, headers={"content-type": "text/plain"}),
    })
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/deny"))
    assert excinfo.value.code == "forbidden"


@_async_test
async def test_circuit_opens_after_repeated_failures():
    transport = QueuedTransport([httpx.Response(500, headers={"content-type": "text/plain"}) for _ in range(9)])
    client = TransportClient(transport=transport, sleep=_no_sleep)
    for _ in range(3):  # 每次请求内部重试 3 次 → 9 次真实请求后熔断
        with pytest.raises(TransportError) as excinfo:
            await client.fetch(TransportRequest(url=f"{BASE}/flaky"))
        assert excinfo.value.code == "http_status"
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/flaky"))
    assert excinfo.value.code == "circuit_open"
    assert len(transport.requests) == 9


@_async_test
async def test_unsafe_direct_target_rejected():
    resolver = FakeResolver({"loopback.example.test": ["127.0.0.1"]})
    client, _ = _client({}, resolver=resolver)
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url="http://loopback.example.test/x"))
    assert excinfo.value.code == "unsafe_target"
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_transport.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.transport'`。

- [ ] **Step 3: 最小实现**

写入 `agent/src/news/transport.py`（从 network.py 提取，剥离 catalog/RSS 耦合）：

```python
"""Generalized, SSRF-hardened transport extracted from network.py (catalog-free, spec §6.5)."""

from __future__ import annotations

import asyncio
import ipaddress
import math
import socket
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from weakref import WeakKeyDictionary
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import SplitResult, urlencode, urljoin, urlsplit, urlunsplit

import httpx

CONNECT_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 15.0
TOTAL_FETCH_TIMEOUT_SECONDS = 15.0
MAX_CONCURRENT_REQUESTS = 16
MAX_CONCURRENT_REQUESTS_PER_HOST = 2  # 规格 §5.4：单 IP 并发 ≤2
MAX_HOST_SEMAPHORE_CACHE_SIZE = 64
READ_CHUNK_BYTES = 64 * 1024
MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = frozenset({408, 429, *range(500, 600)})
RETRY_BASE_DELAY_SECONDS = 1.0
CIRCUIT_FAILURE_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECONDS = 60.0
# Transparent proxy Fake-IP mode uses this RFC 2544 benchmarking range for approved hosts.
_PROXY_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")


class TransportError(Exception):
    """Transport failure carrying a stable, non-sensitive error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _Retryable(Exception):
    """Internal: failure that should consume another attempt."""

    def __init__(self, code: str, retry_after: float | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


@dataclass(frozen=True)
class TransportRequest:
    """Caller-controlled generalized request contract (spec §6.5, verbatim fields)."""

    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: Mapping[str, str] | None = None
    body: bytes | None = None
    content_type: str | None = None
    query: Mapping[str, str] | None = None
    max_redirects: int = 3
    allowed_content_types: frozenset[str] = frozenset({"application/json", "text/html", "text/plain"})
    max_response_bytes: int = 2 * 1024 * 1024


@dataclass(frozen=True)
class TransportResponse:
    """Content-type-validated response payload (spec §6.5, verbatim fields)."""

    status_code: int
    content_type: str
    body: bytes
    elapsed_ms: float
    final_url: str


class HostResolver(Protocol):
    """Resolve a hostname to numeric IP addresses."""

    async def resolve(self, host: str) -> Sequence[str]: ...


class _SystemResolver:
    async def resolve(self, host: str) -> Sequence[str]:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
        return tuple(record[4][0] for record in records)


@dataclass
class _CircuitState:
    failures: int = 0
    opened_until: float | None = None


class _Circuit:
    """Keep transient endpoint failures from repeatedly consuming transport capacity."""

    def __init__(self) -> None:
        self._states: dict[str, _CircuitState] = {}

    def is_open(self, url: str, now: float) -> bool:
        state = self._states.get(url)
        return state is not None and state.opened_until is not None and state.opened_until > now

    def record_success(self, url: str) -> None:
        self._states.pop(url, None)

    def record_failure(self, url: str, now: float) -> None:
        state = self._states.setdefault(url, _CircuitState())
        state.failures += 1
        if state.failures >= CIRCUIT_FAILURE_THRESHOLD:
            state.opened_until = now + CIRCUIT_COOLDOWN_SECONDS


@dataclass
class _HostLimiter:
    semaphore: asyncio.Semaphore
    reservations: int = 0


@dataclass(frozen=True)
class _RequestTarget:
    request_url: str
    hostname: str
    host_header: str


def _host_with_port(hostname: str, port: int | None) -> str:
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{rendered_host}:{port}" if port is not None else rendered_host


def _normalized_hostname(value: str) -> str | None:
    try:
        hostname = urlsplit(value).hostname
    except ValueError:
        return None
    if not hostname:
        return None
    try:
        return hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return None


def _request_url(parsed: SplitResult, address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int | None) -> str:
    rendered_address = f"[{address.compressed}]" if address.version == 6 else address.compressed
    netloc = f"{rendered_address}:{port}" if port is not None else rendered_address
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", parsed.query, ""))


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        delay = float(value)
    except ValueError:
        return None
    return delay if math.isfinite(delay) and delay >= 0 else None


def _content_length_too_large(response: httpx.Response, maximum: int) -> bool:
    try:
        return int(response.headers.get("content-length", "0")) > maximum
    except ValueError:
        return False


async def _read_body(response: httpx.Response, maximum: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes(chunk_size=READ_CHUNK_BYTES):
        body.extend(chunk)
        if len(body) > maximum:
            raise TransportError("response_too_large")
    return bytes(body)


class TransportClient:
    """Fetch one generalized request with SSRF validation, redirects, retries and a circuit."""

    _semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()
    _host_semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, OrderedDict[str, _HostLimiter]] = WeakKeyDictionary()

    def __init__(
        self,
        resolver: HostResolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._resolver = resolver or _SystemResolver()
        self._transport = transport
        self._sleep = sleep
        self._now = now
        self._circuit = _Circuit()

    async def fetch(self, request: TransportRequest) -> TransportResponse:
        """Fetch *request*, raising TransportError with a stable code on failure."""
        try:
            async with asyncio.timeout(TOTAL_FETCH_TIMEOUT_SECONDS):
                if self._circuit.is_open(request.url, self._now()):
                    raise TransportError("circuit_open")
                for attempt in range(MAX_ATTEMPTS):
                    try:
                        response = await self._fetch_once(request)
                        self._circuit.record_success(request.url)
                        return response
                    except _Retryable as retryable:
                        if attempt == MAX_ATTEMPTS - 1:
                            self._circuit.record_failure(request.url, self._now())
                            raise TransportError(retryable.code) from None
                        await self._sleep(self._retry_delay(attempt, retryable.retry_after))
        except TimeoutError:
            self._circuit.record_failure(request.url, self._now())
            raise TransportError("timeout") from None
        raise TransportError("network_error")  # pragma: no cover - unreachable

    async def _fetch_once(self, request: TransportRequest) -> TransportResponse:
        current_url = request.url
        if request.query:
            separator = "&" if "?" in current_url else "?"
            current_url = current_url + separator + urlencode(list(request.query.items()))
        configured_hostname = _normalized_hostname(request.url)
        redirects = 0
        timeout = httpx.Timeout(
            connect=CONNECT_TIMEOUT_SECONDS,
            read=READ_TIMEOUT_SECONDS,
            write=READ_TIMEOUT_SECONDS,
            pool=CONNECT_TIMEOUT_SECONDS,
        )
        method = request.method.upper()
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                timeout=timeout,
                limits=httpx.Limits(max_keepalive_connections=0),
            ) as client:
                while True:
                    target, error_code = await self._validated_target(
                        current_url, allowed_fake_ip_hostname=configured_hostname
                    )
                    if error_code is not None:
                        raise TransportError(error_code)
                    assert target is not None
                    headers = {"Host": target.host_header, "Connection": "close"}
                    if request.headers:
                        headers.update(dict(request.headers))
                    if request.content_type is not None:
                        headers["Content-Type"] = request.content_type
                    try:
                        http_request = httpx.Request(
                            method,
                            target.request_url,
                            headers=headers,
                            content=request.body,
                            extensions={"sni_hostname": target.hostname},
                        )
                    except (UnicodeError, ValueError, httpx.InvalidURL):
                        raise TransportError("invalid_url") from None
                    async with self._host_limit(target.hostname):
                        async with self._semaphore():
                            started = time.perf_counter()
                            response = await client.send(http_request, stream=True)
                            try:
                                if response.is_redirect:
                                    if redirects >= request.max_redirects:
                                        raise TransportError("too_many_redirects")
                                    location = response.headers.get("location")
                                    if not location:
                                        raise TransportError("invalid_redirect")
                                    current_url = urljoin(current_url, location)
                                    redirects += 1
                                    continue  # 每一跳都重新走 SSRF 校验
                                if response.status_code < 200 or response.status_code >= 300:
                                    retry_after = _retry_after(response) if response.status_code == 429 else None
                                    if response.status_code == 429:
                                        code = "rate_limited"
                                    elif response.status_code == 403:
                                        code = "forbidden"
                                    else:
                                        code = "http_status"
                                    if response.status_code in RETRYABLE_STATUS_CODES:
                                        raise _Retryable(code, retry_after)
                                    raise TransportError(code)
                                content_type = (response.headers.get("content-type") or "application/octet-stream")
                                content_type = content_type.split(";")[0].strip().lower()
                                if content_type not in request.allowed_content_types:
                                    raise TransportError("unsupported_content_type")
                                if _content_length_too_large(response, request.max_response_bytes):
                                    raise TransportError("response_too_large")
                                body = await _read_body(response, request.max_response_bytes)
                                return TransportResponse(
                                    status_code=response.status_code,
                                    content_type=content_type,
                                    body=body,
                                    elapsed_ms=(time.perf_counter() - started) * 1000.0,
                                    final_url=current_url,
                                )
                            finally:
                                await response.aclose()
        except httpx.TimeoutException:
            raise _Retryable("timeout") from None
        except httpx.RequestError:
            raise _Retryable("network_error") from None

    @classmethod
    def _semaphore(cls) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        semaphore = cls._semaphores.get(loop)
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
            cls._semaphores[loop] = semaphore
        return semaphore

    @classmethod
    def _host_limiter(cls, hostname: str) -> _HostLimiter:
        loop = asyncio.get_running_loop()
        semaphores = cls._host_semaphores.get(loop)
        if semaphores is None:
            semaphores = OrderedDict()
            cls._host_semaphores[loop] = semaphores
        limiter = semaphores.get(hostname)
        if limiter is None:
            limiter = _HostLimiter(asyncio.Semaphore(MAX_CONCURRENT_REQUESTS_PER_HOST))
            semaphores[hostname] = limiter
        else:
            semaphores.move_to_end(hostname)
        return limiter

    @classmethod
    @asynccontextmanager
    async def _host_limit(cls, hostname: str) -> AsyncIterator[None]:
        limiter = cls._host_limiter(hostname)
        limiter.reservations += 1
        try:
            async with limiter.semaphore:
                yield
        finally:
            limiter.reservations -= 1
            cls._prune_host_limiters()

    @classmethod
    def _prune_host_limiters(cls) -> None:
        semaphores = cls._host_semaphores.get(asyncio.get_running_loop())
        if semaphores is None:
            return
        while len(semaphores) > MAX_HOST_SEMAPHORE_CACHE_SIZE:
            for hostname, limiter in semaphores.items():
                if limiter.reservations == 0:
                    del semaphores[hostname]
                    break
                return

    @staticmethod
    def _retry_delay(attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return retry_after
        return RETRY_BASE_DELAY_SECONDS * (2**attempt)

    async def _validated_target(
        self, value: str, *, allowed_fake_ip_hostname: str | None = None
    ) -> tuple[_RequestTarget | None, str | None]:
        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            return None, "invalid_url"
        if parsed.scheme not in {"http", "https"}:
            return None, "unsupported_scheme"
        if not hostname or parsed.username is not None or parsed.password is not None:
            return None, "invalid_url"
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            return None, "invalid_url"

        try:
            addresses = await self._resolver.resolve(hostname)
        except Exception:  # Resolver implementations are untrusted network boundaries.
            return None, "dns_failed"
        if not addresses:
            return None, "dns_failed"
        try:
            parsed_addresses = tuple(ipaddress.ip_address(address) for address in addresses)
        except ValueError:
            return None, "dns_failed"
        all_proxy_fake_ips = all(address in _PROXY_FAKE_IP_NETWORK for address in parsed_addresses)
        if any(not address.is_global or address.is_multicast for address in parsed_addresses) and not (
            hostname == allowed_fake_ip_hostname and all_proxy_fake_ips
        ):
            return None, "unsafe_target"

        selected = parsed_addresses[0]
        host_header = _host_with_port(hostname, port)
        request_url = _request_url(parsed, selected, port)
        return _RequestTarget(request_url=request_url, hostname=hostname, host_header=host_header), None
```

注意：`network.py` 本任务**不动**（旧 pipeline 仍在用；Task 9 随旧管线一并删除）。

- [ ] **Step 4: 运行验证 PASS + 回归**

```bash
pytest agent/tests/news/test_transport.py agent/tests/news/test_network.py -v
ruff check agent/src/news/transport.py agent/tests/news/test_transport.py
```
Expected: 新 11 条 + 既有 test_network 全部 PASS（network.py 未改 → 无回归）。

- [ ] **Step 5: 提交**

```bash
git add agent/src/news/transport.py agent/tests/news/test_transport.py
git commit -s -m "feat(news): extract generalized SSRF-hardened transport from network.py"
```

---

### Task 4 (T2): 快讯聚合器 + 条目库 + 降级状态机

**Files:**
- Create: `agent/src/news/store.py`（条目库）
- Create: `agent/src/news/health.py`（降级状态机）
- Create: `agent/src/news/flash/__init__.py`（空文件）
- Create: `agent/src/news/flash/service.py`（东财+新浪聚合器）
- Test: `agent/tests/news/test_store.py`、`agent/tests/news/test_health.py`、`agent/tests/news/test_flash_service.py`（Create）

**Interfaces:**
- Consumes: Task 3 `TransportClient/TransportRequest/TransportResponse/TransportError`；Task 2 `TradingCalendar/ConservativeCalendar`。
- Produces: `StoredEntry`（字段见全局契约）；`EntryStore(db_path=None)` 方法 `upsert_entries(entries, now=None) -> int`、`window_merged(limit=50, now=None, before_published_at=None, before_item_id=None) -> list[StoredEntry]`、`purge_expired(now=None) -> None`、`last_updated_at() -> str | None`；`normalize_url(raw: str) -> str`；`SourceHealth` dataclass（source_id, state, last_success_at, last_error, consecutive_failures, stalled_rounds）；`HealthTracker(calendar, now=None)` 方法 `record_success(source_id, *, advanced: bool)`、`record_failure(source_id, error: str)`、`state_of(source_id) -> str`、`snapshot() -> list[SourceHealth]`；`FlashBatch(source, entries: tuple[StoredEntry,...], cursor: str|None, error: str|None)`；`parse_eastmoney(payload: bytes) -> tuple[list[StoredEntry], str | None]`；`parse_sina(payload: bytes) -> list[StoredEntry]`；`FlashAggregator(transport, store, health, sleep=asyncio.sleep, now=time.monotonic)` 方法 `poll_once() -> bool`、`poll_source_now(source: str) -> None`、`run_forever(stop: asyncio.Event)`。

- [ ] **Step 1: 写 store 失败测试**

写入 `agent/tests/news/test_store.py`：

```python
"""TDD：news.db 条目库——窗口/去重/跨源合并/URL 规范化（规格 §3.1/§3.3/§5.5）。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.news.store import FLASH_WINDOW, ANNOUNCEMENT_WINDOW, EntryStore, StoredEntry, normalize_url

NOW = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)


_FLASH_TOPICS = {
    "0": "央行开展逆回购操作",
    "1": "新能源汽车销量创新高",
    "2": "半导体设备出口管制升级",
    "3": "光伏组件价格持续回落",
    "4": "白酒板块资金流向跟踪",
    "old-flash": "隔夜海外市场收盘报道",
    "fresh-flash": "沪深两市早盘高开走势",
}


def _flash(item_id: str, title: str | None = None, published: datetime | None = None, source: str = "eastmoney") -> StoredEntry:
    return StoredEntry(
        source=source, item_id=item_id, type="flash",
        published_at=(published or NOW).isoformat(),
        title=title or _FLASH_TOPICS.get(item_id, f"快讯主题{item_id}"),
        summary="摘要",
        url="", structured_codes=(),
    )


def test_normalize_url_strips_tracking_params():
    assert normalize_url("https://finance.sina.com.cn/a.html?utm_source=x&id=1&source=y") == "https://finance.sina.com.cn/a.html?id=1"
    assert normalize_url("javascript:alert(1)") == ""
    assert normalize_url("https://example.com/ok") == "https://example.com/ok"


def test_upsert_and_window_ordering(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash("1", published=NOW - timedelta(minutes=1)), _flash("0", published=NOW)])
    rows = store.window_merged(limit=10, now=NOW)
    assert [row.item_id for row in rows] == ["0", "1"]  # published_at 新→旧


def test_same_source_dedup_by_item_id(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    assert store.upsert_entries([_flash("a")]) == 1
    assert store.upsert_entries([_flash("a")]) == 0  # (source, item_id) 唯一


def test_cross_source_near_duplicate_merge(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash("sina-1", title="央行宣布降低存款准备金率0.5个百分点", source="sina",
                                 published=NOW - timedelta(hours=1))])
    twin = StoredEntry(
        source="eastmoney", item_id="em-1", type="flash", published_at=NOW.isoformat(),
        title="央行宣布降低存款准备金率0.5个百分点", summary="摘要", url="https://eastmoney.example/x",
        structured_codes=(),
    )
    assert store.upsert_entries([twin], now=NOW) == 0  # simhash ≥0.7 合并，不新增
    rows = store.window_merged(limit=10, now=NOW)
    assert len(rows) == 1
    assert rows[0].source == "sina"  # 保留最早 published_at 的条目
    assert "https://eastmoney.example/x" in rows[0].extra_urls  # 多源链接保留


def test_before_cursor_pagination_returns_older(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash(str(i), published=NOW - timedelta(minutes=i)) for i in range(5)])
    page1 = store.window_merged(limit=2, now=NOW)
    assert len(page1) == 2
    page2 = store.window_merged(limit=2, now=NOW,
                                before_published_at=page1[-1].published_at, before_item_id=page1[-1].item_id)
    assert [row.item_id for row in page2] == ["2", "3"]  # 更早一页（新→旧）


def test_after_cursor_pagination_returns_newer(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash(str(i), published=NOW - timedelta(minutes=i)) for i in range(5)])
    watermark = store.window_merged(limit=10, now=NOW)[-1]  # 最旧条目 "4" 作为水位
    newer = store.window_merged(limit=10, now=NOW,
                                after_published_at=watermark.published_at, after_item_id=watermark.item_id)
    assert [row.item_id for row in newer] == ["0", "1", "2", "3"]  # 严格更新的条目，仍按新→旧排序


def test_purge_expired_windows(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    old_flash = _flash("old-flash", published=NOW - FLASH_WINDOW - timedelta(minutes=5))
    fresh_flash = _flash("fresh-flash", published=NOW - FLASH_WINDOW + timedelta(minutes=5))
    old_ann = StoredEntry(source="sse", item_id="old-ann", type="announcement",
                          published_at=(NOW - ANNOUNCEMENT_WINDOW - timedelta(minutes=5)).isoformat(),
                          title="公告", summary="", url="", structured_codes=())
    fresh_ann = StoredEntry(source="sse", item_id="fresh-ann", type="announcement",
                            published_at=(NOW - ANNOUNCEMENT_WINDOW + timedelta(days=1)).isoformat(),
                            title="季度业绩预告公告", summary="", url="", structured_codes=())
    store.upsert_entries([old_flash, fresh_flash, old_ann, fresh_ann], now=NOW)
    store.purge_expired(now=NOW)
    remaining = {row.item_id for row in store.window_merged(limit=100, now=NOW)}
    assert remaining == {"fresh-flash", "fresh-ann"}


def test_last_updated_at_tracks_ingestion(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    assert store.last_updated_at() is None
    store.upsert_entries([_flash("a")], now=NOW)
    assert store.last_updated_at() is not None
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_store.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.store'`。

- [ ] **Step 3: 实现 store.py**

写入 `agent/src/news/store.py`：

```python
"""Bounded-window SQLite entry store shared by flash and announcement collectors (spec §3.1/§3.3/§5.5)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Literal, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

FLASH_WINDOW = timedelta(hours=24)
ANNOUNCEMENT_WINDOW = timedelta(days=7)
TITLE_DUP_THRESHOLD = 0.7  # simhash 相似度阈值（规格 §5.5）
_NEARDUP_SCAN_LIMIT = 400

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('flash','announcement')),
    published_at TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    structured_codes TEXT NOT NULL DEFAULT '[]',
    extra_urls TEXT NOT NULL DEFAULT '[]',
    matched_codes TEXT NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_type_published ON entries(type, published_at DESC);
"""


def news_db_path() -> Path:
    return Path.home() / ".vibe-trading" / "news.db"


def normalize_url(raw: str) -> str:
    """剥离 utm_* / source=* 跟踪参数；仅接受 http/https，非法输入返回空串（规格 §5.5/§5.8）。"""
    try:
        parsed = urlsplit(raw.strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    kept = [
        (name, value)
        for name, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not (name.lower().startswith("utm_") or name.lower() == "source")
    ]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", urlencode(kept), parsed.fragment))


@dataclass(frozen=True)
class StoredEntry:
    """条目库统一行结构；matched_codes/confidence 为读取时匹配的预留字段（入库恒空）。"""

    source: str
    item_id: str
    type: str
    published_at: str
    title: str
    summary: str
    url: str
    structured_codes: tuple[str, ...]
    extra_urls: tuple[str, ...] = ()


def _simhash64(text: str) -> int:
    tokens = [text[index:index + 2] for index in range(max(len(text) - 1, 0))] or [text]
    weights = [0] * 64
    for token in tokens:
        digest = int.from_bytes(hashlib.md5(token.encode("utf-8")).digest()[:8], "big")
        for bit in range(64):
            weights[bit] += 1 if (digest >> bit) & 1 else -1
    value = 0
    for bit in range(64):
        if weights[bit] > 0:
            value |= 1 << bit
    return value


def title_similarity(left: str, right: str) -> float:
    """simhash 相似度 [0,1]：1 - hamming/64。"""
    return 1.0 - bin(_simhash64(left) ^ _simhash64(right)).count("1") / 64.0


class EntryStore:
    """~/.vibe-trading/news.db：快讯 24h / 公告 7d 有界窗口，超窗物理删除。"""

    def __init__(self, db_path: Path | None = None) -> None:
        self._path = db_path or news_db_path()
        self._lock = threading.Lock()
        self._generation = 0  # 单调递增条目库写入代数：入库/清理各 +1，派生缓存键据此失效
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def generation(self) -> int:
        """当前写入代数；任何写入（入库/清理）都会推进。"""
        return self._generation

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path)
        conn.row_factory = sqlite3.Row
        return conn

    def upsert_entries(self, entries: Iterable[StoredEntry], now: datetime | None = None) -> int:
        """入库：同源 (source,item_id) 去重；跨源标题 simhash ≥0.7 合并（保留多源链接、取最早时间）。"""
        now_iso = (now or datetime.now(timezone.utc)).isoformat()
        inserted = 0
        with self._lock, self._connect() as conn:
            for entry in entries:
                cutoff = (datetime.fromisoformat(now_iso) - max(FLASH_WINDOW, ANNOUNCEMENT_WINDOW)).isoformat()
                recent = conn.execute(
                    "SELECT source, item_id, published_at, title, url, extra_urls FROM entries "
                    "WHERE type = ? AND published_at >= ? ORDER BY published_at DESC LIMIT ?",
                    (entry.type, cutoff, _NEARDUP_SCAN_LIMIT),
                ).fetchall()
                merged = False
                for candidate in recent:
                    if title_similarity(entry.title, candidate["title"]) < TITLE_DUP_THRESHOLD:
                        continue
                    extra = list(json.loads(candidate["extra_urls"]))
                    if entry.url and entry.url != candidate["url"] and entry.url not in extra:
                        extra.append(entry.url)
                    earliest = min(candidate["published_at"], entry.published_at)
                    conn.execute(
                        "UPDATE entries SET extra_urls = ?, published_at = ? WHERE source = ? AND item_id = ?",
                        (json.dumps(extra, ensure_ascii=False), earliest, candidate["source"], candidate["item_id"]),
                    )
                    merged = True
                    break
                if merged:
                    continue
                # ponytail: 跨源近似扫描为窗口内 O(n) 顺序比对；条目量超万级再换倒排索引。
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO entries(source, item_id, type, published_at, title, summary, url,"
                    " structured_codes, extra_urls, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        entry.source, entry.item_id, entry.type, entry.published_at, entry.title,
                        entry.summary, entry.url, json.dumps(list(entry.structured_codes), ensure_ascii=False),
                        json.dumps(list(entry.extra_urls), ensure_ascii=False), now_iso,
                    ),
                )
                inserted += cursor.rowcount
            conn.commit()
            if inserted:
                self._generation += 1
        return inserted

    def window_merged(self, limit: int = 50, now: datetime | None = None,
                      after_published_at: str | None = None, after_item_id: str | None = None,
                      before_published_at: str | None = None, before_item_id: str | None = None,
                      order: Literal["desc", "asc"] = "desc") -> list[StoredEntry]:
        """窗口内条目（快讯 24h / 公告 7d），默认新→旧。

        after_*：只返回严格更新的条目（> 比较严格不等，配合 order="asc" 交付最旧未交付页）；
        before_*：只返回更早条目（< 严格不等，翻页位）。
        """
        at = now or datetime.now(timezone.utc)
        flash_cutoff = (at - FLASH_WINDOW).isoformat()
        announcement_cutoff = (at - ANNOUNCEMENT_WINDOW).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM entries "
                "WHERE ((type = 'flash' AND published_at >= :flash_cutoff) "
                "    OR (type = 'announcement' AND published_at >= :announcement_cutoff)) "
                "AND (:after_ts IS NULL OR published_at > :after_ts "
                "     OR (published_at = :after_ts AND item_id > :after_id)) "
                "AND (:before_ts IS NULL OR published_at < :before_ts "
                "     OR (published_at = :before_ts AND item_id < :before_id)) "
                f"ORDER BY published_at {order.upper()}, item_id {order.upper()} LIMIT :limit",
                {
                    "flash_cutoff": flash_cutoff, "announcement_cutoff": announcement_cutoff,
                    "after_ts": after_published_at, "after_id": after_item_id,
                    "before_ts": before_published_at, "before_id": before_item_id, "limit": limit,
                },
            ).fetchall()
        return [self._to_entry(row) for row in rows]

    def purge_expired(self, now: datetime | None = None) -> None:
        at = now or datetime.now(timezone.utc)
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM entries WHERE type = 'flash' AND published_at < ?", ((at - FLASH_WINDOW).isoformat(),))
            conn.execute(
                "DELETE FROM entries WHERE type = 'announcement' AND published_at < ?",
                ((at - ANNOUNCEMENT_WINDOW).isoformat(),),
            )
            conn.commit()
            self._generation += 1

    def last_updated_at(self) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT MAX(first_seen_at) FROM entries").fetchone()
        return str(row[0]) if row and row[0] else None

    def fetch_by_keys(self, keys: Sequence[tuple[str, str]]) -> list[StoredEntry]:
        """按键集合取回现存行，保持输入顺序；已清理的键自然跳过（缓存 replay 防护）。"""
        if not keys:
            return []
        placeholders = ",".join("?" * len(keys))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM entries WHERE source || ':' || item_id IN ({placeholders})",
                [f"{source}:{item_id}" for source, item_id in keys],
            ).fetchall()
        by_key = {(row["source"], row["item_id"]): self._to_entry(row) for row in rows}
        return [by_key[key] for key in keys if key in by_key]

    @staticmethod
    def _to_entry(row: sqlite3.Row) -> StoredEntry:
        return StoredEntry(
            source=row["source"], item_id=row["item_id"], type=row["type"],
            published_at=row["published_at"], title=row["title"], summary=row["summary"],
            url=row["url"], structured_codes=tuple(json.loads(row["structured_codes"])),
            extra_urls=tuple(json.loads(row["extra_urls"])),
        )
```

- [ ] **Step 4: 运行 store 验证 PASS**

```bash
pytest agent/tests/news/test_store.py -v
```
Expected: 7 PASS。

- [ ] **Step 5: 写 health 失败测试**

写入 `agent/tests/news/test_health.py`：

```python
"""TDD：源健康降级状态机——请求健康与内容新鲜度分离（规格 §5.1/§5.3）。"""
from __future__ import annotations

from datetime import datetime, timezone

from src.news.calendar import ConservativeCalendar
from src.news.health import FAIL_FAILURE_THRESHOLD, HealthTracker

WEDNESDAY = datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc)
SUNDAY = datetime(2026, 8, 30, 10, 0, tzinfo=timezone.utc)


class _FiniteCalendar:
    """工作日开市、快讯期望间隔 30s 的日历（停滞计数可累积，用于验证 §5.1 停滞降级）。"""

    def __init__(self, closed: bool = False) -> None:
        self._closed = closed

    def is_trading_day(self, day):
        return not self._closed

    def current_session(self, at):
        return "closed" if self._closed else "open"

    def expected_flash_interval(self):
        return 30.0


def _tracker(now_value: datetime = WEDNESDAY, calendar=None) -> HealthTracker:
    return HealthTracker(calendar or ConservativeCalendar(), now=lambda: now_value)


def test_initial_state_failed_until_first_success():
    tracker = _tracker()
    assert tracker.state_of("eastmoney") == "failed"
    tracker.record_success("eastmoney", advanced=True)
    assert tracker.state_of("eastmoney") == "ok"


def test_three_consecutive_failures_degrade_six_fail():
    tracker = _tracker()
    for _ in range(3):
        tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "degraded"
    for _ in range(FAIL_FAILURE_THRESHOLD - 3):
        tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "failed"


def test_success_resets_failure_streak():
    tracker = _tracker()
    tracker.record_failure("sina", "timeout")
    tracker.record_failure("sina", "timeout")
    tracker.record_success("sina", advanced=False)
    tracker.record_failure("sina", "timeout")
    tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "ok"  # 3 次失败才降级；成功重置计数


def test_stall_counts_only_in_session_and_degrades_after_three():
    tracker = _tracker(WEDNESDAY, calendar=_FiniteCalendar())
    for _ in range(3):
        tracker.record_success("eastmoney", advanced=False)  # 会话内游标停滞
    assert tracker.state_of("eastmoney") == "degraded"


def test_stall_not_counted_when_market_closed():
    tracker = _tracker(SUNDAY, calendar=_FiniteCalendar(closed=True))
    for _ in range(10):
        tracker.record_success("eastmoney", advanced=False)
    assert tracker.state_of("eastmoney") == "ok"  # 闭市时段静默不计数（§5.1 内容新鲜度）


def test_conservative_calendar_silence_never_degrades():
    tracker = _tracker(WEDNESDAY)  # ConservativeCalendar：interval=inf
    for _ in range(10):
        tracker.record_success("eastmoney", advanced=False)
    assert tracker.state_of("eastmoney") == "ok"  # 静默永不触发 degraded（§5.2）


def test_recovery_requires_three_consecutive_successes():
    tracker = _tracker()
    for _ in range(3):
        tracker.record_failure("sse", "http_status")
    assert tracker.state_of("sse") == "degraded"
    tracker.record_success("sse", advanced=True)
    tracker.record_success("sse", advanced=True)
    assert tracker.state_of("sse") == "degraded"  # 探活连续 3 次才回切
    tracker.record_success("sse", advanced=True)
    assert tracker.state_of("sse") == "ok"


def test_snapshot_covers_all_four_sources():
    snapshot = {health.source_id: health.state for health in _tracker().snapshot()}
    assert snapshot == {"eastmoney": "failed", "sina": "failed", "sse": "failed", "szse": "failed"}
```

- [ ] **Step 6: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_health.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.health'`。

- [ ] **Step 7: 实现 health.py**

写入 `agent/src/news/health.py`：

```python
"""Per-source degradation state machine separating request health from content freshness (spec §5.1/§5.3)."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from src.news.calendar import TradingCalendar

DEGRADE_FAILURE_THRESHOLD = 3   # 连续 3 次失败 → degraded（§5.1）
FAIL_FAILURE_THRESHOLD = 6      # 再度翻倍 → failed（全源失败边界的源级判定）
STALL_DEGRADE_ROUNDS = 3        # 游标停滞 ≥3 轮 → degraded（§5.1）
RECOVERY_STREAK = 3             # 连续 3 次成功回切（§5.3）
SOURCE_IDS = ("eastmoney", "sina", "sse", "szse")


@dataclass
class SourceHealth:
    source_id: str
    state: str = "failed"  # "ok" | "degraded" | "failed"；从未成功即 failed
    last_success_at: str | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    stalled_rounds: int = 0
    success_streak: int = 0
    degraded_by_failures: bool = False  # 由失败（而非停滞）进入 degraded/failed 时需要 3 连成功回切


class HealthTracker:
    """请求健康由失败计数判定；内容静默仅在工作日交易时段（calendar 判定）参与停滞计数。"""

    def __init__(self, calendar: TradingCalendar, now: Callable[[], datetime] | None = None) -> None:
        self._calendar = calendar
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._sources = {source_id: SourceHealth(source_id=source_id) for source_id in SOURCE_IDS}

    def record_success(self, source_id: str, *, advanced: bool) -> None:
        health = self._sources[source_id]
        at = self._now()
        health.last_error = None
        health.last_success_at = at.isoformat()
        if advanced:
            health.stalled_rounds = 0
        in_session = self._calendar.is_trading_day(at.date()) and self._calendar.current_session(at) == "open"
        # 停滞判定防御：expected_flash_interval 为 inf（ConservativeCalendar）→ 静默永不计停滞（§5.2）
        if not advanced and in_session and not math.isinf(self._calendar.expected_flash_interval()):
            health.stalled_rounds += 1
        if health.state != "ok" and health.degraded_by_failures:
            # 探活回切：连续 3 次成功才恢复（§5.3）
            health.success_streak += 1
            if health.success_streak >= RECOVERY_STREAK:
                health.state = "ok"
                health.degraded_by_failures = False
                health.success_streak = 0
                health.consecutive_failures = 0
            return
        health.state = "ok"
        health.consecutive_failures = 0
        if health.stalled_rounds >= STALL_DEGRADE_ROUNDS and not advanced and in_session:
            health.state = "degraded"

    def record_failure(self, source_id: str, error: str) -> None:
        health = self._sources[source_id]
        health.consecutive_failures += 1
        health.success_streak = 0
        health.last_error = error[:200]
        if health.consecutive_failures >= FAIL_FAILURE_THRESHOLD:
            health.state = "failed"
            health.degraded_by_failures = True
        elif health.consecutive_failures >= DEGRADE_FAILURE_THRESHOLD:
            health.state = "degraded"
            health.degraded_by_failures = True

    def state_of(self, source_id: str) -> str:
        return self._sources[source_id].state

    def snapshot(self) -> list[SourceHealth]:
        return [self._sources[source_id] for source_id in SOURCE_IDS]
```

- [ ] **Step 8: 运行 health 验证 PASS**

```bash
pytest agent/tests/news/test_health.py -v
```
Expected: 7 PASS。

- [ ] **Step 9: 写 flash 聚合器失败测试**

写入 `agent/tests/news/test_flash_service.py`：

```python
"""TDD：东财+新浪快讯聚合器——解析/游标/限流退避/健康上报（规格 §3.1/§5.4）。"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

import httpx

from src.news.calendar import ConservativeCalendar
from src.news.flash.service import FlashAggregator, parse_eastmoney, parse_sina
from src.news.health import HealthTracker
from src.news.store import EntryStore
from src.news.transport import TransportClient


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


class FakeResolver:
    async def resolve(self, host: str) -> list[str]:
        return ["93.184.216.34"]


class RoutingTransport(httpx.AsyncBaseTransport):
    """按 path 路由（忽略 query 与 host——传输层会把 host 重写为解析出的 IP），返回预设响应。"""

    def __init__(self, routes: dict[str, list[httpx.Response]]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = str(request.url.path)
        responses = self.routes[key]
        return responses.pop(0) if len(responses) > 1 else responses[0]


@dataclass
class Clock:
    value: float = 1000.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


async def _no_sleep(_seconds: float) -> None:
    return None


def _tracker() -> HealthTracker:
    return HealthTracker(ConservativeCalendar(), now=lambda: datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc))


def _eastmoney_payload() -> bytes:
    return json.dumps({
        "data": {"fastNewsList": [
            {"code": "202608291200", "title": "央行开展逆回购", "summary": "500亿元", "showTime": 1787985600,
             "realSort": 1787985600, "stockList": ["1.600519", "0.000001"]},
            {"code": "202608291199", "title": "某公司发布公告", "summary": "", "showTime": 1787985500,
             "realSort": 1787985500, "stockList": []},
        ]}
    }).encode()


def test_parse_eastmoney_builds_entries_and_cursor():
    entries, cursor = parse_eastmoney(_eastmoney_payload())
    assert cursor == "1787985600"
    assert [entry.item_id for entry in entries] == ["202608291200", "202608291199"]
    assert entries[0].structured_codes == ("1.600519", "0.000001")  # 原样保存，标准化在匹配层
    assert entries[0].type == "flash"


def test_parse_sina_builds_entries():
    payload = json.dumps({"result": {"data": [
        {"title": "新浪快讯", "intro": "内容", "ctime": 1787985600, "url": "https://finance.sina.com.cn/a.html?utm_source=rss"},
    ]}}).encode()
    entries = parse_sina(payload)
    assert len(entries) == 1
    assert entries[0].source == "sina"
    assert entries[0].url == "https://finance.sina.com.cn/a.html"  # utm 剥离


@_async_test
async def test_poll_once_ingests_both_sources_and_reports_health(tmp_path):
    transport = RoutingTransport({
        "/comm/web/getFastNewsList": [
            httpx.Response(200, headers={"content-type": "application/json"}, content=_eastmoney_payload())
        ],
        "/api/roll/get": [
            httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps(
                {"result": {"data": [{"title": "新浪快讯", "intro": "", "ctime": 1787985600,
                                      "url": "https://finance.sina.com.cn/b.html"}]}}).encode())
        ],
    })
    clock = Clock()
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    aggregator = FlashAggregator(transport=TransportClient(resolver=FakeResolver(), transport=transport),
                                 store=store, health=health, sleep=_no_sleep, now=clock.now)

    assert await aggregator.poll_once() is True
    assert len(store.window_merged(limit=10)) == 3
    assert health.state_of("eastmoney") == "ok"
    assert health.state_of("sina") == "ok"
    east_request = next(r for r in transport.requests if "getFastNewsList" in str(r.url))
    assert "req_trace" in str(east_request)


@_async_test
async def test_rate_limit_backoff_suspends_source(tmp_path):
    transport = RoutingTransport({
        "/comm/web/getFastNewsList": [
            httpx.Response(429, headers={"content-type": "text/plain", "retry-after": "0"}),
        ],
        "/api/roll/get": [
            httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps({"result": {"data": []}}).encode()),
        ],
    })
    clock = Clock()
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    aggregator = FlashAggregator(transport=TransportClient(resolver=FakeResolver(), transport=transport),
                                 store=store, health=health, sleep=_no_sleep, now=clock.now)

    await aggregator.poll_once()  # eastmoney 429 → 重试 3 次耗尽 → 退避挂起；sina 空页成功
    assert health.state_of("eastmoney") in {"degraded", "failed"}
    east_calls = [r for r in transport.requests if "getFastNewsList" in str(r.url)]
    assert len(east_calls) == 3  # MAX_ATTEMPTS

    transport.requests.clear()
    await aggregator.poll_once()  # eastmoney 处于退避窗口内 → 跳过；不再发请求
    assert not [r for r in transport.requests if "getFastNewsList" in str(r.url)]
```

- [ ] **Step 10: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_flash_service.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.flash'`。

- [ ] **Step 11: 实现 flash 聚合器**

创建空文件 `agent/src/news/flash/__init__.py`，写入 `agent/src/news/flash/service.py`：

```python
"""东方财富 7x24 + 新浪滚动并行快讯聚合（规格 §3.1/§5.4；端点证据见规格 §10）。"""

from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from src.news.health import HealthTracker
from src.news.store import EntryStore, StoredEntry, normalize_url
from src.news.transport import TransportClient, TransportError, TransportRequest

EASTMONEY_URL = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
SINA_URL = "https://feed.mix.sina.com.cn/api/roll/get"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


@dataclass(frozen=True)
class FlashBatch:
    source: str
    entries: tuple[StoredEntry, ...]
    cursor: str | None = None
    error: str | None = None


def parse_eastmoney(payload: bytes) -> tuple[list[StoredEntry], str | None]:
    """data.fastNewsList[] → 条目；游标 = max(realSort)；stockList 原样保存（标准化在匹配层 §4.1.1）。"""
    document = json.loads(payload)
    items = (document.get("data") or {}).get("fastNewsList") or []
    entries: list[StoredEntry] = []
    cursor: int | None = None
    for item in items:
        try:
            published_at = datetime.fromtimestamp(int(item["showTime"]), tz=timezone.utc).isoformat()
        except (KeyError, TypeError, ValueError, OSError, OverflowError):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        entries.append(StoredEntry(
            source="eastmoney",
            item_id=str(item.get("code") or item.get("realSort") or ""),
            type="flash",
            published_at=published_at,
            title=title,
            summary=str(item.get("summary") or "").strip()[:500],
            url=normalize_url(str(item.get("url") or "")),
            structured_codes=tuple(str(raw) for raw in (item.get("stockList") or [])),
        ))
        try:
            real_sort = int(item["realSort"])
        except (KeyError, TypeError, ValueError):
            continue
        cursor = real_sort if cursor is None else max(cursor, real_sort)
    return entries, (str(cursor) if cursor is not None else None)


def parse_sina(payload: bytes) -> list[StoredEntry]:
    """result.data[] → 条目；item_id = url（新浪无原生 id）；ctime 为秒级时间戳。"""
    document = json.loads(payload)
    items = ((document.get("result") or {}).get("data")) or []
    entries: list[StoredEntry] = []
    for item in items:
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        if not title or not url:
            continue
        try:
            published_at = datetime.fromtimestamp(int(item["ctime"]), tz=timezone.utc).isoformat()
        except (KeyError, TypeError, ValueError, OSError, OverflowError):
            continue
        entries.append(StoredEntry(
            source="sina",
            item_id=url,
            type="flash",
            published_at=published_at,
            title=title,
            summary=str(item.get("intro") or "").strip()[:500],
            url=normalize_url(url),
            structured_codes=(),
        ))
    return entries


class FlashAggregator:
    """东财+新浪并行：各自节奏增量轮询；限流退避 30→60→120s+抖动、3 次挂起；degraded 后 60s 探活。"""

    EASTMONEY_INTERVAL_S = 20.0   # 15-30s 窗口内
    SINA_INTERVAL_S = 25.0
    MIN_SOURCE_SPACING_S = 1.5    # §5.4 单源请求间隔 ≥1.5s
    PROBE_INTERVAL_S = 60.0       # degraded/failed 探活节奏
    RATE_LIMIT_BACKOFF_S = (30.0, 60.0, 120.0)
    RATE_LIMIT_JITTER_S = 5.0
    MAX_RATE_LIMIT_STRIKES = 3
    PURGE_INTERVAL_S = 600.0

    def __init__(
        self,
        transport: TransportClient,
        store: EntryStore,
        health: HealthTracker,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport
        self._store = store
        self._health = health
        self._sleep = sleep
        self._now = now
        self._east_since: str | None = None
        self._due = {"eastmoney": 0.0, "sina": 0.0}
        self._last_request = {"eastmoney": float("-inf"), "sina": float("-inf")}
        self._strikes = {"eastmoney": 0, "sina": 0}
        self._last_purge = 0.0

    async def poll_once(self) -> bool:
        """一轮增量：跳过未到期/退避中的源；返回本轮是否有新条目入库。"""
        progressed = False
        for source in ("eastmoney", "sina"):
            now = self._now()
            if now < self._due[source] or now - self._last_request[source] < self.MIN_SOURCE_SPACING_S:
                continue
            progressed = await self._poll_source(source) or progressed
        if self._now() - self._last_purge >= self.PURGE_INTERVAL_S:
            self._last_purge = self._now()
            self._store.purge_expired()
        return progressed

    async def poll_source_now(self, source: str) -> None:
        """手动强制补拉路径：绕过节奏门，但保留 ≥1.5s 请求间隔。"""
        await self._poll_source(source)

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.poll_once()
            try:
                await asyncio.wait_for(stop.wait(), timeout=1.0)
            except TimeoutError:
                pass

    async def _poll_source(self, source: str) -> bool:
        self._last_request[source] = self._now()
        batch = await (self._fetch_eastmoney() if source == "eastmoney" else self._fetch_sina())
        if batch.error is not None:
            self._health.record_failure(source, batch.error)
            if batch.error in {"rate_limited", "forbidden"}:
                self._suspend_with_backoff(source)
            return False
        inserted = self._store.upsert_entries(batch.entries)
        self._health.record_success(source, advanced=inserted > 0)
        self._strikes[source] = 0
        interval = self.EASTMONEY_INTERVAL_S if source == "eastmoney" else self.SINA_INTERVAL_S
        if self._health.state_of(source) in {"degraded", "failed"}:
            interval = self.PROBE_INTERVAL_S
        self._due[source] = self._now() + interval
        if batch.cursor is not None and source == "eastmoney":
            self._east_since = batch.cursor
        return inserted > 0

    def _suspend_with_backoff(self, source: str) -> None:
        self._strikes[source] += 1
        index = min(self._strikes[source], len(self.RATE_LIMIT_BACKOFF_S)) - 1
        delay = self.RATE_LIMIT_BACKOFF_S[index] + random.uniform(0.0, self.RATE_LIMIT_JITTER_S)
        self._due[source] = self._now() + delay

    async def _fetch_eastmoney(self) -> FlashBatch:
        request = TransportRequest(
            url=EASTMONEY_URL,
            query={
                "client": "web", "biz": "web_724", "fastColumn": "102",
                "sortEnd": self._east_since or "", "pageSize": "20",
                "req_trace": str(uuid.uuid4()),
            },
            headers={"Accept": "application/json", "User-Agent": USER_AGENT, "Referer": "https://kuaixun.eastmoney.com/"},
        )
        try:
            response = await self._transport.fetch(request)
        except TransportError as error:
            return FlashBatch(source="eastmoney", entries=(), error=error.code)
        entries, cursor = parse_eastmoney(response.body)
        return FlashBatch(source="eastmoney", entries=tuple(entries), cursor=cursor)

    async def _fetch_sina(self) -> FlashBatch:
        request = TransportRequest(
            url=SINA_URL,
            query={"pageid": "153", "lid": "2516", "k": "", "num": "50", "page": "1"},
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            response = await self._transport.fetch(request)
        except TransportError as error:
            return FlashBatch(source="sina", entries=(), error=error.code)
        return FlashBatch(source="sina", entries=tuple(parse_sina(response.body)))
```

注意：`FlashBatch.cursor` 只对东财有意义（sortEnd 游标）；`_east_since` 在 `_poll_source` 中由 batch.cursor 更新。

- [ ] **Step 12: 运行 flash 验证 PASS + 全组回归**

```bash
pytest agent/tests/news/test_store.py agent/tests/news/test_health.py agent/tests/news/test_flash_service.py -v
ruff check agent/src/news/store.py agent/src/news/health.py agent/src/news/flash/
```
Expected: 全部 PASS；ruff 无告警。

- [ ] **Step 13: 提交**

```bash
git add agent/src/news/store.py agent/src/news/health.py agent/src/news/flash agent/tests/news/test_store.py agent/tests/news/test_health.py agent/tests/news/test_flash_service.py
git commit -s -m "feat(news): add flash aggregator, entry store and health state machine"
```

---

### Task 5 (T3): 公告采集器（上交所 jsonp + 深交所 HTML）

**Files:**
- Create: `agent/src/news/announcements/__init__.py`（空文件）
- Create: `agent/src/news/announcements/collector.py`
- Test: `agent/tests/news/test_announcements.py`（Create）

**Interfaces:**
- Consumes: Task 3 `TransportClient/TransportRequest/TransportError`；Task 4 `EntryStore/StoredEntry/HealthTracker`。
- Produces: `strip_jsonp(payload: str) -> str`；`parse_sse(payload: bytes) -> list[StoredEntry]`（item_id = sha1("code|SSEDATE|TITLE")，URL 拼 `https://static.sse.com.cn` 前缀）；`parse_szse_html(payload: bytes) -> list[StoredEntry]`（无证券代码字段，structured_codes=()）；`AnnouncementCollector(transport, store, health, now=time.monotonic)` 方法 `poll_once() -> bool`、`maybe_refresh(*, force: bool = False) -> None`（force=False 时仅当距上次拉取 >2min 才触发，Task 7 的 FeedRefreshCoordinator 消费）、`run_forever(stop: asyncio.Event)`。去重键 (code, ann_date, title) → item_id；节奏 POLL_INTERVAL_S=480s（5-10min 区间）；降级链 sse → szse。

- [ ] **Step 1: 写失败测试**

写入 `agent/tests/news/test_announcements.py`：

```python
"""TDD：公告采集——上交所 jsonp 解析 / 深交所 HTML 解析 / 降级链 / 2min 门控（规格 §3.1/§5.3）。"""
from __future__ import annotations

import asyncio
import hashlib
import json
from functools import wraps
from typing import Any, Callable

import httpx

from src.news.announcements.collector import AnnouncementCollector, parse_sse, parse_szse_html, strip_jsonp
from src.news.calendar import ConservativeCalendar
from src.news.health import HealthTracker
from src.news.store import EntryStore
from src.news.transport import TransportClient

SSE_RAW = (
    'jsonp123({"pageHelp": {"data": [{"SECURITY_CODE": "600519", "SECURITY_NAME": "贵州茅台", '
    '"TITLE": "关于召开2026年第一次临时股东大会的通知", "SSEDATE": "2026-08-28", "SSETIME": "18:30", '
    '"URL": "/disclosure/listedinfo/announcement/c/new/2026-08-28/600519_20260828.pdf"}]}});'
).encode("utf-8")
SZSE_HTML = """
<html><body><table>
<tr><td class="date">2026-08-28</td><td><a href="/disclosure/notice/notice.pdf">关于变更持续督导保荐代表人的公告</a></td></tr>
<tr><td class="date">2026-08-27</td><td><a href="/disclosure/notice/other.pdf">2026年半年度报告</a></td></tr>
</table></body></html>
""".encode("utf-8")

def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


async def _no_sleep(_seconds: float) -> None:
    return None


class FakeResolver:
    async def resolve(self, host: str) -> list[str]:
        return ["93.184.216.34"]


class RoutingTransport(httpx.AsyncBaseTransport):
    """按 path 路由（忽略 query 与 host——传输层会把 host 重写为解析出的 IP）。"""

    def __init__(self, routes: dict[str, httpx.Response]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.routes[str(request.url.path)]


def _tracker() -> HealthTracker:
    return HealthTracker(ConservativeCalendar())


def test_strip_jsonp_unwraps_shell():
    assert json.loads(strip_jsonp('cb({"a": 1});')) == {"a": 1}


def test_parse_sse_builds_entries_with_dedup_key():
    entries = parse_sse(SSE_RAW)
    assert len(entries) == 1
    entry = entries[0]
    expected_id = hashlib.sha1("600519|2026-08-28|关于召开2026年第一次临时股东大会的通知".encode()).hexdigest()
    assert entry.item_id == expected_id  # 去重键 (code, ann_date, title)
    assert entry.source == "sse"
    assert entry.type == "announcement"
    assert entry.structured_codes == ("600519",)
    assert entry.url == "https://static.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-08-28/600519_20260828.pdf"
    assert entry.published_at.startswith("2026-08-28T10:30")  # 18:30 +08:00 → UTC


def test_parse_szse_html_extracts_rows():
    entries = parse_szse_html(SZSE_HTML)
    assert [entry.title for entry in entries] == [
        "关于变更持续督导保荐代表人的公告", "2026年半年度报告",
    ]
    assert entries[0].source == "szse"
    assert entries[0].structured_codes == ()  # 深交所 HTML 无证券代码字段，仅标题匹配
    assert entries[0].item_id  # title+date 派生 id


@_async_test
async def test_poll_once_prefers_sse_and_falls_back_on_failure(tmp_path):
    transport = RoutingTransport({
        "/security/stock/queryCompanyBulletin.do": httpx.Response(500, headers={"content-type": "text/plain"}),
        "/disclosure/notice/index.html": httpx.Response(200, headers={"content-type": "text/html"}, content=SZSE_HTML),
    })
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    collector = AnnouncementCollector(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store, health=health, sleep=_no_sleep,
    )
    assert await collector.poll_once() is True
    titles = [entry.title for entry in store.window_merged(limit=10)]
    assert "2026年半年度报告" in titles  # sse 失败 → szse 备源接住
    assert health.state_of("sse") != "ok"  # 单次失败仅累计；连续 3 次才 degraded（§5.1）
    assert health.state_of("szse") == "ok"


@_async_test
async def test_maybe_refresh_respects_two_minute_gate(tmp_path):
    transport = RoutingTransport({
        "/security/stock/queryCompanyBulletin.do": httpx.Response(
            200, headers={"content-type": "text/plain"}, content=SSE_RAW),
    })
    store = EntryStore(tmp_path / "news.db")
    collector = AnnouncementCollector(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store, health=_tracker(), sleep=_no_sleep,
    )
    await collector.maybe_refresh(force=False)  # 首次（距上次拉取无穷远）→ 允许
    first_requests = len(transport.requests)
    assert first_requests == 1
    await collector.maybe_refresh(force=False)  # 刚拉取过 → 2min 门控拦截
    assert len(transport.requests) == first_requests
    await collector.maybe_refresh(force=True)   # 强制绕过
    assert len(transport.requests) == first_requests + 1
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_announcements.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.announcements'`。

- [ ] **Step 3: 最小实现**

创建空文件 `agent/src/news/announcements/__init__.py`，写入 `agent/src/news/announcements/collector.py`：

```python
"""公告采集：上交所 jsonp 主源 → 深交所 HTML 备源降级链（规格 §3.1/§5.3；端点证据见规格 §10）。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

from src.news.health import HealthTracker
from src.news.store import EntryStore, StoredEntry, normalize_url
from src.news.transport import TransportClient, TransportError, TransportRequest

from src.news.flash.service import USER_AGENT  # 共享 UA 常量

SSE_URL = "https://query.sse.com.cn/security/stock/queryCompanyBulletin.do"
SZSE_URL = "https://www.szse.cn/disclosure/notice/index.html"
STATIC_SSE_PREFIX = "https://static.sse.com.cn"
_TZ_SHANGHAI = timezone(timedelta(hours=8))

POLL_INTERVAL_S = 480.0        # 5-10min 区间
FORCE_REFRESH_GAP_S = 120.0    # 手动补拉仅当距上次拉取 >2min（§6.1.1）


def strip_jsonp(payload: str) -> str:
    """剥 jsonp 壳：取首个 '(' 到末尾 ')' 之间的 JSON 文本。"""
    match = re.search(r"\((.*)\)\s*;?\s*$", payload.strip(), re.DOTALL)
    if not match:
        raise ValueError("jsonp shell not found")
    return match.group(1)


def parse_sse(payload: bytes) -> list[StoredEntry]:
    """上交所 jsonp → 条目；去重键 (code, ann_date, title) → item_id；URL 为 PDF 相对路径拼接。"""
    document = json.loads(strip_jsonp(payload.decode("utf-8", errors="replace")))
    rows = ((document.get("pageHelp") or {}).get("data")) or []
    entries: list[StoredEntry] = []
    for row in rows:
        code = str(row.get("SECURITY_CODE") or "").strip()
        title = str(row.get("TITLE") or "").strip()
        date_text = str(row.get("SSEDATE") or "").strip()
        if not code or not title or not date_text:
            continue
        time_text = str(row.get("SSETIME") or "00:00").strip() or "00:00"
        try:
            published_at = datetime.fromisoformat(f"{date_text}T{time_text}:00").replace(
                tzinfo=_TZ_SHANGHAI
            ).astimezone(timezone.utc).isoformat()
        except ValueError:
            continue
        relative = str(row.get("URL") or "").strip()
        entries.append(StoredEntry(
            source="sse",
            item_id=hashlib.sha1(f"{code}|{date_text}|{title}".encode("utf-8")).hexdigest(),
            type="announcement",
            published_at=published_at,
            title=title,
            summary="",
            url=normalize_url(f"{STATIC_SSE_PREFIX}{relative}") if relative else "",
            structured_codes=(code,),
        ))
    return entries


class _NoticeLinkParser(HTMLParser):
    """深交所服务端渲染频道：收集公告 <a> 行与其前的最近日期文本。"""

    _DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[tuple[str, str, str]] = []  # (title, href, date)
        self._in_link = False
        self._href = ""
        self._chunks: list[str] = []
        self._last_date = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if "/disclosure/" in href or href.endswith(".pdf"):
                self._in_link = True
                self._href = href
                self._chunks = []

    def handle_data(self, data: str) -> None:
        date_match = self._DATE_PATTERN.search(data)
        if date_match:
            self._last_date = date_match.group(0)
        if self._in_link:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_link:
            self._in_link = False
            title = "".join(self._chunks).strip()
            if title:
                self.rows.append((title, self._href, self._last_date))


def parse_szse_html(payload: bytes) -> list[StoredEntry]:
    """深交所 HTML 频道 → 条目；无证券代码字段，仅标题匹配（中置信度）。"""
    parser = _NoticeLinkParser()
    parser.feed(payload.decode("utf-8", errors="replace"))
    entries: list[StoredEntry] = []
    for title, href, date_text in parser.rows:
        entries.append(StoredEntry(
            source="szse",
            item_id=hashlib.sha1(f"szse|{date_text}|{title}".encode("utf-8")).hexdigest(),
            type="announcement",
            published_at=(f"{date_text}T00:00:00+00:00" if date_text else ""),
            title=title,
            summary="",
            url=normalize_url(f"https://www.szse.cn{href}" if href.startswith("/") else href),
            structured_codes=(),
        ))
    return [entry for entry in entries if entry.published_at]  # 无日期的行不可排序，丢弃


class AnnouncementCollector:
    """上交所→深交所降级链；POLL_INTERVAL_S 节奏；maybe_refresh 带 2min 门控（§6.1.1）。"""

    def __init__(
        self,
        transport: TransportClient,
        store: EntryStore,
        health: HealthTracker,
        sleep: object = asyncio.sleep,
        now: object = time.monotonic,
    ) -> None:
        self._transport = transport
        self._store = store
        self._health = health
        self._sleep = sleep
        self._now = now
        self._last_poll = float("-inf")

    async def poll_once(self) -> bool:
        """主源 sse → 仅当 sse 采集失败（传输/解析错误）才切备源 szse；各自独立上报健康。"""
        sse_ok, sse_progressed = await self._poll_sse()
        progressed = sse_progressed
        if not sse_ok:
            progressed = (await self._poll_szse())[1] or progressed
        self._last_poll = self._now()
        return progressed

    async def maybe_refresh(self, *, force: bool = False) -> None:
        """手动强制补拉入口：force=False 时仅当距上次拉取 >2min 才触发（§6.1.1）。"""
        if not force and self._now() - self._last_poll < FORCE_REFRESH_GAP_S:
            return
        await self.poll_once()

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.poll_once()
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_S)
            except TimeoutError:
                pass

    async def _poll_sse(self) -> tuple[bool, bool]:
        """返回 (采集是否成功, 是否有新条目入库)。"""
        now = datetime.now(_TZ_SHANGHAI)
        request = TransportRequest(
            url=SSE_URL,
            query={
                "isPagination": "true", "pageHelp.pageSize": "25", "pageHelp.pageNo": "1",
                "pageHelp.beginPage": "1", "pageHelp.cacheSize": "1", "pageHelp.endPage": "1",
                "securityType": "0101", "reportType2": "DQBG", "reportType": "ALL",
                # 探测证据（规格 §10）：仅需 Referer http://www.sse.com.cn/；参数为公开页面默认值
                "beginTime": (now - timedelta(days=14)).strftime("%Y-%m-%d"),
                "endTime": now.strftime("%Y-%m-%d"),
            },
            headers={"Referer": "http://www.sse.com.cn/", "User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        try:
            response = await self._transport.fetch(request)
            entries = parse_sse(response.body)
        except TransportError as error:
            self._health.record_failure("sse", error.code)
            return False, False
        except (ValueError, KeyError):
            self._health.record_failure("sse", "parse_error")
            return False, False
        inserted = self._store.upsert_entries(entries)
        self._health.record_success("sse", advanced=inserted > 0)
        return True, inserted > 0

    async def _poll_szse(self) -> tuple[bool, bool]:
        """返回 (采集是否成功, 是否有新条目入库)。"""
        request = TransportRequest(
            url=SZSE_URL,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
        try:
            response = await self._transport.fetch(request)
            entries = parse_szse_html(response.body)
        except TransportError as error:
            self._health.record_failure("szse", error.code)
            return False, False
        except ValueError:
            self._health.record_failure("szse", "parse_error")
            return False, False
        inserted = self._store.upsert_entries(entries)
        self._health.record_success("szse", advanced=inserted > 0)
        return True, inserted > 0
```

- [ ] **Step 4: 运行验证 PASS**

```bash
pytest agent/tests/news/test_announcements.py -v
ruff check agent/src/news/announcements/
```
Expected: 6 PASS；ruff 无告警（sse 单次失败仅累计失败计数，`test_poll_once_prefers_sse_and_falls_back_on_failure` 断言 `state_of("sse") != "ok"` 与 `state_of("szse") == "ok"`）。

- [ ] **Step 5: 提交**

```bash
git add agent/src/news/announcements agent/tests/news/test_announcements.py
git commit -s -m "feat(news): add SSE/SZSE announcement collector with fallback chain"
```

---

### Task 6 (T4): 匹配器 + 派生缓存

**Files:**
- Create: `agent/src/news/matcher.py`
- Test: `agent/tests/news/test_matcher.py`（Create）

**Interfaces:**
- Consumes: Task 1（watchlist.db 的 name 列）；Task 2（无直接依赖，规格 §7.3 标注 T4 依赖 T0+T1）；Task 4 `EntryStore/StoredEntry/HealthTracker/SourceHealth`。
- Produces: `WatchlistEntry(code, name, market)`；`load_watchlist(db_path: Path | None = None) -> list[WatchlistEntry]`（直读 SQLite，只读连接）；`compute_watchlist_version(entries: Sequence[WatchlistEntry]) -> str`（sha256(sorted((code, name, market) triples))，空列表有确定值）；`normalize_stocklist_code(raw: str) -> str | None`（`1.`→沪 600/601/603/605/688，`0.`→深 000/001/002/003/300/301，6 位数字直通，北交所 → None，§4.1.1）；`MatchedStock(code, name, match_rule)`；`match_entry(entry, by_code, names_lc) -> tuple[list[MatchedStock], str | None]`（三级置信度，§4.1）；`CacheKey(watchlist_version, after_cursor, before_cursor)`；`DerivedFeedCache()`（get/put，LRU ≤16）；`encode_cursor(version, published_at, item_id) -> str` / `decode_cursor(cursor) -> dict | None`；`WatchlistFeedService(store, health, cache=None, watchlist_db=None).feed(after_cursor, before_cursor, limit=50) -> dict`（dict 键与 FeedItem 形状见全局契约；`id = f"{source}:{item_id}"`，url 空串映射 None）。

- [ ] **Step 1: 写失败测试**

写入 `agent/tests/news/test_matcher.py`：

```python
"""TDD：版本键 / stockList 标准化 / 三级匹配 / 游标 / 派生缓存 / 读取服务（规格 §3.1/§4.1/§6.1）。"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.news.calendar import ConservativeCalendar
from src.news.health import HealthTracker
from src.news.matcher import (
    CacheKey,
    DerivedFeedCache,
    WatchlistFeedService,
    compute_watchlist_version,
    decode_cursor,
    encode_cursor,
    match_entry,
    normalize_stocklist_code,
)
from src.news.store import FLASH_WINDOW, EntryStore, StoredEntry

NOW = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)
WATCHLIST_DB_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS watchlist ("
    " code TEXT PRIMARY KEY, name TEXT DEFAULT '', market TEXT DEFAULT 'a_stock', added_at TEXT)"
)


@pytest.fixture()
def watchlist_db(tmp_path: Path) -> Path:
    db = tmp_path / "watchlist.db"
    with sqlite3.connect(db) as conn:
        conn.execute(WATCHLIST_DB_SCHEMA)
        conn.execute("INSERT INTO watchlist(code, name, market, added_at) VALUES ('600519', '贵州茅台', 'a_stock', '2026-08-01')")
        conn.execute("INSERT INTO watchlist(code, name, market, added_at) VALUES ('000001', '平安银行', 'a_stock', '2026-08-02')")
        conn.commit()
    return db


def _entry(source: str = "eastmoney", item_id: str = "e1", title: str = "标题", summary: str = "",
           structured: tuple[str, ...] = ()) -> StoredEntry:
    return StoredEntry(source=source, item_id=item_id, type="flash", published_at=NOW.isoformat(),
                       title=title, summary=summary, url="", structured_codes=structured)


def _match_indexes():
    from src.news.matcher import WatchlistEntry
    entries = [WatchlistEntry("600519", "贵州茅台", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    by_code = {entry.code: entry for entry in entries}
    names_lc = {entry.name.lower(): entry for entry in entries if entry.name}
    return by_code, names_lc


def test_normalize_stocklist_code_prefix_rules():
    assert normalize_stocklist_code("1.600519") == "600519"   # 沪
    assert normalize_stocklist_code("0.000001") == "000001"   # 深
    assert normalize_stocklist_code("1.688001") == "688001"
    assert normalize_stocklist_code("0.300750") == "300750"
    assert normalize_stocklist_code("600519") == "600519"     # 6 位直通（公告 SECURITY_CODE）
    assert normalize_stocklist_code("1.400001") is None       # 非沪前缀（北交所未确认 → 跳过）
    assert normalize_stocklist_code("0.830001") is None
    assert normalize_stocklist_code("garbage") is None


def test_compute_watchlist_version_order_insensitive_and_content_bound():
    from src.news.matcher import WatchlistEntry
    a = [WatchlistEntry("600519", "贵州茅台", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    b = list(reversed(a))
    assert compute_watchlist_version(a) == compute_watchlist_version(b)
    assert compute_watchlist_version(a) != compute_watchlist_version(a[:-1])
    renamed = [WatchlistEntry("600519", "贵州茅台改", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    assert compute_watchlist_version(a) != compute_watchlist_version(renamed)  # 名称参与版本键（T0 回填必须失效缓存）
    assert len(compute_watchlist_version([])) == 64  # 空自选也有确定哈希


def test_match_entry_structured_field_high():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(structured=("1.600519",)), by_code, names_lc)
    assert [(m.code, m.match_rule) for m in matches] == [("600519", "structured_field")]
    assert confidence == "high"


def test_match_entry_code_pattern_requires_context_guard():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(title="股价报（600519）元"), by_code, names_lc)
    assert matches[0].match_rule == "code_pattern"
    assert confidence == "high"
    # 金额数字无护栏 → 不命中
    matches_bare, confidence_bare = match_entry(_entry(title="成交额达 1423000 元"), by_code, names_lc)
    assert matches_bare == [] and confidence_bare is None


def test_match_entry_name_exact_medium():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(title="贵州茅台发布半年报"), by_code, names_lc)
    assert [(m.code, m.match_rule) for m in matches] == [("600519", "name_exact")]
    assert confidence == "medium"


def test_match_entry_no_match_returns_none():
    by_code, names_lc = _match_indexes()
    assert match_entry(_entry(title="国际油价上涨"), by_code, names_lc) == ([], None)


def test_cursor_roundtrip_and_tamper():
    encoded = encode_cursor("v" * 64, "2026-08-29T00:00:00+00:00", "abc")
    assert decode_cursor(encoded) == {"v": "v" * 64, "t": "2026-08-29T00:00:00+00:00", "i": "abc"}
    assert decode_cursor("not-a-cursor") is None


def test_derived_cache_hit_and_lru_eviction():
    cache = DerivedFeedCache()
    value = ([("eastmoney", "a")], "wm", None)
    cache.put(CacheKey("v1", 0, None, None, 50), value)
    assert cache.get(CacheKey("v1", 0, None, None, 50)) == value
    assert cache.get(CacheKey("v2", 0, None, None, 50)) is None
    assert cache.get(CacheKey("v1", 0, None, None, 25)) is None  # limit 维度
    assert cache.get(CacheKey("v1", 1, None, None, 50)) is None  # generation 变化 → 失效（缺陷 5）
    for i in range(16):
        cache.put(CacheKey(f"k{i}", 0, None, None, 50), ([], None, None))
    assert cache.get(CacheKey("v1", 0, None, None, 50)) is None  # LRU 淘汰


def _feed_service(tmp_path: Path, watchlist_db: Path) -> tuple[WatchlistFeedService, EntryStore]:
    store = EntryStore(tmp_path / "news.db")
    health = HealthTracker(ConservativeCalendar())
    return WatchlistFeedService(store=store, health=health, watchlist_db=watchlist_db), store


def asyncio_run(coroutine):
    return asyncio.run(coroutine)


def test_feed_empty_watchlist_boundary(tmp_path, watchlist_db):
    empty_db = tmp_path / "empty.db"
    with sqlite3.connect(empty_db) as conn:
        conn.execute(WATCHLIST_DB_SCHEMA)
        conn.commit()
    service, _ = _feed_service(tmp_path, empty_db)
    payload = asyncio_run(service.feed(None, None, 50))
    assert payload["items"] == []
    assert payload["new_cursor"] is None
    assert payload["next_cursor"] is None
    assert payload["reset_required"] is False
    assert len(payload["watchlist_version"]) == 64


def test_feed_head_page_sets_both_cursors(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id="a", type="flash", published_at=(NOW - timedelta(minutes=1)).isoformat(),
                    title="贵州茅台发布半年报", summary="", url="", structured_codes=()),
        StoredEntry(source="eastmoney", item_id="b", type="flash", published_at=NOW.isoformat(),
                    title="A股三大指数收盘涨跌不一成交额放大", summary="", url="", structured_codes=("1.600519",)),
        StoredEntry(source="eastmoney", item_id="c", type="flash", published_at=(NOW - timedelta(minutes=2)).isoformat(),
                    title="国际油价周四大涨百分之三创近期新高", summary="", url="", structured_codes=()),
        StoredEntry(source="eastmoney", item_id="d", type="flash", published_at=(NOW - timedelta(minutes=3)).isoformat(),
                    title="平安银行获北向资金连续五日净买入", summary="", url="", structured_codes=("0.000001",)),
    ], now=NOW)
    payload = asyncio_run(service.feed(None, None, 2))
    assert [item["id"] for item in payload["items"]] == ["eastmoney:b", "eastmoney:a"]  # 新→旧 + 过滤未命中
    assert payload["items"][0]["confidence"] == "high"
    assert payload["items"][0]["matched_stocks"] == [{"code": "600519", "name": "贵州茅台", "match_rule": "structured_field"}]
    # new_cursor = 窗口头部水位（含未命中行 b）；next_cursor = 本页末行之后的更早页
    assert payload["new_cursor"] is not None
    assert payload["next_cursor"] is not None
    assert payload["new_cursor"] != payload["next_cursor"]

    older = asyncio_run(service.feed(None, payload["next_cursor"], 50))
    assert [item["id"] for item in older["items"]] == ["eastmoney:d"]  # 翻页只出更早条目
    assert older["next_cursor"] is None
    assert older["new_cursor"] is None  # before 模式不推进水位


def test_feed_poll_returns_only_new_items_and_advances_watermark(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id="a", type="flash", published_at=(NOW - timedelta(minutes=1)).isoformat(),
                    title="贵州茅台发布半年报", summary="", url="", structured_codes=()),
    ], now=NOW)
    head = asyncio_run(service.feed(None, None, 50))
    watermark = head["new_cursor"]
    assert watermark is not None

    # 无新条目的一轮：items 空、水位原样回传
    idle = asyncio_run(service.feed(watermark, None, 50))
    assert idle["items"] == []
    assert idle["new_cursor"] == watermark

    # 新条目到达：只返回更新的条目，水位推进到最新行
    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id="m", type="flash", published_at=NOW.isoformat(),
                    title="白酒龙头午后直线拉升带动指数走强", summary="", url="", structured_codes=("1.600519",)),
        StoredEntry(source="eastmoney", item_id="n", type="flash", published_at=(NOW - timedelta(minutes=5)).isoformat(),
                    title="国际黄金价格创历史新高避险情绪升温", summary="", url="", structured_codes=()),
    ], now=NOW)
    polled = asyncio_run(service.feed(watermark, None, 50))
    assert [item["id"] for item in polled["items"]] == ["eastmoney:m"]
    assert polled["new_cursor"] != watermark

    # 再轮询：不再重复返回 m
    again = asyncio_run(service.feed(polled["new_cursor"], None, 50))
    assert again["items"] == []


def test_feed_mutually_exclusive_cursors(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    with pytest.raises(ValueError):
        asyncio_run(service.feed("a", "b", 50))


def test_feed_garbage_cursor_is_error_not_reset(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    with pytest.raises(ValueError):
        asyncio_run(service.feed("not-a-cursor", None, 50))  # 路由层映射 400，不静默当 null
    with pytest.raises(ValueError):
        asyncio_run(service.feed(None, "garbage", 50))


def test_feed_cache_invalidated_on_ingestion(tmp_path, watchlist_db):
    """缺陷 5：同 (version, cursor) 查询 → 入库新条目 → 再查必须返回新条目。"""
    service, store = _feed_service(tmp_path, watchlist_db)
    first = asyncio_run(service.feed(None, None, 50))
    assert first["items"] == []
    gen0 = store.generation()
    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id="m", type="flash", published_at=NOW.isoformat(),
                    title="白酒龙头午后直线拉升带动指数走强", summary="", url="", structured_codes=("1.600519",)),
    ], now=NOW)
    assert store.generation() == gen0 + 1
    second = asyncio_run(service.feed(None, None, 50))
    assert [item["id"] for item in second["items"]] == ["eastmoney:m"]  # generation 推进 → 缓存失效


def test_feed_after_burst_delivery_no_loss_no_dup(tmp_path, watchlist_db):
    """缺陷 3：一轮涌入超过 limit 条（8 条 / limit=3，三轮拉取），全部送达、无重复。

    标题取自人工核对过的 simhash 两两相似度 <0.7 的真实风格语料——
    结构雷同的合成标题本就应被 §5.5 近似合并，不用于本测试。
    """
    titles = [
        "A股三大指数收盘涨跌不一成交额放大",
        "国际油价周四大涨百分之三创近期新高",
        "平安银行获北向资金连续五日净买入",
        "白酒龙头午后直线拉升带动指数走强",
        "国际黄金价格创历史新高避险情绪升温",
        "央行开展6000亿元中期借贷便利操作",
        "证监会发布程序化交易新规征求意见",
        "工信部发布人工智能产业支持政策",
    ]
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([StoredEntry(source="eastmoney", item_id="seed", type="flash",
        published_at=(NOW - timedelta(hours=2)).isoformat(), title="贵州茅台发布半年报业绩说明",
        summary="", url="", structured_codes=())], now=NOW)
    head = asyncio_run(service.feed(None, None, 3))
    watermark = head["new_cursor"]

    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id=f"n{i}", type="flash",
                    published_at=(NOW - timedelta(minutes=60 - i)).isoformat(),
                    title=titles[i], summary="", url="", structured_codes=("1.600519",))
        for i in range(8)
    ], now=NOW)

    delivered: list[str] = []
    cursor: str | None = watermark
    for _ in range(3):
        page = asyncio_run(service.feed(cursor, None, 3))
        assert [item["id"] for item in page["items"]] == sorted(  # 升序交付（最旧未交付优先）
            (item["id"] for item in page["items"]))
        delivered.extend(item["id"] for item in page["items"])
        cursor = page["new_cursor"]
    assert len(delivered) == 8   # 全部送达（3+3+2）
    assert len(set(delivered)) == 8  # 无重复
    assert all(item_id.startswith("eastmoney:n") for item_id in delivered)
    tail = asyncio_run(service.feed(cursor, None, 3))
    assert tail["items"] == []  # 水位之后无新条目


def test_feed_purged_entries_not_replayed(tmp_path, watchlist_db):
    """缺陷 4：条目被清理后，同 cursor 再查不返回已删条目；连续两次查询一致。"""
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([
        StoredEntry(source="eastmoney", item_id="old", type="flash",
                    published_at=(NOW - FLASH_WINDOW - timedelta(minutes=5)).isoformat(),
                    title="即将超窗的旧快讯", summary="", url="", structured_codes=("1.600519",)),
    ], now=NOW)
    first = asyncio_run(service.feed(None, None, 50))
    assert [item["id"] for item in first["items"]] == ["eastmoney:old"]

    store.purge_expired(now=NOW + timedelta(hours=1))  # 清理超窗条目（seed 已超窗）

    second = asyncio_run(service.feed(None, None, 50))
    assert second["items"] == []  # 已删条目不被 replay
    third = asyncio_run(service.feed(None, None, 50))
    assert [item["id"] for item in third["items"]] == [item["id"] for item in second["items"]]


def test_feed_reset_required_on_either_stale_cursor(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([_entry(item_id="a", title="贵州茅台公告")], now=NOW)
    stale = encode_cursor("0" * 64, NOW.isoformat(), "a")

    stale_after = asyncio_run(service.feed(stale, None, 50))
    assert stale_after["reset_required"] is True
    assert stale_after["items"][0]["id"] == "eastmoney:a"  # after 失效 → 从窗口头部重新匹配

    stale_before = asyncio_run(service.feed(None, stale, 50))
    assert stale_before["reset_required"] is True  # before 失效同样触发 reset


def test_feed_source_health_shape(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    payload = asyncio_run(service.feed(None, None, 50))
    assert [h["source_id"] for h in payload["source_health"]] == ["eastmoney", "sina", "sse", "szse"]
    assert set(payload["source_health"][0].keys()) == {"source_id", "state", "last_success_at", "last_error"}
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_matcher.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.matcher'`。

- [ ] **Step 3: 最小实现**

写入 `agent/src/news/matcher.py`：

```python
"""Read-time watchlist matching with content-version keys and a derived cache (spec §3.1/§4.1)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from src.news.health import HealthTracker, SourceHealth
from src.news.store import StoredEntry, EntryStore

WATCHLIST_DB_PATH = Path.home() / ".vibe-trading" / "watchlist.db"

_HU_PREFIXES = {"600", "601", "603", "605", "688"}
_SZ_PREFIXES = {"000", "001", "002", "003", "300", "301"}
_STOCKLIST_CODE_PATTERN = re.compile(r"([01])\.(\d{6})")
# 上下文护栏：全/半角括号包裹，或“股票代码/证券代码/代码：”引导（§4.1 防金额误伤）
_CODE_CONTEXT_PATTERN = re.compile(r"[（(](\d{6})[）)]|[股证][票券]?代码[:：]?\s*(\d{6})")
MATCH_RULE_STRUCTURED = "structured_field"
MATCH_RULE_CODE_PATTERN = "code_pattern"
MATCH_RULE_NAME_EXACT = "name_exact"


@dataclass(frozen=True)
class WatchlistEntry:
    code: str
    name: str
    market: str


def load_watchlist(db_path: Path | None = None) -> list[WatchlistEntry]:
    """直读本机 watchlist.db（规格 §3.1：不走 HTTP）。库不存在视为空自选。"""
    path = db_path or WATCHLIST_DB_PATH
    if not path.exists():
        return []
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT code, name, market FROM watchlist").fetchall()
    finally:
        conn.close()
    return [
        WatchlistEntry(code=str(row[0]), name=str(row[1] or "").strip(), market=str(row[2] or "a_stock"))
        for row in rows
    ]


def compute_watchlist_version(entries: Sequence[WatchlistEntry]) -> str:
    """watchlist_version = sha256(sorted((code, name, market) triples))；空列表有确定值（规格 §3.1/§6.1）。

    名称参与中置信度匹配：T0 回填/改名必须使版本键变化 → 派生缓存失效，否则缓存复用旧匹配结果。
    """
    payload = "\n".join(
        f"{entry.code}|{entry.name}|{entry.market}"
        for entry in sorted(entries, key=lambda item: (item.code, item.market))
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_stocklist_code(raw: str) -> str | None:
    """东财 stockList `1.600519`/`0.000001` → 6 位代码；北交所前缀未确认，首版跳过（§4.1.1）。"""
    text = raw.strip()
    if text.isdigit() and len(text) == 6:
        return text
    match = _STOCKLIST_CODE_PATTERN.fullmatch(text)
    if not match:
        return None
    flag, code = match.group(1), match.group(2)
    if flag == "1" and code[:3] in _HU_PREFIXES:
        return code
    if flag == "0" and code[:3] in _SZ_PREFIXES:
        return code
    return None


@dataclass(frozen=True)
class MatchedStock:
    code: str
    name: str
    match_rule: str


def match_entry(
    entry: StoredEntry,
    by_code: dict[str, WatchlistEntry],
    names_lc: dict[str, WatchlistEntry],
) -> tuple[list[MatchedStock], str | None]:
    """三级匹配：structured_field(high) > code_pattern(high) > name_exact(medium)。无命中返回 ([], None)。"""
    matches: list[MatchedStock] = []
    seen: set[str] = set()
    for raw in entry.structured_codes:
        code = normalize_stocklist_code(raw)
        if code and code in by_code and code not in seen:
            seen.add(code)
            matches.append(MatchedStock(code=code, name=by_code[code].name, match_rule=MATCH_RULE_STRUCTURED))
    haystack = f"{entry.title} {entry.summary}"
    for match in _CODE_CONTEXT_PATTERN.finditer(haystack):
        code = match.group(1) or match.group(2)
        if code in by_code and code not in seen:
            seen.add(code)
            matches.append(MatchedStock(code=code, name=by_code[code].name, match_rule=MATCH_RULE_CODE_PATTERN))
    lowered = haystack.lower()
    for name, watch_entry in names_lc.items():
        if name in lowered and watch_entry.code not in seen:
            seen.add(watch_entry.code)
            matches.append(MatchedStock(code=watch_entry.code, name=watch_entry.name, match_rule=MATCH_RULE_NAME_EXACT))
    if not matches:
        return [], None
    confidence = "high" if any(item.match_rule != MATCH_RULE_NAME_EXACT for item in matches) else "medium"
    return matches, confidence


def encode_cursor(version: str, published_at: str, item_id: str) -> str:
    """不透明游标 = base64(json{v,t,i})；客户端不得解析内部结构（§6.1）。"""
    payload = json.dumps({"v": version, "t": published_at, "i": item_id}, ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def decode_cursor(cursor: str) -> dict | None:
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, UnicodeError, binascii.Error):
        return None
    if not isinstance(payload, dict) or not {"v", "t", "i"} <= set(payload):
        return None
    return payload


@dataclass(frozen=True)
class CacheKey:
    """派生缓存键（§3.1 + 缺陷4/5 修正）：全维度包含，缺一即可能脏读/replay。"""

    watchlist_version: str
    store_generation: int   # 条目库写入代数：入库/清理后旧页缓存立即失效（实时性 + replay 防护）
    after_cursor: str | None
    before_cursor: str | None
    limit: int


class DerivedFeedCache:
    """键 = (watchlist_version, store_generation, after_cursor, before_cursor, limit)。

    值只存"条目 id 有序列表 + 双游标"而非完整条目快照——hydrate 时从 EntryStore join，
    窗口清理删除条目后，缓存 id 指向的行自然消失，不会把已删数据 replay 给用户。
    """

    MAX_ENTRIES = 16

    def __init__(self) -> None:
        self._entries: OrderedDict[CacheKey, tuple[list[tuple[str, str]], str | None, str | None]] = OrderedDict()

    def get(self, key: CacheKey) -> tuple[list[tuple[str, str]], str | None, str | None] | None:
        if key not in self._entries:
            return None
        self._entries.move_to_end(key)
        return self._entries[key]

    def put(self, key: CacheKey, value: tuple[list[tuple[str, str]], str | None, str | None]) -> None:
        self._entries[key] = value
        self._entries.move_to_end(key)
        while len(self._entries) > self.MAX_ENTRIES:
            self._entries.popitem(last=False)


class WatchlistFeedService:
    """GET /news-api/watchlist-feed 读取路径：加载自选 → 版本键 → 匹配 → 缓存 → 边界语义（§6.1）。

    游标两参数正交：
    - after_cursor（轮询水位）：只返回比它更新的条目；响应 new_cursor 是推进后的水位
      （取本页扫描到的最新一行位置，未命中行也推进水位，避免每轮重扫）。
    - before_cursor（翻页游标）：只返回比它更早的条目；响应 next_cursor 指向更早一页。
    - 首屏（两者皆 null）：从窗口头部取最新一页，同时给出 new_cursor 与 next_cursor。
    """

    def __init__(
        self,
        store: EntryStore,
        health: HealthTracker,
        cache: DerivedFeedCache | None = None,
        watchlist_db: Path | None = None,
    ) -> None:
        self._store = store
        self._health = health
        self._cache = cache or DerivedFeedCache()
        self._watchlist_db = watchlist_db

    async def feed(self, after_cursor: str | None, before_cursor: str | None, limit: int = 50) -> dict:
        if after_cursor and before_cursor:
            raise ValueError("after_cursor and before_cursor are mutually exclusive")
        if after_cursor and decode_cursor(after_cursor) is None:
            raise ValueError("after_cursor is invalid")   # 路由层映射为 400，不静默当 null
        if before_cursor and decode_cursor(before_cursor) is None:
            raise ValueError("before_cursor is invalid")
        limit = max(1, min(limit, 50))
        return await asyncio.get_running_loop().run_in_executor(None, self._feed_sync, after_cursor, before_cursor, limit)

    def _feed_sync(self, after_cursor: str | None, before_cursor: str | None, limit: int) -> dict:
        watchlist = load_watchlist(self._watchlist_db)
        version = compute_watchlist_version(watchlist)
        by_code = {entry.code: entry for entry in watchlist}
        names_lc = {entry.name.lower(): entry for entry in watchlist if entry.name}

        reset_required = False
        effective_after = after_cursor
        if after_cursor and decode_cursor(after_cursor)["v"] != version:
            reset_required = True   # 自选已变化 → 旧游标失效（§6.1），视为空并从窗口头部重匹配
            effective_after = None
        effective_before = before_cursor
        if before_cursor and decode_cursor(before_cursor)["v"] != version:
            reset_required = True
            effective_before = None
        # 缓存键全维度：版本 + 条目库写入代数 + 双游标 + limit；代数推进即失效（实时性 + replay 防护）
        key = CacheKey(watchlist_version=version, store_generation=self._store.generation(),
                       after_cursor=effective_after, before_cursor=effective_before, limit=limit)
        cached = None if reset_required else self._cache.get(key)
        if cached is not None:
            cached_keys, new_cursor, next_cursor = cached
            # hydrate：从条目库 join 现存行（已被窗口清理的键自然消失 → 不 replay 已删数据）
            items = self._match_rows(by_code, names_lc, self._store.fetch_by_keys(cached_keys))
        else:
            if effective_after is not None:
                items, new_cursor, next_cursor, delivered_rows = self._page_after(by_code, names_lc, version, effective_after, limit)
            elif effective_before is not None:
                items, new_cursor, next_cursor, delivered_rows = self._page_before(by_code, names_lc, version, effective_before, limit)
            else:
                items, new_cursor, next_cursor, delivered_rows = self._page_head(by_code, names_lc, version, limit)
            self._cache.put(key, ([(row.source, row.item_id) for row in delivered_rows], new_cursor, next_cursor))
        return {
            "items": items,
            "new_cursor": new_cursor,
            "next_cursor": next_cursor,
            "source_health": self._health_payload(),
            "last_updated_at": self._store.last_updated_at(),
            "watchlist_version": version,
            "reset_required": reset_required,
        }

    def _match_rows(
        self,
        by_code: dict[str, WatchlistEntry],
        names_lc: dict[str, WatchlistEntry],
        rows: list[StoredEntry],
    ) -> list[dict]:
        items: list[dict] = []
        for entry in rows:
            matches, confidence = match_entry(entry, by_code, names_lc)
            if not matches or confidence is None:
                continue  # 低置信度/未命中不展示（§4.1）
            items.append({
                "id": f"{entry.source}:{entry.item_id}",
                "source": entry.source,
                "type": entry.type,
                "published_at": entry.published_at,
                "title": entry.title,
                "summary": entry.summary,
                "url": entry.url or None,
                "matched_stocks": [{"code": m.code, "name": m.name, "match_rule": m.match_rule} for m in matches],
                "confidence": confidence,
            })
        return items

    def _page_head(
        self, by_code: dict[str, WatchlistEntry], names_lc: dict[str, WatchlistEntry],
        version: str, limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        rows = self._store.window_merged(limit=limit + 1)
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)
        new_cursor = encode_cursor(version, rows[0].published_at, rows[0].item_id) if rows else None
        next_cursor = (
            encode_cursor(version, rows[limit - 1].published_at, rows[limit - 1].item_id)
            if len(rows) > limit else None
        )
        return items, new_cursor, next_cursor, delivered

    def _page_after(
        self, by_code: dict[str, WatchlistEntry], names_lc: dict[str, WatchlistEntry],
        version: str, after_cursor: str, limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        """升序交付"最旧的未交付 N 条"（缺陷 3）：一轮涌入超过 limit 条也不丢不重——
        ORDER BY published_at ASC 取最旧未交付页，水位 = 本页最后一条（最新已交付）位置。"""
        data = decode_cursor(after_cursor)
        assert data is not None
        rows = self._store.window_merged(
            limit=limit + 1,
            after_published_at=data["t"], after_item_id=data["i"],
            order="asc",
        )
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)  # 升序返回，前端 reverse 展示
        if delivered:
            new_cursor = encode_cursor(version, delivered[-1].published_at, delivered[-1].item_id)
        else:
            new_cursor = after_cursor  # 无新条目 → 水位不变
        return items, new_cursor, None, delivered

    def _page_before(
        self, by_code: dict[str, WatchlistEntry], names_lc: dict[str, WatchlistEntry],
        version: str, before_cursor: str, limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        data = decode_cursor(before_cursor)
        assert data is not None
        rows = self._store.window_merged(
            limit=limit + 1,
            before_published_at=data["t"], before_item_id=data["i"],
        )
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)
        next_cursor = (
            encode_cursor(version, rows[limit - 1].published_at, rows[limit - 1].item_id)
            if len(rows) > limit else None
        )
        return items, None, next_cursor, delivered

    def _health_payload(self) -> list[dict]:
        snapshot: list[SourceHealth] = self._health.snapshot()
        return [
            {
                "source_id": health.source_id,
                "state": health.state,
                "last_success_at": health.last_success_at,
                "last_error": health.last_error,
            }
            for health in snapshot
        ]
```

- [ ] **Step 4: 运行验证 PASS**

```bash
pytest agent/tests/news/test_matcher.py -v
ruff check agent/src/news/matcher.py
```
Expected: 12 PASS；ruff 无告警。

- [ ] **Step 5: 提交**

```bash
git add agent/src/news/matcher.py agent/tests/news/test_matcher.py
git commit -s -m "feat(news): add read-time watchlist matcher with derived cache"
```

---

### Task 7 (T5): 新端点 + 前端解析器

**Files:**
- Create: `agent/src/api/watchlist_feed_routes.py`
- Modify: `agent/api_server.py:385-391`（旧 news 注册块之后追加新注册；旧块 Task 9 删）
- Modify: `agent/api_server.py:237-263` 附近（startup/shutdown 接线后台轮询）
- Modify: `frontend/src/lib/api.ts`（新增 feed 类型/解析器/api 方法，插在 `:685` api 对象关闭 `};` 之前）
- Test: `agent/tests/test_watchlist_feed_routes.py`（Create）、`frontend/src/lib/__tests__/api.test.ts`（追加）

**Interfaces:**
- Consumes: Task 6 `WatchlistFeedService.feed()` dict 契约、`FeedRefreshCoordinator.trigger() -> RefreshDecision`（本任务 Step 5 在 `agent/src/news/refresh.py` 实现协调器）、Task 4 `FlashAggregator/AnnouncementCollector`。
- Produces: `GET /news-api/watchlist-feed?after_cursor=&before_cursor=&limit=`（200，WatchlistFeedResponse 逐字 §6.1 含 `new_cursor`；after/before 同传→400；cursor>512 字符→422）；`POST /news-api/watchlist-feed/refresh`（202 `{accepted, task_id, reused}`；限流 429）；两者均挂 `require_auth`；前端 `api.getWatchlistFeed(after, before, limit, signal)` / `api.refreshWatchlistFeed(signal)` / `parseWatchlistFeedResponse`（exact-key 校验风格同 `newsRecord` api.ts:200-206）。Task 8 消费。

- [ ] **Step 1: 写 refresh 协调器失败测试**

在 `agent/tests/news/test_flash_service.py` 追加：

```python
# --- FeedRefreshCoordinator（§6.1.1 single-flight + 5s 限流）---
from src.news.refresh import FeedRefreshCoordinator  # noqa: E402


class StubAnnouncements:
    def __init__(self) -> None:
        self.calls: list[bool] = []

    async def maybe_refresh(self, *, force: bool = False) -> None:
        self.calls.append(force)


@_async_test
async def test_refresh_single_flight_and_rate_limit(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    aggregator = FlashAggregator(
        transport=TransportClient(resolver=FakeResolver(), transport=RoutingTransport({
            "/comm/web/getFastNewsList": [
                httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps({"data": {"fastNewsList": []}}).encode()),
            ],
            "/api/roll/get": [
                httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps({"result": {"data": []}}).encode()),
            ],
        })),
        store=store, health=_tracker(), sleep=_no_sleep, now=Clock().now,
    )
    announcements = StubAnnouncements()
    coordinator = FeedRefreshCoordinator(flash=aggregator, announcements=announcements,
                                         now=lambda: 1000.0)
    first = await coordinator.trigger()
    assert (first.accepted, first.reused, first.rate_limited) == (True, False, False)
    assert first.task_id
    second = await coordinator.trigger()  # 任务运行中 → reuse
    assert (second.accepted, second.reused, second.task_id == first.task_id) == (True, True, True)

    await coordinator._task  # 等待任务结束后测试 5s 限流窗口
    await asyncio.sleep(0)
    limited = await coordinator.trigger()
    assert limited.rate_limited is True  # now 固定 1000.0 < 5s 窗口
    assert announcements.calls == [False]  # 公告走 2min 门控，不走 force
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
pytest agent/tests/news/test_flash_service.py -k refresh -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.news.refresh'`。

- [ ] **Step 3: 实现 refresh.py**

写入 `agent/src/news/refresh.py`：

```python
"""Manual force-refresh coordinator: single-flight + 5s rate limit (spec §6.1.1)."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from src.news.flash.service import FlashAggregator

logger = logging.getLogger(__name__)

MIN_TRIGGER_INTERVAL_S = 5.0


class AnnouncementRefresher(Protocol):
    async def maybe_refresh(self, *, force: bool = False) -> None: ...


@dataclass(frozen=True)
class RefreshDecision:
    accepted: bool
    task_id: str | None
    reused: bool
    rate_limited: bool = False


class FeedRefreshCoordinator:
    """触发快讯立即增量拉取；公告仅当上次拉取 >2min（由 AnnouncementCollector.maybe_refresh 门控）。"""

    def __init__(
        self,
        flash: FlashAggregator,
        announcements: AnnouncementRefresher | None = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._flash = flash
        self._announcements = announcements
        self._now = now
        self._last_trigger = float("-inf")
        self._task: asyncio.Task[None] | None = None
        self._task_id: str | None = None

    async def trigger(self) -> RefreshDecision:
        # single-flight 优先于 5s 限流：运行中任务始终 reuse（§6.1.1），不返回 429
        if self._task is not None and not self._task.done():
            return RefreshDecision(accepted=True, task_id=self._task_id, reused=True)
        now = self._now()
        if now - self._last_trigger < MIN_TRIGGER_INTERVAL_S:
            return RefreshDecision(accepted=False, task_id=None, reused=False, rate_limited=True)
        self._last_trigger = now
        self._task_id = str(uuid.uuid4())
        self._task = asyncio.create_task(self._run())
        return RefreshDecision(accepted=True, task_id=self._task_id, reused=False)

    async def _run(self) -> None:
        try:
            await self._flash.poll_source_now("eastmoney")
            await self._flash.poll_source_now("sina")
            if self._announcements is not None:
                await self._announcements.maybe_refresh(force=False)
        except Exception:
            logger.warning("watchlist feed force refresh failed", exc_info=True)
```

- [ ] **Step 4: 运行验证 PASS**

```bash
pytest agent/tests/news/test_flash_service.py -v
ruff check agent/src/news/refresh.py
```
Expected: 全部 PASS。

- [ ] **Step 5: 写路由失败测试**

写入 `agent/tests/test_watchlist_feed_routes.py`：

```python
"""TDD：/news-api/watchlist-feed 路由契约（规格 §6.1/§6.1.1）。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.watchlist_feed_routes import register_watchlist_feed_routes
from src.news.refresh import RefreshDecision


class StubService:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls: list[tuple[str | None, str | None, int]] = []

    async def feed(self, after_cursor: str | None, before_cursor: str | None, limit: int = 50) -> dict:
        if after_cursor and before_cursor:
            raise ValueError("after_cursor and before_cursor are mutually exclusive")
        self.calls.append((after_cursor, before_cursor, limit))
        return self.payload


class StubRefresher:
    def __init__(self, decision: RefreshDecision) -> None:
        self.decision = decision

    async def trigger(self) -> RefreshDecision:
        return self.decision


VALID_PAYLOAD = {
    "items": [{
        "id": "eastmoney:202608291200", "source": "eastmoney", "type": "flash",
        "published_at": "2026-08-29T12:00:00+00:00", "title": "央行开展逆回购", "summary": "500亿元",
        "url": None,
        "matched_stocks": [{"code": "600519", "name": "贵州茅台", "match_rule": "structured_field"}],
        "confidence": "high",
    }],
    "new_cursor": "watermark-cursor",
    "next_cursor": None,
    "source_health": [
        {"source_id": "eastmoney", "state": "ok", "last_success_at": "2026-08-29T12:00:00+00:00", "last_error": None},
        {"source_id": "sina", "state": "failed", "last_success_at": None, "last_error": "timeout"},
    ],
    "last_updated_at": None,
    "watchlist_version": "a" * 64,
    "reset_required": False,
}


def _app(service: StubService, refresher: StubRefresher) -> FastAPI:
    app = FastAPI()
    register_watchlist_feed_routes(app, require_auth=lambda: None, service=service, refresher=refresher)
    return app


def test_get_watchlist_feed_returns_payload():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed")
    assert resp.status_code == 200
    assert set(resp.json().keys()) == set(VALID_PAYLOAD.keys())
    assert resp.json()["new_cursor"] == "watermark-cursor"
    assert service.calls == [(None, None, 50)]


def test_get_watchlist_feed_passthrough_cursors_and_limit():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    client.get("/news-api/watchlist-feed", params={"after_cursor": "wm", "limit": 10})
    client.get("/news-api/watchlist-feed", params={"before_cursor": "pg", "limit": 10})
    assert service.calls == [("wm", None, 10), (None, "pg", 10)]


def test_get_watchlist_feed_rejects_both_cursors_400():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed", params={"after_cursor": "a", "before_cursor": "b"})
    assert resp.status_code == 400


def test_get_watchlist_feed_rejects_overlong_cursor():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed", params={"after_cursor": "x" * 513})
    assert resp.status_code == 422


def test_post_refresh_accepted_202():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, "task-1", False))))
    resp = client.post("/news-api/watchlist-feed/refresh")
    assert resp.status_code == 202
    assert resp.json() == {"accepted": True, "task_id": "task-1", "reused": False}


def test_post_refresh_rate_limited_429():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(False, None, False, rate_limited=True))))
    resp = client.post("/news-api/watchlist-feed/refresh")
    assert resp.status_code == 429
```

- [ ] **Step 6: 运行验证 FAIL**

```bash
pytest agent/tests/test_watchlist_feed_routes.py -v
```
Expected: FAIL——`ModuleNotFoundError: No module named 'src.api.watchlist_feed_routes'`。

- [ ] **Step 7: 实现路由**

写入 `agent/src/api/watchlist_feed_routes.py`：

```python
"""/news-api/watchlist-feed read + manual force-refresh routes (spec §6.1/§6.1.1)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from src.news.matcher import WatchlistFeedService
from src.news.refresh import FeedRefreshCoordinator, RefreshDecision

MAX_CURSOR_LENGTH = 512


class MatchedStockDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    name: str
    match_rule: Literal["structured_field", "code_pattern", "name_exact"]


class FeedItemDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    source: Literal["eastmoney", "sina", "sse", "szse"]
    type: Literal["flash", "announcement"]
    published_at: str
    title: str
    summary: str
    url: str | None
    matched_stocks: list[MatchedStockDTO]
    confidence: Literal["high", "medium"]


class SourceHealthDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: Literal["eastmoney", "sina", "sse", "szse"]
    state: Literal["ok", "degraded", "failed"]
    last_success_at: str | None
    last_error: str | None


class WatchlistFeedResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[FeedItemDTO] = Field(max_length=50)
    new_cursor: str | None
    next_cursor: str | None
    source_health: list[SourceHealthDTO]
    last_updated_at: str | None
    watchlist_version: str = Field(min_length=64, max_length=64)
    reset_required: bool


class FeedRefreshResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    task_id: str | None
    reused: bool


def create_watchlist_feed_router(service: WatchlistFeedService, refresher: FeedRefreshCoordinator) -> APIRouter:
    router = APIRouter(prefix="/news-api", tags=["news"])

    @router.get("/watchlist-feed", response_model=WatchlistFeedResponse)
    async def get_watchlist_feed(
        after_cursor: str | None = None, before_cursor: str | None = None, limit: int = 50
    ) -> WatchlistFeedResponse:
        if after_cursor and before_cursor:
            raise HTTPException(status_code=400, detail="after_cursor and before_cursor are mutually exclusive")
        if len(after_cursor or "") > MAX_CURSOR_LENGTH or len(before_cursor or "") > MAX_CURSOR_LENGTH:
            raise HTTPException(status_code=422, detail="cursor is too long")
        try:
            payload = await service.feed(after_cursor, before_cursor, limit)
        except ValueError:
            raise HTTPException(status_code=400, detail="after_cursor and before_cursor are mutually exclusive") from None
        return WatchlistFeedResponse.model_validate(payload)

    @router.post("/watchlist-feed/refresh", response_model=FeedRefreshResponse, status_code=202)
    async def refresh_watchlist_feed() -> FeedRefreshResponse:
        decision: RefreshDecision = await refresher.trigger()
        if decision.rate_limited:
            raise HTTPException(status_code=429, detail="refresh rate limited")
        return FeedRefreshResponse(accepted=decision.accepted, task_id=decision.task_id, reused=decision.reused)

    return router


def register_watchlist_feed_routes(
    app: FastAPI,
    require_auth: Callable[..., Awaitable[None]],
    service: WatchlistFeedService,
    refresher: FeedRefreshCoordinator,
) -> None:
    """Attach the feed boundary with the server's existing auth dependency (spec §6.1)."""
    app.include_router(create_watchlist_feed_router(service, refresher), dependencies=[Depends(require_auth)])
```

接线 `agent/api_server.py`——在旧块（:385-391 `# --- Investment news ---`）之后追加：

```python
# --- Investment news (watchlist feed, spec 2026-08-29) ---
# Register before ``serve_main`` can mount the root SPA catch-all.
from src.api.watchlist_feed_routes import register_watchlist_feed_routes  # noqa: E402
from src.news.announcements.collector import AnnouncementCollector  # noqa: E402
from src.news.calendar import ConservativeCalendar  # noqa: E402
from src.news.flash.service import FlashAggregator  # noqa: E402
from src.news.health import HealthTracker  # noqa: E402
from src.news.matcher import WatchlistFeedService  # noqa: E402
from src.news.refresh import FeedRefreshCoordinator  # noqa: E402
from src.news.store import EntryStore  # noqa: E402
from src.news.transport import TransportClient  # noqa: E402

_feed_store = EntryStore()
_feed_health = HealthTracker(ConservativeCalendar())
_feed_transport = TransportClient()
_flash_aggregator = FlashAggregator(transport=_feed_transport, store=_feed_store, health=_feed_health)
_announcement_collector = AnnouncementCollector(transport=_feed_transport, store=_feed_store, health=_feed_health)
_feed_refresher = FeedRefreshCoordinator(flash=_flash_aggregator, announcements=_announcement_collector)
_feed_service = WatchlistFeedService(store=_feed_store, health=_feed_health)
register_watchlist_feed_routes(app, require_auth=require_auth, service=_feed_service, refresher=_feed_refresher)

_feed_stop = asyncio.Event()


@app.on_event("startup")
async def _start_feed_loops() -> None:
    """后台分层轮询（§7.4）：快讯 15-30s、公告 5-10min；cleanup 由 shutdown 触发。"""
    global _feed_stop
    _feed_stop = asyncio.Event()
    asyncio.create_task(_flash_aggregator.run_forever(_feed_stop))
    asyncio.create_task(_announcement_collector.run_forever(_feed_stop))


@app.on_event("shutdown")
async def _stop_feed_loops() -> None:
    _feed_stop.set()
```

- [ ] **Step 8: 运行路由验证 PASS**

```bash
pytest agent/tests/test_watchlist_feed_routes.py agent/tests/news -v
ruff check agent/src/api/watchlist_feed_routes.py
```
Expected: 新 5 条路由测试 + agent/tests/news 全部 PASS（Task 9 之前旧 news 模块共存，test_news 旧测试仍 PASS）。

- [ ] **Step 9: 前端解析器失败测试**

在 `frontend/src/lib/__tests__/api.test.ts` 文件末尾追加：

```typescript
// --- Watchlist feed parser（exact-key 校验风格同 newsRecord）---
import { parseWatchlistFeedResponse } from "../api";

const validFeed = {
  items: [
    {
      id: "eastmoney:1", source: "eastmoney", type: "flash",
      published_at: "2026-08-29T12:00:00+00:00", title: "央行开展逆回购", summary: "500亿",
      url: null,
      matched_stocks: [{ code: "600519", name: "贵州茅台", match_rule: "structured_field" }],
      confidence: "high",
    },
  ],
  new_cursor: "watermark",
  next_cursor: null,
  source_health: [
    { source_id: "eastmoney", state: "ok", last_success_at: "2026-08-29T12:00:00+00:00", last_error: null },
    { source_id: "sina", state: "failed", last_success_at: null, last_error: "timeout" },
  ],
  last_updated_at: null,
  watchlist_version: "a".repeat(64),
  reset_required: false,
};

describe("parseWatchlistFeedResponse", () => {
  it("parses a valid payload", () => {
    const feed = parseWatchlistFeedResponse(validFeed);
    expect(feed.items[0].matched_stocks[0].code).toBe("600519");
    expect(feed.new_cursor).toBe("watermark");
    expect(feed.watchlist_version).toHaveLength(64);
    expect(feed.reset_required).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    expect(() => parseWatchlistFeedResponse({ ...validFeed, extra: 1 })).toThrow();
  });

  it("rejects missing keys", () => {
    const { reset_required: _dropped, ...partial } = validFeed;
    expect(() => parseWatchlistFeedResponse(partial)).toThrow();
  });

  it("rejects non-http item urls", () => {
    const bad = { ...validFeed, items: [{ ...validFeed.items[0], url: "javascript:alert(1)" }] };
    expect(() => parseWatchlistFeedResponse(bad)).toThrow();
  });

  it("rejects more than 50 items", () => {
    const item = validFeed.items[0];
    expect(() => parseWatchlistFeedResponse({ ...validFeed, items: Array.from({ length: 51 }, () => item) })).toThrow();
  });

  it("rejects malformed watchlist_version", () => {
    expect(() => parseWatchlistFeedResponse({ ...validFeed, watchlist_version: "xyz" })).toThrow();
  });

  it("rejects low-confidence enum violation", () => {
    const bad = { ...validFeed, items: [{ ...validFeed.items[0], confidence: "low" }] };
    expect(() => parseWatchlistFeedResponse(bad)).toThrow();
  });
});
```

若仓库 lint 禁止 mid-file import，将 import 移到文件顶部。

- [ ] **Step 10: 运行验证 FAIL**

```bash
cd frontend && npx vitest run src/lib/__tests__/api.test.ts
```
Expected: FAIL——`parseWatchlistFeedResponse` 未导出。

- [ ] **Step 11: 实现 api.ts 解析器与方法**

修改 `frontend/src/lib/api.ts`——在 api 对象（`:685` 关闭 `};` 之前）插入方法，并在 `NewsRefreshAccepted`（:190-194）之后插入类型与解析器：

```typescript
// --- Watchlist feed (investment news refactor 2026-08-29) ---
export type FeedSourceId = "eastmoney" | "sina" | "sse" | "szse";
export type FeedSourceState = "ok" | "degraded" | "failed";
export type FeedItemType = "flash" | "announcement";
export type FeedMatchRule = "structured_field" | "code_pattern" | "name_exact";
export type FeedConfidence = "high" | "medium";

export interface FeedMatchedStock {
  code: string;
  name: string;
  match_rule: FeedMatchRule;
}

export interface FeedItem {
  id: string;
  source: FeedSourceId;
  type: FeedItemType;
  published_at: string;
  title: string;
  summary: string;
  url: string | null;
  matched_stocks: FeedMatchedStock[];
  confidence: FeedConfidence;
}

export interface FeedSourceHealth {
  source_id: FeedSourceId;
  state: FeedSourceState;
  last_success_at: string | null;
  last_error: string | null;
}

export interface WatchlistFeed {
  items: FeedItem[];
  new_cursor: string | null;
  next_cursor: string | null;
  source_health: FeedSourceHealth[];
  last_updated_at: string | null;
  watchlist_version: string;
  reset_required: boolean;
}

export interface FeedRefreshAccepted {
  accepted: boolean;
  task_id: string | null;
  reused: boolean;
}

const FEED_SOURCE_IDS: readonly FeedSourceId[] = ["eastmoney", "sina", "sse", "szse"];
const FEED_SOURCE_STATES: readonly FeedSourceState[] = ["ok", "degraded", "failed"];
const FEED_ITEM_TYPES: readonly FeedItemType[] = ["flash", "announcement"];
const FEED_MATCH_RULES: readonly FeedMatchRule[] = ["structured_field", "code_pattern", "name_exact"];
const FEED_CONFIDENCES: readonly FeedConfidence[] = ["high", "medium"];

function invalidFeedResponse(): never {
  throw new ApiError("Invalid watchlist feed response", 200);
}

function feedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidFeedResponse();
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) invalidFeedResponse();
  return record;
}

function feedString(value: unknown, minLength: number, maxLength: number): string {
  if (typeof value !== "string") invalidFeedResponse();
  const length = Array.from(value).length;
  if (length < minLength || length > maxLength) invalidFeedResponse();
  return value;
}

function feedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidFeedResponse();
  return value;
}

function feedArray(value: unknown, minLength: number, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) invalidFeedResponse();
  return value;
}

function feedIsoDate(value: unknown, nullable: boolean): string | null {
  if (value === null) {
    if (!nullable) invalidFeedResponse();
    return null;
  }
  const date = feedString(value, 1, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+]00:00)$/.test(date) || Number.isNaN(new Date(date).getTime())) {
    invalidFeedResponse();
  }
  return date;
}

function feedHttpUrl(value: unknown): string | null {
  if (value === null) return null;
  const url = feedString(value, 1, 2048);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalidFeedResponse();
  } catch {
    invalidFeedResponse();
  }
  return url;
}

function parseFeedMatchedStock(value: unknown): FeedMatchedStock {
  const record = feedRecord(value, ["code", "name", "match_rule"]);
  const code = feedString(record.code, 6, 6);
  if (!/^\d{6}$/.test(code)) invalidFeedResponse();
  const matchRule = feedString(record.match_rule, 1, 32);
  if (!FEED_MATCH_RULES.includes(matchRule as FeedMatchRule)) invalidFeedResponse();
  return { code, name: feedString(record.name, 1, 64), match_rule: matchRule as FeedMatchRule };
}

function parseFeedItem(value: unknown): FeedItem {
  const record = feedRecord(value, ["id", "source", "type", "published_at", "title", "summary", "url", "matched_stocks", "confidence"]);
  const source = feedString(record.source, 1, 16);
  const type = feedString(record.type, 1, 16);
  const confidence = feedString(record.confidence, 1, 8);
  if (!FEED_SOURCE_IDS.includes(source as FeedSourceId) || !FEED_ITEM_TYPES.includes(type as FeedItemType) || !FEED_CONFIDENCES.includes(confidence as FeedConfidence)) {
    invalidFeedResponse();
  }
  return {
    id: feedString(record.id, 1, 160),
    source: source as FeedSourceId,
    type: type as FeedItemType,
    published_at: feedIsoDate(record.published_at, false)!,
    title: feedString(record.title, 1, 500),
    summary: feedString(record.summary, 0, 500),
    url: feedHttpUrl(record.url),
    matched_stocks: feedArray(record.matched_stocks, 0, 10).map(parseFeedMatchedStock),
    confidence: confidence as FeedConfidence,
  };
}

export function parseWatchlistFeedResponse(value: unknown): WatchlistFeed {
  const record = feedRecord(value, ["items", "new_cursor", "next_cursor", "source_health", "last_updated_at", "watchlist_version", "reset_required"]);
  const version = feedString(record.watchlist_version, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(version)) invalidFeedResponse();
  const items = feedArray(record.items, 0, 50).map(parseFeedItem);
  const newCursor = record.new_cursor === null ? null : feedString(record.new_cursor, 1, 512);
  const nextCursor = record.next_cursor === null ? null : feedString(record.next_cursor, 1, 512);
  const sourceHealth = feedArray(record.source_health, 0, 4).map((entry): FeedSourceHealth => {
    const health = feedRecord(entry, ["source_id", "state", "last_success_at", "last_error"]);
    const sourceId = feedString(health.source_id, 1, 16);
    const state = feedString(health.state, 1, 16);
    if (!FEED_SOURCE_IDS.includes(sourceId as FeedSourceId) || !FEED_SOURCE_STATES.includes(state as FeedSourceState)) {
      invalidFeedResponse();
    }
    return {
      source_id: sourceId as FeedSourceId,
      state: state as FeedSourceState,
      last_success_at: feedIsoDate(health.last_success_at, true),
      last_error: health.last_error === null ? null : feedString(health.last_error, 1, 200),
    };
  });
  return {
    items,
    new_cursor: newCursor,
    next_cursor: nextCursor,
    source_health: sourceHealth,
    last_updated_at: feedIsoDate(record.last_updated_at, true),
    watchlist_version: version,
    reset_required: feedBoolean(record.reset_required),
  };
}

function parseFeedRefreshAccepted(value: unknown): FeedRefreshAccepted {
  const record = feedRecord(value, ["accepted", "task_id", "reused"]);
  const taskId = record.task_id === null ? null : feedString(record.task_id, 1, 64);
  if (taskId !== null && !NEWS_UUID_PATTERN.test(taskId)) invalidFeedResponse();
  return { accepted: feedBoolean(record.accepted), task_id: taskId, reused: feedBoolean(record.reused) };
}
```

在 api 对象内（`getNewsRefreshStatus`（:683-684）之后、对象关闭 `};` 之前）插入：

```typescript
  getWatchlistFeed: async (after: string | null, before: string | null, limit: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after_cursor", after);
    if (before) params.set("before_cursor", before);
    return parseWatchlistFeedResponse(await request<unknown>(`/news-api/watchlist-feed?${params.toString()}`, { signal }));
  },
  refreshWatchlistFeed: async (signal?: AbortSignal) =>
    parseFeedRefreshAccepted(await request<unknown>("/news-api/watchlist-feed/refresh", { method: "POST", signal })),
```

- [ ] **Step 12: 运行前后端验证**

```bash
cd frontend && npx vitest run src/lib/__tests__/api.test.ts && npx tsc -b
cd .. && pytest agent/tests/test_watchlist_feed_routes.py -v && ruff check agent/src/api/watchlist_feed_routes.py
```
Expected: 前端解析器 7 条 PASS + tsc 无类型错误；后端路由 5 条 PASS。

- [ ] **Step 13: 提交**

```bash
git add agent/src/api/watchlist_feed_routes.py agent/src/news/refresh.py agent/api_server.py agent/tests/test_watchlist_feed_routes.py agent/tests/news/test_flash_service.py frontend/src/lib/api.ts frontend/src/lib/__tests__/api.test.ts
git commit -s -m "feat(news): add watchlist-feed API endpoints and frontend parser"
```

---

### Task 8 (T6): 前端 News 页重构

**Files:**
- Create: `frontend/src/hooks/useWatchlistFeed.ts`
- Rewrite: `frontend/src/pages/News.tsx`
- Rewrite: `frontend/src/pages/__tests__/News.test.tsx`
- Delete: `frontend/src/pages/__tests__/News.layout.test.tsx`（旧赛道布局契约随页面删除）
- Create: `frontend/src/hooks/__tests__/useWatchlistFeed.test.tsx`
- Modify: `frontend/src/i18n/locales/{zh-CN,en,ja,ko,ar}.json`（news.* 键替换）与 `frontend/src/i18n/__tests__/newsLocales.test.ts`

**Interfaces:**
- Consumes: Task 7 `api.getWatchlistFeed/refreshWatchlistFeed` 与 `WatchlistFeed/FeedItem/FeedSourceHealth` 类型。
- Produces: `useWatchlistFeed(): { feed: WatchlistFeed | null; isLoading: boolean; isRefreshing: boolean; error: string | null; refresh: () => Promise<void>; loadMore: () => Promise<void> }`。游标状态机：首屏 `(null,null)` 拉最新页并保存 `new_cursor`/`next_cursor`；轮询 tick 发 `(new_cursor,null)` 增量合并（前置新条目、按 id 去重、水位推进）；上滑加载发 `(null,next_cursor)` 追加更早条目；`reset_required` 整页替换。轮询 12s（10-15s 窗口）、`document.hidden` 暂停、`visibilitychange` 回前台补拉（§6.3）。

- [ ] **Step 1: 写 hook 失败测试**

写入 `frontend/src/hooks/__tests__/useWatchlistFeed.test.tsx`：

```tsx
import { act, render, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWatchlistFeed: vi.fn(),
  refreshWatchlistFeed: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getWatchlistFeed: mocks.getWatchlistFeed,
    refreshWatchlistFeed: mocks.refreshWatchlistFeed,
  },
}));

import { useWatchlistFeed } from "../useWatchlistFeed";

const feed = (overrides: Record<string, unknown> = {}) => ({
  items: [] as Array<{ id: string }>,
  new_cursor: null as string | null,
  next_cursor: null as string | null,
  source_health: [{ source_id: "eastmoney", state: "ok", last_success_at: null, last_error: null }],
  last_updated_at: null,
  watchlist_version: "a".repeat(64),
  reset_required: false,
  ...overrides,
});

function Harness({ onState }: { onState: (state: ReturnType<typeof useWatchlistFeed>) => void }) {
  onState(useWatchlistFeed());
  return null;
}

test("initial load fetches head page", async () => {
  mocks.getWatchlistFeed.mockResolvedValue(feed({ items: [{ id: "1" }], new_cursor: "wm1", next_cursor: "pg1" }));
  render(<Harness onState={() => {}} />);
  await waitFor(() => expect(mocks.getWatchlistFeed).toHaveBeenCalledWith(null, null, 50, undefined));
});

test("poll sends after_cursor and prepends only new items", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1", next_cursor: "pg1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm2" }));
  let latest: ReturnType<typeof useWatchlistFeed> | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith("wm1", null, 50, undefined);
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2", "1"]); // 新条目前置，旧条目保留
  expect(latest!.feed!.new_cursor).toBe("wm2");   // 水位推进
  expect(latest!.feed!.next_cursor).toBe("pg1");  // 翻页游标不受轮询影响
  vi.useRealTimers();
});

test("poll with no new items keeps stream and watermark", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1" }))
    .mockResolvedValueOnce(feed({ items: [], new_cursor: "wm1" }));
  let latest: ReturnType<typeof useWatchlistFeed> | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["1"]);
  expect(latest!.feed!.new_cursor).toBe("wm1");
  vi.useRealTimers();
});

test("skips polling while document is hidden and refetches on visible", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  mocks.getWatchlistFeed.mockResolvedValue(feed());
  render(<Harness onState={() => {}} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(mocks.getWatchlistFeed).toHaveBeenCalledTimes(0); // hidden 暂停（§6.3）
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.getWatchlistFeed).toHaveBeenCalled(); // 回前台补拉
  vi.useRealTimers();
});

test("refresh posts then reloads head page", async () => {
  mocks.getWatchlistFeed.mockResolvedValue(feed({ items: [{ id: "1" }] }));
  mocks.refreshWatchlistFeed.mockResolvedValue({ accepted: true, task_id: "t", reused: false });
  let latest: ReturnType<typeof useWatchlistFeed> | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await waitFor(() => expect(latest).not.toBeNull());
  await act(async () => { await latest!.refresh(); });
  expect(mocks.refreshWatchlistFeed).toHaveBeenCalledTimes(1);
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith(null, null, 50, undefined);
});

test("loadMore sends before_cursor and appends older items", async () => {
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm1", next_cursor: "pg1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], next_cursor: null }));
  let latest: ReturnType<typeof useWatchlistFeed> | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await waitFor(() => expect(latest?.feed?.next_cursor).toBe("pg1"));
  await act(async () => { await latest!.loadMore(); });
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith(null, "pg1", 50, undefined);
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2", "1"]); // 更早条目追加在后
  expect(latest!.feed!.next_cursor).toBe(null);
  expect(latest!.feed!.new_cursor).toBe("wm1"); // 翻页不推进水位
});

test("reset_required on poll replaces items", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm2", next_cursor: "pg2", reset_required: true }));
  let latest: ReturnType<typeof useWatchlistFeed> | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2"]); // 整页替换（服务端已按头部重匹配）
  expect(latest!.feed!.new_cursor).toBe("wm2");
  vi.useRealTimers();
});
```

- [ ] **Step 2: 运行验证 FAIL**

```bash
cd frontend && npx vitest run src/hooks/__tests__/useWatchlistFeed.test.tsx
```
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 useWatchlistFeed.ts**

写入 `frontend/src/hooks/useWatchlistFeed.ts`：

```typescript
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, type WatchlistFeed } from "@/lib/api";

const POLL_INTERVAL_MS = 12_000; // 规格 §6.3：10-15s 短轮询
const PAGE_LIMIT = 50;           // 规格 §6.1 items 上限

export interface WatchlistFeedState {
  feed: WatchlistFeed | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
}

type FeedAction =
  | { type: "loaded"; feed: WatchlistFeed }   // 首屏/整页替换
  | { type: "polled"; feed: WatchlistFeed }   // 轮询：增量合并新条目
  | { type: "appended"; feed: WatchlistFeed } // 上滑：追加更早条目
  | { type: "refreshing"; value: boolean }
  | { type: "failed"; error: string };

function mergeNewer(current: WatchlistFeed, incoming: WatchlistFeed): WatchlistFeed {
  const seen = new Set(current.items.map((item) => item.id));
  // after 模式服务端升序交付（防 poll 丢条目），前端 reverse 后前置，维持新→旧展示序
  const fresh = incoming.items.filter((item) => !seen.has(item.id)).reverse();
  return {
    ...current,
    items: [...fresh, ...current.items],
    new_cursor: incoming.new_cursor ?? current.new_cursor, // 水位推进；无新条目时回传原水位
    source_health: incoming.source_health,
    last_updated_at: incoming.last_updated_at,
    reset_required: false,
  };
}

function mergeOlder(current: WatchlistFeed, incoming: WatchlistFeed): WatchlistFeed {
  const seen = new Set(current.items.map((item) => item.id));
  const older = incoming.items.filter((item) => !seen.has(item.id));
  return {
    ...current,
    items: [...current.items, ...older],
    next_cursor: incoming.next_cursor,
    source_health: incoming.source_health,
    last_updated_at: incoming.last_updated_at,
    reset_required: false,
  };
}

function reduce(state: WatchlistFeedState, action: FeedAction): WatchlistFeedState {
  switch (action.type) {
    case "loaded":
      return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
    case "polled":
      if (!state.feed || action.feed.reset_required) {
        // reset_required：服务端已按窗口头部重匹配 → 整页替换
        return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
      }
      return { feed: mergeNewer(state.feed, action.feed), isLoading: false, isRefreshing: false, error: null };
    case "appended":
      if (!state.feed || action.feed.reset_required) {
        return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
      }
      return { feed: mergeOlder(state.feed, action.feed), isLoading: false, isRefreshing: false, error: null };
    case "refreshing":
      return { ...state, isRefreshing: action.value };
    case "failed":
      return { ...state, isLoading: false, isRefreshing: false, error: action.error };
  }
}

function wasAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWatchlistFeed(): WatchlistFeedState & {
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const [state, dispatch] = useReducer(reduce, { feed: null, isLoading: true, isRefreshing: false, error: null });
  const feedRef = useRef(state.feed);
  feedRef.current = state.feed;

  const loadHead = useCallback(async () => {
    try {
      const response = await api.getWatchlistFeed(null, null, PAGE_LIMIT);
      dispatch({ type: "loaded", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  const poll = useCallback(async () => {
    const watermark = feedRef.current?.new_cursor ?? null;
    try {
      const response = await api.getWatchlistFeed(watermark, null, PAGE_LIMIT);
      dispatch({ type: "polled", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  const refresh = useCallback(async () => {
    dispatch({ type: "refreshing", value: true });
    try {
      await api.refreshWatchlistFeed();
    } catch {
      // 429/网络失败不阻断：随后仍立即 GET 拉新（§6.1.1 前端约定）
    }
    await loadHead();
    dispatch({ type: "refreshing", value: false });
  }, [loadHead]);

  const loadMore = useCallback(async () => {
    const cursor = feedRef.current?.next_cursor ?? null;
    if (!cursor) return;
    try {
      const response = await api.getWatchlistFeed(null, cursor, PAGE_LIMIT);
      dispatch({ type: "appended", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.hidden) return; // hidden 暂停（§6.3）
      if (feedRef.current === null) await loadHead();
      else await poll();
    };
    const schedule = () => {
      timer = setTimeout(() => {
        timer = null;
        void tick().then(() => {
          if (active) schedule();
        });
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) void poll(); // 回前台补拉（§6.3）
    };
    void tick();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadHead, poll]);

  return { ...state, refresh, loadMore };
}
```

- [ ] **Step 4: 运行验证 PASS**

```bash
cd frontend && npx vitest run src/hooks/__tests__/useWatchlistFeed.test.tsx
```
Expected: 5 PASS（fake timers 下 hidden/轮询行为如断言；若 fake timer 与 visibility 组合抖动，把第 2 条改为 real timers + jest-dom 等待——以实际为准，但不得放松 §6.3 语义）。

- [ ] **Step 5: 写页面失败测试（重写 News.test.tsx）**

用以下内容**整文件替换** `frontend/src/pages/__tests__/News.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import type { WatchlistFeed } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn().mockResolvedValue(undefined),
  state: { feed: null as WatchlistFeed | null, isLoading: false, isRefreshing: false, error: null as string | null },
}));

vi.mock("@/hooks/useWatchlistFeed", () => ({
  useWatchlistFeed: () => ({
    ...mocks.state,
    refresh: mocks.refresh,
    loadMore: mocks.loadMore,
  }),
}));

import { News } from "../News";

const feed = (overrides: Partial<WatchlistFeed> = {}): WatchlistFeed => ({
  items: [
    {
      id: "sse:abc", source: "sse", type: "announcement",
      published_at: "2026-08-28T10:30:00+00:00",
      title: "关于召开临时股东大会的通知", summary: "摘要内容",
      url: "https://static.sse.com.cn/x.pdf",
      matched_stocks: [{ code: "600519", name: "贵州茅台", match_rule: "structured_field" }],
      confidence: "high",
    },
    {
      id: "eastmoney:1", source: "eastmoney", type: "flash",
      published_at: "2026-08-29T12:00:00+00:00", title: "央行开展逆回购", summary: "",
      url: null, matched_stocks: [], confidence: "high",
    },
  ],
  next_cursor: null,
  source_health: [
    { source_id: "eastmoney", state: "ok", last_success_at: null, last_error: null },
    { source_id: "sina", state: "ok", last_success_at: null, last_error: null },
    { source_id: "sse", state: "degraded", last_success_at: null, last_error: "timeout" },
    { source_id: "szse", state: "ok", last_success_at: null, last_error: null },
  ],
  last_updated_at: "2026-08-29T12:00:01+00:00",
  watchlist_version: "a".repeat(64),
  reset_required: false,
  ...overrides,
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

test("renders unified stream with announcement badge and stock badge link", () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  expect(screen.getByText("关于召开临时股东大会的通知")).toBeInTheDocument();
  expect(screen.getByText("公告")).toBeInTheDocument(); // 公告置顶标识（§6.3）
  const badge = screen.getByText("600519 贵州茅台");
  expect(badge).toHaveAttribute("href", "/watchlist"); // 股票徽标跳自选管理（§6.3）
});

test("shows degraded hint but not banner when any source is ok", () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  expect(screen.getByText(/上交所/)).toBeInTheDocument(); // 单源降级小字提示（§6.3）
  expect(screen.queryByText("数据可能延迟")).not.toBeInTheDocument();
});

test("shows delayed banner when all sources failed", () => {
  const all = feed().source_health.map((health) => ({ ...health, state: "failed" as const }));
  mocks.state = { feed: feed({ source_health: all }), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  expect(screen.getByText("数据可能延迟")).toBeInTheDocument(); // 全源失败横幅（§5.7）
  expect(screen.getByText(/最后更新/)).toBeInTheDocument();
});

test("shows empty-watchlist guidance when no items and no failures", () => {
  mocks.state = { feed: feed({ items: [] }), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  expect(screen.getByText("还没有自选股")).toBeInTheDocument();
  expect(screen.getByText("去添加自选").closest("a")).toHaveAttribute("href", "/watchlist");
});

test("manual refresh calls hook refresh", async () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

test("load more button appears when next_cursor exists", async () => {
  mocks.state = { feed: feed({ next_cursor: "cursor" }), isLoading: false, isRefreshing: false, error: null };
  render(<News />);
  await userEvent.click(screen.getByRole("button", { name: "加载更早" }));
  expect(mocks.loadMore).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 6: 运行验证 FAIL**

```bash
cd frontend && npx vitest run src/pages/__tests__/News.test.tsx
```
Expected: FAIL——新 i18n 键与新组件结构尚未实现。

- [ ] **Step 7: 重写 News.tsx**

用以下内容**整文件替换** `frontend/src/pages/News.tsx`：

```tsx
import { Bell, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/common/Skeleton";
import { useWatchlistFeed } from "@/hooks/useWatchlistFeed";
import type { FeedItem, FeedMatchedStock, WatchlistFeed } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";

function safeArticleUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function formatTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale);
}

function StockBadge({ stock }: { stock: FeedMatchedStock }) {
  return (
    <Link
      to="/watchlist"
      className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
    >
      {stock.code} {stock.name}
    </Link>
  );
}

function FeedRow({ item, locale }: { item: FeedItem; locale: string | undefined }) {
  const { t } = useTranslation();
  const url = item.url ? safeArticleUrl(item.url) : null;
  const timeText = formatTime(item.published_at, locale) || t("news.unknownTime");
  return (
    <article className="border-b border-border/60 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {item.type === "announcement" && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600">
            <Bell className="size-3" aria-hidden />
            {t("news.announcement")}
          </span>
        )}
        <span>{t(`news.sources.${item.source}`)}</span>
        <span aria-hidden>·</span>
        <time dateTime={item.published_at}>{timeText}</time>
      </div>
      <h3 className="mt-1 text-sm font-medium leading-6">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
            {item.title}
            <ExternalLink className="ml-1 inline size-3.5 text-muted-foreground" aria-hidden />
          </a>
        ) : (
          item.title
        )}
      </h3>
      {item.summary && <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>}
      {item.matched_stocks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.matched_stocks.map((stock) => (
            <StockBadge key={`${stock.code}-${stock.match_rule}`} stock={stock} />
          ))}
        </div>
      )}
    </article>
  );
}

function HealthHints({ feed }: { feed: WatchlistFeed }) {
  const { t } = useTranslation();
  const allFailed = feed.source_health.length > 0 && feed.source_health.every((health) => health.state === "failed");
  const degraded = feed.source_health.filter((health) => health.state === "degraded");
  return (
    <>
      {allFailed && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600" role="alert">
          <p className="font-medium">{t("news.delayedBanner")}</p>
          {feed.last_updated_at && (
            <p className="mt-0.5 text-xs">{t("news.lastUpdated", { time: formatTime(feed.last_updated_at, undefined) || t("news.unknownTime") })}</p>
          )}
        </div>
      )}
      {degraded.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {degraded.map((health) => t("news.sourceDegraded", { source: t(`news.sources.${health.source_id}`) })).join("；")}
        </p>
      )}
    </>
  );
}

export function News() {
  const { t, i18n } = useTranslation();
  const { feed, isLoading, isRefreshing, error, refresh, loadMore } = useWatchlistFeed();
  const locale = i18n.resolvedLanguage;
  const allFailed = (feed?.source_health.length ?? 0) > 0 && feed!.source_health.every((health) => health.state === "failed");
  const emptyNoWatchlist = feed !== null && feed.items.length === 0 && !allFailed && !error;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="News"
        title={t("news.title")}
        sub={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} aria-hidden />
            {isRefreshing ? t("news.refreshing") : t("news.refresh")}
          </button>
        }
      />
      <div className="space-y-2">
        {feed && <HealthHints feed={feed} />}
        {error && <p className="text-sm text-red-600">{t("news.error")}</p>}
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {emptyNoWatchlist && (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm font-medium">{t("news.emptyNoWatchlist")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("news.emptyNoWatchlistHint")}</p>
            <Link to="/watchlist" className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
              {t("news.goWatchlist")}
            </Link>
          </div>
        )}
        {feed && feed.items.length > 0 && (
          <>
            {feed.items.map((item) => (
              <FeedRow key={item.id} item={item} locale={locale} />
            ))}
            {feed.next_cursor && (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="w-full rounded-md border py-2 text-sm hover:bg-muted"
              >
                {t("news.loadMore")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default News;
```

- [ ] **Step 8: i18n 键替换**

把 5 个 locale 文件的 `"news": { ... }` 对象整段替换。`frontend/src/i18n/locales/zh-CN.json`：

```json
"news": {
  "title": "自选资讯",
  "refresh": "刷新",
  "refreshing": "刷新中…",
  "loading": "加载中…",
  "error": "加载失败，请稍后重试",
  "emptyNoWatchlist": "还没有自选股",
  "emptyNoWatchlistHint": "添加自选股后，这里会展示与它们相关的实时快讯和公告",
  "goWatchlist": "去添加自选",
  "announcement": "公告",
  "noSummary": "暂无摘要",
  "unknownTime": "时间未知",
  "viewOriginal": "查看原文",
  "delayedBanner": "数据可能延迟",
  "lastUpdated": "最后更新：{{time}}",
  "sourceDegraded": "{{source}}源暂时不可用，数据可能不完整",
  "loadMore": "加载更早",
  "sources": { "eastmoney": "东方财富", "sina": "新浪财经", "sse": "上交所", "szse": "深交所" }
}
```

`en.json`：

```json
"news": {
  "title": "Watchlist Feed",
  "refresh": "Refresh",
  "refreshing": "Refreshing…",
  "loading": "Loading…",
  "error": "Failed to load, please retry",
  "emptyNoWatchlist": "No watchlist stocks yet",
  "emptyNoWatchlistHint": "Add stocks to your watchlist to see related flashes and announcements",
  "goWatchlist": "Manage watchlist",
  "announcement": "Announcement",
  "noSummary": "No summary",
  "unknownTime": "Unknown time",
  "viewOriginal": "View original",
  "delayedBanner": "Data may be delayed",
  "lastUpdated": "Last updated: {{time}}",
  "sourceDegraded": "{{source}} source is degraded, data may be incomplete",
  "loadMore": "Load earlier",
  "sources": { "eastmoney": "Eastmoney", "sina": "Sina", "sse": "SSE", "szse": "SZSE" }
}
```

`ja.json`：

```json
"news": {
  "title": "ウォッチリストフィード",
  "refresh": "更新",
  "refreshing": "更新中…",
  "loading": "読み込み中…",
  "error": "読み込みに失敗しました、再試行してください",
  "emptyNoWatchlist": "ウォッチリストが空です",
  "emptyNoWatchlistHint": "銘柄を追加すると、関連するニュースと公告が表示されます",
  "goWatchlist": "ウォッチリストを管理",
  "announcement": "公告",
  "noSummary": "概要なし",
  "unknownTime": "時刻不明",
  "viewOriginal": "原文を見る",
  "delayedBanner": "データが遅延している可能性があります",
  "lastUpdated": "最終更新：{{time}}",
  "sourceDegraded": "{{source}}ソースが不安定です、データが不完全な可能性があります",
  "loadMore": "さらに読み込む",
  "sources": { "eastmoney": "東方財富", "sina": "新浪財経", "sse": "上証所", "szse": "深証所" }
}
```

`ko.json`：

```json
"news": {
  "title": "관심 종목 피드",
  "refresh": "새로고침",
  "refreshing": "새로고침 중…",
  "loading": "불러오는 중…",
  "error": "불러오기에 실패했습니다, 다시 시도하세요",
  "emptyNoWatchlist": "관심 종목이 없습니다",
  "emptyNoWatchlistHint": "종목을 추가하면 관련 뉴스와 공시가 표시됩니다",
  "goWatchlist": "관심 종목 관리",
  "announcement": "공시",
  "noSummary": "요약 없음",
  "unknownTime": "시간 미상",
  "viewOriginal": "원문 보기",
  "delayedBanner": "데이터가 지연될 수 있습니다",
  "lastUpdated": "마지막 업데이트: {{time}}",
  "sourceDegraded": "{{source}} 소스가 불안정합니다, 데이터가 불완전할 수 있습니다",
  "loadMore": "이전 항목 불러오기",
  "sources": { "eastmoney": "동방재부", "sina": "신화재경", "sse": "상해거래소", "szse": "심천거래소" }
}
```

`ar.json`：

```json
"news": {
  "title": "تدفقات قائمة المتابعة",
  "refresh": "تحديث",
  "refreshing": "جارٍ التحديث…",
  "loading": "جارٍ التحميل…",
  "error": "فشل التحميل، يرجى المحاولة مرة أخرى",
  "emptyNoWatchlist": "لا توجد أسهم في قائمة المتابعة",
  "emptyNoWatchlistHint": "أضف أسهمًا لعرض الأخبار والإعلانات ذات الصلة",
  "goWatchlist": "إدارة قائمة المتابعة",
  "announcement": "إعلان",
  "noSummary": "لا يوجد ملخص",
  "unknownTime": "وقت غير معروف",
  "viewOriginal": "عرض الأصل",
  "delayedBanner": "قد تكون البيانات متأخرة",
  "lastUpdated": "آخر تحديث: {{time}}",
  "sourceDegraded": "مصدر {{source}} غير مستقر، قد تكون البيانات غير مكتملة",
  "loadMore": "تحميل الأقدم",
  "sources": { "eastmoney": "إيستموني", "sina": "سينا", "sse": "بورصة شنغهاي", "szse": "بورصة شنتشن" }
}
```

用以下内容**整文件替换** `frontend/src/i18n/__tests__/newsLocales.test.ts` 的 `requiredPaths`（其余结构不变）：

```typescript
const requiredPaths = [
  "layout.news",
  "news.title",
  "news.refresh",
  "news.refreshing",
  "news.loading",
  "news.error",
  "news.emptyNoWatchlist",
  "news.emptyNoWatchlistHint",
  "news.goWatchlist",
  "news.announcement",
  "news.noSummary",
  "news.unknownTime",
  "news.viewOriginal",
  "news.delayedBanner",
  "news.lastUpdated",
  "news.sourceDegraded",
  "news.loadMore",
  "news.sources.eastmoney",
  "news.sources.sina",
  "news.sources.sse",
  "news.sources.szse",
];
```

并删除该文件顶部的 `trackIds` 常量与 `...trackIds.map(...)` 展开。

- [ ] **Step 9: 删除旧布局测试 + 运行验证**

```bash
rm frontend/src/pages/__tests__/News.layout.test.tsx
cd frontend && npx vitest run src/pages/__tests__/News.test.tsx src/hooks/__tests__/useWatchlistFeed.test.tsx src/i18n/__tests__/newsLocales.test.ts src/i18n/__tests__/locales.test.ts && npx tsc -b
```
Expected: 全部 PASS；tsc 无错误。（`locales.test.ts` 若校验全键结构，随新键集自动通过；若 FAIL 报缺失键，按报错把对应键补入报错语言文件。）

- [ ] **Step 10: 提交**

```bash
git add frontend/src/hooks/useWatchlistFeed.ts frontend/src/hooks/__tests__/useWatchlistFeed.test.tsx frontend/src/pages/News.tsx frontend/src/pages/__tests__/News.test.tsx frontend/src/pages/__tests__/News.layout.test.tsx frontend/src/i18n
git commit -s -m "feat(news): rebuild News page as watchlist-centric unified feed"
```

---

### Task 9 (T7): clean cutover

**Files:**
- Delete: `agent/src/api/news_routes.py`、`agent/src/news/{feeds,llm,catalog,coordinator,pipeline,storage,models,network,distribution}.py`（distribution.py 若存在——以审计结果为准）、`agent/src/news/source_registry.json`、`agent/src/news/upstream_manifest.json`、`agent/src/news/upstream_manifest.sha256`、`agent/src/news/THIRD_PARTY_NOTICES.md`
- Delete: `agent/tests/news/{test_feeds,test_llm_enrichment,test_catalog,test_network,test_coordinator,test_pipeline,test_storage,test_models,test_distribution,test_end_to_end}.py`、`agent/tests/fixtures/{atom.xml,malicious_dtd.xml,rss.xml}`（新测试不用这些 fixture）
- Modify: `agent/api_server.py:385-391`（删除旧 news 注册块）与 `:263`（删除 `_close_news_coordinator_registry` shutdown）
- Modify: `frontend/src/lib/api.ts`（删除旧 news 常量 `:68-88`、类型 `:90-194`、解析器 `invalidNewsResponse` 起（:196）至旧 news api 方法 `:679-684` 全部）
- Delete: `frontend/src/hooks/useNews.ts`、`frontend/src/hooks/__tests__/useNews.test.tsx`
- Audit outputs: 遗留资产审计（见 Step 2）

**Interfaces:**
- Consumes: Task 7/8 已让新端点与新页面独立于旧实现。
- Produces: 旧管线零残留；**保留 StockNewsTool**（与 News 页解耦，规格 §6.4）。主 spec `openspec/specs/investment-news-hub/spec.md` 本任务**不删**——其归并在 change archive 阶段执行（§7.4）。

- [ ] **Step 1: 遗留资产审计（6 标识符全库搜索）**

```bash
grep -rn "news-api\|useNews\|NewsSnapshot\|NewsScope\|NewsTrackId\|NEWS_TRACK" \
  frontend/src frontend/vite.config.ts agent/src agent/tests scripts docs AGENTS.md \
  --include="*.py" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" \
  | grep -v "watchlist_feed_routes\|watchlist-feed\|useWatchlistFeed\|WatchlistFeed\|src/i18n/locales\|newsLocales"
grep -rn "source_registry\|upstream_manifest\|StockNewsTool" agent scripts --include="*.py" --include="*.toml" --include="*.json" | grep -v agent/src/news/
grep -rn "news" src-tauri/console-app/src --include="*.vue" --include="*.ts" | grep -iv "announcement"
```
Expected（剩余命中白名单）：新 watchlist-feed 实现（已被上方 grep -v 过滤）、`News.tsx`/`News.test.tsx` 组件名本身、`layout.news` i18n 键、`/news` 路由与 NavLink（`router.tsx:73`、`Layout.tsx:418-424`——页面保留，路由保留）、StockNewsTool（保留不动）、vite proxy `"/news-api"`（`vite.config.ts:19` 与 `viteProxy.test.ts:14-15` 保留——新端点同命名空间）。白名单之外的每个命中 = 待删残留。

- [ ] **Step 2: 删除后端旧管线**

```bash
git rm agent/src/api/news_routes.py
git rm agent/src/news/feeds.py agent/src/news/llm.py agent/src/news/catalog.py agent/src/news/coordinator.py agent/src/news/pipeline.py agent/src/news/storage.py agent/src/news/models.py agent/src/news/network.py
git rm agent/src/news/source_registry.json agent/src/news/upstream_manifest.json agent/src/news/upstream_manifest.sha256 agent/src/news/THIRD_PARTY_NOTICES.md
git rm agent/tests/news/test_feeds.py agent/tests/news/test_llm_enrichment.py agent/tests/news/test_catalog.py agent/tests/news/test_network.py agent/tests/news/test_coordinator.py agent/tests/news/test_pipeline.py agent/tests/news/test_storage.py agent/tests/news/test_models.py agent/tests/news/test_end_to_end.py
git rm agent/tests/fixtures/atom.xml agent/tests/fixtures/malicious_dtd.xml agent/tests/fixtures/rss.xml
```
（`distribution.py`/`test_distribution.py`：仅当 Step 1 审计显示存在时加入；若 test_distribution.py 存在且被上一行漏掉会挂全套测试——以 `ls agent/src/news` 为准。）

修改 `agent/api_server.py`：删除 `:385-391` 旧注册块（`from src.api.news_routes import register_news_routes` 至 `register_news_routes(app, ...)`）与 `:263` 的 `app.on_event("shutdown")(_close_news_coordinator_registry)`（及其 import）。

- [ ] **Step 3: 删除前端旧实现**

```bash
git rm frontend/src/hooks/useNews.ts frontend/src/hooks/__tests__/useNews.test.tsx
```

修改 `frontend/src/lib/api.ts`：删除 `NEWS_TRACK_IDS`（:68）至 `NEWS_PUBLIC_ERRORS` 结束（:88）、`NewsTrackId` 至 `NewsRefreshAccepted`（:90-194）、`invalidNewsResponse`（:196）至 `parseScopedNews*` 系列解析器、api 对象内 `getNewsSnapshot`/`startNewsRefresh`/`getNewsRefreshStatus`（:679-684）。以 `grep -n "News" frontend/src/lib/api.ts` 逐个核对删除后的残留（只允许 Watchlist feed 新类型与 `News.tsx` 引用）。

- [ ] **Step 4: i18n / router / vite proxy 同步确认**

- i18n：`grep -rn "news\." frontend/src/i18n/locales | grep -v "sources\.\|title\|refresh\|loading\|error\|emptyNoWatchlist\|goWatchlist\|announcement\|noSummary\|unknownTime\|viewOriginal\|delayedBanner\|lastUpdated\|sourceDegraded\|loadMore\|refreshing"` → 期望零命中（旧键 news.tracks.* 等已随 Step 8 of Task 8 替换）。
- router：`/news` 路由与 NavLink 保留（页面重写未换路径）。
- vite proxy：`/news-api` 前缀保留（新端点共用），`viteProxy.test.ts` 不动。

- [ ] **Step 5: 全套验证**

```bash
pytest --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py --tb=short -q
cd frontend && npx vitest run && npm run build
cd .. && ruff check agent/src agent/tests
git status --short   # 确认删除均已暂存
```
Expected: pytest 全绿（Rail×1 + SettingsPage×3 为 console-app vitest 既有失败基线，与本工作无关）；前端 vitest 全绿、build 成功；ruff 无告警。若 `agent/tests/` 之外还有模块 import 旧 news（如 scripts/news/import_upstream.py 的测试），`git rm scripts/news/import_upstream.py`（§6.4 清单项）并复跑。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -s -m "refactor(news): clean cutover removing legacy track snapshot pipeline"
```

---

## 自审记录（writing-plans Self-Review）

1. **规格逐节覆盖**：§3.1 三层架构 → Task 4/5/6；§3.3 留存窗口 → Task 4（store.purge_expired + 窗口查询）+ Global Constraints；§4.1 三级置信度/§4.1.1 stockList → Task 6；§4.2 名称解析 → Task 1；§5.1-5.3 状态机/日历/降级链/探活 → Task 2/4/5（HealthTracker + ConservativeCalendar + sse→szse 链 + 60s 探活 + 3 次回切）；§5.4 限流退避 → Task 4（MIN_SOURCE_SPACING/BACKOFF/per-host≤2 并发）；§5.5 去重 → Task 4（store 同源唯一键 + simhash 合并 + URL 规范化）；§5.6 监控日志 → Task 4（health 落 source_health；logger.warning 于 refresh 失败）+ §5.7 横幅 → Task 8；§5.8 URL 安全/不抓正文 → Task 4（normalize_url）+ Task 7（feedHttpUrl）+ 采集器仅存 title/summary；§6.1 API 契约含 reset_required/边界 → Task 6/7；§6.1.1 补拉 → Task 7（refresh.py）；§6.2 FeedItem → Task 6/7；§6.3 前端 → Task 8；§6.4 cutover → Task 9；§6.5 transport → Task 3；§6.6 解析器 → Task 7；§7 任务拆分 → 计划任务序列（Task 0=change，Task 1=T0，Task 2=T1，Task 3=T-A，Task 4=T2，Task 5=T3，Task 6=T4，Task 7=T5，Task 8=T6，Task 9=T7）；§8 → Task 0 delta。§9 首版排除：未引入主数据表/财联社/历史搜索/板块匹配。
2. **占位符扫描**：无 TBD/TODO/"适当处理"/"类似 Task N"；所有代码步骤含完整代码与精确命令。
3. **跨任务类型一致性**：`TransportRequest/TransportResponse/TransportError` 在 Task 3 定义、Task 4/5 消费字段一致（query/headers/allowed_content_types/method/body/content_type）；`StoredEntry` 字段（source/item_id/type/published_at/title/summary/url/structured_codes/extra_urls）在 Task 4 定义、Task 5/6 使用一致；`EntryStore.window_merged(limit, now, after_*, before_*, order)` 签名 Task 6 调用一致，`generation()/fetch_by_keys()` 被 Task 6 服务消费；`HealthTracker.record_success(source_id, advanced=)` Task 4/5 调用一致；`compute_watchlist_version`（triples 含名称）/`load_watchlist`/`normalize_stocklist_code`/`encode_cursor`/`decode_cursor`/`WatchlistFeedService.feed(after, before, limit)` Task 6 定义、Task 7 路由与服务 dict 键一致（含 new_cursor）；FeedItem dict 键与前端 `WatchlistFeed`/`FeedItem` TS 类型及 `parseWatchlistFeedResponse` 键集一一对应；`useWatchlistFeed` 返回形状与 News.tsx 解构一致。
4. **游标语义（正交双游标）**：`after_cursor`（轮询水位）升序交付"最旧未交付 N 条"、`new_cursor` 推进到本页最后已交付——一轮涌入 >limit 条不丢不重（test_feed_after_burst_delivery_no_loss_no_dup 证明 8 条/limit=3 三轮全送达）；`before_cursor`（翻页）降序交付更早页、`next_cursor` 指向更早页；两者互斥（service ValueError → 路由 400），垃圾游标 ValueError → 400 不静默重置；`reset_required` 仅由版本不匹配触发且双游标都检查；派生缓存键 = (watchlist_version, store_generation, after_cursor, before_cursor, limit) 全维度——generation 推进保证入库后旧缓存立即失效（实时性），缓存值只存 id 键表并在读取时与条目库 join（窗口清理后不 replay 已删数据）；前端状态机：首屏 (null,null) 拉最新页 → 轮询 (new_cursor,null) 增量前置（reverse 升序批、按 id 去重）→ 上滑 (null,next_cursor) 追加更早。
