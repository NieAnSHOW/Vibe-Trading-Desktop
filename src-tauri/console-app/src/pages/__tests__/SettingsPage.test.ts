import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import type {
  EnvironmentReport,
  LLMSettings,
  DataSourceSettings,
  ChannelRuntimeStatus,
} from "../../ipc/types";

// 与组件交互语义一致的 LLM / 数据源 fixture(custom 模式,单提供商)
const fakeLlm: LLMSettings = {
  provider: "openrouter",
  model_name: "qwen/max",
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
  api_key_configured: true,
  api_key_hint: null,
  api_key_required: true,
  temperature: 0.2,
  timeout_seconds: 120,
  max_retries: 2,
  reasoning_effort: "medium",
  sse_timeout_seconds: 300,
  env_path: "/home/u/.vibe-trading/runtime/agent/.env",
  providers: [
    {
      name: "openrouter",
      label: "OpenRouter",
      api_key_env: "OPENROUTER_API_KEY",
      base_url_env: "LLM_BASE_URL",
      default_model: "qwen/max",
      default_base_url: "https://openrouter.ai/api/v1",
      api_key_required: true,
      auth_type: "api_key",
      login_command: null,
    },
  ],
  desktop_login_provisioned: false,
  desktop_llm_mode: "custom",
  desktop_vip_available: true,
};

const fakeDataSource: DataSourceSettings = {
  tushare_token_configured: false,
  tushare_token_hint: null,
  baostock_supported: true,
  baostock_installed: true,
  baostock_message: "loader ok",
  env_path: "/home/u/.vibe-trading/runtime/agent/.env",
};

const mocks = vi.hoisted(() => ({
  consoleGetSettings: vi.fn<() => Promise<{
    theme_mode: "system" | "light" | "dark";
    theme_color: "teal" | "blue" | "purple" | "pink" | "orange" | "green";
    api_auth_key: string;
  }>>(async () => ({
    theme_mode: "system" as const,
    theme_color: "teal" as const,
    api_auth_key: "",
  })),
  consoleSetThemeMode: vi.fn(async () => undefined),
  consoleSetThemeColor: vi.fn(async () => undefined),
  consoleSetApiAuthKey: vi.fn(async () => undefined),
  consoleGetLlmSettings: vi.fn(),
  consoleSetLlmSettings: vi.fn(),
  consoleGetDataSourceSettings: vi.fn(),
  consoleSetDataSourceSettings: vi.fn(),
  consoleStatus: vi.fn(async () => ({
    env: "ready" as const,
    service_running: false,
    port: null as number | null,
  })),
  consoleOpenLogs: vi.fn(),
  consoleClearLogs: vi.fn(async () => 2),
  consoleClearVenv: vi.fn(async () => undefined),
  consoleUninstallLegacyApp: vi.fn(async () => undefined),
  consoleStopService: vi.fn(async () => undefined),
  consoleCheckEnvironment: vi.fn(async (): Promise<EnvironmentReport> => ({
    env: "ready",
    installedVersion: "1.0.0",
    bundleVersion: "1.0.0",
    depsOk: true,
    runtimeOk: true,
  })),
  consoleRepairEnvironment: vi.fn(async () => undefined),
  consoleChannelsStatus: vi.fn(),
  consoleStartChannels: vi.fn(),
  consoleStopChannels: vi.fn(),
  consoleRunPairingCommand: vi.fn(),
  consoleWeixinLoginStart: vi.fn(),
  consoleWeixinLoginStatus: vi.fn(),
  consoleOpenExternalUrl: vi.fn(async () => undefined),
}));

