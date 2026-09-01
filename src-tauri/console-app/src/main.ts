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

// ── 诊断热键(人工测试用):Ctrl+Alt+D 导出交互失灵现场证据 ──────────
// 背景:WKWebView 下曾出现"关闭公告弹窗后整页不可点"。document 级键盘监听
// 不受 dialog inert 影响,页面"死"了也能触发。输出直接复制回调试会话。
window.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || !event.altKey || event.code !== "KeyD") return;
  const dialogs = [...document.querySelectorAll("dialog")].map((d) => ({
    cls: d.className,
    openAttr: d.hasAttribute("open"),
    openProp: d.open,
    display: getComputedStyle(d).display,
    opacity: getComputedStyle(d).opacity,
    pe: getComputedStyle(d).pointerEvents,
  }));
  const probes = [
    [0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.1], [0.5, 0.9],
  ].map(([x, y]) => {
    const el = document.elementFromPoint(innerWidth * x, innerHeight * y);
    return `${Math.round(x * 100)}%,${Math.round(y * 100)}% → ${el ? el.tagName + (el.id ? "#" + el.id : "") + "." + String(el.className).slice(0, 40) : "null"}`;
  });
  const overlays = [...document.querySelectorAll("body *")].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.position === "fixed" || cs.position === "absolute";
  }).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  }).map((el) => el.tagName + (el.id ? "#" + el.id : "") + "." + String(el.className).slice(0, 40));
  console.log("[diag] dialogs:", JSON.stringify(dialogs, null, 1));
  console.log("[diag] hit-probes:\n" + probes.join("\n"));
  console.log("[diag] fullscreen overlays:", overlays.length ? overlays : "none");
  console.log("[diag] html.cls:", document.documentElement.className, "body.cls:", document.body.className);
});

createApp(App).use(createPinia()).use(router).mount("#app");
