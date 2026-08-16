<script lang="ts">
/**
 * 桌面控制台主题契约(Rail 持有主题引擎;SettingsPage 通过 window 事件驱动)。
 *
 * storage(~/.vibe-trading/settings.json,由 Tauri command 读写):
 *   theme_mode  — "system" | "light" | "dark"(缺省 "system",跟随系统)
 *   theme_color — 主题色 id(缺省 "teal",见 THEME_COLORS)
 *
 * events(控制台内部):
 *   window "vibe:theme-mode"  CustomEvent<ThemeMode>   — 设置页选择后广播
 *   window "vibe:theme-color" CustomEvent<ThemeColorId> — 设置页选择后广播
 *
 * DOM:<html data-theme="light|dark" data-brand=<id>>,配合本文件末尾非 scoped
 * 变量覆盖让亮/暗与主题色生效。
 *
 */
export type ThemeMode = "system" | "light" | "dark";
export type ThemeColorId =
  | "teal"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "green";

export const THEME_MODE_EVENT = "vibe:theme-mode";
export const THEME_COLOR_EVENT = "vibe:theme-color";

export interface ThemeColorOption {
  id: ThemeColorId;
  label: string;
  /** 与 console.css --brand 同构的 HSL 字符串,仅用于设置页色块展示。 */
  hsl: string;
}

export const THEME_COLORS: ThemeColorOption[] = [
  { id: "teal", label: "青绿", hsl: "175 72% 40%" },
  { id: "blue", label: "蓝", hsl: "217 76% 52%" },
  { id: "purple", label: "紫", hsl: "262 60% 55%" },
  { id: "pink", label: "粉", hsl: "330 70% 55%" },
  { id: "orange", label: "橙", hsl: "25 92% 52%" },
  { id: "green", label: "绿", hsl: "145 62% 40%" },
];

export const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { MonitorCog, Moon, Settings, Sun, Telescope, UserRound } from "@lucide/vue";
import { useAuthStore } from "../stores/auth";
import { useEnvStore } from "../stores/env";
import {
  consoleGetSettings,
  consoleOpenWebui,
  consoleSetThemeMode,
} from "../ipc/commands";

/**
 * 桌面壳层级导航栏(账户/环境/研究/底部设置),与 WebUI 侧
 * DesktopShellRail 同构:控制台各页面渲染本 rail,「研究」经
 * console_open_webui 把主窗口导航进 WebUI;WebUI 侧的 rail 经
 * hash 路由返回对应页面。两侧共同构成常驻的层级导航。
 */
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const envStore = useEnvStore();
const { port, serviceRunning } = storeToRefs(envStore);

// ── 主题引擎:默认跟随系统,设置页经 window 事件驱动本引擎生效 ──
const themeMode = ref<ThemeMode>("system");
const themeColor = ref<ThemeColorId>("teal");
const themeSaving = ref(false);
const researchOpening = ref(false);
const SHELL_PAGE_TRANSITION_MS = 220;

function transferredThemeMode(): ThemeMode | null {
  try {
    const mode = new URLSearchParams(window.location.search).get("theme");
    return mode === "system" || mode === "light" || mode === "dark" ? mode : null;
  } catch {
    return null;
  }
}

function transferredThemeColor(): ThemeColorId | null {
  try {
    const color = new URLSearchParams(window.location.search).get("theme_color");
    return THEME_COLORS.some((option) => option.id === color) ? (color as ThemeColorId) : null;
  } catch {
    return null;
  }
}

const initialThemeMode = transferredThemeMode();
const initialThemeColor = transferredThemeColor();
if (initialThemeMode) themeMode.value = initialThemeMode;
if (initialThemeColor) themeColor.value = initialThemeColor;

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const systemDark = ref(systemPrefersDark());

const effectiveTheme = computed<"light" | "dark">(() =>
  themeMode.value === "system"
    ? systemDark.value
      ? "dark"
      : "light"
    : themeMode.value,
);

