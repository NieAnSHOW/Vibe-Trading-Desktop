import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

// hash history: Tauri 加载本地文件,无服务端路由。
const routes: RouteRecordRaw[] = [
  { path: "/", component: () => import("./pages/ConsolePage.vue") },
  { path: "/channels", component: () => import("./pages/ChannelsPage.vue") },
  { path: "/settings", component: () => import("./pages/SettingsPage.vue") },
  { path: "/monitor", component: () => import("./pages/MonitorPage.vue") },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
