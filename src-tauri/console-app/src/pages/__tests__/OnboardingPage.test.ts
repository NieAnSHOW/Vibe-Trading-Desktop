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

    await wrapper.get(".onboarding-page__shell").trigger("animationend");
    expect(wrapper.classes()).not.toContain("onboarding-page--entering");
  });

  it("keeps the application header outside the content shell", () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    const header = wrapper.get(".app-header").element;
    const shell = wrapper.get(".console-shell").element;

    expect(shell.contains(header)).toBe(false);
  });

  it("keeps the local service workspace full width while signed out", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get(".console-workspace").classes()).toContain("console-workspace--guest");
    expect(wrapper.find(".member-panel").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("登录使用会员服务");
    expect(wrapper.find('[data-test="settings-entry"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="primary-service-action"]').text()).toBe("启动研究服务");
  });

  it("shows the workbench action when the environment reports a running service", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="primary-service-action"]').text()).toContain("进入研究工作台");
  });

  it("consolidates every service action into one operation bar without an inline log viewer", async () => {
    const wrapper = mount(OnboardingPage, { global: { plugins: [router] } });

    await flushPromises();

    const operationBars = wrapper.findAll('[aria-label="服务操作"]');
    expect(operationBars).toHaveLength(1);
    expect(operationBars[0].classes()).toContain("operation-bar");

    const servicePanel = wrapper.get(".service-panel");
    expect(servicePanel.findAll("button").every((button) => operationBars[0].element.contains(button.element))).toBe(true);
    expect(operationBars[0].find('[data-test="primary-service-action"]').exists()).toBe(true);
    expect(wrapper.find('[role="log"]').exists()).toBe(false);
    expect(wrapper.find("#log").exists()).toBe(false);
    expect(wrapper.find(".operations-footer").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("清空");
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
    expect(wrapper.get('[data-test="primary-service-action"]').text()).toContain("安装或修复依赖");
  });
});
