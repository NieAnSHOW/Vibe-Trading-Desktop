# investment-news-hub Specification

## Purpose
TBD - created by archiving change investment-news-hub. Update Purpose after archive.
## Requirements
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

### Requirement: 隔离键为本机自选内容版本键
系统 SHALL 以本机 watchlist 内容计算隔离键：watchlist_version = sha256(sorted((code, name, market) triples))，名称参与匹配，回填/改名必须使缓存失效。
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

### Requirement: 单一服务与现有 API 安全边界
资讯 API SHALL 使用 `/news-api/...` 命名空间并运行在现有 FastAPI sidecar 中，以避免与 SPA `/news` 路由冲突。所有读取、刷新和状态接口 SHALL 复用项目现有的本地回环信任与远程 `API_AUTH_KEY` 鉴权规则。API 响应、持久化快照、任务错误摘要和日志 MUST NOT 包含 LLM 或 API 凭据。

#### Scenario: 本地页面调用资讯 API
- **WHEN** 应用从受信任的本地回环环境访问 `/news-api/...`
- **THEN** 系统按现有本地 API 安全策略处理请求，并由同一个 FastAPI 进程返回结果

#### Scenario: 远程未授权调用
- **WHEN** 非本地客户端未提供有效 `API_AUTH_KEY` 访问资讯读取或刷新接口
- **THEN** 系统按现有远程鉴权策略拒绝请求

#### Scenario: 非同源 loopback 刷新请求
- **WHEN** 浏览器页面从不属于 `CORS_ORIGINS` 的 loopback Origin 向 `/news-api/refresh` 发起请求
- **THEN** 系统在协调器开始工作前以 `403` 拒绝该请求；同源、显式可信前端 Origin 或不带 `Origin` 的非浏览器客户端仍按现有鉴权策略处理

#### Scenario: 检查敏感信息边界
- **WHEN** 生成快照、任务状态、错误摘要、日志或 API 响应
- **THEN** 这些输出不包含 LLM 密钥、`API_AUTH_KEY` 或其他 Provider 凭据

### Requirement: 明确限定首版功能范围
首版系统 MUST NOT 提供跨留存窗口的资讯历史、搜索、日期筛选、收藏、已读状态或消息推送，也 MUST NOT 为
新闻模块启动第二个后端服务或引入独立账户体系。首版 SHALL 允许后台定时轮询，并 SHALL 允许留存窗口内以
next_cursor + limit 游标分页作为唯一回溯手段。

#### Scenario: 使用首版页面
- **WHEN** 用户访问投资资讯模块
- **THEN** 页面只提供窗口内统一流浏览、原文跳转、手动强制补拉、源健康提示与窗口内分页，不提供范围外入口
