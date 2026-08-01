import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
  consoleGetSettings: vi.fn(async () => ({ autostart_service: false })),
  consoleSetAutostart: vi.fn(async () => undefined),
  consoleStatus: vi.fn(async () => ({
    env: "ready" as const,
    service_running: false,
    port: null,
  })),
  consoleOpenLogs: vi.fn(),
  consoleClearLogs: vi.fn(async () => 2),
  consoleClearVenv: vi.fn(async () => undefined),
  consoleStopService: vi.fn(async () => undefined),
}));

vi.mock("../../ipc/commands", () => ({
  consoleGetSettings: mocks.consoleGetSettings,
  consoleSetAutostart: mocks.consoleSetAutostart,
  consoleStatus: mocks.consoleStatus,
  consoleOpenLogs: mocks.consoleOpenLogs,
  consoleClearLogs: mocks.consoleClearLogs,
  consoleClearVenv: mocks.consoleClearVenv,
  consoleStopService: mocks.consoleStopService,
}));

import SettingsPage from "../SettingsPage.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { template: "<div />" } }],
});

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement, returnValue = "") {
        this.returnValue = returnValue;
        this.open = false;
      },
    },
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  await router.push("/");
  await router.isReady();
});

describe("SettingsPage", () => {
  it("loads the autostart setting and renders the current version", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(mocks.consoleGetSettings).toHaveBeenCalledOnce();
    expect(wrapper.get('[role="switch"]').attributes("aria-checked")).toBe("false");
    expect(wrapper.text()).toContain("v0.");
  });

  it("turns the switch on and persists the change", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[role="switch"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleSetAutostart).toHaveBeenCalledWith(true);
    expect(wrapper.get('[role="switch"]').attributes("aria-checked")).toBe("true");
  });

  it("rolls the switch back when saving fails", async () => {
    mocks.consoleSetAutostart.mockRejectedValueOnce(new Error("io error"));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[role="switch"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="switch"]').attributes("aria-checked")).toBe("false");
    expect(wrapper.text()).toContain("保存失败");
  });

  it("renders the maintenance actions migrated from the console", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('[data-test="clear-environment-action"]').text()).toBe("清理");
    expect(wrapper.get('[data-test="open-logs-action"]').text()).toBe("打开");
    expect(wrapper.get('[data-test="clear-logs-action"]').text()).toBe("清理");
  });

  it("opens the persisted log directory from the maintenance card", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="open-logs-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleOpenLogs).toHaveBeenCalledOnce();
  });

  it("clears persisted log files only after confirmation", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="clear-logs-action"]').trigger("click");
    expect(mocks.consoleClearLogs).not.toHaveBeenCalled();

    const clearLogsDialog = wrapper.findAll("dialog").find(
      (dialog) => dialog.find("h3").text() === "确认清理日志文件？",
    );
    expect(clearLogsDialog).toBeDefined();
    (clearLogsDialog!.element as HTMLDialogElement).returnValue = "ok";
    await clearLogsDialog!.trigger("close");
    await flushPromises();

    expect(mocks.consoleClearLogs).toHaveBeenCalledOnce();
    expect(wrapper.get(".settings-notice").text()).toBe("已清理 2 个日志文件");
  });

  it("clears the runtime environment only after confirmation", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="clear-environment-action"]').trigger("click");
    expect(mocks.consoleClearVenv).not.toHaveBeenCalled();

    const clearVenvDialog = wrapper.findAll("dialog").find(
      (dialog) => dialog.find("h3").text() === "确认强制清理环境？",
    );
    expect(clearVenvDialog).toBeDefined();
    (clearVenvDialog!.element as HTMLDialogElement).returnValue = "ok";
    await clearVenvDialog!.trigger("close");
    await flushPromises();

    // 服务未运行,直接清理,无需停服
    expect(mocks.consoleStopService).not.toHaveBeenCalled();
    expect(mocks.consoleClearVenv).toHaveBeenCalledOnce();
    expect(wrapper.get(".settings-notice").text()).toBe("运行环境已清理，请重新安装依赖");
  });
});
