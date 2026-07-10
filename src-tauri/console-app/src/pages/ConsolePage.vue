<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { storeToRefs } from "pinia";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useAuthStore } from "../stores/auth";
import { useRouter } from "vue-router";

import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBootstrapStore } from "../stores/bootstrap";
import { useChannelsStore } from "../stores/channels";

import {
  consoleBootstrap,
  consoleOpenWebui,
  consoleOpenLogs,
  consoleClearLogs,
  consoleQuit,
  consoleClearVenv,
  consoleLogout,
  consoleFetchAds,
} from "../ipc/commands";
import {
  onBootstrapEvent,
  onBootstrapExit,
  onServiceStarted,
  onQuitRequested,
  onChanneldepProgress,
  onChanneldepExit,
} from "../ipc/events";
import type { BootstrapEvent } from "../ipc/types";
import type { AdItem } from "../ipc/types";

import StatusBadge from "../components/StatusBadge.vue";
import AppButton from "../components/AppButton.vue";
import ProgressBar from "../components/ProgressBar.vue";
import LogViewer from "../components/LogViewer.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import HintBanner from "../components/HintBanner.vue";
import AdSlot from "../components/AdSlot.vue";
import VersionFooter from "../components/VersionFooter.vue";
import UpdateBanner from "../components/UpdateBanner.vue";
import { useBusy } from "../composables/useBusy";
import logoPng from "../assets/128x128@2x.png";
import ProdConfig from '../config/prod.ts'

const env = useEnvStore();
const service = useServiceStore();
const bootstrap = useBootstrapStore();
const channels = useChannelsStore();
const authStore = useAuthStore();
const router = useRouter();

const { env: envState, port, serviceRunning } = storeToRefs(env);
const { running } = storeToRefs(service);

const logViewer = ref<InstanceType<typeof LogViewer> | null>(null);
const updateBanner = ref<InstanceType<typeof UpdateBanner> | null>(null);
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

// console_bootstrap 是 fire-and-forget:spawn 后立即返回,真正的结束信号是
// bootstrap://exit 事件。installing 由该事件翻转,而非 IPC resolve——否则按钮
// 在 IPC 返回瞬间就恢复可点,但实际安装仍在后台跑几十秒到几分钟。
const installing = ref(false);
const startBusy = useBusy();
const stopBusy = useBusy();

