import { describe, it, expect, vi } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { onBootstrapEvent, onServiceStarted, onCloseRequested } from "../events";

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

  it("onCloseRequested 注册 app://close-requested", async () => {
    listenMock.mockResolvedValue(vi.fn());
    await onCloseRequested(vi.fn());
    expect(listenMock).toHaveBeenCalledWith("app://close-requested", expect.any(Function));
  });
});
