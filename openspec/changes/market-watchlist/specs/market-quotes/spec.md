## ADDED Requirements

### Requirement: 批量获取最新报价

系统 SHALL 接受一个股票代码列表，返回每只股票的最新行情（代码、名称、最新价、涨跌幅、涨跌额、成交量、成交金额、换手率）。

#### Scenario: 批量拉取多只股票

- **WHEN** 客户端请求 `[600519, 000001, 600036]` 的报价
- **THEN** 一次返回三只股票的完整行情字段

#### Scenario: 空列表请求

- **WHEN** 客户端请求空股票列表
- **THEN** 返回空结果且不抛出错误

#### Scenario: 单只股票缺失字段不阻断整体

- **WHEN** 批量请求中某只股票在上游无数据
- **THEN** 该只返回缺失标记，其余股票正常返回，整体请求不失败

### Requirement: 行情 provider 抽象与市场可扩展

系统 SHALL 通过 provider / adapter 抽象提供行情：A 股 adapter 落地实现，美股 / crypto 的 adapter 接口预留（本次不实现 provider）。

#### Scenario: A 股报价走 A 股 adapter

- **WHEN** 请求的股票市场标记为 A 股
- **THEN** 行情由 A 股 adapter（Eastmoney `push2/clist`）提供

#### Scenario: 未实现的 provider 返回明确不支持

- **WHEN** 请求美股或 crypto 股票
- **THEN** 系统返回明确的 `该市场暂未支持` 响应，且不抛出未处理异常

### Requirement: TTL 缓存

系统 SHALL 对行情报价施加 TTL 缓存：同一股票篮子在缓存有效期内复用上次拉取结果，避免重复请求击穿数据源限频。

#### Scenario: 缓存命中

- **WHEN** 在缓存有效期内对同一篮子再次请求
- **THEN** 返回缓存结果，且不向上游数据源发起新请求

#### Scenario: 多端共享缓存

- **WHEN** 多个客户端（多 tab / 多端）在同一个 TTL 窗口内请求同一篮子
- **THEN** 上游数据源在该窗口内仅被请求一次

#### Scenario: 缓存过期后刷新

- **WHEN** 缓存超过 TTL 有效期后再次请求
- **THEN** 系统向上游发起一次新请求并刷新缓存

### Requirement: 限频复用

系统 SHALL 复用现有 `HostThrottle` 限频设施对上游行情请求进行节流，防止单 IP 被数据源封禁。

#### Scenario: 高频请求被节流

- **WHEN** 短时间内产生大量上游行情请求
- **THEN** 请求按 `HostThrottle` 规则排队 / 延迟，不超过上游限频阈值

### Requirement: 交易时段标记

系统 SHALL 在行情响应中携带交易时段状态标志，供消费方（前端 / agent）判断数据是否为实时。

#### Scenario: 交易时段返回实时标志

- **WHEN** 当前为 A 股交易时段
- **THEN** 报价响应携带 `market_closed = false`

#### Scenario: 非交易时段返回收盘标志

- **WHEN** 当前为非交易时段（收盘 / 周末 / 节假日）
- **THEN** 报价响应携带 `market_closed = true`，数据为最近交易日的收盘值
