## ADDED Requirements

### Requirement: 自选股清单持久化

系统 SHALL 在 SQLite 中持久化用户的自选股清单（股票代码、市场、名称、排序、添加时间），使其在页面刷新与服务重启后保留。

#### Scenario: 刷新页面后清单保留

- **WHEN** 用户在 `/watchlist` 添加股票后刷新页面
- **THEN** 自选股清单仍完整显示，顺序与刷新前一致

#### Scenario: 服务重启后清单保留

- **WHEN** 后端服务重启后用户打开 `/watchlist`
- **THEN** 重启前保存的自选股清单仍然存在

### Requirement: 通过搜索添加自选股

系统 SHALL 提供按股票代码或名称搜索并将其加入自选清单的能力。

#### Scenario: 按代码搜索添加

- **WHEN** 用户在搜索框输入 `600519` 并在候选中选择
- **THEN** 贵州茅台被加入自选清单并出现在盯盘表格中

#### Scenario: 按名称模糊搜索

- **WHEN** 用户输入 `茅台`
- **THEN** 返回名称包含 `茅台` 的候选股票列表供用户选择

#### Scenario: 防止重复添加

- **WHEN** 用户尝试添加已在清单中的股票
- **THEN** 系统不产生重复条目，并提示该股票已在自选中

### Requirement: 删除自选股

系统 SHALL 允许用户从自选清单中移除股票。

#### Scenario: 删除单只股票

- **WHEN** 用户点击某行的删除按钮并确认
- **THEN** 该股票从清单移除，盯盘表格不再显示该行

### Requirement: 盯盘表格实时展示

系统 SHALL 在 `/watchlist` 页面以表格展示自选股的实时行情（最新价、涨跌幅、涨跌额、成交量），交易时段按固定间隔轮询刷新，并以红绿配色区分涨跌。

#### Scenario: 交易时段轮询刷新

- **WHEN** 自选清单非空且处于 A 股交易时段
- **THEN** 表格行情数据按配置的固定间隔刷新，上涨为红 / 下跌为绿（或符合本地化配色约定）

#### Scenario: 批量拉取报价

- **WHEN** 自选清单包含 N 只股票
- **THEN** 前端以单次请求获取全部股票报价，不对每只股票逐只请求

### Requirement: 非交易时段降级展示

系统 SHALL 在非交易时段（收盘后、周末、节假日）展示最近收盘价并明确标注非实时状态，且不抛出错误。

#### Scenario: 周末打开盯盘页

- **WHEN** 用户在非交易时段打开 `/watchlist`
- **THEN** 表格显示最近交易日的收盘价，行或标识标注 `收盘` 态，且无错误提示

### Requirement: sparkline 展示

系统 SHALL 在每只自选股的表格行中展示近期价格的迷你分时图（sparkline）。

#### Scenario: 渲染 sparkline

- **WHEN** 盯盘表格渲染某自选股行
- **THEN** 该行包含一段近期价格的 sparkline（复用 `MiniEquityChart` 组件）

### Requirement: 自选股管理 API 可复用

系统 SHALL 通过 REST API 暴露自选股清单的增删查改，使其可被前端 UI 与 agent / 其他程序化客户端共同调用，且二者走同一存储路径。

#### Scenario: 程序化读取清单

- **WHEN** agent 或脚本调用 `GET /watchlist`
- **THEN** 返回当前自选股清单的完整列表

#### Scenario: 程序化添加

- **WHEN** agent 调用 `POST /watchlist` 传入股票代码
- **THEN** 该股票被加入清单，与 UI 添加写入同一存储

### Requirement: 独立盯盘路由与导航入口

系统 SHALL 提供独立的 `/watchlist` 路由并在左侧导航中提供入口。

#### Scenario: 从导航进入盯盘页

- **WHEN** 用户点击左侧导航的盯盘入口
- **THEN** 路由切换到 `/watchlist` 并加载盯盘页面