// busy 期间按钮保留显示，由 AppButton 的 :busy 接管(spinner + disabled)。
// 服务真正 ready 后 serviceRunning 翻转，按钮才在此切换——否则最长 120s
// (sidecar await_health)内两个按钮都消失，看起来像假死。
const showInstallBtn = computed(() => envState.value !== "ready");
const showStartBtn = computed(() => serviceRunning.value === false);
const showStopBtn = computed(() => serviceRunning.value === true);
const btnStartDisabled = computed(
  () => envState.value !== "ready" || port.value !== null || startBusy.busy.value,
);

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
  log("开始安装依赖…");
  bootstrap.start();
  installing.value = true;
  try {
    await consoleBootstrap(); // fire-and-forget:spawn 成功即返回,结束走 bootstrap://exit
  } catch (e) {
    setErr(e);
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
      hintHidden.value = true;
    } catch (e: any) {
      if (e?.variant === "LoginExpired") {
        authStore.clear();
        setErr("登录已过期，请重新登录");
        return;
      }
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
      await refresh();
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 退出登录(二次确认 → 清登录信息 → 重启服务) ──────────────────
const logoutBusy = useBusy();
const logoutDialogOpen = ref(false);
const logoutText = computed(() =>
  serviceRunning.value
    ? "若您退出登录，当前服务将会重启，正在任务中的智能体也会被强制关闭，确认操作吗？"
    : "若您退出登录，则需要您手动配置大模型，确认操作吗？",
);
function onLogout() {
  logoutDialogOpen.value = true;
}
async function onLogoutDialogClose(v: "ok" | "cancel") {
  logoutDialogOpen.value = false;
  if (v !== "ok") return;
  await logoutBusy.run("退出中", async () => {
    setErr("");
    try {
      await consoleLogout(); // 清 .env 登录段 + Rust 内存 session
      authStore.clear();
      // 重启服务：清掉旧 token 的进程，新进程以未登录态启动
      if (serviceRunning.value) {
        await service.stop();
        env.setPort(null);
        const p = await service.start();
        env.setPort(p);
      }
    } catch (e) {
      setErr(e);
    }
  });
}

// ── 强制清理 venv(二次确认 → 停服 → 删目录 → 刷新) ────────────────
const clearVenvBusy = useBusy();
const clearVenvDialogOpen = ref(false);
function onClearVenv() {
  clearVenvDialogOpen.value = true;
}
async function onClearVenvDialogClose(v: "ok" | "cancel") {
  clearVenvDialogOpen.value = false;
  if (v !== "ok") return;
  await clearVenvBusy.run("清理中", async () => {
    setErr("");
    try {
      // venv 被占用时(Win)删除会失败,先停服务释放进程。
      if (serviceRunning.value) {
        await service.stop();
        env.setPort(null);
      }
      await consoleClearVenv();
      log("已清理虚拟环境,请重新安装依赖");
      await refresh();
    } catch (e) {
      setErr(e);
    }
  });
}
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

// ── 清理日志文件(二次确认 → 删 logs/*.log → 反馈数量) ─────────────
const clearLogsBusy = useBusy();
const clearLogsDialogOpen = ref(false);
function onClearLogs() {
  clearLogsDialogOpen.value = true;
}
async function onClearLogsDialogClose(v: "ok" | "cancel") {
  clearLogsDialogOpen.value = false;
  if (v !== "ok") return;
  await clearLogsBusy.run("清理中", async () => {
    setErr("");
    try {
      const n = await consoleClearLogs();
      log(`已清理 ${n} 个日志文件`);
    } catch (e) {
      setErr(e);
    }
  });
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
const adBanner = ref<AdItem | null>(null);
const adBottom = ref<AdItem | null>(null);

function pickAd(items: AdItem[]): AdItem | null {
  return items.length > 0 ? items[0] : null;
}

async function fetchAds() {
  try {
    const [banner, bottom] = await Promise.all([
      consoleFetchAds("banner").then((r) => pickAd(r), () => null),
      consoleFetchAds("bottom").then((r) => pickAd(r), () => null),
    ]);
    adBanner.value = banner;
    adBottom.value = bottom;
  } catch {
    // 静默：广告接口不可用不影响控制台
  }
}

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
let adTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  // 恢复登录态（静默，不阻塞）
  await authStore.refresh();
  // 启动时静默检查更新（失败不影响主流程）
  updateBanner.value?.checkUpdate().catch(() => {});

  unlistens = await Promise.all([
    onBootstrapEvent((e: BootstrapEvent) => {
      if (e.message) log(`[${e.stage}] ${e.message}`);
      bootstrap.advance(e.stage, e.message ?? "");
      if (e.ok === false) setErr(e.message || "依赖安装失败");
    }),
    onBootstrapExit((code: number) => {
      log("bootstrap 退出码: " + code);
      if (code !== 0 && bootstrap.state !== "done") bootstrap.advance("failed", "");
      installing.value = false; // 权威结束信号:无论成功失败,后台线程退出即释放按钮
      refresh();
    }),
    onServiceStarted((p: number) => {
      env.setPort(p);
      service.setRunning(true);
      hintHidden.value = true;
      refresh();
    }),
    onQuitRequested((payload: any) => {
      quitInstalling.value = !!payload?.installing;
      quitDialogOpen.value = true;
    }),
    onChanneldepProgress((line: string) => log(line)),
    onChanneldepExit((code: number) => {
      log("渠道依赖安装退出码: " + code);
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
      <div style="display:flex;align-items:center;gap:8px">
        <div v-if="ProdConfig.enableLogin">
          <template v-if="authStore.authenticated && authStore.userInfo">
            <span style="font-size:12px;color:#666">{{ authStore.userInfo.nickName || authStore.userInfo.phone || '已登录'
            }}</span>
            <AppButton variant="ghost" :busy="logoutBusy.busy.value" @click="onLogout">退出登录</AppButton>
          </template>
          <AppButton v-else variant="ghost" @click="router.push('/login')">登录</AppButton>
        </div>
        <AppButton variant="ghost" :disabled="!running" @click="onOpenWebui">
          在浏览器打开 WebUI
        </AppButton>
      </div>
    </div>
    <!-- 版本更新通知横幅 -->
    <UpdateBanner ref="updateBanner" />

    <!-- 广告位 banner:标题 + 多图轮播 / 文字 -->
    <AdSlot :ad="adBanner" variant="banner" />

    <!-- status -->
    <div class="status">
      <div class="status-row">
        <span class="status-label">运行环境</span>
        <div style="display: flex; gap: 8px">
          <StatusBadge :cls="envBadge.cls" :text="envBadge.txt" />
          <AppButton v-if="showInstallBtn" :variant="envState === 'ready' ? 'ghost' : 'primary'"
            :busy="installing" busy-label="安装中" @click="onInstall">
            安装/修复依赖
          </AppButton>
          <AppButton variant="ghost" :busy="clearVenvBusy.busy.value" @click="onClearVenv">
            强制清理环境
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

    <ConfirmDialog :open="installStopDialogOpen" title="服务运行中，确认停止并安装？" @close="onInstallStopDialogClose">
      检测到后端服务正在运行，安装新版本依赖需要先停止服务。<b>停止将中断正在执行的任务</b>（回测、研究、实盘等），确认停止并继续安装吗？
      <template #confirm-text>停止并安装</template>
    </ConfirmDialog>

    <ConfirmDialog :open="stopDialogOpen" title="确认停止服务？" @close="onStopDialogClose">
      停止将中断后端进程，<b>请确保当前没有正在执行的任务</b>（回测、研究、实盘等）。
      <template #confirm-text>确认停止</template>
    </ConfirmDialog>

    <ConfirmDialog :open="clearVenvDialogOpen" title="确认强制清理环境？" @close="onClearVenvDialogClose">
      将删除 <b>~/.vibe-trading/venv</b> 虚拟环境(含已安装依赖)，<b>不会删除您的配置、会话等数据</b>。清理后需重新完整安装依赖，确认操作吗？
      <template #confirm-text>确认清理</template>
    </ConfirmDialog>

    <ConfirmDialog :open="clearLogsDialogOpen" title="确认清理日志文件？" @close="onClearLogsDialogClose">
      将删除 <b>~/.vibe-trading/logs</b> 下的所有日志文件（sidecar-*.log），<b>不影响配置、会话等数据</b>。服务运行中当天日志可能被占用而跳过，确认操作吗？
      <template #confirm-text>确认清理</template>
    </ConfirmDialog>

    <ConfirmDialog :open="quitDialogOpen" title="确认退出客户端？" @close="onQuitDialogClose">
      <span v-html="quitText"></span>
      <template #confirm-text>确认退出</template>
    </ConfirmDialog>

    <ConfirmDialog :open="logoutDialogOpen" title="确认退出登录？" @close="onLogoutDialogClose">
      {{ logoutText }}
      <template #confirm-text>确认退出</template>
    </ConfirmDialog>
    <!-- 广告位 bottom:横条 -->
    <AdSlot :ad="adBottom" variant="bottom" />
    <div id="err">{{ errorMsg }}</div>

    <LogViewer ref="logViewer" @open-logs="onOpenLogs" @clear-logs="onClearLogs" />


    <!-- 版本号展示 -->
    <VersionFooter />
  </main>
</template>

<style>
@import "../styles/console.css";
</style>
