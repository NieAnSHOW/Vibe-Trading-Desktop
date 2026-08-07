## Context

`web_search` 工具（`agent/src/tools/web_search_tool.py`）当前默认链路是 ddgs 聚合的海外引擎（duckduckgo/google/bing/brave/mojeek/yahoo），仅在它们全部失败时才走 CN fallback（搜狗 → cn.bing）。中国大陆无代理用户在出口侧对这些海外域名不可达（2026-08-07 sidecar 日志：brave 全超时、yahoo 403），导致默认链路几乎 100% 失败、agent 联网检索不可用。CN fallback 逻辑已存在（commit 81a09a2e），但主链仍以海外优先，每次都要先超时再降级，体验差且浪费约 20–30s。

## Goals / Non-Goals

**Goals:**
- CN 无代理用户默认获得可用的 web 搜索（国产引擎直连）。
- 零新增依赖、零配置开箱即用。
- 海外/有代理用户仍可通过 env 启用海外引擎。
- 复用现有架构（`_sogou_search`/`_bing_cn_search`/`_aliyun_iqs_search` 范式）。

**Non-Goals:**
- 不接入付费 AI 搜索 API（博查/秘塔/Tavily/IQS 内置 key）——已调研，用户决定走免费爬取路线，IQS 仅保留用户自配 fast-path。
- 不爬百度（反爬严）、头条（JS 混淆）、神马/夸克（动态 punish）——实测不可行或不稳定。
- 不改 `web_search` 对外接口契约（参数、返回 envelope 结构不变）。
- 不碰其他工具或安全面。

## Decisions

**D1: 主链海外引擎降级为可选，默认走国产链**
- 备选：保留海外主链 + 仅扩充 CN fallback。
- 否决理由：CN 用户每次都要先承受海外引擎超时（ddgs 每个 backend timeout 累加）才降级，默认体验仍差，这是当前主痛点。
- 做法：`execute()` 中，除非 `VIBE_TRADING_SEARCH_BACKENDS` 显式设置非空，否则跳过 ddgs 整段，直接走国产链。

**D2: 国产链顺序 360 → 搜狗 → cn.bing**
- 依据 2026-08-07 多轮实测：360 四次稳定返回、金融实体命中最精准（官网+股吧+公告+新闻），放首位；搜狗已有质量好；cn.bing 兜底。
- 备选：神马/夸克（m.sm.cn/quark.sm.cn）放首位。否决：见 D3，punish 不可靠。
- 备选：百度优先。否决：captcha + 仅 1 外链。

**D3: 放弃神马/夸克（动态 punish 不可靠）**
- 实测 `m.sm.cn` 与 `quark.sm.cn` 首次请求返回完整结果页（343K/642K），但后续请求触发阿里 `____tmd_____/punish` 反爬惩罚页（1121/1265 字节的 JS 重定向）。PC/移动 UA、加 Referer 均无法绕过。
- 神马系对脚本访问 IP 累计惩罚，fallback 链要求每档可靠，故不纳入。真实用户偶发查询或许能用一阵，但属不可验证的赌注。

**D4: 新爬取函数对齐 `_sogou_search` 范式**
- 纯 stdlib `urllib` + 正则，返回 ddgs 形状 `[{"title","href","body"}]`，零新依赖，与现有 `_sogou_search`/`_bing_cn_search` 完全同构。
- 360 的 href 是 `so.com/link?m=...` 跳转代理（真实 URL 不直接暴露），与搜狗跳转链接同构，下游 `read_url` 可跟随。

**D5: 保留 IQS fast-path 与 CN fallback 开关**
- `ALIYUN_IQS_API_KEY` 配置时仍最先走官方 API（质量最佳）；`VIBE_TRADING_SEARCH_BING_FALLBACK=0` 仍可禁用国产兜底。

## Risks / Trade-offs

- [360 改版导致正则失效] → 函数独立、失败降级到搜狗/cn.bing；正则保持宽松（取 `<a href>` + 锚文本），降低脆弱性。
- [360 href 是 so.com 跳转] → 与搜狗同构，`read_url` 跟随；envelope 的 url 字段如实记录跳转链接。
- [海外用户默认失去海外引擎] → BREAKING，但通过 `VIBE_TRADING_SEARCH_BACKENDS` env 完整保留能力；在 `.env.example` 文档化。
- [国产引擎结果质量 vs 海外] → 金融实体查询实测更好（360 命中官网+股吧+公告）；通用查询由 fallback 链多源互补缓解。
- [神马/夸克未来可能放宽 punish] → 若需补第四档，后续可作为 env 开关的实验性引擎加入，默认不启用。

## Migration Plan

- 无数据迁移、无 API 契约变更（envelope 结构不变）。
- 海外用户升级后需在 `agent/.env` 设置 `VIBE_TRADING_SEARCH_BACKENDS=duckduckgo,google,bing,brave,mojeek,yahoo` 恢复原行为；Release notes 注明此 BREAKING 变更及配置方式。
- 回滚：git revert 单文件 `web_search_tool.py` + `.env.example` 即可。

## Open Questions

- 无（引擎清单与顺序经用户确认 + 实测验证）。
