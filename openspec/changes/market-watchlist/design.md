## Context

- **现状**：`backtest/loaders/` 仅提供历史 OHLCV，无实时行情；`market_screener_tool` 已调通 Eastmoney `push2/clist` 实时接口（返回 `code/name/price/change_pct/change/volume/amount/turnover_rate`），但仅服务于选股筛选，未对外暴露为通用能力；`agent/src/goal/store.py:101` 提供了 SQLite + Store 模式的先例；前端 `MiniEquityChart`、`useSSE.ts` 可复用。
- **约束**：A 股 `push2` 仅交易时段有实时数据；Eastmoney 按 IP 限频 / 封禁；桌面端为单机 MVP，资源敏感。
- **stakeholders**：盯盘用户（前端展示）、agent（程序化消费 watchlist + quotes）、后续接入美股 / crypto 的扩展方。

## Goals / Non-Goals

**Goals:**
- 自选股清单持久化 + 可复用 REST API（前端 UI 与 agent 共用同一存储与路由）
- 批量实时报价：A 股 adapter 落地，provider 接口可扩展到其他市场
- TTL 缓存 + 限频复用，防多端击穿数据源限频
- 独立 `/watchlist` 页面：搜索添加、表格、sparkline、轮询刷新、非交易时段降级

**Non-Goals:**
- 价格告警 / 阈值通知 / agent 异动联动（后续 change）
- 美股 / crypto provider 的实际实现（仅预留接口）
- WebSocket / 真·tick 推送（轮询满足"看涨跌"）

## Decisions

1. **轮询而非推送**。现有 loader 无 tick 源，后端若做 WebSocket/SSE 推送仍需自己轮询上游，多一层桥接无收益。前端按固定间隔 REST 轮询 `/quotes`。
   - *备选*：SSE 推送复用 `/sessions/{id}/events` → rejected，该通道绑定会话且 `useSSE.ts` knownTypes 硬编码 agent 事件，行情走它会污染会话语义。
2. **provider / adapter 抽象**。定义 `QuoteProvider` 接口（`fetch_quotes(symbols) -> List[Quote]`），A 股实现 `EastmoneyQuoteProvider`（复用 `market_screener_tool` 的 `push2/clist` 路径 + `_http.py` 的 `HostThrottle`）。路由按 symbol 市场标记分发；未实现的市场返回明确"暂未支持"。
   - *备选*：路由内直接写死 Eastmoney 调用 → rejected，用户明确要求"预览接入其他股市的能力"。
   - *克制*：仅一个接口 + 一个实现，**不预先造 registry / 插件加载器**（YAGNI），市场分发用最简映射。
3. **SQLite 存 watchlist，仿 GoalStore**。新增 `watchlist` 表（`symbol, market, name, sort_order, created_at`），与 goal store 同库，首次访问自动建表。
   - *备选*：JSON 文件 → rejected，缺并发安全且与项目 SQLite 先例不一致。
4. **进程内 TTL 缓存**。`key = 排序后的 symbols fingerprint`，`val = (quotes, expires_at)`；缓存命中直接返回，不触上游。
   - *备选*：无缓存 → rejected，多 tab / 多端会击穿 Eastmoney IP 限频。
5. **非交易时段在后端判定**。A 股交易时段（工作日 9:30–11:30、13:00–15:00）由后端判定，quotes 响应携带 `market_closed` 标志；前端据此显示"收盘"态，不伪装实时。
   - *备选*：前端判定 → rejected，多端需单一事实源。
6. **前端 `market` store 持有轮询生命周期**。`setInterval` 轮询 `/quotes`，组件卸载或页面不可见时降频 / 清除。

## Risks / Trade-offs

- **[Eastmoney IP 封禁]** → TTL 缓存 + HostThrottle 复用 + 轮询间隔不过激（默认值在 comet-design 定）
- **[非交易时段体验]** → 明确"收盘"标注，不伪造实时
- **[provider 抽象过度设计]** → 仅接口 + 单实现，不预造 registry；若后续市场增多再演进
- **[轮询资源占用]** → 间隔可配置；页面不可见时用 Page Visibility API 降频

## Migration Plan

- 纯新增，无破坏性变更；`watchlist` 表首次访问自动建表（仿 GoalStore 的 `CREATE TABLE IF NOT EXISTS`）。
- 回滚：删除新增路由 / 页面 / store 即可，无数据迁移、无 schema 破坏。

## Open Questions

（留给 comet-design 细化）
- 轮询间隔默认值（5s / 10s？）与页面不可见降频策略
- watchlist 表复用 goal store 的 DB 文件还是独立库
- 搜索股票的候选数据源（代码 / 名称搜索用哪个接口）
- Eastmoney `secids` 与内部 symbol 的映射规则（沪/深前缀）
