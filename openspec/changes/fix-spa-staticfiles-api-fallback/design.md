# Design — fix-spa-staticfiles-api-fallback

## 方案

在 `SPAStaticFiles.get_response` 的 404 fallback 分支，依据请求 `Accept` 头区分两类请求：

1. **浏览器导航型**（`Accept` 含 `text/html`）→ 维持现状，返回 `index.html`（SPA 深链刷新行为不变）。
2. **API 调用型**（`Accept` 不含 `text/html`，典型 `application/json` / `*/*` / 其它）→ 返回 JSON 404：`JSONResponse({"detail": "Not Found"}, status_code=404)`。

判定逻辑与项目已有的 `_spa_html_deep_link_fallback` 中间件（`api_server.py:555-570`）一致——都基于 `Accept` 含 `text/html`，保证语义统一，避免两处对"是否浏览器导航"的判定漂移。

## 关键点

- `get_response(self, path: str, scope)` 只有 `scope`，无 `Request` 对象。从 `scope` 读 headers：`scope["headers"]` 是 `list[(bytes, bytes)]`，按小写 `accept` 查找解码值。
- 返回 JSON 404 用 `starlette.responses.JSONResponse`（FastAPI 已传递依赖，无需新增）。
- 仅改 404 分支；其它状态码（403 等）行为不变（原样 raise）。
- 不引入新依赖、不改路由结构、不动 `_spa_html_deep_link_fallback` 中间件、不改 `version.rs` / `runtime_dir.rs`。

## 影响面

- 单文件改动：`agent/api_server.py`（`SPAStaticFiles` 类，约 10 行）。
- 不影响已匹配的真实 API 路由（它们不会进 404 分支）。
- 不影响真实静态资源请求（assets/js/css 命中 StaticFiles 正常返回 200）。
- 仅在「未匹配路径」时改变行为：API 路径由 HTML(200) 改为 JSON(404)，浏览器导航路径行为不变。

## 非目标

- 不修复「构建产物过期」本身（那是 assemble / 打包流程问题，hotfix 范畴外；用户已选择另行重新 `assemble.sh` + 重新打包）。
- 不为 optional-deps 补路由（repo 已有完整实现，bundle 过期导致缺失，重新 assemble 解决）。
- 不动 version.rs 的 Reuse/Upgrade 判定（逻辑本身正确，问题是 bundle 内容过期而非版本号机制）。
