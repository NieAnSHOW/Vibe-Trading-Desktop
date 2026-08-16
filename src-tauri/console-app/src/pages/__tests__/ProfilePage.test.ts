import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

const mocks = vi.hoisted(() => ({
  consoleAuthStatus: vi.fn(),
  consoleMemberUsage: vi.fn(),
  consoleMemberBenefits: vi.fn(),
  consoleLogout: vi.fn(),
  consoleStartService: vi.fn(),
  consoleStopService: vi.fn(),
  consoleOpenWebui: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleAuthStatus: mocks.consoleAuthStatus,
  consoleMemberUsage: mocks.consoleMemberUsage,
  consoleLogout: mocks.consoleLogout,
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
    expect(usageSection.text()).toContain("98,025,508积分");
    expect(usageSection.get('[role="progressbar"]').attributes("aria-label")).toBe("剩余额度");
    expect(wrapper.text()).toContain("总量 113,514,188");
    expect(wrapper.text()).toContain("已用 15,488,680");

    await wrapper.get('[data-test="member-usage-refresh"]').trigger("click");
    await flushPromises();
    expect(mocks.consoleMemberUsage).toHaveBeenCalledTimes(2);
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
});
