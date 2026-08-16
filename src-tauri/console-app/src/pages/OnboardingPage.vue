<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBootstrapStore } from "../stores/bootstrap";
import { consoleBootstrap, consoleQuit } from "../ipc/commands";
import {
  onBootstrapEvent,
  onBootstrapExit,
  onServiceStarted,
  onQuitRequested,
} from "../ipc/events";
import type { BootstrapEvent } from "../ipc/types";
import AppButton from "../components/AppButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import logoPng from "../assets/128x128@2x.png";
import { Wrench } from "@lucide/vue";

const env = useEnvStore();
const service = useServiceStore();
const bootstrap = useBootstrapStore();
const { env: envState, serviceRunning, error: envError } = storeToRefs(env);

const pageReady = ref(false);
const pageEntering = ref(false);
const installing = ref(false);
const bootstrapFailed = ref(false);
const errorMsg = ref("");
const displayError = computed(() => errorMsg.value || envError.value);

const needsRepair = computed(() =>
  envState.value === "not_installed" ||
  envState.value === "incomplete" ||
  bootstrapFailed.value ||
  Boolean(displayError.value),
);

function setErr(error: unknown) {
  errorMsg.value = error ? String(error) : "";
}

const installStopDialogOpen = ref(false);

async function onRepair() {
  if (installing.value) return;
  if (serviceRunning.value) {
    installStopDialogOpen.value = true;
    return;
  }
  await doInstall();
}

async function onInstallStopDialogClose(value: "ok" | "cancel") {
  installStopDialogOpen.value = false;
  if (value !== "ok") return;
  try {
    await service.stop();
    env.setPort(null);
  } catch (error) {
    setErr(error);
    return;
  }
  await doInstall();
}

async function doInstall() {
  setErr("");
  bootstrapFailed.value = false;
  bootstrap.start();
  installing.value = true;
  try {
    await consoleBootstrap();
  } catch (error) {
    bootstrapFailed.value = true;
    bootstrap.advance("failed", "");
    setErr(error);
    installing.value = false;
  }
}

async function startResearchService() {
  try {
    const port = await service.start();
    env.setPort(port);
    env.serviceRunning = true;
  } catch (error) {
    setErr(error);
  }
}

const quitDialogOpen = ref(false);
const quitInstalling = ref(false);
const quitText = computed(() =>
  quitInstalling.value
    ? "依赖仍在安装中,<b>退出将中断安装</b>,下次需要重新安装。确认要退出吗?"
    : "后端服务仍在运行,<b>退出将终止服务并中断正在执行的任务</b>(回测、研究、实盘等)。确认要退出吗?",
);

async function onQuitDialogClose(value: "ok" | "cancel") {
  quitDialogOpen.value = false;
  if (value !== "ok") return;
  try {
    await consoleQuit();
  } catch (error) {
    setErr(error);
  }
}

let unlistens: UnlistenFn[] = [];

onMounted(async () => {
  pageReady.value = true;
  pageEntering.value = true;

  unlistens = await Promise.all([
    onBootstrapEvent((event: BootstrapEvent) => {
      bootstrap.advance(event.stage, event.message ?? "");
      if (event.ok === false) {
        bootstrapFailed.value = true;
        setErr(event.message || "依赖安装失败");
      }
    }),
    onBootstrapExit(async (code: number) => {
      if (code !== 0 && bootstrap.state !== "done") {
        bootstrapFailed.value = true;
        bootstrap.advance("failed", "");
        if (!errorMsg.value) setErr("依赖安装失败");
      }
      if (code === 0) bootstrapFailed.value = false;
      installing.value = false;
      await env.refresh();
      if (code === 0 && envState.value === "ready" && !serviceRunning.value) {
        await startResearchService();
      } else if (code === 0 && envState.value !== "ready") {
        setErr("安装完成，但运行环境尚未就绪，请重试安装");
      }
    }),
    onServiceStarted((port: number) => {
      env.setPort(port);
      env.serviceRunning = true;
    }),
    onQuitRequested((payload: any) => {
      quitInstalling.value = !!payload?.installing;
      quitDialogOpen.value = true;
    }),
  ]);

  await env.refresh();
});

onUnmounted(() => {
  unlistens.forEach((unlisten) => unlisten());
});

function onStartupAnimationEnd() {
  pageEntering.value = false;
}
</script>

<template>
  <main
    class="onboarding-page"
    :class="{ 'onboarding-page--ready': pageReady, 'onboarding-page--entering': pageEntering }"
    aria-label="应用启动"
    @animationend.self="onStartupAnimationEnd"
  >
    <section class="onboarding-stage">
      <img class="onboarding-logo" alt="Trading Worker" :src="logoPng" />
      <p class="onboarding-status">{{ needsRepair ? '请先点击安装环境' : '应用启动中...' }} </p>
      <p v-show="displayError" id="err" class="onboarding-error" role="alert">{{ displayError }}</p>
      <AppButton
        v-if="needsRepair"
        variant="primary"
        :busy="installing"
        busy-label="修复中"
        data-test="repair-environment"
        @click="onRepair"
      >
        <Wrench :size="17" aria-hidden="true" />
        安装/修复环境
      </AppButton>
    </section>

    <ConfirmDialog :open="installStopDialogOpen" title="服务运行中，确认停止并修复？" @close="onInstallStopDialogClose">
      检测到后端服务正在运行，修复环境需要先停止服务。<b>停止将中断正在执行的任务</b>，确认停止并继续修复吗？
      <template #confirm-text>停止并修复</template>
    </ConfirmDialog>

    <ConfirmDialog :open="quitDialogOpen" title="确认退出客户端？" @close="onQuitDialogClose">
      <span v-html="quitText"></span>
      <template #confirm-text>确认退出</template>
    </ConfirmDialog>
  </main>
</template>

<style scoped>
.onboarding-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  background: hsl(var(--bg));
  color: hsl(var(--ink));
}

.onboarding-stage {
  display: flex;
  min-width: 240px;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px;
  text-align: center;
}

.onboarding-logo {
  width: 96px;
  height: 96px;
  border-radius: 22px;
  object-fit: contain;
  filter: drop-shadow(0 12px 30px hsl(var(--brand) / 0.2));
}

.onboarding-status {
  color: hsl(var(--ink-dim));
  font-size: 16px;
}

.onboarding-error {
  max-width: 320px;
  color: hsl(var(--bad-fg));
  font-size: 13px;
  line-height: 1.5;
}

.onboarding-stage :deep(.btn-primary) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding-inline: 18px;
}

.onboarding-page--ready .onboarding-stage {
  animation: onboarding-enter 220ms ease-out both;
}

@keyframes onboarding-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .onboarding-page--ready .onboarding-stage {
    animation-duration: 0.01ms;
  }
}
</style>