const themeTitle = computed(() => {
  if (themeMode.value === "system") return "主题：跟随系统（点击切换深浅色）";
  return effectiveTheme.value === "dark" ? "主题：深色" : "主题：浅色";
});

function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme.value;
  document.documentElement.dataset.brand = themeColor.value;
}

function applyThemeMode(mode: ThemeMode) {
  themeMode.value = mode;
  applyTheme();
}

async function toggleTheme() {
  if (themeSaving.value) return;
  const mode: ThemeMode = effectiveTheme.value === "dark" ? "light" : "dark";
  themeSaving.value = true;
  try {
    await consoleSetThemeMode(mode);
    applyThemeMode(mode);
    window.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: mode }));
  } catch {
    // 持久化失败时保留原主题，避免 UI 与下次启动读取到的设置不一致。
  } finally {
    themeSaving.value = false;
  }
}

function onSystemSchemeChange(e?: MediaQueryListEvent) {
  if (e) systemDark.value = e.matches;
  if (themeMode.value === "system") applyTheme();
}

function onThemeModeEvent(e: Event) {
  const mode = (e as CustomEvent<ThemeMode>).detail;
  if (mode === "system" || mode === "light" || mode === "dark") {
    applyThemeMode(mode);
  }
}

function onThemeColorEvent(e: Event) {
  const color = (e as CustomEvent<ThemeColorId>).detail;
  if (THEME_COLORS.some((c) => c.id === color)) {
    themeColor.value = color;
    applyTheme();
  }
}

// rail 挂载即刷新一次状态:从任意页面(如登录页)直达时也能感知服务态。
onMounted(async () => {
  void envStore.refresh();
  applyTheme();
  try {
    const settings = await consoleGetSettings();
    if (!initialThemeMode && (settings.theme_mode === "system" || settings.theme_mode === "light" || settings.theme_mode === "dark")) {
      themeMode.value = settings.theme_mode;
    }
    if (!initialThemeColor && THEME_COLORS.some((color) => color.id === settings.theme_color)) {
      themeColor.value = settings.theme_color;
    }
    applyTheme();
  } catch {
    // 设置读取失败时保留系统默认主题。
  }
  window.addEventListener(THEME_MODE_EVENT, onThemeModeEvent);
  window.addEventListener(THEME_COLOR_EVENT, onThemeColorEvent);
  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", onSystemSchemeChange);
  }
});

onUnmounted(() => {
  window.removeEventListener(THEME_MODE_EVENT, onThemeModeEvent);
  window.removeEventListener(THEME_COLOR_EVENT, onThemeColorEvent);
  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .removeEventListener("change", onSystemSchemeChange);
  }
});

type RailKey = "account" | "environment" | "research" | "settings";

const activeKey = computed<RailKey | null>(() => {
  const p = route.path;
  if (p === "/login" || p === "/profile") return "account";
  if (p === "/settings") return "settings";
  return "environment"; // / 、/channels、/monitor 都归环境(运行时管理)
});

const researchReady = computed(() => serviceRunning.value && port.value != null);

async function openAccount() {
  if (!authStore.authenticated) await authStore.refresh();
  return router.push(authStore.authenticated ? "/profile" : "/login");
}

