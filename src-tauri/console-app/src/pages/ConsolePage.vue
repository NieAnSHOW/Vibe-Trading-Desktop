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
  consoleQuit,
  consoleFetchAds,
  consoleOpenExternalUrl,
} from "../ipc/commands";
import {
  onBootstrapEvent,
  onBootstrapExit,
  onServiceStarted,
  onQuitRequested,
  onChanneldepExit,
} from "../ipc/events";
import type { BootstrapEvent } from "../ipc/types";
import type { AdItem } from "../ipc/types";

import StatusBadge from "../components/StatusBadge.vue";
import AppButton from "../components/AppButton.vue";
import ProgressBar from "../components/ProgressBar.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import HintBanner from "../components/HintBanner.vue";
import AdSlot from "../components/AdSlot.vue";
import UpdateBanner from "../components/UpdateBanner.vue";
import { useBusy } from "../composables/useBusy";
import logoPng from "../assets/128x128@2x.png";
import { config as ProdConfig } from '../config/prod'
import {
  Database,
  ExternalLink,
  MessageCircleMore,
  Play,
  ServerCog,
  ShieldCheck,
  Square,
  MessageSquareText,
  ChartCandlestick,
  Wrench,
} from "@lucide/vue";

const env = useEnvStore();
const service = useServiceStore();
const bootstrap = useBootstrapStore();
const channels = useChannelsStore();

const { env: envState, port, serviceRunning } = storeToRefs(env);

const updateBanner = ref<InstanceType<typeof UpdateBanner> | null>(null);
const errorMsg = ref("");
const pageReady = ref(false);
const pageEntering = ref(false);

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

// console_bootstrap 是 fire-and-forget:spawn 后立即返回,真正的结束信号是
// bootstrap://exit 事件。installing 由该事件翻转,而非 IPC resolve——否则按钮
// 在 IPC 返回瞬间就恢复可点,但实际安装仍在后台跑几十秒到几分钟。
const installing = ref(false);
const bootstrapFailed = ref(false);
const startBusy = useBusy();
const stopBusy = useBusy();

// busy 期间按钮保留显示，由 AppButton 的 :busy 接管(spinner + disabled)。
// 服务真正 ready 后 serviceRunning 翻转，按钮才在此切换——否则最长 120s
// (sidecar await_health)内两个按钮都消失，看起来像假死。
const isServiceRunning = computed(() => serviceRunning.value);
const btnStartDisabled = computed(
  () => envState.value !== "ready" || isServiceRunning.value || port.value !== null || startBusy.busy.value,
);
const primaryActionKind = computed<"install" | "start" | "open">(() => {
  if (envState.value !== "ready" || bootstrapFailed.value) return "install";
  return isServiceRunning.value ? "open" : "start";
});

// ── 安装 ────────────────────────────────────────────────────────
// 安装前「服务运行中」确认对话框:安装新版本依赖会影响正在运行的服务,
// 需先停服务再安装；用户取消则放弃本次安装。
const installStopDialogOpen = ref(false);

async function onInstall() {
  if (installing.value) return; // 防重入:安装期间按钮已被 AppButton 的 busy 禁用
  // 服务运行中:弹确认框,由 onInstallStopDialogClose 续接后续逻辑
  if (serviceRunning.value) {
    installStopDialogOpen.value = true;
    return;
  }
  await doInstall();
}

async function onInstallStopDialogClose(v: "ok" | "cancel") {
  installStopDialogOpen.value = false;
  if (v !== "ok") return;
  // 先停止服务再安装
  try {
    await service.stop();
    env.setPort(null);
  } catch (e) {
    setErr(e);
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
    await consoleBootstrap(); // fire-and-forget:spawn 成功即返回,结束走 bootstrap://exit
  } catch (e) {
    setErr(e);
    bootstrapFailed.value = true;
    bootstrap.advance("failed", "");
    installing.value = false; // spawn 失败:后台线程不会 emit exit,这里释放
  }
}

