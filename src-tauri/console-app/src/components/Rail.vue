<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { MonitorCog, Settings, Telescope, UserRound } from "@lucide/vue";
import { useEnvStore } from "../stores/env";
import { consoleOpenWebui } from "../ipc/commands";

/**
 * 桌面壳层级导航栏(账户/环境/研究/底部设置),与 WebUI 侧
 * DesktopShellRail 同构:控制台各页面渲染本 rail,「研究」经
 * console_open_webui 把主窗口导航进 WebUI;WebUI 侧的 rail 经
 * hash 路由返回对应页面。两侧共同构成常驻的层级导航。
 */
const route = useRoute();
const router = useRouter();
const envStore = useEnvStore();
const { port, serviceRunning } = storeToRefs(envStore);

// rail 挂载即刷新一次状态:从任意页面(如登录页)直达时也能感知服务态。
onMounted(() => {
  void envStore.refresh();
});

type RailKey = "account" | "environment" | "research" | "settings";

const activeKey = computed<RailKey | null>(() => {
  const p = route.path;
  if (p === "/login" || p === "/profile") return "account";
  if (p === "/settings") return "settings";
  return "environment"; // / 、/channels、/monitor 都归环境(运行时管理)
});

const researchReady = computed(() => serviceRunning.value && port.value != null);

async function openResearch() {
  if (researchReady.value && port.value != null) {
    await consoleOpenWebui(port.value);
  } else {
    // 服务未运行:进入环境页让用户启动,启动成功后自动进入研究。
    router.push("/");
  }
}
</script>

<template>
  <nav class="rail" aria-label="桌面导航">
    <button
      type="button"
      class="rail__item"
      :class="{ 'rail__item--active': activeKey === 'account' }"
      :aria-current="activeKey === 'account' ? 'page' : undefined"
      @click="router.push('/login')"
    >
      <UserRound class="rail__icon" aria-hidden="true" />
      <span class="rail__label">账户</span>
    </button>

    <button
      type="button"
      class="rail__item"
      :class="{ 'rail__item--active': activeKey === 'environment' }"
      :aria-current="activeKey === 'environment' ? 'page' : undefined"
      @click="router.push('/')"
    >
      <MonitorCog class="rail__icon" aria-hidden="true" />
      <span class="rail__label">环境</span>
    </button>

    <button
      type="button"
      class="rail__item"
      :title="researchReady ? '进入研究(WebUI)' : '服务未运行,点击前往环境页启动'"
      @click="openResearch"
    >
      <Telescope class="rail__icon" aria-hidden="true" />
      <span class="rail__label">研究</span>
    </button>

    <button
      type="button"
      class="rail__item rail__item--bottom"
      :class="{ 'rail__item--active': activeKey === 'settings' }"
      :aria-current="activeKey === 'settings' ? 'page' : undefined"
      @click="router.push('/settings')"
    >
      <Settings class="rail__icon" aria-hidden="true" />
      <span class="rail__label">设置</span>
    </button>
  </nav>
</template>

<style scoped>
.rail {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 68px;
  padding: 14px 0;
  background: hsl(var(--surface-1) / 0.92);
  border-right: 1px solid hsl(var(--line));
  backdrop-filter: blur(8px);
}

.rail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 56px;
  padding: 8px 2px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: hsl(var(--ink-dim));
  cursor: pointer;
  transition:
    background 160ms var(--ease),
    color 160ms var(--ease);
}

.rail__item:hover {
  background: hsl(var(--surface-2));
  color: hsl(var(--ink));
}

.rail__item:focus-visible {
  outline: 1px solid hsl(var(--brand));
  outline-offset: 1px;
}

.rail__item--active {
  background: hsl(var(--brand) / 0.16);
  color: hsl(var(--brand));
}

.rail__item--bottom {
  margin-top: auto;
}

.rail__icon {
  width: 20px;
  height: 20px;
}

.rail__label {
  font-size: 11px;
  line-height: 1.2;
}
</style>
