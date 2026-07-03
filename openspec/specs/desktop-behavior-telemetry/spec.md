# desktop-behavior-telemetry Specification

## Purpose
TBD - created by archiving change desktop-behavior-telemetry. Update Purpose after archive.
## Requirements
### Requirement: 前端采集 UI 交互事件
桌面客户端 SHALL 在前端提供统一埋点接口采集 UI 交互事件（页面浏览、功能使用、会话起止、错误），事件通过显式白名单枚举，属性仅允许枚举值与聚合数字。

#### Scenario: 路由切换产生 page_view
- **WHEN** 用户在应用内切换到路由 `/agent`
- **THEN** 产生一条 `page_view` 事件，属性 `{route:"/agent"}`，写入当天桶

#### Scenario: 白名单外事件被拒绝
- **WHEN** 调用方传入白名单之外的 event type
- **THEN** 该事件被丢弃，不写入存储，不抛出异常

#### Scenario: 禁用属性被剔除
- **WHEN** 事件属性包含自由文本或敏感字段（如 prompt 内容、查询串、标的、金额）
- **THEN** 该属性在写入前被剔除，仅保留白名单允许的属性

### Requirement: sidecar 产出脱敏聚合指标并通过本地同源通道暴露
Python sidecar SHALL 在进程内累积脱敏聚合指标（技能调用计数、回测次数/总耗时/按引擎分布、错误计数及分类），并通过同源 HTTP 路由 `GET /telemetry/sidecar-metrics` 暴露给前端，响应中不得包含任何用户内容字段。

#### Scenario: 前端拉取当日指标
- **WHEN** 前端在 flush 前请求 `/telemetry/sidecar-metrics`
- **THEN** 返回聚合数字（计数/耗时），不含 prompt、查询、交易标的等内容

#### Scenario: sidecar 不可达时跳过
- **WHEN** flush 时 sidecar 未就绪或请求失败
- **THEN** 前端跳过 sidecar 指标，不阻塞 UI 事件的上传

### Requirement: 按本地日期分桶本地存储
客户端 SHALL 将事件按本地时区日期（`YYYY-MM-DD`）分桶写入 IndexedDB，并在 meta 存储中维护设备 ID、同意状态与上次 flush 标记。当天产生的事件不参与本次 flush。

#### Scenario: 当天事件入当天桶
- **WHEN** 用户在日期 D 产生事件
- **THEN** 事件写入 date=D 的桶，且在 D 当天启动应用时不被上传

#### Scenario: 同日多次启动不触发当日上传
- **WHEN** 用户在日期 D 内多次启动应用
- **THEN** 仅扫描 date<D 的桶上传，date=D 的桶保留到 D 之后

### Requirement: 隔天启动批量上传
应用启动时 SHALL 扫描本地 `date < today(本地时区)` 的批次，按日期升序逐日组装并上传到 VIP 服务器；单批次上传成功（HTTP 2xx）后删除该日本地数据。

#### Scenario: 隔天启动上传昨日批次
- **WHEN** 用户在日期 D+1 启动应用，本地存在 date=D 的批次
- **THEN** 应用上传 date=D 批次到 :8001，成功后删除 date=D 的本地数据

### Requirement: 上传失败退避重试与保留上限
上传失败（网络错误 / 5xx / 429）时 SHALL 对该批次进行指数退避重试，单批次单次启动内最多重试 3 次；仍失败则保留待下次启动。本地批次保留超过 14 天后 SHALL 被丢弃以防无限增长。

#### Scenario: 上传失败保留重试
- **WHEN** 某批次上传因网络错误失败且 3 次重试均未成功
- **THEN** 该批次保留在本地，等待下一次应用启动再次上传

#### Scenario: 超 14 天丢弃
- **WHEN** 本地存在日期早于今天超过 14 天的批次
- **THEN** 该批次在 flush 末尾被丢弃，不再上传

