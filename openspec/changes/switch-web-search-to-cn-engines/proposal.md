## Why

`web_search` 工具的信息源长期依赖海外搜索引擎（brave、yahoo，以及 ddgs 聚合的 duckduckgo/google/bing 等）。中国大陆用户在无代理出口下，这些域名大面积超时或被封：2026-08-07 的 sidecar 日志显示 `search.brave.com` 全部请求 `operation timed out`、`query2.finance.yahoo.com` 返回 403，智能体联网检索几乎不可用，并由此产生大量"信息源错误"。需要在默认链路上切换为大陆直连可达的国产搜索引擎，让 CN 用户零配置开箱即用，同时为有代理或海外用户保留海外引擎作为可选项。

## What Changes

- 新增 360 搜索爬取后端（`so.com`），实现风格对齐现有 `_sogou_search`（纯 stdlib `urllib` + 正则，零新增依赖）。
- CN 兜底链由两档（搜狗 → cn.bing）扩展为三档，按金融实体查询质量与稳定性排序：**360 → 搜狗 → cn.bing**；单个引擎失败不阻断整体。
- **BREAKING（行为变更）**：主链海外引擎 `_DEFAULT_BACKENDS`（duckduckgo/google/bing/brave/mojeek/yahoo）从默认启用降级为可选——默认完全走国产链；海外引擎仅在显式设置 `VIBE_TRADING_SEARCH_BACKENDS` 时启用，供有代理或海外用户使用。
- 保留现有 `ALIYUN_IQS_API_KEY` fast-path：配置时仍优先走阿里云 IQS 官方 API（质量最佳、CN 直连）。
- 配套在 `agent/.env.example` 文档化全部搜索相关环境变量（`VIBE_TRADING_SEARCH_BACKENDS`、`VIBE_TRADING_SEARCH_BING_FALLBACK`、`ALIYUN_IQS_API_KEY`），当前完全无文档。

实测依据（2026-08-07，多 query 多轮）：360 四次实测稳定返回、金融实体命中最精准（公司官网、股吧、公告、新闻）；搜狗与 cn.bing 长期可用；神马 `m.sm.cn` 与夸克 `quark.sm.cn` 触发阿里动态反爬 `____tmd_____/punish`（连续请求返回惩罚页），不稳，不纳入；百度 captcha、头条 JS 混淆，亦不纳入。

## Capabilities

### New Capabilities

- `web-search`: `web_search` 工具的搜索引擎后端选择策略——默认使用国产引擎链保证 CN 直连可用，海外引擎作为可选，key-gated AI 搜索 API 作为优先 fast-path；并约束兜底链的排序与单点容错。

### Modified Capabilities

- 无（现有 specs 不涉及 web_search）。

## Impact

- 代码：`agent/src/tools/web_search_tool.py`（单文件——新增 `_qihu_search`、扩 fallback 链、主链降级、`.env.example` 文档）。
- 配置：`agent/.env.example` 新增搜索 env 文档段。
- 依赖：零新增（纯 stdlib）。
- 行为：CN 用户默认获得可用搜索；海外或有代理用户需显式设置 `VIBE_TRADING_SEARCH_BACKENDS` 启用海外引擎。
- 不影响：安全面、其他工具、整体架构、live trading 路径。
