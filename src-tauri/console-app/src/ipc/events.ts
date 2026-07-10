import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BootstrapEvent, DownloadProgress } from "./types";

// 6 个事件的 typed wrapper,每个返回 unlisten,由调用方在 onUnmounted 时清理。

export const onBootstrapEvent = (cb: (e: BootstrapEvent) => void): Promise<UnlistenFn> =>
  listen<BootstrapEvent>("bootstrap://event", (ev) => cb(ev.payload));

export const onBootstrapExit = (cb: (code: number) => void): Promise<UnlistenFn> =>
  listen<number>("bootstrap://exit", (ev) => cb(ev.payload));

export const onServiceStarted = (cb: (port: number) => void): Promise<UnlistenFn> =>
  listen<number>("service://started", (ev) => cb(ev.payload));

export const onQuitRequested = (
  cb: (payload: { installing?: boolean } | unknown) => void,
): Promise<UnlistenFn> =>
  listen("app://quit-requested", (ev) => cb(ev.payload));

export const onChanneldepProgress = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>("channeldep://progress", (ev) => cb(ev.payload));

export const onChanneldepExit = (cb: (code: number) => void): Promise<UnlistenFn> =>
  listen<number>("channeldep://exit", (ev) => cb(ev.payload));

export const onUpdateProgress = (cb: (p: DownloadProgress) => void): Promise<UnlistenFn> =>
  listen<DownloadProgress>("update://progress", (ev) => cb(ev.payload));
