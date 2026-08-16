import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia } from "pinia";
import App from "../App.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<p>first page</p>" } },
    { path: "/next", component: { template: "<p>next page</p>" } },
    { path: "/wide-console", component: { template: '<main class="console-page" />' } },
    { path: "/login-facade", component: { template: '<main class="login-page" />' } },
  ],
});

beforeEach(async () => {
  await router.push("/");
  await router.isReady();
});

afterEach(() => {
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
  it("removes the pre-rendered rail after the Vue rail is mounted", () => {
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

  it("keeps the rail outside the cross-document transition content", () => {
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

  it("expands the console route to the full shell content area", async () => {
    await router.push("/wide-console");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();

    const content = wrapper.get('[data-test="shell-content"]');
    const page = wrapper.find(".console-page");
    expect(page.exists()).toBe(true);
    expect(content.element.contains(page.element)).toBe(true);
  });

  it("keeps the login facade out of the centered console layout", async () => {
    await router.push("/login-facade");
    const wrapper = mountAppAtDocumentRoot();
    await flushPromises();

    const content = wrapper.get('[data-test="shell-content"]');
    const page = wrapper.find(".login-page");
    expect(page.exists()).toBe(true);
    expect(content.element.contains(page.element)).toBe(true);
  });
});