// ── 启动服务 ────────────────────────────────────────────────────
async function onStart() {
  await startBusy.run("启动中", async () => {
    setErr("");
    try {
      const p = await service.start();
      env.setPort(p);
      serviceRunning.value = true;
      hintHidden.value = true;
    } catch (e: any) {
      setErr(e?.message || String(e));
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
      serviceRunning.value = false;
      await refresh();
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 退出登录(二次确认 → 清登录信息 → 重启服务) ──────────────────

async function onOpenWebui() {
  if (port.value == null) return;
  try {
    await consoleOpenWebui(port.value);
  } catch (e) {
    setErr(e);
  }
}
// ── 退出二次确认(由托盘「退出」在服务运行中 / 安装中时触发) ──────────
// 窗口关闭按钮 X 一律静默收纳后台,不经此确认;只有托盘「退出」有活跃工作时才弹。
const quitDialogOpen = ref(false);
const quitInstalling = ref(false);
const quitText = computed(() =>
  quitInstalling.value
    ? '依赖仍在安装中,<b>退出将中断安装</b>,下次需要重新安装。确认要退出吗?'
    : '后端服务仍在运行,<b>退出将终止服务并中断正在执行的任务</b>(回测、研究、实盘等)。确认要退出吗?',
);
async function onQuitDialogClose(v: "ok" | "cancel") {
  quitDialogOpen.value = false;
  if (v !== "ok") return;
  try {
    await consoleQuit(); // Rust 侧 app.exit(0) → ExitRequested 回收 sidecar
  } catch (e) {
    setErr(e);
  }
}

// ── hint 显隐 ───────────────────────────────────────────────────
const hintHidden = ref(false);

// ── 广告 ─────────────────────────────────────────────────────────
const adBanner = ref<AdItem[]>([]);
const adBottom = ref<AdItem[]>([]);

async function fetchAds() {
  try {
    const [banner, bottom] = await Promise.all([
      consoleFetchAds("banner").then((r) => r, () => [] as AdItem[]),
      consoleFetchAds("bottom").then((r) => r, () => [] as AdItem[]),
    ]);
    adBanner.value = banner;
    adBottom.value = bottom;
  } catch {
    // 静默：广告接口不可用不影响控制台
  }
}

// ── 刷新(轮询) ──────────────────────────────────────────────────
async function refresh(clearError = true) {
  await env.refresh();
  // 渲染依赖 envState/serviceRunning 的 computed 自动更新。
  hintHidden.value = envState.value === "ready" || serviceRunning.value;
  await channels.refresh(port.value, serviceRunning.value);
  if (clearError) setErr("");
}

// ── 事件监听(生命周期内) ────────────────────────────────────────
let unlistens: UnlistenFn[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let adTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  pageReady.value = true;
  pageEntering.value = true;
  // TODO: 暂时禁用自动更新，启动时静默检查更新（失败不影响主流程）
  if (ProdConfig.checkUpdate) {
    updateBanner.value?.checkUpdate().catch(() => { });
  }

  unlistens = await Promise.all([
    onBootstrapEvent((e: BootstrapEvent) => {
      bootstrap.advance(e.stage, e.message ?? "");
      if (e.ok === false) {
        bootstrapFailed.value = true;
        setErr(e.message || "依赖安装失败");
      }
    }),
    onBootstrapExit(async (code: number) => {
      if (code !== 0 && bootstrap.state !== "done") {
        bootstrapFailed.value = true;
        bootstrap.advance("failed", "");
        if (!errorMsg.value) setErr("依赖安装失败");
      }
      if (code === 0) bootstrapFailed.value = false;
      installing.value = false; // 权威结束信号:无论成功失败,后台线程退出即释放按钮
      await refresh(code === 0);
      if (code === 0 && envState.value === "ready" && !serviceRunning.value) {
        await onStart();
      } else if (code === 0 && envState.value !== "ready") {
        setErr("安装完成，但运行环境尚未就绪，请重试安装");
      }
    }),
    onServiceStarted((p: number) => {
      env.setPort(p);
      serviceRunning.value = true;
      service.setRunning(true);
      hintHidden.value = true;
      refresh();
    }),
    onQuitRequested((payload: any) => {
      quitInstalling.value = !!payload?.installing;
      quitDialogOpen.value = true;
    }),
    onChanneldepExit(() => {
      refresh();
    }),
  ]);
  refresh();
  pollTimer = setInterval(refresh, 3000);

  // 当启用AD时才需要请求此接口
  if (ProdConfig.enableAd) {
    fetchAds();
    adTimer = setInterval(fetchAds, 120_000);
  }

});

onUnmounted(() => {
  unlistens.forEach((u) => u());
  if (pollTimer) clearInterval(pollTimer);
  if (adTimer) clearInterval(adTimer);
});

function onStartupAnimationEnd() {
  pageEntering.value = false;
}
</script>

<template>
  <main class="console-page" :class="{ 'console-page--ready': pageReady, 'console-page--entering': pageEntering }">
    <header class="app-header console-page__header">
      <div class="brand-lockup" role="link" tabindex="0" aria-label="访问官网"
        @click="ProdConfig.officialUrl && consoleOpenExternalUrl(ProdConfig.officialUrl)"
        @keydown.enter="ProdConfig.officialUrl && consoleOpenExternalUrl(ProdConfig.officialUrl)">
        <img class="mark" alt="Trading Worker" :src="logoPng" />
        <div class="brand-copy">
          <h1>Trading Worker</h1>
          <span class="brand-divider" aria-hidden="true"></span>
          <p class="sub">您的专属 AI 理财专家</p>
        </div>
      </div>
    </header>

    <section class="console-shell console-page__shell" aria-label="控制台内容" @animationend.self="onStartupAnimationEnd">
      <UpdateBanner ref="updateBanner" />
      <AdSlot :ads="adBanner" variant="banner" />


      <div class="console-workspace console-workspace--guest">
        <section class="service-panel" aria-labelledby="service-title">
          <div class="service-hero">
            <div class="service-state-line">
              <StatusBadge :cls="isServiceRunning ? 'ok' : envBadge.cls"
                :text="isServiceRunning ? '服务就绪' : envBadge.txt" :live="isServiceRunning" />
              <span>{{ isServiceRunning ? `本地端口 ${port ?? '检测中'}` : '本地运行，数据保留在您的设备上' }}</span>
            </div>
            <h2 id="service-title">研究服务</h2>
            <p class="service-description">启动本地 AI 研究服务，在浏览器中进行市场分析、策略回测和投研对话。</p>
            <div class="operation-bar" aria-label="服务操作">
              <div class="operation-bar__primary">
                <AppButton v-if="primaryActionKind === 'install'" variant="primary" :busy="installing" busy-label="安装中"
                  data-test="primary-service-action" @click="onInstall">
                  <Wrench :size="19" aria-hidden="true" />安装或修复依赖
                </AppButton>
                <AppButton v-else-if="primaryActionKind === 'start'" variant="primary" :disabled="btnStartDisabled"
                  :busy="startBusy.busy.value" busy-label="启动中" data-test="primary-service-action" @click="onStart">
                  <Play :size="19" aria-hidden="true" />启动研究服务
                </AppButton>
                <AppButton v-else variant="primary" :disabled="port === null" data-test="primary-service-action"
                  @click="onOpenWebui">
                  <ExternalLink :size="19" aria-hidden="true" />进入研究工作台
                </AppButton>
                <AppButton v-if="isServiceRunning" variant="ghost" :busy="stopBusy.busy.value" busy-label="停止中"
                  data-test="stop-service-action" @click="onStop">
                  <Square :size="15" aria-hidden="true" />停止服务
                </AppButton>
              </div>
            </div>
            <div class="service-intro">
              <p class="service-intro-title">关于本项目</p>
              <p class="service-intro-text">
                Trading Worker 是一款自然语言驱动的金融研究 AI 智能体桌面应用，内置 70+ 金融技能与回测引擎，覆盖投研对话、策略研究与回测分析。
              </p>
              <ul class="service-intro-points">
                <li>
                  <MessageSquareText :size="14" aria-hidden="true" />自然语言投研对话
                </li>
                <li>
                  <ChartCandlestick :size="14" aria-hidden="true" />策略回测与分析
                </li>
                <li>
                  <ShieldCheck :size="14" aria-hidden="true" />数据私密
                </li>
              </ul>
            </div>
          </div>

          <div class="runtime-strip" aria-label="运行状态">
            <div class="runtime-item">
              <Database :size="21" aria-hidden="true" />
              <span><small>运行环境</small><b>{{ envBadge.txt }}</b></span>
            </div>
            <div class="runtime-item">
              <ServerCog :size="21" aria-hidden="true" />
              <span><small>研究服务</small><b>{{ isServiceRunning ? '运行中' : '已停止' }}</b></span>
            </div>
            <div class="runtime-item">
              <MessageCircleMore :size="21" aria-hidden="true" />
              <span><small>消息渠道</small><b :class="`runtime-value--${channels.cls}`">{{ channels.text }}</b></span>
            </div>
          </div>

          <HintBanner :hidden="hintHidden" />
          <ProgressBar />
        </section>

      </div>

      <ConfirmDialog :open="installStopDialogOpen" title="服务运行中，确认停止并安装？" @close="onInstallStopDialogClose">
        检测到后端服务正在运行，安装新版本依赖需要先停止服务。<b>停止将中断正在执行的任务</b>（回测、研究、实盘等），确认停止并继续安装吗？
        <template #confirm-text>停止并安装</template>
      </ConfirmDialog>

      <ConfirmDialog :open="stopDialogOpen" title="确认停止服务？" @close="onStopDialogClose">
        停止将中断后端进程，<b>请确保当前没有正在执行的任务</b>（回测、研究、实盘等）。
        <template #confirm-text>确认停止</template>
      </ConfirmDialog>

      <ConfirmDialog :open="quitDialogOpen" title="确认退出客户端？" @close="onQuitDialogClose">
        <span v-html="quitText"></span>
        <template #confirm-text>确认退出</template>
      </ConfirmDialog>

      <AdSlot :ads="adBottom" variant="bottom" />
      <div id="err">{{ errorMsg }}</div>
    </section>
  </main>
</template>

<style>
@import "../styles/console.css";

.console-page__header,
.console-page__shell {
  opacity: 0;
  transform: translateY(8px);
}

.console-page--ready .console-page__header,
.console-page--ready .console-page__shell {
  animation: console-enter 260ms ease-out both;
}

.console-page--ready .console-page__shell {
  animation-delay: 60ms;
}

@keyframes console-enter {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {

  .console-page--ready .console-page__header,
  .console-page--ready .console-page__shell {
    animation-duration: 0.01ms;
  }
}
</style>