vi.mock("../../ipc/commands", () => ({
  consoleGetSettings: mocks.consoleGetSettings,
  consoleSetThemeMode: mocks.consoleSetThemeMode,
  consoleSetThemeColor: mocks.consoleSetThemeColor,
  consoleSetApiAuthKey: mocks.consoleSetApiAuthKey,
  consoleGetLlmSettings: mocks.consoleGetLlmSettings,
  consoleSetLlmSettings: mocks.consoleSetLlmSettings,
  consoleGetDataSourceSettings: mocks.consoleGetDataSourceSettings,
  consoleSetDataSourceSettings: mocks.consoleSetDataSourceSettings,
  consoleStatus: mocks.consoleStatus,
  consoleOpenLogs: mocks.consoleOpenLogs,
  consoleClearLogs: mocks.consoleClearLogs,
  consoleClearVenv: mocks.consoleClearVenv,
  consoleUninstallLegacyApp: mocks.consoleUninstallLegacyApp,
  consoleStopService: mocks.consoleStopService,
  consoleCheckEnvironment: mocks.consoleCheckEnvironment,
  consoleRepairEnvironment: mocks.consoleRepairEnvironment,
  consoleChannelsStatus: mocks.consoleChannelsStatus,
  consoleStartChannels: mocks.consoleStartChannels,
  consoleStopChannels: mocks.consoleStopChannels,
  consoleRunPairingCommand: mocks.consoleRunPairingCommand,
  consoleWeixinLoginStart: mocks.consoleWeixinLoginStart,
  consoleWeixinLoginStatus: mocks.consoleWeixinLoginStatus,
  consoleOpenExternalUrl: mocks.consoleOpenExternalUrl,
}));

import SettingsPage from "../SettingsPage.vue";
import { useAuthStore } from "../../stores/auth";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div />" } },
    { path: "/login", component: { template: "<div>login</div>" } },
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

