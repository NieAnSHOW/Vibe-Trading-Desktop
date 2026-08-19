import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

const mocks = vi.hoisted(() => ({
  consoleAuthStatus: vi.fn(),
  consoleMemberUsage: vi.fn(),
  consoleMemberBenefits: vi.fn(),
  consoleLogout: vi.fn(),
  consoleCustomLlmReadiness: vi.fn(),
  consoleLogoutToCustom: vi.fn(),
  consoleStartService: vi.fn(),
  consoleStopService: vi.fn(),
  consoleOpenWebui: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleAuthStatus: mocks.consoleAuthStatus,
  consoleMemberUsage: mocks.consoleMemberUsage,
  consoleLogout: mocks.consoleLogout,
  consoleCustomLlmReadiness: mocks.consoleCustomLlmReadiness,
  consoleLogoutToCustom: mocks.consoleLogoutToCustom,
  consoleStartService: mocks.consoleStartService,
  consoleStopService: mocks.consoleStopService,
  consoleOpenWebui: mocks.consoleOpenWebui,
  consoleMemberBenefits: mocks.consoleMemberBenefits,
}));

import ProfilePage from "../ProfilePage.vue";
import { useAuthStore } from "../../stores/auth";
import { useEnvStore } from "../../stores/env";
import { config } from "../../config/prod";
import ConfirmDialog from "../../components/ConfirmDialog.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>environment</div>" } },
    { path: "/login", component: { template: "<div>login</div>" } },
    { path: "/profile", component: ProfilePage },
  ],
});

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() { this.open = false; },
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.consoleAuthStatus.mockResolvedValue({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  });
  mocks.consoleMemberBenefits.mockResolvedValue({ benefits: [] });
  mocks.consoleMemberUsage.mockResolvedValue({
    total_available: 98025508,
    total_granted: 113514188,
    total_used: 15488680,
    unlimited_quota: false,
  });
  mocks.consoleLogout.mockResolvedValue(undefined);
  mocks.consoleCustomLlmReadiness.mockResolvedValue({ customConfigured: false });
  mocks.consoleLogoutToCustom.mockResolvedValue({ customConfigured: false });
  mocks.consoleStartService.mockResolvedValue(8899);
  mocks.consoleStopService.mockResolvedValue(undefined);
  mocks.consoleOpenWebui.mockResolvedValue(undefined);
  config.kefuQrCode = "";
  config.rewardQrCode = "";
  await router.push("/profile");
  await router.isReady();
});

