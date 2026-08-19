import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia } from "pinia";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import App from "../App.vue";
import consoleDocument from "../../index.html?raw";

const consoleStyles = readFileSync(
  resolve(process.cwd(), "src/styles/console.css"),
  "utf8",
);
const appSource = readFileSync(resolve(process.cwd(), "src/App.vue"), "utf8");
const settingsPageSource = readFileSync(
  resolve(process.cwd(), "src/pages/SettingsPage.vue"),
  "utf8",
);

let openListener: ((url: string) => void) | undefined;
let closeListener: (() => void) | undefined;
vi.mock("../ipc/events", () => ({
  onWebuiOpen: vi.fn(async (callback: (url: string) => void) => {
    openListener = callback;
    return vi.fn();
  }),
  onWebuiClose: vi.fn(async (callback: () => void) => {
    closeListener = callback;
    return vi.fn();
  }),
}));
vi.mock("../ipc/commands", () => ({
  consoleTakePendingWebui: vi.fn(async () => null),
  consoleOpenExternalUrl: vi.fn(async () => undefined),
}));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: '<main class="onboarding-page"><p>first page</p></main>' } },
    { path: "/next", component: { template: "<p>next page</p>" } },
    { path: "/login", component: { template: '<main class="login-page" />' } },
  ],
});

beforeEach(async () => {
  await router.push("/");
  await router.isReady();
});

afterEach(() => {
  openListener = undefined;
  closeListener = undefined;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.brand;
  document.getElementById("app")?.remove();
  document.getElementById("console-rail-bootstrap")?.remove();
});

function mountAppAtDocumentRoot() {
  const appRoot = document.createElement("div");
  appRoot.id = "app";
  document.body.append(appRoot);
  return mount(App, {
    attachTo: appRoot,
    global: { plugins: [router, createPinia()] },
  });
}

