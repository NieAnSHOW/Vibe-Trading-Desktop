import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "./stores/auth";

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

// 未登录（auth.authenticated !== true）一律跳 /login；登录后 /login 跳回 /。
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.path === "/login") {
    if (auth.authenticated) return "/";
    return true;
  }
  if (!auth.authenticated) return "/login";
  return true;
});
