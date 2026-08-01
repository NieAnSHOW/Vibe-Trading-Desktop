import { describe, expect, it, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";

const mocks = vi.hoisted(() => ({
  consoleGetSettings: vi.fn(async () => ({ autostart_service: false })),
  consoleSetAutostart: vi.fn(async () => undefined),
}));

vi.mock("../../ipc/commands", () => ({
  consoleGetSettings: mocks.consoleGetSettings,
  consoleSetAutostart: mocks.consoleSetAutostart,
}));

import SettingsPage from "../SettingsPage.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { template: "<div />" } }],
});

beforeEach(async () => {
  vi.clearAllMocks();
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
});
