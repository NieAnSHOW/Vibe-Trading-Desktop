## Why

当前 WebUI 只能通过 agent 对话或回测间接查看股票，**没有一个"持续盯着自选股实时涨跌"的入口**。用户每次想知道关注股的当前涨跌，都要重新提问或跑回测，无法一眼扫过多只股票的实时行情。

同时，现有行情能力是割裂的：`backtest/loaders/` 全是历史 OHLCV（无实时），`market_screener_tool` 虽调通 Eastmoney `push2/clist` 实时接口但只服务于选股筛选——**没有一条"按自选篮子批量取最新报价"的可复用通道**，agent 想读"用户关注的股票"也没有现成接口。

本次补齐这条链路：可复用的自选股清单管理 + 批量实时报价能力 + 一个常驻盯盘页面。

## What Changes

- **新增自选股清单管理**（CRUD + SQLite 持久化）：仿 `agent/src/goal/store.py` GoalStore 模式，设计为**可被前端 UI 与 agent 共同调用**的后端能力
- **新增批量实时行情报价能力**：抽象 provider/adapter 接口，**A 股 adapter 落地**（复用 Eastmoney `push2/clist` 按 `secids` 批量拉取，复用 `market_screener_tool` 已验证的取数路径与 `_http.py` 的 `HostThrottle` 限频）；美股/crypto **仅预留接口**，本次不实现 provider
- **新增 TTL 缓存层**：同一篮子报价在缓存有效期内复用，避免多 tab / 多端击穿 Eastmoney 的 IP 限频
- **WebUI 新增独立 `/watchlist` 路由 + 左侧导航项**：搜索添加自选股；表格展示最新价 / 涨跌幅 / 涨跌额 / 成交量 + sparkline（复用 `MiniEquityChart`）；交易时段按固定间隔轮询刷新
- **前端新增 `market` Zustand store**：管理自选清单与报价状态
- **非交易时段降级**：显示最近收盘价并标注"收盘"态，不报错

## Capabilities

### New Capabilities

- `watchlist`: 用户自选股清单的持久化管理（增删查改 / 排序）及其盯盘展示——SQLite 存储、可复用 REST API、独立 `/watchlist` 页面（搜索添加、表格、sparkline、轮询刷新、非交易时段降级展示）
- `market-quotes`: 按股票篮子批量获取最新行情报价的能力——provider/adapter 抽象（A 股 adapter 落地，美股 / crypto 接口预留）、TTL 缓存、限频复用，供 watchlist UI 与 agent 共同消费

### Modified Capabilities

无。本次不修改现有 specs 的 requirement；watchlist / market-quotes 是全新能力维度。对 `market_screener_tool`、`api_server.py` 路由挂载、前端 router / store 的改动属于新增接入，不改变现有行为契约。

## Impact

- **代码**：
  - 后端：新增 watchlist store（仿 `agent/src/goal/store.py:101`）、watchlist REST 路由、market-quotes provider 抽象 + A 股 adapter + TTL 缓存 + quotes 路由，统一挂载到 `agent/api_server.py`
  - 前端：`frontend/src/router.tsx` 新增 `/watchlist` 路由 + 左侧导航项；新增 `frontend/src/stores/market.ts`；新增 watchlist 页面组件；复用 `frontend/src/components/charts/MiniEquityChart`
- **API**：新增 `/watchlist`（清单 CRUD）与 `/quotes`（批量行情）两组 REST 路由
- **数据**：新增 SQLite watchlist 表（与 goal store 同库）
- **依赖**：不引入新重型依赖；复用现有 `_http.py` 限频设施
- **合规 / 风险**：A 股 push2 仅交易时段有实时数据；Eastmoney 按 IP 限频 / 封禁 → TTL 缓存 + 轮询频率取值在 design 阶段确定
- **平台**：macOS + Windows 桌面端行为一致
