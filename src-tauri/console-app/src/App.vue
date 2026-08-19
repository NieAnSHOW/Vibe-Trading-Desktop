<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, onErrorCaptured } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useRoute } from "vue-router";
import { loadPublicConfig } from "./config/prod";
import Rail, { THEME_COLOR_EVENT, THEME_MODE_EVENT } from "./components/Rail.vue";
import { consoleCloseWebui, consoleOpenExternalUrl, consoleTakePendingWebui } from "./ipc/commands";
import { onWebuiClose, onWebuiOpen } from "./ipc/events";

const errMsg = ref("");
const route = useRoute();
const isOnboarding = computed(() => route.path === "/");
const isStandaloneSurface = computed(() => isOnboarding.value || route.path === "/login");
const hasRail = computed(() => !isStandaloneSurface.value || webuiVisible.value);
const webuiFrameUrl = ref<string | null>(null);
const webuiVisible = ref(false);
const webuiFrameActive = ref(false);
const webuiFrame = ref<HTMLIFrameElement | null>(null);
const SHELL_TRANSITION_MS = 220;
let unlistens: UnlistenFn[] = [];
let closeTransition: Promise<void> | null = null;
let transitionGeneration = 0;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function syncWebuiTheme() {
  const frame = webuiFrame.value;
  const frameUrl = webuiFrameUrl.value;
  if (!frame?.contentWindow || !frameUrl) return;
  try {
    frame.contentWindow.postMessage(
      {
        type: "vibe-shell:theme",
        dark: document.documentElement.dataset.theme === "dark",
        color: document.documentElement.dataset.brand ?? null,
      },
      new URL(frameUrl, window.location.href).origin,
    );
  } catch {
    // The frame may be navigating; its load handler will retry the sync.
  }
}

// iframe 内的 WebUI 拿不到 Tauri IPC(仅注入主框架),外链经消息桥委托此处
// 调 open_external_url 拉起系统浏览器。只信任自家 frame 的消息,且仅放行
// http/https(Rust 侧 open_external_url 会再校验一次)。
function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function onWebuiMessage(event: MessageEvent) {
  if (event.source !== webuiFrame.value?.contentWindow) return;
  const data = event.data as { type?: string; url?: string } | null;
  if (data?.type !== "vibe-shell:open-external" || typeof data.url !== "string") return;
  if (!isWebUrl(data.url)) return;
  void consoleOpenExternalUrl(data.url);
}

function openWebui(url: string) {  if (!url) return;
  const generation = ++transitionGeneration;
  closeTransition = null;
  if (webuiFrameUrl.value !== url) webuiFrameUrl.value = url;
  webuiVisible.value = true;
  webuiFrameActive.value = false;
  requestAnimationFrame(() => {
    if (generation !== transitionGeneration) return;
    webuiFrameActive.value = true;
    document.documentElement.classList.remove("desktop-shell-leaving");
    syncWebuiTheme();
  });
}

function finishCloseWebui() {
  webuiVisible.value = false;
  webuiFrameActive.value = false;
  document.documentElement.classList.remove("desktop-shell-leaving");
  document.documentElement.classList.add("desktop-shell-entering");
  requestAnimationFrame(() => document.documentElement.classList.remove("desktop-shell-entering"));
}

function animateCloseWebui(): Promise<void> {
  if (!webuiVisible.value) return Promise.resolve();
  if (closeTransition) return closeTransition;

  const generation = ++transitionGeneration;
  webuiFrameActive.value = false;
  closeTransition = new Promise<void>((resolve) => {
    if (prefersReducedMotion()) {
      finishCloseWebui();
      resolve();
      return;
    }
    window.setTimeout(() => {
      if (generation === transitionGeneration) finishCloseWebui();
      resolve();
    }, SHELL_TRANSITION_MS);
  });
  const current = closeTransition;
  void current.then(() => {
    if (closeTransition === current) closeTransition = null;
  });
  return current;
}

async function returnToConsole() {
  const transition = animateCloseWebui();
  try {
    await consoleCloseWebui();
  } finally {
    await transition;
  }
}
onErrorCaptured((e) => {
  errMsg.value = String(e);
  return false; // 阻止向上抛
});

