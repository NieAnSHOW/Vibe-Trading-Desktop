// frontend/src/lib/telemetry/types.ts
// 事件白名单与契约定义。隐私硬边界（§5）：仅枚举值与聚合数字，
// 任何 prompt/查询/交易标的/持仓/金额内容一律不得出现在 props。

export const EVENT_TYPES = [
  "page_view",
  "feature_use",
  "session_start",
  "session_end",
  "error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const FEATURE_NAMES = [
  // 核心功能
  "chat_send",
  "backtest_run",
  "report_view",
  "export_pdf",
  "compare_view",
  "correlation_view",
  "alpha_zoo_open",
  "runtime_open",
  // 侧边栏导航
  "nav_sidebar",
  // 外部快捷方式
  "external_shortcut",
  // 侧边栏控件
  "sidebar_toggle",
  "theme_toggle",
  "lang_toggle",
  // 会话管理
  "session_new",
  "session_delete",
  // 首页 CTA
  "home_start_research",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** 每个 EventType 允许出现在 props 的字段白名单；未列出 = 一律剔除。 */
export const ALLOWED_PROPS: Record<EventType, readonly string[]> = {
  page_view: ["route"],
  feature_use: ["name", "nav_target", "shortcut_id"],
  session_start: [],
  session_end: ["duration_ms"],
  error: ["type", "stack_hash"],
};

export interface TelemetryEvent {
  ts: number; // 秒级 unix 时间戳
  type: EventType;
  /** feature_use 必带 name；page_view 用 route（在 props）；其余为 undefined。 */
  name?: string;
  props: Record<string, number | string>;
}

export interface SidecarMetrics {
  since: number;
  skill_calls: Record<string, number>;
  backtests: { count: number; total_ms: number; by_engine: Record<string, number> };
  errors: { count: number; by_type: Record<string, number> };
}

export interface TelemetryBatch {
  device_id: string;
  app_version: string;
  batch_date: string; // YYYY-MM-DD 本地时区
  events: TelemetryEvent[];
  sidecar_metrics: SidecarMetrics;
}

/** 服务端响应契约（§6.2）。 */
export interface UploadResponse {
  accepted: boolean;
  accepted_count: number;
}