async function openResearch() {
  if (researchReady.value && port.value != null) {
    if (researchOpening.value) return;
    researchOpening.value = true;
    const transitionMs = prefersReducedMotion() ? 0 : SHELL_PAGE_TRANSITION_MS;
    if (transitionMs) document.documentElement.classList.add("desktop-shell-leaving");
    try {
      if (transitionMs) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, transitionMs));
      }
      const embedded = await consoleOpenWebui(port.value);
      if (!embedded) {
        document.documentElement.classList.remove("desktop-shell-leaving");
        researchOpening.value = false;
      }
      } catch {
      // WebUI 导航失败时恢复控制台，用户可以再次尝试。
      document.documentElement.classList.remove("desktop-shell-leaving");
      researchOpening.value = false;
    }
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
      :disabled="researchOpening"
      @click="openAccount"
    >
      <UserRound class="rail__icon" aria-hidden="true" />
      <span class="rail__label">账户</span>
    </button>

    <button
      type="button"
      class="rail__item"
      :class="{ 'rail__item--active': activeKey === 'environment' }"
      :aria-current="activeKey === 'environment' ? 'page' : undefined"
      :disabled="researchOpening"
      @click="router.push('/')"
    >
      <MonitorCog class="rail__icon" aria-hidden="true" />
      <span class="rail__label">环境</span>
    </button>

    <button
      type="button"
      class="rail__item"
      :title="researchReady ? '进入研究(WebUI)' : '服务未运行,点击前往环境页启动'"
      :disabled="researchOpening"
      @click="openResearch"
    >
      <Telescope class="rail__icon" aria-hidden="true" />
      <span class="rail__label">研究</span>
    </button>

    <div class="rail__bottom">
      <button
        type="button"
        class="rail__item"
        :title="themeTitle"
        :aria-label="themeTitle"
        data-test="theme-toggle"
        :disabled="themeSaving || researchOpening"
        @click="toggleTheme"
      >
        <Sun v-if="effectiveTheme === 'light'" class="rail__icon" aria-hidden="true" />
        <Moon v-else class="rail__icon" aria-hidden="true" />
        <span class="rail__label">{{ effectiveTheme === "light" ? "浅色" : "深色" }}</span>
      </button>

      <button
        type="button"
        class="rail__item"
        :class="{ 'rail__item--active': activeKey === 'settings' }"
        :aria-current="activeKey === 'settings' ? 'page' : undefined"
        :disabled="researchOpening"
        @click="router.push('/settings')"
      >
        <Settings class="rail__icon" aria-hidden="true" />
        <span class="rail__label">设置</span>
      </button>
    </div>
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
  width: var(--rail-width);
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

.rail__bottom {
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

<style>
/* 主题引擎变量覆盖:html[data-theme]/data-brand 由本组件写入,优先级高于
   console.css 的 :root 默认深色,让亮/暗与主题色在整站生效。 */
html[data-theme="light"] {
  color-scheme: light;
  --bg: 220 20% 96%;
  --surface-1: 0 0% 100%;
  --surface-2: 220 18% 92%;
  --line: 220 16% 84%;
  --ink: 220 18% 16%;
  --ink-dim: 220 12% 42%;
  --ok: 145 62% 42%;
  --ok-fg: 145 55% 30%;
  --warn: 38 92% 48%;
  --warn-fg: 38 80% 36%;
  --bad: 0 75% 55%;
  --bad-fg: 0 70% 45%;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --bg: 220 24% 4%;
  --surface-1: 220 20% 8%;
  --surface-2: 220 20% 12%;
  --line: 220 18% 18%;
  --ink: 220 12% 93%;
  --ink-dim: 220 10% 66%;
  --ok: 145 62% 50%;
  --ok-fg: 145 58% 66%;
  --warn: 38 92% 55%;
  --warn-fg: 40 95% 66%;
  --bad: 0 75% 60%;
  --bad-fg: 0 88% 74%;
}

html[data-brand="teal"] {
  --brand: 175 72% 40%;
  --brand-strong: 175 60% 41%;
  --on-brand: 26 48% 13%;
}

html[data-brand="blue"] {
  --brand: 217 76% 52%;
  --brand-strong: 217 70% 46%;
  --on-brand: 210 40% 98%;
}

html[data-brand="purple"] {
  --brand: 262 60% 55%;
  --brand-strong: 262 65% 49%;
  --on-brand: 270 50% 98%;
}

html[data-brand="pink"] {
  --brand: 330 70% 55%;
  --brand-strong: 330 68% 49%;
  --on-brand: 340 60% 98%;
}

html[data-brand="orange"] {
  --brand: 25 92% 52%;
  --brand-strong: 25 86% 46%;
  --on-brand: 26 48% 13%;
}

html[data-brand="green"] {
  --brand: 145 62% 40%;
  --brand-strong: 145 55% 34%;
  --on-brand: 150 45% 98%;
}
</style>
