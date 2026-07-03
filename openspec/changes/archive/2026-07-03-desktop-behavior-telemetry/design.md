## Context

桌面端目前零埋点。架构上有两个后端：① agent 后端（FastAPI，`:8899`，**嵌入本地**、随 app 启停，经 `SPAStaticFiles` 自己托管 `frontend/dist`，故 webview 与之同源）；② VIP 用户服务器（cool-admin-midway / midway.js，`:8001`，远程，掌握用户身份；前端已跨域直连，CORS 由 cool-midway 核心处理）。前端为 React + zustand，本地用 `localStorage` 存少量元数据。Tauri command 层极薄（仅 `open_external_url` + `tauri-plugin-process`）。

金融/交易场景对“数据离开设备”的时机与口径敏感，且桌面端常离线 → 选 **本地按天累积 + 隔天启动批量上传** 的 deferred 模式。用户拥有 cool-admin-midway 服务端，并要求**未登录用户也能上传**。

## Goals / Non-Goals

**Goals:**
- 客户端采集 UI 事件 + sidecar 脱敏聚合指标，按本地日期分桶存 IndexedDB。
- app 启动时 flush `日期 < 今天` 的批次到 `:8001`，成功删除、失败退避重试、超期丢弃。
- **支持未登录匿名上传**：公开端点 + 匿名 device_id；登录用户由服务端盖戳 user_id。
- 同意开关（默认开可关）；严格脱敏（仅事件 + 聚合数字）。
- 服务端（cool-admin-midway）公开端点接收 + 批次级落库。

**Non-Goals:**
- 分析后台 / 聚合查询接口 / 可视化。
- 实时/在线上传；跨设备行为归因；第三方分析平台集成。
- per-event 落库（本期批次级）。

## Decisions

1. **采集职责拆分，前端为唯一上传方**
   - 前端采集 UI 事件；sidecar 只产出脱敏聚合指标。前端独占 IndexedDB、flush 逻辑与上传。
   - *替代方案*：sidecar 自带上传路径——被否，token 在前端、sidecar 嵌入本地不宜直连远程。

2. **本地存储用 IndexedDB（native，无依赖）**
   - 事件日志体量超出 localStorage ~5MB 上限且同步阻塞；IndexedDB 异步、容量大、可按日期索引。schema 简单（events + date 索引 + meta kv），native 够用。
   - localStorage 仅存少量元数据（设备 ID、同意开关、上次 flush 标记）。

3. **隔天 flush 模型**
   - 触发：app 启动。规则：上传 `date < today(本地时区)` 的批次，按日期先后；2xx 删本地；失败指数退避（单批单启动 ≤3 次）；**保留上限 14 天**后丢弃。当天数据不传。

4. **身份：匿名设备 ID + 服务端盖戳 user_id**
   - 设备 ID（UUID）存 localStorage；每批次必带，访客唯一身份。
   - **客户端 body 不传 user_id**；仅当已登录时上传请求附带 VIP token，**服务端解析 token 盖戳真实 user_id**；未登录 ⇒ user_id=null（匿名）。杜绝客户端伪造。

5. **同意 gating：默认开、可关**
   - Settings 新增开关；关闭后新增采集为 no-op；**已缓冲的历史批次仍按计划上传一次**。

6. **sidecar → 前端 通道：同源 HTTP（复用 sidecar）**
   - sidecar 已跑 FastAPI `:8899`，新增同源路由 `GET /telemetry/sidecar-metrics` 供前端 flush 前拉取聚合指标。
   - *替代方案*：Tauri command（IPC）——被否，Tauri command 层极薄，加 command/app-data 需新插件，严格贵于同源 HTTP；共享文件——并发与原子性差，不选。

7. **上传目标与请求方式：公开端点 + 独立 POST**
   - 上传到 cool-admin-midway `:8001` 的**公开端点**（`controller/open/`），**支持未登录上传**。
   - 上传器用**独立 fetch**（非 `apiUser.request`，避免其 401 刷新逻辑误伤公开端点/访客）：仅当 auth store 有 token 时附 `Authorization`，body 不含 user_id。
   - CORS 复用 cool-midway 现网配置（现有跨域登录可用为证），build 阶段验证覆盖 open 路由。

8. **服务端：cool-admin-midway 新增 telemetry 模块**
   - `src/modules/telemetry/`：公开控制器（接收）+ service（校验/盖戳/落库）+ `telemetry_event` 实体（批次级一行）。
   - schema 校验 + 单批体积上限 + 按 device_id 频控 + 参数化查询防注入。
   - 跨仓实现，作为本 change 的任务（契约是两边缝合线）。

9. **契约路径已确定：`/open/{module}/{file}/{method}`**
   - cool-admin `@CoolController()` 前缀 = `{目录}/{模块}/{文件}`（open/app/admin 在最前）+ `@Post` 方法路径；`/open/` 不经鉴权中间件（`user/middleware/app.ts` 仅拦 `/app/`）⇒ 天然免登，匿名可用。
   - telemetry 公开端点 = `/open/telemetry/events/events`；前端 uploader 默认 endpoint `${VITE_USER_API_BASE}/open/telemetry/events/events`。
   - *曾误写 `/telemetry/open/...`（目录顺序错）导致 404，已修正。*

## Risks / Trade-offs

- [Tauri command 通道贵] → 同源 HTTP 复用现成 sidecar，零新插件。
- [设备 ID 跨重装丢失] → localStorage 接受；脱敏统计不强归因；升级路径 Tauri app-data。
- [公开端点被滥用/伪造 user_id] → schema 校验 + 体积上限 + device_id 频控 + 服务端盖戳（不信任 body user_id）。
- [sidecar 不可用丢指标] → 非关键路径，best-effort。
- [时区/时钟漂移] → 统一本地时区日期分桶，文档注明。
- [cool-admin `open/` 路由前缀未定] → ✅ 已解决（§Decision 9）：前缀 = `/open/{module}/{file}/{method}`，telemetry = `/open/telemetry/events/events`。

## Open Questions

- 频控实现选型（cool-admin 内置中间件 vs 进程内简单 cap）。
- `app_version` 来源（Tauri 版本注入 vs 硬编码）。
