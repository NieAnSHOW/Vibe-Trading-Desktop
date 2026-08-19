// 镜像 src-tauri/src/console.rs 的 StatusReport 与事件 payload 结构。

export type EnvState = "ready" | "incomplete" | "not_installed";

export interface StatusReport {
  env: EnvState;
  service_running: boolean;
  port: number | null;
}

export interface CustomLLMReadiness {
  customConfigured: boolean;
}

// 镜像 src-tauri/src/console.rs 的 EnvironmentReport。
export interface EnvironmentReport {
  env: EnvState;
  installedVersion: string | null;
  bundleVersion: string;
  depsOk: boolean;
  runtimeOk: boolean;
}

// 镜像 src-tauri/src/settings.rs 的 Settings。
export interface Settings {
  autostart_service: boolean;
  theme_mode: "system" | "light" | "dark";
  theme_color: "teal" | "blue" | "purple" | "pink" | "orange" | "green";
  api_auth_key: string;
}

export type BootstrapStage =
  | "venv"
  | "installing"
  | "smoke"
  | "done"
  | "failed";

export interface BootstrapEvent {
  stage: BootstrapStage;
  message?: string;
  ok?: boolean;
}

export interface ChannelInfo {
  enabled?: boolean;
  loaded?: boolean;
  running?: boolean;
  health?: "ok" | "expired" | string;
}

// ── 消息渠道(镜像 backend /channels/*,自 WebUI src/lib/api.ts 迁移) ──

export interface ChannelAdapterStatus {
  name: string;
  display_name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
  loaded: boolean;
  running: boolean;
  health?: string;
  error?: string;
  install_hint?: string;
}

export interface ChannelRuntimeStatus {
  running: boolean;
  inbound_queue: number;
  outbound_queue: number;
  session_count: number;
  channels: Record<string, ChannelAdapterStatus>;
}

export interface ChannelPairingCommandResponse {
  channel: string;
  reply: string;
}

export interface WeixinLoginStartResponse {
  login_id: string;
  qr_image: string;
}

export interface WeixinLoginStatusResponse {
  status: string;
}

// ── LLM / 数据源设置(镜像 backend /settings/llm 与 /settings/data-sources,
//    自 WebUI src/lib/api.ts 迁移) ─────────────────────────────────

export interface LLMProviderOption {
  name: string;
  label: string;
  api_key_env?: string | null;
  base_url_env: string;
  default_model: string;
  default_base_url: string;
  api_key_required: boolean;
  auth_type?: string;
  login_command?: string | null;
}

export interface LLMSettings {
  provider: string;
  model_name: string;
  base_url: string;
  api_key_env?: string | null;
  api_key_configured: boolean;
  api_key_hint?: string | null;
  api_key_required: boolean;
  temperature: number;
  timeout_seconds: number;
  max_retries: number;
  reasoning_effort: string;
  sse_timeout_seconds: number;
  env_path: string;
  providers: LLMProviderOption[];
  desktop_login_provisioned?: boolean;
  desktop_llm_mode: "vip" | "custom";
  desktop_vip_available: boolean;
  vip_models?: string[];
}

export interface DataSourceSettings {
  tushare_token_configured: boolean;
  tushare_token_hint?: string | null;
  baostock_supported: boolean;
  baostock_installed: boolean;
  baostock_message: string;
  env_path: string;
}

export interface ChannelStatus {
  channels?: Record<string, ChannelInfo>;
}

// === Auth / Login（镜像 src-tauri/src/console.rs 与 auth.rs）===

export interface UserInfo {
  id: number;
  unionid?: string | null;
  avatarUrl?: string | null;
  nickName?: string | null;
  phone?: string | null;
  gender: number;
  status: number;
  loginType: number;
  description?: string | null;
  memberLevel?: MemberLevel | null;
}

export interface MemberLevel {
  id: number;
  name: string;
  code?: string | null;
  levelValue: number;
  expireTime?: string | null;
}

export interface LoginResultView {
  userInfo: UserInfo;
  hasPassword: boolean;
  expireAt: number; // epoch 秒
  message: string;
}

export interface CommandMessage {
  message: string;
}

export interface AuthStatusView {
  authenticated: boolean;
  userInfo?: UserInfo | null;
  expireAt?: number | null;
  membershipChanged?: boolean;
}

export interface MemberUsageView {
  total_available: number;
  total_granted: number;
  total_used: number;
  unlimited_quota: boolean;
}

export interface MemberBenefit {
  id: string;
  title: string;
  description?: string | null;
}

export interface MemberBenefitsView {
  benefits: MemberBenefit[];
}

export interface Captcha {
  captchaId: string;
  data: string; // base64 svg（可能含 data: 前缀）
}

// Rust 端 #[serde(tag="variant")] 错误，前端按 e.variant 分流
export interface AuthError {
  variant:
    | "Network"
    | "Api"
    | "LoginExpired"
    | "EnvWrite"
    | "Credential"
    | "NotAuthenticated";
  message?: string;
  code?: number;
}

export interface ServiceStartError {
  variant:
    | "EnvNotReady"
    | "AlreadyRunning"
    | "LoginExpired"
    | "SpawnFailed"
    | "HealthTimeout"
    | "ProcessExited"
    | "Other";
  message?: string;
  code?: number | null;
}

// === 版本更新 ===

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  downloadUrl: string;
  assetName: string;
  releaseNotes: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  done: boolean;
  path?: string | null;
}

// === 广告 ===

export interface AdImage {
  url: string;
  link?: string | null;
}

export interface AdItem {
  id: number;
  title: string;
  type: number; // 1=纯图片 2=纯文本
  position: string;
  images?: AdImage[] | null;
  content?: string | null;
  link?: string | null;
  sort: number;
}

// === 公共配置 ===

/** 服务端公共配置（/app/base/comm/publicConfig），Rust 侧解析后原样返回 */
export interface PublicConfig {
  officialUrl: string;
  enableLogin: boolean;
  checkUpdate: boolean;
  enableService: boolean;
  serviceQrCode: string;
  /** 客服微信二维码（登录用户「联系客服」弹窗展示） */
  kefuQrCode: string;
  /** 支持作者二维码（登录用户「支持作者领中级会员」弹窗展示） */
  rewardQrCode: string;
  enableAd: boolean;
}