### Requirement: 支持未登录匿名上传
上传端点 SHALL 为公开端点（无需登录），未登录用户 SHALL 能以匿名设备 ID 上传埋点数据；客户端上传请求仅在已登录时附带 VIP token，body 中不携带 user_id。

#### Scenario: 未登录用户成功上传
- **WHEN** 未登录用户在 D+1 启动应用，本地存在 date=D 的批次
- **THEN** 应用以匿名 device_id 上传批次（不带 Authorization），服务端接收并以 user_id=null 落库

#### Scenario: 已登录用户上传附带 token
- **WHEN** 已登录用户上传批次
- **THEN** 请求附带 `Authorization: Bearer <token>`，body 不含 user_id

### Requirement: 服务端盖戳用户身份
服务端 SHALL 不信任客户端 body 中的 user_id；仅当请求携带合法 VIP token 时，由服务端解析 token 并将真实 user_id 写入落库记录，否则记为匿名（user_id 为空）。

#### Scenario: 合法 token 盖戳 user_id
- **WHEN** 上传请求携带合法 VIP token
- **THEN** 服务端解析 token 得到真实 user_id 并写入 `telemetry_event` 记录

#### Scenario: 伪造 body user_id 被忽略
- **WHEN** 请求 body 携带 user_id 字段但无合法 token
- **THEN** 服务端忽略 body 中的 user_id，记录以 user_id=null 落库

### Requirement: 服务端接收并批次级落库
服务端 SHALL 在 cool-admin-midway 新增公开端点接收批次，做 schema 校验（字段/类型/枚举/单批体积上限）、按 device_id 频控、参数化查询落库到 `telemetry_event` 表（批次级一行），并通过 2xx 响应告知接收结果。

#### Scenario: 正常批次落库
- **WHEN** 服务端收到符合 schema 的批次
- **THEN** 写入一条 `telemetry_event` 记录（含 device_id、user_id?、batch_date、app_version、event_count、payload(JSON)、created_at），返回 200 与接收计数

#### Scenario: schema 不合被拒
- **WHEN** 服务端收到缺字段或超体积上限的批次
- **THEN** 返回 400，不落库

#### Scenario: 频控触发
- **WHEN** 同一 device_id 在频控窗口内再次上传
- **THEN** 服务端返回 429，客户端按失败重试策略保留批次

### Requirement: 同意开关与默认开启
客户端 SHALL 在 Settings 提供「使用数据」开关，**默认开启，可由用户关闭**；关闭后新增采集为 no-op（不写入存储），但已缓冲的历史批次 SHALL 仍按计划上传一次。未登录访客同样可操作该开关。

#### Scenario: 关闭后停止新增采集
- **WHEN** 用户在 Settings 关闭「使用数据」开关
- **THEN** 此后的 UI 交互不再产生写入（`track()` 直接返回）

#### Scenario: 关闭后历史批次仍上传
- **WHEN** 用户关闭开关时本地仍存在未上传的历史批次
- **THEN** 下次启动时这些历史批次仍被上传一次，之后不再有新增

### Requirement: 匿名设备 ID 持久化
客户端 SHALL 在首次使用时生成稳定的匿名设备 ID（UUID）并持久化于 localStorage，后续读取复用；每批次必带 device_id 作为身份。

#### Scenario: 首次生成并复用
- **WHEN** 用户首次启动应用且无已存 device_id
- **THEN** 生成 UUID 存入 localStorage；此后每次上传携带同一 device_id

### Requirement: 严格脱敏与隐私边界
埋点链路 SHALL 仅采集 UI 事件与聚合数字指标，**绝不采集、存储或上传** prompt 文本、用户查询、交易标的、持仓、金额等任何用户内容；隐私口径由采集 SDK 的白名单统一收口。

#### Scenario: 敏感内容不进入事件
- **WHEN** 用户在对话中输入包含交易标的的 prompt
- **THEN** 该 prompt 文本不进入任何埋点事件，仅可能产生 `feature_use{name:chat_send}` 计数

