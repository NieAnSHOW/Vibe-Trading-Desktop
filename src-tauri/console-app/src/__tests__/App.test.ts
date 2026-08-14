import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia } from "pinia";
import App from "../App.vue";
import AppSource from "../App.vue?raw";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<p>first page</p>" } },
    { path: "/next", component: { template: "<p>next page</p>" } },
  ],
});

beforeEach(async () => {
  await router.push("/");
  await router.isReady();
});

describe("App", () => {
  it("clips only the visual overflow produced by route transitions", () => {
    expect(AppSource).toContain("#app:has(> .page-enter-active),");
    expect(AppSource).toContain("#app:has(> .page-leave-active),");
    expect(AppSource).toContain("#app:has(> .console-page--entering) {");
    expect(AppSource).toContain("overflow: clip;");
  });

  it("renders routed pages through the named out-in page transition", async () => {
    const wrapper = mount(App, {
      global: {
        // App 壳含 Rail(账户/环境/研究/设置),其 env store 需要 pinia。
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
});