describe("App", () => {
  it("ships a pre-rendered navigation rail without an Environment item", () => {
    expect(consoleDocument).toContain("console-rail-bootstrap");
    expect(consoleDocument).toContain('data-console-rail="research"');
    expect(consoleDocument).not.toContain("环境");
  });

  it("keeps login and transition styles aligned with the console surface wrapper", () => {
    // 正则容忍格式化工具对长选择器的折行
    expect(consoleStyles).toMatch(
      /body:has\(\s*> #app > \.shell-content > \[data-test="console-surface"\] > \.login-page\s*\)/,
    );
    expect(appSource).toContain(
      '.shell-content:has(> [data-test="console-surface"] > .page-enter-active)',
    );
  });

  it("uses a Rail-aware document canvas for console content", () => {
    expect(consoleStyles).toContain(".shell-content--rail");
    expect(consoleStyles).toContain("margin-left: var(--rail-width);");
    expect(consoleStyles).toContain("min-height: 100dvh;");
  });

  it("keeps Rail-aware console content inside the document viewport when a vertical scrollbar is present", () => {
    const railShell = consoleStyles.match(/\.shell-content--rail\s*\{[^}]*\}/)?.[0] ?? "";

    expect(railShell).toContain("margin-left: var(--rail-width);");
    expect(railShell).not.toContain("width:");
  });

  it("keeps native console page roots fluid inside the Rail-aware canvas", () => {
    expect(consoleStyles.match(/\.console\s*\{[^}]*\}/)?.[0]).toContain("width: 100%;");
    expect(consoleStyles.match(/\.profile\s*\{[^}]*\}/)?.[0]).toContain("width: 100%;");
    expect(settingsPageSource.match(/\.settings\s*\{[^}]*\}/)?.[0]).toContain("width: 100%;");
  });

  it("floats rail-aware console surfaces as rounded panels on the canvas", () => {
    const panel = consoleStyles.match(
      /\.shell-content--rail:not\(\.shell-content--standalone\)\s*>\s*\[data-test="console-surface"\]\s*\{[^}]*\}/,
    )?.[0] ?? "";

    expect(panel).toContain("border-radius:");
    expect(panel).toContain("background:");
    // 登录/引导等 standalone 门面不套面板
    expect(consoleStyles).not.toContain(
      '.shell-content--standalone:not(.shell-content--rail) > [data-test="console-surface"]',
    );
  });

  it("removes the pre-rendered rail after the Vue app is mounted", () => {
    const bootstrap = document.createElement("aside");
    bootstrap.id = "console-rail-bootstrap";
    document.body.append(bootstrap);

    mount(App, {
      global: { plugins: [router, createPinia()] },
    });

    expect(document.getElementById("console-rail-bootstrap")).toBeNull();
  });

  it("keeps route transitions inside the shell content", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [router, createPinia()],
        stubs: {
          Transition: {
            props: ["name", "mode"],
            template: '<section data-test="route-transition"><slot /></section>',
          },
        },
      },
    });

    expect(wrapper.get('[data-test="shell-content"]').find("transition-stub").exists()).toBe(true);
  });

  it("renders routed pages through the named out-in page transition", async () => {
    const wrapper = mount(App, {
      global: {
        // App 壳含 Rail(账户/研究/设置),其 env store 需要 pinia。
        plugins: [router, createPinia()],
        stubs: {
          Transition: {
            props: ["name", "mode"],
            template: '<section data-test="route-transition" :data-name="name" :data-mode="mode"><slot /></section>',
          },
        },
      },
    });

    expect(wrapper.get("transition-stub").attributes("name")).toBe("page");
    expect(wrapper.get("transition-stub").attributes("mode")).toBe("out-in");
    expect(wrapper.text()).toContain("first page");

    await router.push("/next");
    await flushPromises();

    expect(wrapper.text()).toContain("next page");
  });

  it("keeps the rail outside the cross-document transition content", async () => {
    await router.push("/next");
    const wrapper = mount(App, {
      global: {
        plugins: [router, createPinia()],
      },
    });

    const content = wrapper.find('[data-test="shell-content"]');
    const rail = wrapper.find(".rail");

    expect(content.exists()).toBe(true);
    expect(content.element.contains(rail.element)).toBe(false);
  });

  it("renders the startup onboarding route without the application rail", () => {
    const wrapper = mount(App, {
      global: {
        plugins: [router, createPinia()],
      },
    });

    expect(wrapper.find(".rail").exists()).toBe(false);
    const content = wrapper.get('[data-test="shell-content"]');
    const page = wrapper.find(".onboarding-page");
    expect(content.classes()).toContain("shell-content--onboarding");
    expect(content.classes()).not.toContain("shell-content--rail");
    expect(page.exists()).toBe(true);
    expect(content.element.contains(page.element)).toBe(true);
  });

  it("renders the login page as an independent startup surface", async () => {
    await router.push("/login");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();

    const content = wrapper.get('[data-test="shell-content"]');
    const page = wrapper.find(".login-page");
    expect(page.exists()).toBe(true);
    expect(wrapper.find(".rail").exists()).toBe(false);
    expect(content.classes()).toContain("shell-content--standalone");
    expect(content.classes()).not.toContain("shell-content--rail");
    expect(content.element.contains(page.element)).toBe(true);
  });

  it("adds the rail class when WebUI opens from a standalone route", async () => {
    await router.push("/login");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();

    const content = wrapper.get('[data-test="shell-content"]');
    expect(content.classes()).toContain("shell-content--standalone");
    expect(content.classes()).not.toContain("shell-content--rail");

    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    expect(content.classes()).toContain("shell-content--rail");
  });

  it("keeps the console document mounted while the WebUI frame is shown and hidden", async () => {
    vi.useFakeTimers();
    try {
      await router.push("/next");
      const wrapper = mountAppAtDocumentRoot();
      await flushPromises();

      openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
      await flushPromises();

      const frame = wrapper.get('iframe[data-test="desktop-webui-frame"]');
      expect(frame.attributes("src")).toContain("shell=frame");
      expect(wrapper.find(".rail").exists()).toBe(true);
      expect(wrapper.get('[data-test="shell-content"]').classes()).toContain("shell-content--rail");
      expect(wrapper.get('[data-test="console-surface"]').isVisible()).toBe(false);

      closeListener?.();
      await flushPromises();
      expect(wrapper.get('[data-test="console-surface"]').isVisible()).toBe(false);

      await vi.advanceTimersByTimeAsync(220);
      expect(wrapper.find('iframe[data-test="desktop-webui-frame"]').exists()).toBe(true);
      expect(wrapper.get('[data-test="console-surface"]').isVisible()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the WebUI frame outside the transitioning console surface", async () => {
    await router.push("/next");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();

    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    const frame = wrapper.get('iframe[data-test="desktop-webui-frame"]');
    const surface = wrapper.get('[data-test="shell-content"]');
    expect(surface.element.contains(frame.element)).toBe(false);
  });

  it("marks non-standalone routes as rail-aware", async () => {
    await router.push("/next");
    const wrapper = mount(App, { global: { plugins: [router, createPinia()] } });

    expect(wrapper.get('[data-test="shell-content"]').classes()).toContain("shell-content--rail");
  });

  it("ignores a stale close animation when research is reopened", async () => {
    vi.useFakeTimers();
    try {
      await router.push("/next");
      const wrapper = mountAppAtDocumentRoot();
      await flushPromises();
      const url = "http://127.0.0.1:8899/?desktop=1&shell=frame";

      openListener?.(url);
      await flushPromises();
      closeListener?.();
      await flushPromises();
      openListener?.(url);
      await flushPromises();

      await vi.advanceTimersByTimeAsync(220);
      expect(wrapper.get('[data-test="console-surface"]').isVisible()).toBe(false);
      expect(wrapper.get('iframe[data-test="desktop-webui-frame"]').isVisible()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards console theme changes to the retained WebUI frame", async () => {
    await router.push("/next");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();
    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    const frame = wrapper.get('iframe[data-test="desktop-webui-frame"]');
    const postMessage = vi.spyOn((frame.element as HTMLIFrameElement).contentWindow!, "postMessage");
    window.dispatchEvent(new CustomEvent("vibe:theme-mode", { detail: "dark" }));
    window.dispatchEvent(new CustomEvent("vibe:theme-color", { detail: "blue" }));

    expect(postMessage).toHaveBeenCalledWith(
      { type: "vibe-shell:theme", dark: true, color: "blue" },
      "http://127.0.0.1:8899",
    );
  });

  it("opens external URLs requested by the retained WebUI frame", async () => {
    const { consoleOpenExternalUrl } = await import("../ipc/commands");
    vi.mocked(consoleOpenExternalUrl).mockClear();
    await router.push("/next");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();
    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    const frame = wrapper.get('iframe[data-test="desktop-webui-frame"]');
    window.dispatchEvent(
      new MessageEvent("message", {
        source: (frame.element as HTMLIFrameElement).contentWindow,
        data: { type: "vibe-shell:open-external", url: "https://www.10jqka.com.cn/" },
      }),
    );
    await flushPromises();

    expect(consoleOpenExternalUrl).toHaveBeenCalledWith("https://www.10jqka.com.cn/");
  });

  it("ignores external-open requests from sources other than the WebUI frame", async () => {
    const { consoleOpenExternalUrl } = await import("../ipc/commands");
    vi.mocked(consoleOpenExternalUrl).mockClear();
    await router.push("/next");
    mountAppAtDocumentRoot();
    await flushPromises();
    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "vibe-shell:open-external", url: "https://www.10jqka.com.cn/" },
      }),
    );
    await flushPromises();

    expect(consoleOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("rejects non-web URLs requested by the WebUI frame", async () => {
    const { consoleOpenExternalUrl } = await import("../ipc/commands");
    vi.mocked(consoleOpenExternalUrl).mockClear();
    await router.push("/next");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();
    openListener?.("http://127.0.0.1:8899/?desktop=1&shell=frame");
    await flushPromises();

    const frame = wrapper.get('iframe[data-test="desktop-webui-frame"]');
    window.dispatchEvent(
      new MessageEvent("message", {
        source: (frame.element as HTMLIFrameElement).contentWindow,
        data: { type: "vibe-shell:open-external", url: "file:///etc/passwd" },
      }),
    );
    await flushPromises();

    expect(consoleOpenExternalUrl).not.toHaveBeenCalled();
  });
});
