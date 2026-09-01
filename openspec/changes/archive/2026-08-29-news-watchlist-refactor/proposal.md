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
