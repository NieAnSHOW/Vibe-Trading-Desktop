import { describe, it, expect, vi } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { onBootstrapEvent, onServiceStarted, onQuitRequested } from "../events";

describe("ipc/events", () => {
  it("onBootstrapEvent 注册 bootstrap://event 并返回 unlisten", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onBootstrapEvent(cb);
    expect(listenMock).toHaveBeenCalledWith("bootstrap://event", expect.any(Function));
    expect(result).toBe(unlisten);
  });

  it("onServiceStarted 注册 service://started", async () => {
    listenMock.mockResolvedValue(vi.fn());
    await onServiceStarted(vi.fn());
    expect(listenMock).toHaveBeenCalledWith("service://started", expect.any(Function));
  });

  it("onQuitRequested 注册 app://quit-requested", async () => {
    listenMock.mockResolvedValue(vi.fn());
    await onQuitRequested(vi.fn());
    expect(listenMock).toHaveBeenCalledWith("app://quit-requested", expect.any(Function));
  });
});
