import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/login", component: () => import("./pages/LoginPage.vue") },
  { path: "/", component: () => import("./pages/ConsolePage.vue") },
  { path: "/channels", component: () => import("./pages/ChannelsPage.vue") },
  { path: "/settings", component: () => import("./pages/SettingsPage.vue") },
  { path: "/monitor", component: () => import("./pages/MonitorPage.vue") },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
