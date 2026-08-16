import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { StatusReport } from "../../ipc/types";

const mocks = vi.hoisted(() => ({
  consoleStatus: vi.fn(async (): Promise<StatusReport> => ({
    env: "ready" as const,
    service_running: false,
    port: null,
  })),
  bootstrapExitHandler: null as ((code: number) => unknown) | null,
  unlisten: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleStatus: mocks.consoleStatus,
  consoleBootstrap: vi.fn(),
  consoleOpenWebui: vi.fn(),
  consoleQuit: vi.fn(),
  consoleLogout: vi.fn(),
  consoleFetchAds: vi.fn(async () => []),
  consoleGetPublicConfig: vi.fn(async () => ({
    officialUrl: "",
    enableLogin: true,
    checkUpdate: false,
    enableService: false,
    serviceQrCode: "",
    kefuQrCode: "",
    rewardQrCode: "",
    enableAd: true,
  })),
  consoleStartService: vi.fn(),
  consoleStopService: vi.fn(),
  consoleChannelsStatus: vi.fn(),
  consoleCheckUpdate: vi.fn(),
  consoleDownloadUpdate: vi.fn(),
  consoleInstallUpdate: vi.fn(),
  consoleLoginCaptcha: vi.fn(async () => ({
    captchaId: "captcha-1",
    data: "data:image/svg+xml;base64,AA==",
  })),
  consoleLoginSendSms: vi.fn(),
  consoleLoginByPhone: vi.fn(),
  consoleLoginByPassword: vi.fn(),
  consoleLoginRegister: vi.fn(),
  consoleLoginSetPassword: vi.fn(),
}));

vi.mock("../../ipc/events", () => ({
  onBootstrapEvent: vi.fn(async () => mocks.unlisten),
  onBootstrapExit: vi.fn(async (handler: (code: number) => unknown) => {
    mocks.bootstrapExitHandler = handler;
    return mocks.unlisten;
  }),
  onServiceStarted: vi.fn(async () => mocks.unlisten),
  onQuitRequested: vi.fn(async () => mocks.unlisten),
  onChanneldepProgress: vi.fn(async () => mocks.unlisten),
  onChanneldepExit: vi.fn(async () => mocks.unlisten),
  onUpdateProgress: vi.fn(async () => mocks.unlisten),
}));

import OnboardingPage from "../OnboardingPage.vue";
import LoginPage from "../LoginPage.vue";

const EmptyRoute = { template: "<div />" };

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: OnboardingPage },
    { path: "/login", component: LoginPage },
    { path: "/profile", component: EmptyRoute },
    { path: "/settings", component: EmptyRoute },
  ],
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
  mocks.bootstrapExitHandler = null;
  setActivePinia(createPinia());
  await router.push("/");
  await router.isReady();
});

describe("OnboardingPage", () => {
  it("marks the onboarding page ready after mounting", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await nextTick();
    expect(wrapper.classes()).toContain("onboarding-page--ready");
  });

  it("keeps the page in its startup state until the content animation ends", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await nextTick();
    expect(wrapper.classes()).toContain("onboarding-page--entering");

    await wrapper.get(".onboarding-page").trigger("animationend");
    expect(wrapper.classes()).not.toContain("onboarding-page--entering");
  });

  it("keeps the startup placeholder free of the application shell", () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    expect(wrapper.find(".app-header").exists()).toBe(false);
    expect(wrapper.find(".console-shell").exists()).toBe(false);
  });

  it("shows only the startup placeholder while the environment is ready", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.find(".onboarding-logo").exists()).toBe(true);
    expect(wrapper.get(".onboarding-status").text()).toBe("应用启动中");
    expect(wrapper.find('[data-test="repair-environment"]').exists()).toBe(false);
    expect(wrapper.find(".service-panel").exists()).toBe(false);
  });

  it("shows the repair button when the environment is incomplete", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "incomplete",
      service_running: false,
      port: null,
    });
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="repair-environment"]').text()).toContain("安装/修复环境");
    expect(wrapper.get(".onboarding-status").text()).toBe("应用启动中");
  });

  it("starts bootstrap from the repair button", async () => {
    const { consoleBootstrap } = await import("../../ipc/commands");
    const bootstrapCommand = vi.mocked(consoleBootstrap);
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "not_installed",
      service_running: false,
      port: null,
    });
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();
    await wrapper.get('[data-test="repair-environment"]').trigger("click");

    expect(bootstrapCommand).toHaveBeenCalledTimes(1);
  });

  it("starts the service after a successful bootstrap reaches a ready environment", async () => {
    const { consoleStartService, consoleOpenWebui } = await import("../../ipc/commands");
    const start = vi.mocked(consoleStartService);
    const open = vi.mocked(consoleOpenWebui);
    start.mockResolvedValue(8899);
    mocks.consoleStatus
      .mockResolvedValueOnce({ env: "not_installed", service_running: false, port: null })
      .mockResolvedValue({ env: "ready", service_running: false, port: null });

    mount(OnboardingPage, { global: { plugins: [router] } });
    await flushPromises();
    await mocks.bootstrapExitHandler?.(0);
    await flushPromises();

    expect(start).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(8899);
  });

  it("keeps the onboarding error visible when bootstrap fails", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });
    await flushPromises();

    await mocks.bootstrapExitHandler?.(1);
    await flushPromises();

    expect(wrapper.get("#err").text()).toContain("依赖安装失败");
    expect(wrapper.get('[data-test="repair-environment"]').text()).toContain("安装/修复环境");
  });
});
