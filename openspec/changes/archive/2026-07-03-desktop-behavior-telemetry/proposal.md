## Why

桌面端目前对“用户如何使用应用”零可见度——代码库中没有任何埋点/分析能力。产品侧无法回答“哪些功能被用、会话多长、回测/技能命中频次如何、哪里出错”这类基本问题。

作为一款金融/交易研究桌面应用，数据离开设备的时机与口径都敏感：实时上报既增加泄漏面、又依赖常在线的实时 infra，与离线友好的桌面形态不匹配。因此采用 **本地按天累积 → 隔天启动时批量上传** 的 deferred 模式：离线可用、泄漏面最小、无需实时 infra、批量少请求。

## What Changes

- **前端采集层**：新增轻量埋点 SDK，捕获 UI 交互事件（路由切换、功能使用次数、会话时长、发起对话/回测、查看报告、导出、错误），事件经白名单枚举、属性仅允许枚举值与聚合数字。
- **本地按天存储**：事件写入 IndexedDB，按本地时区日期（`YYYY-MM-DD`）分桶累积；`localStorage` 仅用于设备 ID / 同意开关等少量元数据。
- **隔天批量上传**：app 启动时检查 `日期 < 今天` 的批次，按日期先后上传到 VIP 服务器 `:8001`，成功后删除本地批次；失败退避重试（单批单启动 ≤3 次），**保留上限 14 天**后丢弃。当天数据不传。
- **Python sidecar 脱敏指标**：sidecar 产出聚合指标（技能调用计数、回测次数/耗时/错误计数），通过同源本地路由 `GET /telemetry/sidecar-metrics` 交给前端统一上传；**仅聚合数字，绝不含 prompt/查询/交易内容**。
- **同意机制**：Settings 新增埋点开关，**默认开启但可关**；关闭后停止新增采集（已缓冲历史批次仍按计划上传一次）。
- **身份**：匿名设备 ID（UUID，localStorage 持久）+ 登录用户关联；**客户端 body 不传 user_id，由服务端从 VIP token 盖戳**；未登录访客以匿名 device_id 上传。
- **服务端接收端点（cool-admin-midway，跨仓）**：新增公开端点（放 `controller/open/`）接收批次，**支持未登录匿名上传**；做 schema 校验、按 device_id 频控、批次级落库到 `telemetry_event` 表。

## Capabilities

### New Capabilities

- `desktop-behavior-telemetry`: 桌面端用户行为埋点——前端 UI 事件采集、sidecar 脱敏指标、本地按天存储（IndexedDB）、隔天启动批量上传（含未登录匿名上传）、同意开关、匿名设备 ID + 服务端盖戳登录身份、服务端公开端点接收与批次级落库。

### Modified Capabilities

（无。现有 `desktop-shell` / `desktop-packaging-build` / `python-runtime-bundling` / `python-runtime-optional-deps` 的 spec 级需求不变；本 change 在 shell/前端/sidecar 内部新增模块，并跨仓在 cool-admin-midway 新增独立 telemetry 模块，不修改既有规格。）

## Impact

- **frontend**：新增埋点 SDK（`src/lib/telemetry/`）、IndexedDB 存储层、独立上传器、Settings 同意开关、app 启动 flush hook、路由/功能/会话/错误埋点接入。
- **agent (Python sidecar)**：新增脱敏指标计数器 + 同源路由 `GET /telemetry/sidecar-metrics`。
- **cool-admin-midway（跨仓，`:8001`）**：新增 `src/modules/telemetry/`（公开控制器 + service + `telemetry_event` 实体）；公开端点、schema 校验、频控、批次级落库。**分析后台/聚合查询接口仍为非目标。**
- **隐私/合规**：采集口径严格限定为 UI 事件 + 聚合指标；prompt、查询、交易标的、持仓、金额等内容**一律不采集不上传**；隐私收口于采集 SDK 白名单。
- **测试**：前端（vitest + fake-indexeddb）、sidecar（pytest）、服务端（jest）三套单测 + 隐私静态核验 + 桌面集成冒烟，覆盖分桶、flush 触发、失败重试、保留上限、匿名上传、服务端盖戳、同意 gating。
