import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

const mocks = vi.hoisted(() => ({
  consoleAuthStatus: vi.fn(),
  consoleMemberBenefits: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleAuthStatus: mocks.consoleAuthStatus,
  consoleLogout: vi.fn(),
  consoleMemberBenefits: mocks.consoleMemberBenefits,
}));

import ProfilePage from "../ProfilePage.vue";
import { useAuthStore } from "../../stores/auth";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>environment</div>" } },
    { path: "/login", component: { template: "<div>login</div>" } },
    { path: "/profile", component: ProfilePage },
  ],
});

beforeEach(async () => {
  setActivePinia(createPinia());
  mocks.consoleAuthStatus.mockResolvedValue({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  });
  mocks.consoleMemberBenefits.mockResolvedValue({ benefits: [] });
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
    mocks.consoleAuthStatus.mockResolvedValueOnce({
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
});