describe("SettingsPage", () => {
  it("hides startup behavior while keeping maintenance controls available", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(mocks.consoleGetSettings).toHaveBeenCalledOnce();
    expect(wrapper.find('[aria-label="启动行为"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="维护"]')).toBeTruthy();
    expect(wrapper.get('[data-test="check-environment-action"]')).toBeTruthy();
    expect(wrapper.text()).toContain("v0.");
  });

  it("renders the maintenance actions migrated from the console", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('[data-test="clear-environment-action"]').text()).toBe("清理");
    expect(wrapper.get('[data-test="open-logs-action"]').text()).toBe("打开");
    expect(wrapper.get('[data-test="clear-logs-action"]').text()).toBe("清理");
    expect(wrapper.get('[data-test="uninstall-legacy-action"]').text()).toBe("卸载老版本");
    expect(wrapper.get('[data-test="check-environment-action"]').text()).toBe("检查");
  });

  it("saves the local API access key migrated from the WebUI settings", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    // 已配置的密钥回填输入框
    mocks.consoleGetSettings.mockResolvedValueOnce({
      theme_mode: "light" as const,
      theme_color: "teal" as const,
      api_auth_key: "sk-legacy",
    });
    const withKey = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();
    expect((withKey.get('[data-test="api-key-input"]').element as HTMLInputElement).value).toBe(
      "sk-legacy",
    );

    await wrapper.get('[data-test="api-key-input"]').setValue("sk-new");
    await wrapper.get('[data-test="save-api-key-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleSetApiAuthKey).toHaveBeenCalledWith("sk-new");
    expect(wrapper.text()).toContain("本地 API 密钥已保存");
  });

  it("shows LLM / data source service hints and skips loading when the service is off", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('[data-test="llm-service-hint"]').text()).toContain("服务未运行");
    expect(wrapper.get('[data-test="datasource-service-hint"]').text()).toContain("服务未运行");
    expect(mocks.consoleGetLlmSettings).not.toHaveBeenCalled();
    expect(mocks.consoleGetDataSourceSettings).not.toHaveBeenCalled();
  });

  it("loads and saves LLM settings through the backend proxy", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleGetLlmSettings.mockResolvedValueOnce(fakeLlm);
    mocks.consoleGetDataSourceSettings.mockResolvedValueOnce(fakeDataSource);
    mocks.consoleSetLlmSettings.mockResolvedValueOnce(fakeLlm);
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(mocks.consoleGetLlmSettings).toHaveBeenCalledWith(8899);
    expect(
      (wrapper.get('[data-test="llm-model-input"]').element as HTMLInputElement).value,
    ).toBe("qwen/max");
    expect(wrapper.text()).toContain(fakeLlm.env_path);

    await wrapper.get('[data-test="llm-model-input"]').setValue("qwen/plus");
    await wrapper.get('[data-test="save-llm-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleSetLlmSettings).toHaveBeenCalledWith(8899, {
      mode: "custom",
      provider: "openrouter",
      model_name: "qwen/plus",
      base_url: "https://openrouter.ai/api/v1",
      api_key: undefined,
      clear_api_key: false,
    });
    expect(wrapper.text()).toContain("LLM 设置已保存");
  });

  it("switches to VIP mode through the backend proxy", async () => {
    useAuthStore().setFromLogin({
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
      expireAt: 9999999999,
    });
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleGetLlmSettings.mockResolvedValueOnce(fakeLlm);
    mocks.consoleGetDataSourceSettings.mockResolvedValueOnce(fakeDataSource);
    mocks.consoleSetLlmSettings.mockResolvedValueOnce({
      ...fakeLlm,
      desktop_llm_mode: "vip" as const,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="llm-mode"] button[data-mode="vip"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleSetLlmSettings).toHaveBeenCalledWith(8899, { mode: "vip" });
    expect(wrapper.get('[data-test="vip-status"]').text()).toContain("VIP 服务可用");
  });

  it("redirects unauthenticated users to login before switching to VIP", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleGetLlmSettings.mockResolvedValueOnce(fakeLlm);
    mocks.consoleGetDataSourceSettings.mockResolvedValueOnce(fakeDataSource);
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="llm-mode"] button[data-mode="vip"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
    expect(mocks.consoleSetLlmSettings).not.toHaveBeenCalled();
  });

  it("saves data source settings through the backend proxy", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleGetLlmSettings.mockResolvedValueOnce(fakeLlm);
    mocks.consoleGetDataSourceSettings.mockResolvedValueOnce(fakeDataSource);
    mocks.consoleSetDataSourceSettings.mockResolvedValueOnce({
      ...fakeDataSource,
      tushare_token_configured: true,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("BaoStock");
    expect(wrapper.text()).toContain("loader ok");

    await wrapper.get('[data-test="tushare-token-input"]').setValue("tok-1");
    await wrapper.get('[data-test="save-datasource-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleSetDataSourceSettings).toHaveBeenCalledWith(8899, {
      tushare_token: "tok-1",
      clear_tushare_token: false,
    });
    expect(wrapper.text()).toContain("数据源设置已保存");
  });

  it("reports a healthy environment after checking", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="check-environment-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleCheckEnvironment).toHaveBeenCalledOnce();
    expect(wrapper.get(".env-badge").text()).toBe("正常");
    expect(wrapper.text()).toContain("依赖完整");
    expect(wrapper.text()).toContain("运行时代码已是最新");
    expect(wrapper.find('[data-test="repair-environment-action"]').exists()).toBe(false);
  });

  it("shows repair when dependencies or runtime are outdated, then repairs", async () => {
    mocks.consoleCheckEnvironment
      .mockResolvedValueOnce({
        env: "incomplete",
        installedVersion: "1.0.0",
        bundleVersion: "1.1.0",
        depsOk: false,
        runtimeOk: false,
      })
      .mockResolvedValueOnce({
        env: "ready",
        installedVersion: "1.1.0",
        bundleVersion: "1.1.0",
        depsOk: true,
        runtimeOk: true,
      });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="check-environment-action"]').trigger("click");
    await flushPromises();

    expect(wrapper.get(".env-badge").text()).toBe("异常");
    expect(wrapper.text()).toContain("依赖不完整");
    expect(wrapper.text()).toContain("运行时代码版本落后");

    await wrapper.get('[data-test="repair-environment-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleRepairEnvironment).toHaveBeenCalledOnce();
    // 修复后复查显示正常
    expect(wrapper.get(".env-badge").text()).toBe("正常");
    expect(wrapper.text()).toContain("环境检查通过");
    expect(wrapper.find('[data-test="repair-environment-action"]').exists()).toBe(false);
  });

  it("stops a running service before repairing the environment", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready" as const,
      service_running: true,
      port: 4173,
    });
    mocks.consoleCheckEnvironment.mockResolvedValueOnce({
      env: "ready" as const,
      installedVersion: "1.0.0",
      bundleVersion: "1.1.0",
      depsOk: true,
      runtimeOk: false,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="check-environment-action"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-test="repair-environment-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleStopService).toHaveBeenCalledOnce();
    expect(mocks.consoleRepairEnvironment).toHaveBeenCalledOnce();
    expect(mocks.consoleStopService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consoleRepairEnvironment.mock.invocationCallOrder[0],
    );
  });

  it("renders an environment check error", async () => {
    mocks.consoleCheckEnvironment.mockRejectedValueOnce(new Error("bundle missing"));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="check-environment-action"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("bundle missing");
  });

  it("uninstalls the legacy app only after confirmation and stops the service first", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready" as const,
      service_running: true,
      port: 4173,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="uninstall-legacy-action"]').trigger("click");
    expect(mocks.consoleUninstallLegacyApp).not.toHaveBeenCalled();

    const dialog = wrapper.findAll("dialog").find(
      (candidate) => candidate.find("h3").text().includes("Vibe Trading"),
    );
    expect(dialog).toBeDefined();
    (dialog!.element as HTMLDialogElement).returnValue = "ok";
    await dialog!.trigger("close");
    await flushPromises();

    expect(mocks.consoleStopService).toHaveBeenCalledOnce();
    expect(mocks.consoleUninstallLegacyApp).toHaveBeenCalledOnce();
    expect(mocks.consoleStopService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consoleUninstallLegacyApp.mock.invocationCallOrder[0],
    );
    expect(wrapper.text()).toContain("用户数据");
  });

  it("renders a legacy uninstall error", async () => {
    mocks.consoleUninstallLegacyApp.mockRejectedValueOnce(new Error("legacy app missing"));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="uninstall-legacy-action"]').trigger("click");
    const dialog = wrapper.findAll("dialog").find(
      (candidate) => candidate.find("h3").text().includes("Vibe Trading"),
    );
    expect(dialog).toBeDefined();
    (dialog!.element as HTMLDialogElement).returnValue = "ok";
    await dialog!.trigger("close");
    await flushPromises();

    expect(wrapper.text()).toContain("legacy app missing");
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
    expect(wrapper.get(".settings-notice").text()).toBe("运行环境和过时代码已清理，请重新安装依赖");
  });

  it("asks to stop the running service before clearing the environment", async () => {
    mocks.consoleStatus.mockResolvedValue({
      env: "ready" as const,
      service_running: true,
      port: 4173,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="clear-environment-action"]').trigger("click");
    await flushPromises();
    const dialog = wrapper.findAll("dialog").find(
      (candidate) => candidate.find("h3").text() === "服务正在运行，确认停止后清理？",
    );
    expect(dialog).toBeDefined();
    expect(dialog!.text()).toContain("停止当前服务");

    (dialog!.element as HTMLDialogElement).returnValue = "ok";
    await dialog!.trigger("close");
    await flushPromises();

    expect(mocks.consoleStopService).toHaveBeenCalledOnce();
    expect(mocks.consoleClearVenv).toHaveBeenCalledOnce();
    expect(mocks.consoleStopService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consoleClearVenv.mock.invocationCallOrder[0],
    );
  });
});

