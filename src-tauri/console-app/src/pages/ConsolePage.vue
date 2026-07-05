<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { storeToRefs } from "pinia";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBootstrapStore } from "../stores/bootstrap";
import { useChannelsStore } from "../stores/channels";

import {
  consoleBootstrap,
  consoleOpenWebui,
  consoleOpenLogs,
  consoleConfirmClose,
} from "../ipc/commands";
import {
  onBootstrapEvent,
  onBootstrapExit,
  onServiceStarted,
  onCloseRequested,
  onChanneldepProgress,
  onChanneldepExit,
} from "../ipc/events";
import type { BootstrapEvent } from "../ipc/types";

import StatusBadge from "../components/StatusBadge.vue";
import AppButton from "../components/AppButton.vue";
import ProgressBar from "../components/ProgressBar.vue";
import LogViewer from "../components/LogViewer.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import HintBanner from "../components/HintBanner.vue";
import VersionFooter from "../components/VersionFooter.vue";
import { useBusy } from "../composables/useBusy";
import logoPng from "../assets/128x128@2x.png";

const env = useEnvStore();
const service = useServiceStore();
const bootstrap = useBootstrapStore();
const channels = useChannelsStore();

const { env: envState, port, serviceRunning } = storeToRefs(env);
const { running } = storeToRefs(service);

const logViewer = ref<InstanceType<typeof LogViewer> | null>(null);
const errorMsg = ref("");

function log(line: string) {
  logViewer.value?.append(line);
}
function setErr(m: unknown) {
  errorMsg.value = m ? String(m) : "";
}

// ── ENV/SVC 渲染(搬自 renderEnv/renderSvc) ──────────────────────
const ENV_MAP = {
  ready: { txt: "就绪", cls: "ok" },
  incomplete: { txt: "依赖不全", cls: "warn" },
  not_installed: { txt: "未安装", cls: "bad" },
} as const;

const envBadge = computed(() => {
  if (!envState.value) return { txt: "检测中", cls: "warn" };
  return ENV_MAP[envState.value] ?? { txt: "未知", cls: "warn" };
});

// busy 期间不覆盖按钮态(交由 useBusy 的 busy ref 接管 disabled)。
const installBusy = useBusy();
const startBusy = useBusy();
const stopBusy = useBusy();

const showInstallBtn = computed(
  () => envState.value !== "ready" && !installBusy.busy.value,
);
const showStartBtn = computed(
  () => serviceRunning.value === false && !startBusy.busy.value,
);
const showStopBtn = computed(
  () => serviceRunning.value === true && !stopBusy.busy.value,
);
const btnStartDisabled = computed(
  () => envState.value !== "ready" || port.value !== null || startBusy.busy.value,
);

// ── 安装 ────────────────────────────────────────────────────────
async function onInstall() {
  await installBusy.run("安装中", async () => {
    setErr("");
    log("开始安装依赖…");
    bootstrap.start();
    try {
      await consoleBootstrap();
    } catch (e) {
      setErr(e);
      bootstrap.advance("failed", "");
    }
  });
}

