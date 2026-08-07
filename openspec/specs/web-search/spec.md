# web-search Specification

## Purpose
定义 `web_search` 工具的搜索引擎后端选择策略：默认使用国产引擎链（360 → 搜狗 → cn.bing）保证中国大陆无代理出口用户直连可用；海外搜索引擎（ddgs 聚合的 duckduckgo/google/bing/brave/mojeek/yahoo）作为可选 opt-in（`VIBE_TRADING_SEARCH_BACKENDS`），供有代理或海外出口的用户；阿里云 IQS 作为配置 `ALIYUN_IQS_API_KEY` 时的优先 fast-path。约束兜底链按质量与稳定性排序，且单点失败不阻断整体搜索。
## Requirements
### Requirement: Default search via CN-direct engine chain

`web_search` 工具在未配置任何搜索环境变量时 SHALL 通过国产搜索引擎链（360 → 搜狗 → cn.bing）获取结果，保证中国大陆无代理出口用户直连可用。

#### Scenario: CN 用户零配置调用 web_search

- **WHEN** 未设置 `VIBE_TRADING_SEARCH_BACKENDS` 且未设置 `ALIYUN_IQS_API_KEY`，调用 `web_search(query="双环传动 002472")`
- **THEN** 返回 `status: ok` 的结果信封，`backends` 字段标记实际命中的国产引擎（`qihu`/`sogou`/`bing_cn` 之一），且 MUST NOT 调用任何海外搜索引擎域名

#### Scenario: 国产引擎链按既定顺序降级

- **WHEN** 链首引擎（360）请求超时或返回空结果
- **THEN** 自动降级尝试下一个引擎（搜狗 → cn.bing），首个返回非空结果的引擎即作为结果源

### Requirement: Overseas engines are opt-in

ddgs 聚合的海外搜索引擎（duckduckgo/google/bing/brave/mojeek/yahoo） SHALL 仅在显式设置 `VIBE_TRADING_SEARCH_BACKENDS` 时启用；默认 MUST NOT 发起对海外搜索域名的请求。

#### Scenario: 默认不调用海外引擎

- **WHEN** 未设置 `VIBE_TRADING_SEARCH_BACKENDS`，执行任意 web_search 调用
- **THEN** 不对 `search.brave.com`、`query2.finance.yahoo.com`、`duckduckgo.com` 等海外域名发起请求

#### Scenario: 海外用户显式启用海外引擎

- **WHEN** 设置 `VIBE_TRADING_SEARCH_BACKENDS=duckduckgo,google,bing,brave`
- **THEN** web_search 按该列表调用 ddgs 海外引擎，适用于有代理或海外出口的用户

### Requirement: CN fallback chain is fault-tolerant

国产引擎链中单个引擎的失败或空结果 MUST NOT 中断整体搜索；全部引擎均失败时 SHALL 返回结构化错误信封而非抛出异常。

#### Scenario: 全部国产引擎失败

- **WHEN** 360、搜狗、cn.bing 全部超时或返回空
- **THEN** 返回 `status: error` 的 JSON 信封，错误信息列出各引擎失败原因，且不抛出未捕获异常

### Requirement: Aliyun IQS fast-path retained

当设置了 `ALIYUN_IQS_API_KEY` 时，web_search SHALL 优先调用阿里云 IQS 官方搜索 API，跳过国产引擎链与海外引擎；IQS 返回非空结果即作为最终结果。

#### Scenario: 配置 IQS key 时优先走官方 API

- **WHEN** 设置了 `ALIYUN_IQS_API_KEY`，调用 web_search
- **THEN** 请求发往 `cloud-iqs.aliyuncs.com`，`backends` 字段为 `aliyun_iqs`，不调用其他引擎

