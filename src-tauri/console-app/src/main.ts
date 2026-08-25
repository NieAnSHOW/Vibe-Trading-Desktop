import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./styles/console.css";

// 桌面端禁用全局右键菜单(原生应用手感);capture 阶段先于任何元素级处理器,
// 库在内部节点上 stopPropagation 也不会漏。文本录入框(input/textarea/
// contenteditable)豁免,保留复制/粘贴等原生菜单。内嵌 WebUI 在 desktopShell.ts 侧自行抑制。
window.addEventListener(
  "contextmenu",
  (event) => {
    const target = event.target;
    const isTextEntry =
      target instanceof HTMLElement &&
      (target.closest("input, textarea") !== null || target.isContentEditable);
    if (!isTextEntry) event.preventDefault();
  },
  { capture: true },
);

createApp(App).use(createPinia()).use(router).mount("#app");
