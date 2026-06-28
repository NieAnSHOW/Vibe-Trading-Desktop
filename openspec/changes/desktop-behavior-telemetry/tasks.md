# Tasks — desktop-behavior-telemetry

> 客户端用户行为埋点（端到端）：前端 UI 事件 + Python sidecar 脱敏指标 → IndexedDB 按天存储 → 隔天启动批量上传到 cool-admin-midway :8001（**含未登录匿名上传**）+ 服务端公开端点接收与批次级落库。
> 跨仓：客户端在 Vibe-Trading-Desktop，服务端在 cool-admin-midway；契约是两边缝合线。

## 1. 契约与口径（基础）

- [x] 1.1 定义上传接口契约：公开端点路由（遵循 cool-admin `open/` 约定）、请求/响应字段、token 可选、错误码（400/429/2xx）；客户端与服务端共享此契约。
- [x] 1.2 定义事件白名单与脱敏规则：显式枚举合法 UI 事件与聚合指标字段；写明”禁止采集 prompt/查询/交易/持仓/金额等任意内容”。
- [x] 1.3 定义本地数据模型：IndexedDB `events` store（按 `date=YYYY-MM-DD` 索引）+ `meta` store（`device_id` / `consent` / `last_flush_at`）。

## 2. 前端采集 SDK 与本地存储

- [x] 2.1 实现 IndexedDB 封装层（native，无依赖）：写入、按日期查询、删除、`purgeOld(days)`；附单测。
- [x] 2.2 实现（匿名）设备 ID 的稳定生成与读取（localStorage `vibe_device_id`）。
- [ ] 2.3 实现采集 SDK 核心 `track(type, props)`：consent off ⇒ no-op；白名单校验（type 枚举 + props 字段过滤）→ 写入当天桶。
- [ ] 2.4 接入关键 UI 埋点：路由切换、功能使用次数、会话起止/时长、前端错误（stack_hash）。

## 3. sidecar 脱敏指标与本地同源通道

- [ ] 3.1 在 Python sidecar 实现进程内脱敏指标计数器（技能调用计数、回测次数/耗时/按引擎、错误计数及分类）。
- [ ] 3.2 新增同源路由 `GET /telemetry/sidecar-metrics`（支持 `?since=` 增量），响应仅聚合数字、无内容字段。
- [ ] 3.3 前端 flush 前拉取 sidecar 指标并入对应日期桶（best-effort，失败跳过）。

## 4. 隔天 flush 上传器

- [ ] 4.1 实现 flush 调度：app 启动触发；扫描 `date < today(本地时区)` 批次，按日期升序；当天数据不传；同日多次启动不触发当日上传。
- [ ] 4.2 实现上传：**独立 fetch**（非 apiUser.request），仅登录时附 `Authorization: Bearer <token>`，body 不含 user_id；2xx 删本地；失败指数退避（单批单启动 ≤3 次）。
- [x] 4.3 实现 14 天保留上限清理（`purgeOld(14)`）。
- [ ] 4.4 consent 关闭后：停止新增采集，但已缓冲历史批次仍按计划上传一次。

## 5. Settings 同意开关

- [ ] 5.1 Settings 页新增「使用数据」开关卡片（默认开启）+ 一句隐私说明 + i18n（zh-CN/en）。
- [x] 5.2 开关状态持久化（meta + localStorage 双写）并接入采集层 gating。

## 6. 服务端端点（cool-admin-midway 跨仓）

- [ ] 6.1 新增模块 `src/modules/telemetry/`：公开控制器 `controller/open/events.ts`（`@CoolController()` 免登，`@Post` 接收批次）。
- [ ] 6.2 实现 `service/events.ts`：schema 校验（字段/类型/枚举/单批体积上限）、按 `device_id` 频控、token 有则解析盖戳 user_id（不信任 body user_id）。
- [ ] 6.3 实现 `entity/event.ts`：`@Entity('telemetry_event') extends BaseEntity`，批次级字段（device_id/user_id?/batch_date/app_version/event_count/payload(JSON)/created_at）+ 落库。
- [ ] 6.4 确认 cool-admin `open/` 路由前缀与契约路径一致；验证 CORS 覆盖该公开路由。

## 7. 测试与隐私核验

- [ ] 7.1 前端单测（vitest + fake-indexeddb）：白名单拒绝/剔除、按天分桶、flush 触发条件（同日多次启动不传）、失败退避（≤3）、14 天上限、consent gating（off⇒不写；历史仍传）、设备 ID 持久。
- [ ] 7.2 sidecar 单测（pytest）：计数器正确、`/telemetry/sidecar-metrics` 形状与 `since` 增量、脱敏（无内容字段）。
- [ ] 7.3 服务端单测（jest）：公开端点接收、匿名批次落库（user_id=null）、带 token 盖戳 user_id、伪造 body user_id 被忽略、schema 拒绝（400）、频控（429）。
- [ ] 7.4 隐私核验：静态检查 `track()` 全部调用点 + 数据流，确认无 prompt/查询/交易内容进入事件。
- [ ] 7.5 桌面端集成冒烟：模拟 Day1 采集（含未登录匿名）→ 改日期触发 Day2 flush → 验证 :8001 收到批次并落库、本地已删。