// ── 启动服务 ────────────────────────────────────────────────────
async function onStart() {
  await startBusy.run("启动中", async () => {
    setErr("");
    try {
      const p = await service.start();
      env.setPort(p);
      hintHidden.value = true;
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 停止服务(二次确认) ──────────────────────────────────────────
const stopDialogOpen = ref(false);
function onStop() {
  stopDialogOpen.value = true;
}
async function onStopDialogClose(v: "ok" | "cancel") {
  stopDialogOpen.value = false;
  if (v !== "ok") return;
  await stopBusy.run("停止中", async () => {
    try {
      await service.stop();
      env.setPort(null);
      await refresh();
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 打开 WebUI / 日志 ───────────────────────────────────────────
async function onOpenWebui() {
  if (port.value == null) return;
  try {
    await consoleOpenWebui(port.value);
  } catch (e) {
    setErr(e);
  }
}
async function onOpenLogs() {
  try {
    await consoleOpenLogs();
  } catch (e) {
    setErr(e);
  }
}

// ── 关闭二次确认 ────────────────────────────────────────────────
const closeDialogOpen = ref(false);
const closeInstalling = ref(false);
const closeText = computed(() =>
  closeInstalling.value
    ? '依赖仍在安装中，<b>关闭客户端将中断安装</b>，下次需要重新安装。确认要关闭吗？'
    : '后端服务仍在运行，<b>关闭客户端将终止服务并中断正在执行的任务</b>（回测、研究、实盘等）。确认要关闭吗？',
);
async function onCloseDialogClose(v: "ok" | "cancel") {
  closeDialogOpen.value = false;
  if (v !== "ok") return;
  try {
    await consoleConfirmClose();
    const win = (window as any).__TAURI__?.window?.getCurrentWindow?.();
    if (win) await win.close();
  } catch (e) {
    setErr(e);
  }
}

// ── hint 显隐 ───────────────────────────────────────────────────
const hintHidden = ref(false);

// ── 刷新(轮询) ──────────────────────────────────────────────────
async function refresh() {
  await env.refresh();
  // 渲染依赖 envState/serviceRunning 的 computed 自动更新。
  hintHidden.value = envState.value === "ready" || serviceRunning.value;
  await channels.refresh(port.value, serviceRunning.value);
  setErr("");
}

// ── 事件监听(生命周期内) ────────────────────────────────────────
let unlistens: UnlistenFn[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  unlistens = await Promise.all([
    onBootstrapEvent((e: BootstrapEvent) => {
      if (e.message) log(`[${e.stage}] ${e.message}`);
      bootstrap.advance(e.stage, e.message ?? "");
      if (e.ok === false) setErr(e.message || "依赖安装失败");
    }),
    onBootstrapExit((code: number) => {
      log("bootstrap 退出码: " + code);
      if (code !== 0 && bootstrap.state !== "done") bootstrap.advance("failed", "");
      refresh();
    }),
    onServiceStarted((p: number) => {
      env.setPort(p);
      service.setRunning(true);
      hintHidden.value = true;
      refresh();
    }),
    onCloseRequested((payload: any) => {
      closeInstalling.value = !!payload?.installing;
      closeDialogOpen.value = true;
    }),
    onChanneldepProgress((line: string) => log(line)),
    onChanneldepExit((code: number) => {
      log("渠道依赖安装退出码: " + code);
      refresh();
    }),
  ]);
  refresh();
  pollTimer = setInterval(refresh, 3000);
});

onUnmounted(() => {
  unlistens.forEach((u) => u());
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <main class="console">
    <!-- head: logo + 标题 + 打开 WebUI -->
    <div class="head">
      <div style="display: flex; align-items: center; gap: 13px">
        <img class="mark" alt="Vibe Trading" :src="logoPng" />
        <div>
          <h1>Vibe Trading</h1>
          <p class="sub">桌面运行环境控制台</p>
        </div>
      </div>
      <AppButton variant="ghost" :disabled="!running" @click="onOpenWebui">
        在浏览器打开 WebUI
      </AppButton>
    </div>

    <!-- status -->
    <div class="status">
      <div class="status-row">
        <span class="status-label">运行环境</span>
        <div style="display: flex; gap: 8px">
          <StatusBadge :cls="envBadge.cls" :text="envBadge.txt" />
          <AppButton v-if="showInstallBtn" :variant="envState === 'ready' ? 'ghost' : 'primary'"
            :busy="installBusy.busy.value" busy-label="安装中" @click="onInstall">
            安装/修复依赖
          </AppButton>
        </div>
      </div>
      <div class="status-row">
        <span class="status-label">研究服务</span>
        <div style="display: flex; gap: 8px">
          <StatusBadge :cls="running ? 'ok' : 'warn'" :text="running ? '运行中' : '已停止'" :live="running" />
          <div class="action-group">
            <AppButton v-if="showStartBtn" variant="primary" :disabled="btnStartDisabled" :busy="startBusy.busy.value"
              busy-label="启动中" @click="onStart">
              启动服务
            </AppButton>
            <AppButton v-if="showStopBtn" variant="danger" :busy="stopBusy.busy.value" busy-label="停止中" @click="onStop">
              停止服务
            </AppButton>
          </div>
        </div>
      </div>
      <div class="status-row">
        <span class="status-label">消息渠道</span>
        <StatusBadge :cls="channels.cls" :text="channels.text" :live="channels.live" />
      </div>
    </div>

    <HintBanner :hidden="hintHidden" />

    <ProgressBar />

    <ConfirmDialog :open="stopDialogOpen" title="确认停止服务？" @close="onStopDialogClose">
      停止将中断后端进程，<b>请确保当前没有正在执行的任务</b>（回测、研究、实盘等）。
      <template #confirm-text>确认停止</template>
    </ConfirmDialog>

    <ConfirmDialog :open="closeDialogOpen" title="确认关闭客户端？" @close="onCloseDialogClose">
      <span v-html="closeText"></span>
      <template #confirm-text>确认关闭</template>
    </ConfirmDialog>

    <div id="err">{{ errorMsg }}</div>

    <LogViewer ref="logViewer" @open-logs="onOpenLogs" />

    <VersionFooter />
  </main>
</template>

<style>
@import "../styles/console.css";
</style>
