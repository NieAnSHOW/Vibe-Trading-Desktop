import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { AuthStatusView, StatusReport } from "../../ipc/types";

const mocks = vi.hoisted(() => ({
  consoleStatus: vi.fn(async (): Promise<StatusReport> => ({
    env: "ready" as const,
    service_running: false,
    port: null,
  })),
  consoleAuthStatus: vi.fn(async (): Promise<AuthStatusView> => ({
    authenticated: true,
    userInfo: null,
    expireAt: 9999999999,
  })),
  consoleMemberUsage: vi.fn(async () => ({
    total_available: 98025508,
    total_granted: 113514188,
    total_used: 15488680,
    unlimited_quota: false,
  })),
  unlisten: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleAuthStatus: mocks.consoleAuthStatus,
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
  consoleMemberUsage: mocks.consoleMemberUsage,
}));

vi.mock("../../ipc/events", () => ({
  onBootstrapEvent: vi.fn(async () => mocks.unlisten),
  onBootstrapExit: vi.fn(async () => mocks.unlisten),
  onServiceStarted: vi.fn(async () => mocks.unlisten),
  onQuitRequested: vi.fn(async () => mocks.unlisten),
  onChanneldepProgress: vi.fn(async () => mocks.unlisten),
  onChanneldepExit: vi.fn(async () => mocks.unlisten),
  onUpdateProgress: vi.fn(async () => mocks.unlisten),
}));

import ConsolePage from "../ConsolePage.vue";
import LoginPage from "../LoginPage.vue";

const EmptyRoute = { template: "<div />" };

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: ConsolePage },
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
  setActivePinia(createPinia());
  await router.push("/");
  await router.isReady();
});

describe("ConsolePage", () => {
  it("marks the console page ready after mounting", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await nextTick();
    expect(wrapper.classes()).toContain("console-page--ready");
  });

  it("keeps the page in its startup state until the content animation ends", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await nextTick();
    expect(wrapper.classes()).toContain("console-page--entering");

    await wrapper.get(".console-page__shell").trigger("animationend");
    expect(wrapper.classes()).not.toContain("console-page--entering");
  });

  it("keeps the application header outside the content shell", () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    const header = wrapper.get(".app-header").element;
    const shell = wrapper.get(".console-shell").element;

    expect(shell.contains(header)).toBe(false);
  });

  it("displays a restored login notice passed by the login page", async () => {
    await router.push({ path: "/", query: { loginMessage: "欢迎回来" } });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="login-notice"]').attributes("role")).toBe("status");
    expect(wrapper.get('[data-test="login-notice"]').text()).toBe("欢迎回来");
  });

  it("keeps the local service workspace full width while signed out", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: false,
      userInfo: null,
      expireAt: null,
    });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get(".console-workspace").classes()).toContain("console-workspace--guest");
    expect(wrapper.find(".member-panel").exists()).toBe(false);
    expect(wrapper.text()).toContain("登录使用会员服务");
    expect(wrapper.get('[data-test="primary-service-action"]').text()).toBe("启动研究服务");
  });

  it("shows the workbench action when the environment reports a running service", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="primary-service-action"]').text()).toContain("进入研究工作台");
  });

  it("consolidates every service action into one operation bar without an inline log viewer", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

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

  it("shows a remembered token-only session as logged in", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.text()).toContain("已登录");
    expect(wrapper.get('[data-test="account-profile-entry"]').attributes("aria-label")).toContain("个人中心");
    await wrapper.get('[data-test="account-profile-entry"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/profile");
    expect(wrapper.findAll("button").some((button) => button.text() === "退出登录")).toBe(false);
  });

  it("opens settings from the application header", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="settings-entry"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/settings");
  });

  it("shows the membership level returned with the authenticated profile", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: {
        id: 1,
        nickName: "Tester",
        gender: 0,
        status: 1,
        loginType: 2,
        memberLevel: {
          id: 3,
          name: "Pro",
          code: "pro",
          levelValue: 20,
          expireTime: "2026-12-31 23:59:59",
        },
      },
      expireAt: 9999999999,
    });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.text()).toContain("Pro 会员");
    expect(wrapper.text()).toContain("有效期至 2026-12-31 23:59:59");
    expect(wrapper.get(".member-tier").classes()).toContain("member-tier--pro");
  });

  it("renders member usage and refreshes it manually", async () => {
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get(".member-panel").text()).toContain("98,025,508积分");
    const usageSection = wrapper.get('[data-test="member-usage-section"]');
    expect(usageSection.text()).toContain("剩余用量");
    expect(usageSection.text()).toContain("98,025,508积分");
    expect(usageSection.get('[role="progressbar"]').attributes("aria-label")).toBe("剩余额度");
    expect(wrapper.text()).toContain("总量 113,514,188");
    expect(wrapper.text()).toContain("已用 15,488,680");
    await wrapper.get('[data-test="member-usage-refresh"]').trigger("click");
    await flushPromises();
    expect(mocks.consoleMemberUsage).toHaveBeenCalledTimes(2);
  });

  it("renders an unlimited badge instead of usage amounts for unlimited quotas", async () => {
    mocks.consoleMemberUsage.mockResolvedValueOnce({
      total_available: 98025508,
      total_granted: 113514188,
      total_used: 15488680,
      unlimited_quota: true,
    });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="member-usage-unlimited"]').text()).toBe("不限量");
    expect(wrapper.get('[data-test="member-usage-unlimited-note"]').text()).toBe("当前套餐权益");
    expect(wrapper.text()).not.toContain("剩余 98,025,508");
    expect(wrapper.text()).not.toContain("总量 113,514,188");
    expect(wrapper.text()).not.toContain("已用 15,488,680");
    expect(wrapper.get('[data-test="member-usage-section"]').find('[role="progressbar"]').exists()).toBe(false);
  });

  it("keeps usage refresh available after the initial request fails", async () => {
    mocks.consoleMemberUsage.mockRejectedValueOnce(new Error("offline"));
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    await wrapper.get('[data-test="member-usage-refresh"]').trigger("click");
    await flushPromises();
    expect(mocks.consoleMemberUsage).toHaveBeenCalledTimes(2);
  });

  it("clears member usage when the usage request reports an expired login", async () => {
    mocks.consoleMemberUsage.mockRejectedValueOnce({ variant: "LoginExpired" });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.find('[data-test="member-usage-refresh"]').exists()).toBe(false);
  });

  it("shows the kefu entry with a QR code dialog when kefuQrCode is configured", async () => {
    const { config } = await import("../../config/prod");
    config.kefuQrCode = "/kefu-qr.png";
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="member-kefu-entry"]').text()).toContain("联系客服");
    await wrapper.get('[data-test="member-kefu-entry"]').trigger("click");
    await nextTick();

    const dialog = wrapper.get('[data-test="kefu-dialog"]');
    expect(dialog.attributes("open")).toBeDefined();
    expect(dialog.get("img").attributes("src")).toBe("http://127.0.0.1:8001/kefu-qr.png");
    expect(dialog.get("img").attributes("alt")).toBe("客服微信二维码");
  });

  it("hides the kefu entry when no kefu QR code is configured", async () => {
    const { config } = await import("../../config/prod");
    config.kefuQrCode = "";
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.find('[data-test="member-kefu-entry"]').exists()).toBe(false);
  });
});
