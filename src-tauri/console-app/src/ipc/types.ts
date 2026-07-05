// 镜像 src-tauri/src/console.rs 的 StatusReport 与事件 payload 结构。

export type EnvState = "ready" | "incomplete" | "not_installed";

export interface StatusReport {
  env: EnvState;
  service_running: boolean;
  port: number | null;
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

export interface ChannelStatus {
  channels?: Record<string, ChannelInfo>;
}
