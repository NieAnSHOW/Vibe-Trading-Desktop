## 1. 国产搜索引擎爬取函数

- [x] 1.1 新增 `_qihu_search(query, max_results=5)`：爬 `so.com`，返回 ddgs 形状 `[{"title","href","body"}]`，带浏览器 UA + `Accept-Language: zh-CN`；href 为 `so.com/link?m=...` 跳转时如实保留（与 `_sogou_search` 同构，`read_url` 可跟随）；纯 stdlib `urllib`+`re`
- [x] 1.2 为 `_qihu_search` 加一个解析单测（喂固定 HTML 片段，断言提取出 title/href，不打网络），对齐现有 `_sogou_search`/`_bing_cn_search` 的测试写法
- [x] 1.3 适配现有 `test_web_search_tool.py` 至 CN-first 默认行为：原"默认走 ddgs"的用例改为设置 `VIBE_TRADING_SEARCH_BACKENDS` 启用海外路径；新增默认走 CN 链、链内降级、全失败报错、`_qihu_search` 解析等用例（共 12 个，全过）

## 2. 主链降级与 fallback 链调整

- [x] 2.1 `execute()` 中：当 `VIBE_TRADING_SEARCH_BACKENDS` 未设置或为空时，跳过整个 ddgs 段，直接进入国产链（满足"海外引擎 opt-in"）
- [x] 2.2 CN fallback 循环从 `(("sogou", _sogou_search), ("bing_cn", _bing_cn_search))` 扩展为 `(("qihu", _qihu_search), ("sogou", _sogou_search), ("bing_cn", _bing_cn_search))`
- [x] 2.3 更新最终错误信封文案，反映三档国产链与海外 opt-in 语义

## 3. 配置文档

- [x] 3.1 在 `agent/.env.example` 新增"Web Search"段，文档化 `VIBE_TRADING_SEARCH_BACKENDS`（含 BREAKING：默认空=国产链）、`VIBE_TRADING_SEARCH_BING_FALLBACK`、`ALIYUN_IQS_API_KEY`，并给出海外用户恢复原行为的示例值

## 4. 验证

- [x] 4.1 运行搜索相关测试确认通过（`tests/test_web_search_tool.py` 12/12）
- [x] 4.2 `python -m py_compile agent/src/tools/web_search_tool.py` 语法检查
- [x] 4.3 手动验证默认路径：无 env 时走国产链且不触达海外域名（实测 `execute(query="双环传动 002472")` → `qihu_fallback`、5 条结果、首条命中 002472 股票行情）；设 `VIBE_TRADING_SEARCH_BACKENDS` 时走 ddgs 海外引擎（单测覆盖）
