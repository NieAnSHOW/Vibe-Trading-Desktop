# Implementation Tasks — fix-spa-staticfiles-api-fallback

## 1. SPAStaticFiles fallback 区分 API 与浏览器导航

- [x] 1.1 修改 `agent/api_server.py` `SPAStaticFiles.get_response`：404 分支从 `scope` 读取 `accept` 头；含 `text/html` 才 fallback 到 `index.html`，否则返回 `JSONResponse({"detail": "Not Found"}, status_code=404)`
- [x] 1.2 补充测试：未知 API 路径（Accept `application/json`）在无路由时返回 JSON 404（status 404、content-type `application/json`、body `{"detail":"Not Found"}`）；未知 SPA 路径（Accept `text/html`）仍返回 index.html（HTML 200）
- [x] 1.3 运行 `python -m py_compile agent/api_server.py` 及 optional-deps 相关测试，确认无回归

## 2. 验证

- [x] 2.1 TestClient 复现 mount SPAStaticFiles 后的行为：未知 API 路径 → JSON 404；浏览器导航路径 → HTML 200；已知 API 路由（`/health`、`/optional-deps/list`）不受影响
- [x] 2.2 静态资源（`/assets/...`、`/favicon.png`）正常返回 200