// 面板滚动条平时隐藏、仅滚动期间浮现(见 console.css 的 .is-scrolling 规则)
let surfaceScrollHideTimer: number | undefined;
function onSurfaceScroll(event: Event) {
  const surface = event.currentTarget as HTMLElement;
  surface.classList.add("is-scrolling");
  window.clearTimeout(surfaceScrollHideTimer);
  surfaceScrollHideTimer = window.setTimeout(
    () => surface.classList.remove("is-scrolling"),
    600,
  );
}

// 启动即拉取服务端公共配置（enableLogin/enableAd/checkUpdate 等），失败静默降级默认值
onMounted(async () => {
  document.getElementById("console-rail-bootstrap")?.remove();
  if (document.documentElement.classList.contains("desktop-shell-entering")) {
    requestAnimationFrame(() => document.documentElement.classList.remove("desktop-shell-entering"));
  }
  unlistens = await Promise.all([onWebuiOpen(openWebui), onWebuiClose(() => void animateCloseWebui())]);
  window.addEventListener(THEME_MODE_EVENT, syncWebuiTheme);
  window.addEventListener(THEME_COLOR_EVENT, syncWebuiTheme);
  window.addEventListener("message", onWebuiMessage);
  const pendingUrl = await consoleTakePendingWebui();
  if (pendingUrl) openWebui(pendingUrl);
  void loadPublicConfig();
});

onUnmounted(() => {
  unlistens.forEach((unlisten) => unlisten());
  window.clearTimeout(surfaceScrollHideTimer);
  window.removeEventListener(THEME_MODE_EVENT, syncWebuiTheme);
  window.removeEventListener(THEME_COLOR_EVENT, syncWebuiTheme);
  window.removeEventListener("message", onWebuiMessage);
});
</script>

<template>
  <div v-if="errMsg" class="fatal">
    控制台发生错误：{{ errMsg }}
  </div>
  <template v-else>
    <!-- The rail belongs to the retained shell, never to the WebUI document. -->
    <Rail
      v-if="!isStandaloneSurface || webuiVisible"
      :webui-active="webuiVisible"
      @navigate-console="returnToConsole"
    />
    <div
      class="shell-content"
      :class="{
        'shell-content--onboarding': isOnboarding,
        'shell-content--standalone': isStandaloneSurface,
        'shell-content--rail': hasRail,
      }"
      data-test="shell-content"
    >
      <div v-show="!webuiVisible" data-test="console-surface" @scroll.passive="onSurfaceScroll">
        <router-view v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" />
          </Transition>
        </router-view>
      </div>
    </div>
    <iframe
      v-if="webuiFrameUrl"
      v-show="webuiVisible"
      ref="webuiFrame"
      :src="webuiFrameUrl"
      class="desktop-webui-frame"
      :class="{ 'desktop-webui-frame--active': webuiFrameActive }"
      data-test="desktop-webui-frame"
      title="研究"
      @load="syncWebuiTheme"
    />
  </template>
</template>

<style>
.fatal {
  padding: 24px; color: #ff8080; font-family: ui-monospace, Menlo, monospace;
  background: #0e0f13; min-height: 100vh;
}

.page-enter-active,
.page-leave-active {
  transition: opacity 220ms ease, transform 220ms ease;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.shell-content:has(> [data-test="console-surface"] > .page-enter-active),
.shell-content:has(> [data-test="console-surface"] > .page-leave-active),
.shell-content:has(> [data-test="console-surface"] > .onboarding-page--entering) {
  overflow: clip;
}

.desktop-webui-frame {
  position: fixed;
  inset: 0 0 0 var(--rail-width);
  z-index: 5;
  width: calc(100vw - var(--rail-width));
  height: 100dvh;
  border: 0;
  background: hsl(var(--bg));
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px);
  transition: opacity 220ms ease, transform 220ms ease;
}

.desktop-webui-frame--active {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active,
  .desktop-webui-frame {
    transition-duration: 0.01ms;
  }
}
</style>