describe("ProfilePage", () => {
  it("sends a signed-out account visit to the login page", async () => {
    mount(ProfilePage, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("clears an expired session and returns to the login page", async () => {
    mocks.consoleAuthStatus.mockResolvedValue({
      authenticated: true,
      userInfo: {
        id: 1,
        nickName: "Tester",
        gender: 0,
        status: 1,
        loginType: 2,
      },
      expireAt: 9999999999,
    });
    mocks.consoleMemberBenefits.mockRejectedValueOnce({ variant: "LoginExpired" });
    mount(ProfilePage, { global: { plugins: [router] } });
    await flushPromises();

    expect(useAuthStore().authenticated).toBe(false);
    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("renders member usage and refreshes it manually", async () => {
    mocks.consoleAuthStatus.mockResolvedValue({
      authenticated: true,
      userInfo: {
        id: 1,
        nickName: "Tester",
        gender: 0,
        status: 1,
        loginType: 2,
        memberLevel: { id: 3, name: "Pro", code: "pro", levelValue: 20 },
      },
      expireAt: 9999999999,
    });
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();

    const usageSection = wrapper.get('[data-test="member-usage-section"]');
    expect(usageSection.text()).toContain("98,025,508积分可用");
    expect(usageSection.get('[role="progressbar"]').attributes("aria-label")).toBe("剩余研究额度");
    expect(wrapper.text()).toContain("总额度 113,514,188");
    expect(wrapper.text()).toContain("已使用 15,488,680");

    await wrapper.get('[data-test="member-usage-refresh"]').trigger("click");
    await flushPromises();
    expect(mocks.consoleMemberUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps the research quota panel stable with a loading skeleton", async () => {
    mocks.consoleAuthStatus.mockResolvedValue({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
      expireAt: 9999999999,
    });
    mocks.consoleMemberUsage.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();

    const usageSection = wrapper.get('[data-test="member-usage-section"]');
    expect(usageSection.get('[data-test="member-usage-skeleton"]').attributes("aria-busy")).toBe("true");
    expect(usageSection.find(".pf-state").exists()).toBe(false);
  });

  it("groups account context, research quota, and membership capabilities", async () => {
    mocks.consoleAuthStatus.mockResolvedValue({
      authenticated: true,
      userInfo: {
        id: 1,
        nickName: "Tester",
        gender: 0,
        status: 1,
        loginType: 2,
        memberLevel: { id: 3, name: "Pro", code: "pro", levelValue: 20 },
      },
      expireAt: 9999999999,
    });
    mocks.consoleMemberBenefits.mockResolvedValue({
      benefits: [{ id: "models", title: "高级模型访问", description: "可使用会员模型进行研究" }],
    });
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="profile-workspace"]').classes()).toContain("pf-workspace");
    expect(wrapper.get(".tw-kicker").text()).toBe("Membership");
    expect(wrapper.get('[data-test="member-usage-section"]').text()).toContain("研究额度");
    expect(wrapper.get('[data-test="member-capabilities"]').text()).toContain("会员能力");
    expect(wrapper.text()).toContain("用于会员支持的研究与模型能力");
  });

  it("restarts a running service when membership changes are acknowledged", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1 },
      expireAt: 9999999999,
      membershipChanged: true,
    });
    const env = useEnvStore();
    env.serviceRunning = true;
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();

    await wrapper.get('[data-test="membership-refresh-service"]').trigger("click");
    const restartDialog = wrapper.findAllComponents(ConfirmDialog)
      .find((dialog) => dialog.attributes("data-test") === "membership-restart-dialog");
    expect(restartDialog).toBeDefined();
    restartDialog?.vm.$emit("close", "ok");
    await flushPromises();

    expect(mocks.consoleStopService).toHaveBeenCalledTimes(1);
    expect(mocks.consoleStartService).toHaveBeenCalledTimes(1);
    expect(mocks.consoleMemberUsage).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-test="membership-refresh-service"]').exists()).toBe(false);
  });

  it("shows configured support and reward actions on the profile", async () => {
    config.kefuQrCode = "/kefu-qr.png";
    config.rewardQrCode = "/reward-qr.png";
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1 },
      expireAt: 9999999999,
    });
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();

    expect(wrapper.get('[data-test="member-kefu-entry"]').text()).toContain("联系客服");
    expect(wrapper.get('[data-test="member-reward-entry"]').text()).toContain("支持作者");
  });

  it("uses ready copy and logs out without restarting the service", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1 },
      expireAt: 9999999999,
    });
    mocks.consoleCustomLlmReadiness.mockResolvedValueOnce({ customConfigured: true });
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();
    await wrapper.get('[data-test="logout-action"]').trigger("click");
    await flushPromises();

    const dialog = wrapper.get('[data-test="logout-dialog"]');
    expect(dialog.text()).toContain("退出后，正在运行的会员任务将继续完成；后续任务将使用本机自定义模型配置。");
    wrapper.findAllComponents(ConfirmDialog)
      .find((dialog) => dialog.attributes("data-test") === "logout-dialog")
      ?.vm.$emit("close", "ok");
    await flushPromises();

    expect(mocks.consoleLogoutToCustom).toHaveBeenCalledTimes(1);
    expect(useAuthStore().authenticated).toBe(false);
    expect(router.currentRoute.value.path).toBe("/login");
    expect(mocks.consoleStopService).not.toHaveBeenCalled();
    expect(mocks.consoleStartService).not.toHaveBeenCalled();
    expect(mocks.consoleOpenWebui).not.toHaveBeenCalled();
  });

  it("uses not-ready copy when custom readiness is unavailable", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1 },
      expireAt: 9999999999,
    });
    mocks.consoleCustomLlmReadiness.mockRejectedValueOnce(new Error("readiness failed"));
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();
    await wrapper.get('[data-test="logout-action"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="logout-dialog"]').text()).toContain(
      "退出后，正在运行的会员任务将继续完成；后续任务需要先配置本机自定义模型，否则无法执行。",
    );
  });

  it("keeps auth and shows an error when coordinated logout fails", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1 },
      expireAt: 9999999999,
    });
    mocks.consoleCustomLlmReadiness.mockResolvedValueOnce({ customConfigured: true });
    mocks.consoleLogoutToCustom.mockRejectedValueOnce(new Error("runtime switch failed"));
    const wrapper = mount(ProfilePage, { global: { plugins: [router] } });

    await flushPromises();
    await wrapper.get('[data-test="logout-action"]').trigger("click");
    await flushPromises();
    wrapper.findAllComponents(ConfirmDialog)
      .find((dialog) => dialog.attributes("data-test") === "logout-dialog")
      ?.vm.$emit("close", "ok");
    await flushPromises();

    expect(useAuthStore().authenticated).toBe(true);
    expect(router.currentRoute.value.path).toBe("/profile");
    expect(wrapper.get('[role="alert"]').text()).toContain("runtime switch failed");
  });
});
