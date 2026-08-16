import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

vi.mock("../ipc/commands", () => ({
  consoleOpenWebui: vi.fn(),
  consoleGetSettings: vi.fn(async () => ({
    autostart_service: false,
    theme_mode: "system",
    theme_color: "teal",
  })),
  consoleSetThemeMode: vi.fn(async () => undefined),
  consoleAuthStatus: vi.fn(async () => ({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  })),
  consoleStatus: vi.fn(async () => ({
    env: "ready",
    port: null,
    service_running: false,
  })),
}));

import Rail from "../components/Rail.vue";
import { useAuthStore } from "../stores/auth";
import {
  consoleAuthStatus,
  consoleGetSettings,
  consoleSetThemeMode,
} from "../ipc/commands";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>environment</div>" } },
    { path: "/login", component: { template: "<div>login</div>" } },
    { path: "/profile", component: { template: "<div>profile</div>" } },
    { path: "/settings", component: { template: "<div>settings</div>" } },
  ],
});

async function mountRail(path = "/settings") {
  await router.push(path);
  await router.isReady();
  const wrapper = mount(Rail, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

let currentMq: ReturnType<typeof installMatchMedia> | null = null;

/** jsdom 没有 matchMedia;返回可控的 prefers-color-scheme 模拟。 */
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mq = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
      listeners.delete(cb);
    },
    setDark(v: boolean) {
      dark = v;
      listeners.forEach((cb) => cb({ matches: v }));
    },
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mq));
  currentMq = mq;
  return mq;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  vi.mocked(consoleAuthStatus).mockResolvedValue({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  });
  installMatchMedia(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  currentMq = null;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.brand;
});

describe("Rail account navigation", () => {
  it("opens the profile page for an authenticated user", async () => {
    useAuthStore().setFromLogin({
      userInfo: {
        id: 1,
        nickName: "Tester",
        gender: 0,
        status: 1,
        loginType: 2,
      },
      expireAt: 9999999999,
    });
    const wrapper = await mountRail();

    await wrapper.get(".rail__item").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/profile");
  });

  it("restores a remembered session before opening the profile page", async () => {
    vi.mocked(consoleAuthStatus).mockResolvedValueOnce({
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
    const wrapper = await mountRail();

    await wrapper.get(".rail__item").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/profile");
  });

  it("opens the login page for a signed-out user", async () => {
    const wrapper = await mountRail();

    await wrapper.get(".rail__item").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
  });
});

describe("Rail theme", () => {
  it("defaults to the system theme and reflects it on <html>", async () => {
    await mountRail();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows system theme changes while in system mode", async () => {
    await mountRail();

    currentMq!.setDark(false);

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies the persisted explicit theme mode", async () => {
    vi.mocked(consoleGetSettings).mockResolvedValueOnce({
      autostart_service: false,
      theme_mode: "light",
      theme_color: "teal",
    });
    await mountRail();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggles light/dark from the rail and persists the explicit choice", async () => {
    const wrapper = await mountRail();
    expect(document.documentElement.dataset.theme).toBe("dark");

    await wrapper.get('[data-test="theme-toggle"]').trigger("click");

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(consoleSetThemeMode).toHaveBeenCalledWith("light");

    await wrapper.get('[data-test="theme-toggle"]').trigger("click");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(consoleSetThemeMode).toHaveBeenLastCalledWith("dark");
  });

  it("keeps the current theme when persisting a rail toggle fails", async () => {
    vi.mocked(consoleSetThemeMode).mockRejectedValueOnce(new Error("settings unavailable"));
    const wrapper = await mountRail();
    const onThemeMode = vi.fn();
    window.addEventListener("vibe:theme-mode", onThemeMode);

    await wrapper.get('[data-test="theme-toggle"]').trigger("click");
    await flushPromises();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(onThemeMode).not.toHaveBeenCalled();
    window.removeEventListener("vibe:theme-mode", onThemeMode);
  });

  it("applies the persisted theme color to <html>", async () => {
    vi.mocked(consoleGetSettings).mockResolvedValueOnce({
      autostart_service: false,
      theme_mode: "system",
      theme_color: "blue",
    });
    await mountRail();

    expect(document.documentElement.dataset.brand).toBe("blue");
  });

  it("applies theme mode changes emitted by the settings page", async () => {
    await mountRail();

    window.dispatchEvent(
      new CustomEvent("vibe:theme-mode", { detail: "dark" }),
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(consoleSetThemeMode).not.toHaveBeenCalled();
  });

  it("applies theme color changes emitted by the settings page", async () => {
    await mountRail();

    window.dispatchEvent(
      new CustomEvent("vibe:theme-color", { detail: "green" }),
    );

    expect(document.documentElement.dataset.brand).toBe("green");
  });
});