// 消息渠道 fixture:runtime 停止,微信渠道启用/加载/未运行;
// 附带 telegram 证明桌面端与 WebUI 同口径——仅微信露出。
function channelStatusFixture(overrides: Partial<ChannelRuntimeStatus> = {}): ChannelRuntimeStatus {
  return {
    running: false,
    inbound_queue: 0,
    outbound_queue: 0,
    session_count: 0,
    channels: {
      weixin: {
        name: "weixin",
        display_name: "微信",
        configured: true,
        enabled: true,
        available: true,
        loaded: true,
        running: false,
        health: "ok",
        error: "",
        install_hint: "",
      },
      telegram: {
        name: "telegram",
        display_name: "Telegram",
        configured: false,
        enabled: false,
        available: true,
        loaded: false,
        running: false,
        error: "",
        install_hint: "",
      },
    },
    ...overrides,
  };
}

describe("SettingsPage channels (migrated from WebUI settings)", () => {
  function mockServiceRunning() {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready" as const,
      service_running: true,
      port: 8899,
    });
    mocks.consoleGetLlmSettings.mockResolvedValueOnce(fakeLlm);
    mocks.consoleGetDataSourceSettings.mockResolvedValueOnce(fakeDataSource);
  }

  it("shows the channels service hint and skips loading when the service is off", async () => {
    // 上一个用例以 mockResolvedValue(持久)设定过 service_running=true,
    // clearAllMocks 不清除实现,这里用 Once 覆盖本次挂载的刷新。
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready" as const,
      service_running: false,
      port: null,
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('[data-test="channels-service-hint"]').text()).toContain("服务未运行");
    expect(mocks.consoleChannelsStatus).not.toHaveBeenCalled();
  });

  it("renders the weixin channel runtime status and hides other channels", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValueOnce(JSON.stringify(channelStatusFixture()));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(mocks.consoleChannelsStatus).toHaveBeenCalledWith(8899);
    const panel = wrapper.get('[data-test="channels-panel"]');
    expect(panel.text()).toContain("微信");
    expect(panel.text()).toContain("已启用");
    expect(panel.text()).toContain("已加载");
    expect(panel.text()).toContain("已停止");
    expect(panel.text()).not.toContain("Telegram");
    // 扫码登录入口在微信行可用
    expect(panel.find('[data-test="weixin-scan-login-action"]').exists()).toBe(true);
  });

  it("flags login-expired when health=expired despite the poll loop running", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValueOnce(
      JSON.stringify(
        channelStatusFixture({
          running: true,
          channels: {
            weixin: {
              ...channelStatusFixture().channels.weixin,
              running: true,
              health: "expired",
            },
          },
        }),
      ),
    );
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    const panel = wrapper.get('[data-test="channels-panel"]');
    expect(panel.text()).toContain("登录失效 · 需重新扫码");
    expect(panel.find('[data-test="weixin-scan-login-action"]').exists()).toBe(true);
  });

  it("starts and stops channels through the backend proxy", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValue(JSON.stringify(channelStatusFixture()));
    mocks.consoleStartChannels.mockResolvedValueOnce(
      JSON.stringify(channelStatusFixture({ running: true })),
    );
    mocks.consoleStopChannels.mockResolvedValueOnce(JSON.stringify(channelStatusFixture()));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="channels-start-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleStartChannels).toHaveBeenCalledWith(8899);
    expect(wrapper.get('[data-test="channels-notice"]').text()).toBe("IM 通道已启动");
    expect(wrapper.get('[data-test="channels-panel"]').text()).toContain("运行中");

    await wrapper.get('[data-test="channels-stop-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleStopChannels).toHaveBeenCalledWith(8899);
    expect(wrapper.get('[data-test="channels-notice"]').text()).toBe("IM 通道已停止");
  });

  it("refreshes the channel status from the control surface", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValue(JSON.stringify(channelStatusFixture()));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="channels-refresh-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleChannelsStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps start/stop disabled when the channel status is unknown", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockRejectedValueOnce(
      new Error("Expected JSON from /channels/status, got text/html"),
    );
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('[data-test="channels-error"]').text()).toContain("加载消息渠道状态失败");
    expect(
      (wrapper.get('[data-test="channels-start-action"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (wrapper.get('[data-test="channels-stop-action"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    // 刷新仍可用:状态未知只是不盲目启停
    expect(
      (wrapper.get('[data-test="channels-refresh-action"]').element as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("runs pairing approval commands through the backend proxy", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValueOnce(JSON.stringify(channelStatusFixture()));
    mocks.consoleRunPairingCommand.mockResolvedValueOnce(
      JSON.stringify({ channel: "weixin", reply: "approved UM59-EGIT" }),
    );
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="pairing-command-input"]').setValue("approve UM59-EGIT");
    await wrapper.get('[data-test="pairing-form"]').trigger("submit");
    await flushPromises();

    expect(mocks.consoleRunPairingCommand).toHaveBeenCalledWith(8899, {
      channel: "weixin",
      command: "approve UM59-EGIT",
    });
    expect(wrapper.get('[data-test="channels-notice"]').text()).toContain("approved UM59-EGIT");
    expect(
      (wrapper.get('[data-test="pairing-command-input"]').element as HTMLInputElement).value,
    ).toBe("");
  });

  it("renders a pairing command error from the backend proxy", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValueOnce(JSON.stringify(channelStatusFixture()));
    mocks.consoleRunPairingCommand.mockRejectedValueOnce(new Error("unknown pairing code"));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="pairing-command-input"]').setValue("approve NOPE");
    await wrapper.get('[data-test="pairing-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-test="channels-error"]').text()).toContain("unknown pairing code");
  });

  it("shows the login QR code in-app instead of opening a browser", async () => {
    mockServiceRunning();
    mocks.consoleChannelsStatus.mockResolvedValue(JSON.stringify(channelStatusFixture()));
    mocks.consoleWeixinLoginStart.mockResolvedValueOnce(
      JSON.stringify({ login_id: "qid-1", qr_image: "https://open.weixin.example/qr" }),
    );
    mocks.consoleWeixinLoginStatus.mockResolvedValue(JSON.stringify({ status: "wait" }));
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get('[data-test="weixin-scan-login-action"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleWeixinLoginStart).toHaveBeenCalledWith(8899);
    // 二维码直接渲染在应用内,不再自动拉起系统浏览器
    expect(mocks.consoleOpenExternalUrl).not.toHaveBeenCalled();
    const qrImg = wrapper.get('[data-test="weixin-login-qr"]');
    expect(
      (qrImg.element as HTMLImageElement).src.startsWith("data:image/svg+xml"),
    ).toBe(true);
    // 浏览器打开降级为弹窗内的手动链接
    expect(wrapper.find('[data-test="weixin-open-external"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="weixin-login-modal"]').text()).toContain("微信扫码登录");

    await wrapper.get('[data-test="weixin-login-cancel"]').trigger("click");
    expect(wrapper.find('[data-test="weixin-login-modal"]').exists()).toBe(false);
  });

  it("closes the modal and refreshes status when the login is confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockServiceRunning();
      mocks.consoleChannelsStatus.mockResolvedValue(JSON.stringify(channelStatusFixture()));
      mocks.consoleWeixinLoginStart.mockResolvedValueOnce(
        JSON.stringify({ login_id: "qid-1", qr_image: "https://open.weixin.example/qr" }),
      );
      mocks.consoleWeixinLoginStatus.mockResolvedValue(JSON.stringify({ status: "confirmed" }));
      const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
      await flushPromises();

      await wrapper.get('[data-test="weixin-scan-login-action"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-test="weixin-login-modal"]').text()).toContain("微信扫码登录");

      // 越过一个 2s 轮询周期:confirmed 关闭弹窗并刷新状态
      await vi.advanceTimersByTimeAsync(2500);
      await flushPromises();

      expect(wrapper.find('[data-test="weixin-login-modal"]').exists()).toBe(false);
      expect(wrapper.get('[data-test="channels-notice"]').text()).toBe("微信登录成功");
      // 挂载 1 次 + 确认后刷新 ≥1 次
      expect(mocks.consoleChannelsStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an expired QR code and keeps the panel usable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockServiceRunning();
      mocks.consoleChannelsStatus.mockResolvedValue(JSON.stringify(channelStatusFixture()));
      mocks.consoleWeixinLoginStart.mockResolvedValueOnce(
        JSON.stringify({ login_id: "qid-1", qr_image: "https://open.weixin.example/qr" }),
      );
      mocks.consoleWeixinLoginStatus.mockResolvedValue(JSON.stringify({ status: "expired" }));
      const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
      await flushPromises();

      await wrapper.get('[data-test="weixin-scan-login-action"]').trigger("click");
      await flushPromises();
      await vi.advanceTimersByTimeAsync(2500);
      await flushPromises();

      expect(wrapper.find('[data-test="weixin-login-modal"]').exists()).toBe(false);
      expect(wrapper.get('[data-test="channels-error"]').text()).toContain("二维码已过期");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingsPage appearance", () => {
  it("defaults the theme mode to light and shows all choices", async () => {
    mocks.consoleGetSettings.mockResolvedValueOnce({
      theme_mode: "light",
      theme_color: "teal",
      api_auth_key: "",
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    const modeButtons = wrapper.findAll('[data-test="theme-mode"] button');
    expect(modeButtons.map((b) => b.attributes("data-mode"))).toEqual([
      "system",
      "light",
      "dark",
    ]);
    expect(
      wrapper.get('[data-test="theme-mode"] button[data-mode="light"]').classes(),
    ).toContain("active");
    expect(wrapper.text()).toContain("跟随系统");
  });

  it("persists a selected theme mode and notifies the theme engine", async () => {
    const events: string[] = [];
    window.addEventListener("vibe:theme-mode", (e) => {
      events.push(String((e as CustomEvent).detail));
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper
      .get('[data-test="theme-mode"] button[data-mode="dark"]')
      .trigger("click");
    await flushPromises();

    expect(mocks.consoleSetThemeMode).toHaveBeenCalledWith("dark");
    expect(events).toEqual(["dark"]);
  });

  it("persists a selected theme color and notifies the theme engine", async () => {
    const events: string[] = [];
    window.addEventListener("vibe:theme-color", (e) => {
      events.push(String((e as CustomEvent).detail));
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper
      .get('[data-test="theme-color"] button[data-color="blue"]')
      .trigger("click");
    await flushPromises();

    expect(mocks.consoleSetThemeColor).toHaveBeenCalledWith("blue");
    expect(events).toEqual(["blue"]);
  });

  it("loads persisted theme preferences", async () => {
    mocks.consoleGetSettings.mockResolvedValueOnce({
      theme_mode: "light",
      theme_color: "green",
      api_auth_key: "",
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(
      wrapper
        .get('[data-test="theme-mode"] button[data-mode="light"]')
        .classes(),
    ).toContain("active");
    expect(
      wrapper
        .get('[data-test="theme-color"] button[data-color="green"]')
        .classes(),
    ).toContain("active");
  });

  it("keeps the selected mode in sync when the rail changes it", async () => {
    const wrapper = mount(SettingsPage, { global: { plugins: [router] } });
    await flushPromises();

    window.dispatchEvent(new CustomEvent("vibe:theme-mode", { detail: "dark" }));
    await flushPromises();

    expect(
      wrapper
        .get('[data-test="theme-mode"] button[data-mode="dark"]')
        .classes(),
    ).toContain("active");
  });
});
