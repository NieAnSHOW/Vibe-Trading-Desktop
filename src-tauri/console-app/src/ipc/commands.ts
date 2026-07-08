import { invoke } from "@tauri-apps/api/core";
import type {
  AuthStatusView,
  Captcha,
  LoginResultView,
  StatusReport,
  AdItem,
} from "./types";

// 与 src-tauri/src/console.rs 的 #[tauri::command] 一一对应。
// 所有命令透传 invoke;Rust 侧 camelCase ↔ snake_case 由 Tauri 自动转换。

export const consoleStatus = (): Promise<StatusReport> =>
  invoke<StatusReport>("console_status");

export const consoleBootstrap = (): Promise<void> =>
  invoke<void>("console_bootstrap");

export const consoleStartService = (): Promise<number> =>
  invoke<number>("console_start_service");

export const consoleStopService = (): Promise<void> =>
  invoke<void>("console_stop_service");

export const consoleOpenWebui = (port: number): Promise<void> =>
  invoke<void>("console_open_webui", { port });

export const consoleOpenLogs = (): Promise<void> =>
  invoke<void>("console_open_logs");

export const consoleClearVenv = (): Promise<void> =>
  invoke<void>("console_clear_venv");

export const consoleStartChannels = (port: number): Promise<string> =>
  invoke<string>("console_start_channels", { port });

export const consoleChannelsStatus = (port: number): Promise<string> =>
  invoke<string>("console_channels_status", { port });

export const consoleInstallChannelDep = (channel: string): Promise<void> =>
  invoke<void>("console_install_channel_dep", { channel });

export const consoleConfirmClose = (): Promise<void> =>
  invoke<void>("console_confirm_close");

// 与 src-tauri/src/console.rs 的 #[tauri::command] 一一对应。
export const consoleLoginCaptcha = (): Promise<Captcha> =>
  invoke<Captcha>("console_login_captcha");

export const consoleLoginSendSms = (
  phone: string,
  captchaId: string,
  code: string,
): Promise<void> =>
  invoke<void>("console_login_send_sms", { phone, captchaId, code });

export const consoleLoginByPhone = (
  phone: string,
  smsCode: string,
): Promise<LoginResultView> =>
  invoke<LoginResultView>("console_login_by_phone", { phone, smsCode });

export const consoleLoginByPassword = (
  phone: string,
  password: string,
): Promise<LoginResultView> =>
  invoke<LoginResultView>("console_login_by_password", { phone, password });

export const consoleLoginSetPassword = (password: string): Promise<void> =>
  invoke<void>("console_login_set_password", { password });

export const consoleAuthStatus = (): Promise<AuthStatusView> =>
  invoke<AuthStatusView>("console_auth_status");

export const consoleLogout = (): Promise<void> =>
  invoke<void>("console_logout");

export const consoleFetchAds = (position: string): Promise<AdItem[]> =>
  invoke<AdItem[]>("console_fetch_ads", { position });
