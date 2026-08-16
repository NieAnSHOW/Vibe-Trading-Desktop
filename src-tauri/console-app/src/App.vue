<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, onErrorCaptured } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useRoute } from "vue-router";
import { loadPublicConfig } from "./config/prod";
import Rail, { THEME_COLOR_EVENT, THEME_MODE_EVENT } from "./components/Rail.vue";
import { consoleCloseWebui, consoleTakePendingWebui } from "./ipc/commands";
import { onWebuiClose, onWebuiOpen } from "./ipc/events";

const errMsg = ref("");
const route = useRoute();
const isOnboarding = computed(() => route.path === "/");
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

function openWebui(url: string) {
  if (!url) return;
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

// 启动即拉取服务端公共配置（enableLogin/enableAd/checkUpdate 等），失败静默降级默认值
onMounted(async () => {
  document.getElementById("console-rail-bootstrap")?.remove();
  if (document.documentElement.classList.contains("desktop-shell-entering")) {
    requestAnimationFrame(() => document.documentElement.classList.remove("desktop-shell-entering"));
  }
  unlistens = await Promise.all([onWebuiOpen(openWebui), onWebuiClose(() => void animateCloseWebui())]);
  window.addEventListener(THEME_MODE_EVENT, syncWebuiTheme);
  window.addEventListener(THEME_COLOR_EVENT, syncWebuiTheme);
  const pendingUrl = await consoleTakePendingWebui();
  if (pendingUrl) openWebui(pendingUrl);
  void loadPublicConfig();
});

onUnmounted(() => {
  unlistens.forEach((unlisten) => unlisten());
  window.removeEventListener(THEME_MODE_EVENT, syncWebuiTheme);
  window.removeEventListener(THEME_COLOR_EVENT, syncWebuiTheme);
});
</script>

<template>
  <div v-if="errMsg" class="fatal">
    控制台发生错误：{{ errMsg }}
  </div>
  <template v-else>
    <!-- The rail belongs to the retained shell, never to the WebUI document. -->
    <Rail
      v-if="!isOnboarding || webuiVisible"
      :webui-active="webuiVisible"
      @navigate-console="returnToConsole"
    />
    <div class="shell-content" :class="{ 'shell-content--onboarding': isOnboarding }" data-test="shell-content">
      <div v-show="!webuiVisible" data-test="console-surface">
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
