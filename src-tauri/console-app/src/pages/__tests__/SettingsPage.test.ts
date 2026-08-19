import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import type { EnvironmentReport, LLMSettings, DataSourceSettings } from "../../ipc/types";

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
