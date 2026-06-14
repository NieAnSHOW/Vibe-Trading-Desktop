# fix-spa-staticfiles-api-fallback

## Why

桌面端在前后端 agent 代码版本不一致时（典型场景：optional-deps 路由已在前端被调用，但运行时后端缺该路由——如本次 bundle/runtime 过期），前端 `fetch` 未匹配的后端 API 路径，`SPAStaticFiles`（`agent/api_server.py` `serve_main` 内 mount 在 `/`、`html=True`）的 404 fallback **无条件**返回 `index.html`，导致响应体是 HTML（`<!DOCTYPE html>...`）。前端 `request()`（`frontend/src/lib/api.ts`）对响应体执行 `JSON.parse(text)`，text 以 `<` 开头即抛 `Unrecognized token '<'`，最终 UI 上显示晦涩的 `加载可选依赖失败: JSON Parse error: Unrecognized token '<'`——完全看不出真实原因是"后端缺少该路由 / 版本不匹配"。

该缺陷**独立于**本次的构建产物过期问题：任何打错的 API URL、任何后端尚未部署的新前端 API 调用，都会触发同样的晦涩错误。网页端因后端代码与前端同步、路由齐全而难以暴露；桌面端 bundle 与运行时 agent 可分别陈旧，极易触发。

## 根因

`agent/api_server.py` 的 `SPAStaticFiles.get_response`（serve_main 内，约 3092-3101 行）对所有 404（含 `/optional-deps/list` 这类明显是 API 的路径）都 fallback 到 `index.html`，未区分「浏览器导航」（应返回 SPA shell）与「API 调用」（应返回 JSON 404）。

证据链（systematic-debugging Phase 1 已确认）：

- `.desktop-build/agent/src/optional_deps/` 缺失（bundle 是 6/12 旧 assemble 产物，早于 6/14 的 optional_deps 实现）
- `~/.vibe-trading/runtime/agent/src/optional_deps/` 缺失（从旧 bundle 同步）
- `runtime marker == bundle VERSION`（均 `de48ae9-20260613163311`）→ `version.rs::decide` 返回 `Reuse` → runtime 永不升级
- repo 内 prod 模式（含 optional-deps 路由）TestClient 验证：`/optional-deps/list` 返回 200 JSON——证明路由匹配本身正确，问题纯在"缺路由时 fallback 成 HTML"

## What Changes

- 修改 `SPAStaticFiles.get_response`：404 fallback 分支读取请求 `Accept` 头，仅当请求是浏览器导航（`Accept` 含 `text/html`）时才返回 `index.html`；否则（API 调用，`Accept` 为 `application/json` / `*/*` / 其它）返回标准 JSON 404（`{"detail":"Not Found"}`、`content-type: application/json`、status 404），使前端 `errorFromResponse` 走正常错误分支而非 `JSON.parse` 崩溃。

不改 spec 验收场景（这是 SPA 服务的健壮性修复，不改变任何已声明 capability 的契约）。

## Fix Goal

- 未知 API 路径返回 JSON 404（而非 HTML），前端显示 `HTTP 404` 这类可诊断的错误。
- 浏览器导航（`Accept: text/html`）的未知 SPA 路径仍正常 fallback 到 `index.html`（深链刷新行为不变）。
