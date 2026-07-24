import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

const mocks = vi.hoisted(() => ({
  consoleAuthStatus: vi.fn(async () => ({
    authenticated: true,
    userInfo: null,
    expireAt: 9999999999,
  })),
  unlisten: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleAuthStatus: mocks.consoleAuthStatus,
  consoleStatus: vi.fn(async () => ({
    env: "ready",
    service_running: false,
    port: null,
  })),
  consoleBootstrap: vi.fn(),
  consoleOpenWebui: vi.fn(),
  consoleOpenLogs: vi.fn(),
  consoleClearLogs: vi.fn(),
  consoleQuit: vi.fn(),
  consoleClearVenv: vi.fn(),
  consoleLogout: vi.fn(),
  consoleFetchAds: vi.fn(async () => []),
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
  onBootstrapExit: vi.fn(async () => mocks.unlisten),
  onServiceStarted: vi.fn(async () => mocks.unlisten),
  onQuitRequested: vi.fn(async () => mocks.unlisten),
  onChanneldepProgress: vi.fn(async () => mocks.unlisten),
  onChanneldepExit: vi.fn(async () => mocks.unlisten),
  onUpdateProgress: vi.fn(async () => mocks.unlisten),
}));

import App from "../../App.vue";
import ConsolePage from "../ConsolePage.vue";
import LoginPage from "../LoginPage.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: ConsolePage },
    { path: "/login", component: LoginPage },
  ],
});

beforeEach(async () => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  await router.push("/");
  await router.isReady();
});

describe("ConsolePage", () => {
  it("displays a login success message passed by the login page", async () => {
    await router.push({ path: "/", query: { loginMessage: "欢迎回来" } });
    const wrapper = mount(ConsolePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[role="status"]').text()).toBe("欢迎回来");
  });

  it("keeps a token-only restored session on the login page after clicking login", async () => {
    const wrapper = mount(App, { global: { plugins: [router] } });

    await flushPromises();

    const loginButton = wrapper.findAll("button").find((button) => button.text() === "登录");
    await loginButton?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
    expect(wrapper.find(".login-wrap").exists()).toBe(true);
  });
});
