import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core 的 invoke
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  consoleStatus,
  consoleBootstrap,
  consoleStartService,
  consoleOpenWebui,
  consoleCloseWebui,
  consoleTakePendingWebui,
  consoleChannelsStatus,
  consoleInstallChannelDep,
  consoleUninstallLegacyApp,
  consoleGetPublicConfig,
} from "../commands";

describe("ipc/commands", () => {
  beforeEach(() => invokeMock.mockReset());

  it("consoleStatus 调用 invoke 且无参数", async () => {
    invokeMock.mockResolvedValue({ env: "ready", service_running: false, port: null });
    const r = await consoleStatus();
    expect(invokeMock).toHaveBeenCalledWith("console_status");
    expect(r.env).toBe("ready");
  });

  it("consoleOpenWebui 透传 port 参数", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleOpenWebui(8899);
    expect(invokeMock).toHaveBeenCalledWith("console_open_webui", { port: 8899 });
  });

  it("consoleTakePendingWebui retrieves an auto-start request once the shell mounts", async () => {
    invokeMock.mockResolvedValue("http://127.0.0.1:8899/?desktop=1&shell=frame");

    await expect(consoleTakePendingWebui()).resolves.toContain("shell=frame");
    expect(invokeMock).toHaveBeenCalledWith("console_take_pending_webui");
  });

  it("consoleCloseWebui synchronizes a rail-initiated return with the native shell", async () => {
    invokeMock.mockResolvedValue(undefined);

    await consoleCloseWebui();
    expect(invokeMock).toHaveBeenCalledWith("console_close_webui");
  });

  it("consoleChannelsStatus 透传 port", async () => {
    invokeMock.mockResolvedValue('{"channels":{}}');
    await consoleChannelsStatus(8899);
    expect(invokeMock).toHaveBeenCalledWith("console_channels_status", { port: 8899 });
  });

  it("consoleInstallChannelDep 透传 channel", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleInstallChannelDep("weixin");
    expect(invokeMock).toHaveBeenCalledWith("console_install_channel_dep", { channel: "weixin" });
  });

  it("consoleBootstrap 调用命令名", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleBootstrap();
    expect(invokeMock).toHaveBeenCalledWith("console_bootstrap");
  });

  it("consoleStartService 返回 port", async () => {
    invokeMock.mockResolvedValue(8899);
    const port = await consoleStartService();
    expect(port).toBe(8899);
  });

  it("consoleUninstallLegacyApp invokes the fixed Tauri command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await consoleUninstallLegacyApp();
    expect(invokeMock).toHaveBeenCalledWith("console_uninstall_legacy_app");
  });

  it("consoleGetPublicConfig 调用命令名并返回配置", async () => {
    const cfg = { officialUrl: "", enableLogin: true, checkUpdate: false, enableService: false, serviceQrCode: "", kefuQrCode: "", rewardQrCode: "", enableAd: true };
    invokeMock.mockResolvedValue(cfg);
    const r = await consoleGetPublicConfig();
    expect(invokeMock).toHaveBeenCalledWith("console_get_public_config");
    expect(r.enableLogin).toBe(true);
  });
});
