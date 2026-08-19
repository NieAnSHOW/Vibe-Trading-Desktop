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
    api_auth_key: "",
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
import { useEnvStore } from "../stores/env";
import {
  consoleAuthStatus,
  consoleGetSettings,
  consoleOpenWebui,
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

function getRailButton(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll("button").find((candidate) => candidate.text().trim() === label);
  if (!button) throw new Error(`Rail button not found: ${label}`);
  return button;
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
  vi.stubGlobal("matchMedia", vi.fn((query: string) =>
    query === "(prefers-reduced-motion: reduce)" ? { matches: false } : mq,
  ));
  currentMq = mq;
  return mq;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  setActivePinia(createPinia());
  vi.mocked(consoleAuthStatus).mockResolvedValue({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  });
  vi.mocked(consoleOpenWebui).mockResolvedValue(true);
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

describe("Rail research navigation", () => {
  it("keeps Research active without triggering another WebUI navigation while its frame is visible", async () => {
    const wrapper = mount(Rail, {
      props: { webuiActive: true },
      global: { plugins: [router] },
    });
    await flushPromises();

    const research = getRailButton(wrapper, "研究");
    expect(research.classes()).toContain("rail__item--active");
    expect(research.attributes("disabled")).toBeDefined();

    await research.trigger("click");
    expect(consoleOpenWebui).not.toHaveBeenCalled();
  });

  it("renders no Environment navigation item", async () => {
    const wrapper = await mountRail();

    expect(wrapper.get(".rail").text()).not.toContain("环境");
    expect(wrapper.findAll("button").some((button) => button.text().trim() === "环境")).toBe(false);
  });

  it("returns to the onboarding page when the service is stopped", async () => {
    const wrapper = await mountRail();

    await getRailButton(wrapper, "研究").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/");
    expect(consoleOpenWebui).not.toHaveBeenCalled();
  });

  it("plays the shell exit transition before opening the WebUI", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = await mountRail();
      const envStore = useEnvStore();
      envStore.serviceRunning = true;
      envStore.setPort(8899);

      const click = getRailButton(wrapper, "研究").trigger("click");

      expect(consoleOpenWebui).not.toHaveBeenCalled();
      expect(document.documentElement.classList.contains("desktop-shell-leaving")).toBe(true);
      await wrapper.vm.$nextTick();
      expect(getRailButton(wrapper, "账户").attributes("disabled")).toBeDefined();
      expect(getRailButton(wrapper, "研究").attributes("disabled")).toBeDefined();
      expect(getRailButton(wrapper, "设置").attributes("disabled")).toBeDefined();
      await vi.advanceTimersByTimeAsync(220);
      await click;
      expect(consoleOpenWebui).toHaveBeenCalledWith(8899);
    } finally {
      vi.useRealTimers();
      document.documentElement.classList.remove("desktop-shell-leaving");
    }
  });

  it("restores the console when WebUI falls back to the system browser", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(consoleOpenWebui).mockResolvedValueOnce(false);
      const wrapper = await mountRail();
      const envStore = useEnvStore();
      envStore.serviceRunning = true;
      envStore.setPort(8899);

      const click = getRailButton(wrapper, "研究").trigger("click");
      await vi.advanceTimersByTimeAsync(220);
      await click;

      expect(document.documentElement.classList.contains("desktop-shell-leaving")).toBe(false);
    } finally {
      vi.useRealTimers();
      document.documentElement.classList.remove("desktop-shell-leaving");
    }
  });
});

describe("Rail theme", () => {
  it("defaults to the system theme and reflects it on <html>", async () => {
    await mountRail();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("uses the transferred theme before asynchronously loading settings", () => {
    installMatchMedia(false);
    window.history.replaceState(null, "", "?theme=dark&theme_color=blue#/settings");
    let resolveSettings: (() => void) | undefined;
    vi.mocked(consoleGetSettings).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSettings = () => resolve({
          autostart_service: false,
          theme_mode: "dark",
          theme_color: "blue",
            api_auth_key: "",
        });
      }),
    );

    const wrapper = mount(Rail, { global: { plugins: [router] } });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.brand).toBe("blue");
    resolveSettings?.();
    wrapper.unmount();
  });

  it("follows system theme changes while in system mode", async () => {
    await mountRail();
    const onThemeMode = vi.fn();
    window.addEventListener("vibe:theme-mode", onThemeMode);

    currentMq!.setDark(false);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(onThemeMode).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "system" }),
    );
    window.removeEventListener("vibe:theme-mode", onThemeMode);
  });

  it("applies the persisted explicit theme mode", async () => {
    vi.mocked(consoleGetSettings).mockResolvedValueOnce({
      autostart_service: false,
      theme_mode: "light",
      theme_color: "teal",
        api_auth_key: "",
    });
    await mountRail();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggles light/dark from the rail and persists the explicit choice", async () => {
    const wrapper = await mountRail();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(wrapper.get(".rail__bottom").get('[data-test="theme-toggle"]')).toBeTruthy();

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
        api_auth_key: "",
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
