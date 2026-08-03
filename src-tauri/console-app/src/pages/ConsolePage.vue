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
  consoleQuit,
  consoleFetchAds,
  consoleMemberUsage,
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
import type { AdItem, MemberUsageView } from "../ipc/types";

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
  ArrowUpRight,
  CircleUserRound,
  Database,
  ExternalLink,
  Gift,
  Headset,
  LogIn,
  MessageCircleMore,
  Play,
  RefreshCw,
  ServerCog,
  Settings,
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
const authStore = useAuthStore();
const router = useRouter();

const { env: envState, port, serviceRunning } = storeToRefs(env);

const updateBanner = ref<InstanceType<typeof UpdateBanner> | null>(null);
const errorMsg = ref("");
const pageReady = ref(false);
const pageEntering = ref(false);
const kefuDialogOpen = ref(false);
const kefuQrCode = computed(() => ProdConfig.kefuQrCode.trim());
function onKefuDialogClose() {
  kefuDialogOpen.value = false;
}
const rewardDialogOpen = ref(false);
const rewardQrCode = computed(() => ProdConfig.rewardQrCode.trim());
function onRewardDialogClose() {
  rewardDialogOpen.value = false;
}
const memberUsage = ref<MemberUsageView | null>(null);
const usageRefreshing = ref(false);
const usageNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatUsageAmount(value: number) {
  return usageNumberFormatter.format(value);
}

const remainingPercent = computed(() => {
  const usage = memberUsage.value;
  if (!usage || usage.total_granted <= 0) return 0;
  return Math.min(100, Math.max(0, (usage.total_available / usage.total_granted) * 100));
});

async function refreshMemberUsage() {
  if (!authStore.authenticated || usageRefreshing.value) return;
  usageRefreshing.value = true;
  try {
    memberUsage.value = await consoleMemberUsage();
  } catch (e: any) {
    if (e?.variant === "LoginExpired") {
      authStore.clear();
      clearMemberUsage();
      return;
    }
    // 保留上次成功结果，用量接口不可用不影响控制台其他状态。
  } finally {
    usageRefreshing.value = false;
  }
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

const accountName = computed(
  () => authStore.userInfo?.nickName || authStore.userInfo?.phone || "已登录",
);

const memberTier = computed(() => {
  const level = authStore.userInfo?.memberLevel;
  if (!level) return null;

  const name = level.name?.trim() || "会员";
  const identity = `${level.code ?? ""} ${name}`.toLowerCase();
  const tone = /vip|elite|ultimate|diamond|至尊/.test(identity) || level.levelValue >= 50
    ? "signature"
    : /pro|premium|plus|gold|高级/.test(identity) || level.levelValue >= 20
      ? "pro"
      : "member";

  return {
    name,
    tone,
    caption: name.includes("会员") ? "" : "会员",
    label: name.includes("会员") ? name : `${name} 会员`,
  };
});

const memberExpireTime = computed(() => {
  const expireTime = authStore.userInfo?.memberLevel?.expireTime?.trim();
  return expireTime || null;
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
const isServiceRunning = computed(() => serviceRunning.value);
const btnStartDisabled = computed(
  () => envState.value !== "ready" || isServiceRunning.value || port.value !== null || startBusy.busy.value,
);
const primaryActionKind = computed<"install" | "start" | "open">(() => {
  if (envState.value !== "ready") return "install";
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
      serviceRunning.value = true;
      hintHidden.value = true;
    } catch (e: any) {
      if (e?.variant === "LoginExpired") {
        authStore.clear();
        clearMemberUsage();
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
let usageTimer: ReturnType<typeof setInterval> | null = null;

function clearMemberUsage() {
  memberUsage.value = null;
  if (usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

onMounted(async () => {
  pageReady.value = true;
  pageEntering.value = true;
  // 恢复登录态（静默，不阻塞）
  await authStore.refresh();
  if (ProdConfig.enableLogin && authStore.authenticated) {
    void refreshMemberUsage();
    usageTimer = setInterval(refreshMemberUsage, 300_000);
  }
  // TODO: 暂时禁用自动更新，启动时静默检查更新（失败不影响主流程）
  if (ProdConfig.checkUpdate) {
    updateBanner.value?.checkUpdate().catch(() => { });
  }

  unlistens = await Promise.all([
    onBootstrapEvent((e: BootstrapEvent) => {
      bootstrap.advance(e.stage, e.message ?? "");
      if (e.ok === false) setErr(e.message || "依赖安装失败");
    }),
    onBootstrapExit((code: number) => {
      if (code !== 0 && bootstrap.state !== "done") bootstrap.advance("failed", "");
      installing.value = false; // 权威结束信号:无论成功失败,后台线程退出即释放按钮
      refresh();
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
  clearMemberUsage();
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
      <nav class="header-actions" aria-label="控制台快捷操作">
        <button v-if="ProdConfig.enableLogin && authStore.authenticated" class="account-profile-entry"
          data-test="account-profile-entry" type="button" :aria-label="`打开个人中心，${accountName}`"
          @click="router.push('/profile')">
          <CircleUserRound :size="18" aria-hidden="true" />
          <span class="account-name" :title="accountName">{{ accountName }}</span>
          <span v-if="memberTier" class="member-tier" :class="`member-tier--${memberTier.tone}`"
            :title="`当前会员等级：${memberTier.label}`">
            <span class="member-tier-mark" aria-hidden="true">V</span>
            <span class="member-tier-name">{{ memberTier.name }}</span>
          </span>
        </button>
        <AppButton v-else-if="ProdConfig.enableLogin" variant="ghost" @click="router.push('/login')">
          <LogIn :size="16" aria-hidden="true" />登录使用会员服务
        </AppButton>
        <button class="icon-button" data-test="settings-entry" type="button" aria-label="打开设置" title="设置"
          @click="router.push('/settings')">
          <Settings :size="19" aria-hidden="true" />
        </button>
      </nav>
    </header>

    <section class="console-shell console-page__shell" aria-label="控制台内容" @animationend.self="onStartupAnimationEnd">
      <UpdateBanner ref="updateBanner" />
      <AdSlot :ads="adBanner" variant="banner" />

      <div class="console-workspace"
        :class="{ 'console-workspace--guest': !ProdConfig.enableLogin || !authStore.authenticated }">
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

        <aside v-if="ProdConfig.enableLogin && authStore.authenticated" class="member-panel" aria-label="会员服务">
          <button class="member-profile-link" type="button" @click="router.push('/profile')">
            <CircleUserRound :size="48" stroke-width="1.3" aria-hidden="true" />
            <span class="member-profile-copy">
              <b>{{ memberTier?.label ?? '会员账户' }}</b>
              <small>{{ accountName }}</small>
            </span>
            <ArrowUpRight :size="17" aria-hidden="true" />
          </button>
          <p v-if="memberExpireTime" class="member-expire-time">有效期至 {{ memberExpireTime }}</p>
          <section class="member-usage-section" data-test="member-usage-section" aria-label="会员用量">
            <div class="member-usage-head">
              <span class="member-usage-title">剩余用量</span>
              <AppButton variant="ghost" :busy="usageRefreshing" busy-label="刷新中" data-test="member-usage-refresh"
                @click="refreshMemberUsage">
                <RefreshCw :size="14" aria-hidden="true" />刷新
              </AppButton>
            </div>
            <template v-if="memberUsage?.unlimited_quota">
              <div class="member-usage-unlimited-state">
                <strong class="member-usage-unlimited" data-test="member-usage-unlimited">不限量</strong>
                <span data-test="member-usage-unlimited-note">当前套餐权益</span>
              </div>
            </template>
            <template v-else-if="memberUsage">
              <div class="usage-summary">
                <strong>{{ formatUsageAmount(memberUsage.total_available) }}</strong><span>积分</span>
                <small>{{ Math.round(remainingPercent) }}% 可用</small>
              </div>
              <div class="member-usage-track" role="progressbar" aria-label="剩余额度" :aria-valuenow="remainingPercent"
                aria-valuemin="0" aria-valuemax="100">
                <div class="member-usage-fill" :style="{ width: `${remainingPercent}%` }"></div>
              </div>
              <div class="usage-detail">
                <span>总量 <b>{{ formatUsageAmount(memberUsage.total_granted) }}</b></span>
                <span>已用 <b>{{ formatUsageAmount(memberUsage.total_used) }}</b></span>
              </div>
            </template>
            <p v-else class="member-usage-placeholder">用量暂未加载</p>
          </section>
          <div style="display: flex;justify-content:space-between">
            <AppButton v-if="kefuQrCode" variant="ghost" class="member-kefu-entry" data-test="member-kefu-entry"
              @click="kefuDialogOpen = true">
              <Headset :size="15" aria-hidden="true" />联系客服
            </AppButton>
            <AppButton v-if="rewardQrCode" variant="ghost" class="member-kefu-entry" data-test="member-reward-entry"
              @click="rewardDialogOpen = true">
              <Gift :size="15" aria-hidden="true" />支持作者领中级会员
            </AppButton>
          </div>

        </aside>
      </div>

      <ConfirmDialog data-test="kefu-dialog" :open="kefuDialogOpen" title="联系客服"
        :image="ProdConfig.imgBase + kefuQrCode" image-alt="客服微信二维码" hide-cancel @close="onKefuDialogClose">
        <p style="margin-top: 8px;">请使用微信扫描上方二维码添加专属客服</p>
        <template #confirm-text>我知道了</template>
      </ConfirmDialog>

      <ConfirmDialog data-test="reward-dialog" :open="rewardDialogOpen" title="支持作者领中级会员"
        :image="ProdConfig.imgBase + rewardQrCode" image-alt="支持作者二维码" hide-cancel @close="onRewardDialogClose">
        <p style="margin-top: 8px;">将打赏后的截图私发客服领取会员</p>
        <template #confirm-text>我知道了</template>
      </ConfirmDialog>

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

.login-notice {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid hsl(var(--ok) / 0.3);
  border-radius: 8px;
  background: hsl(var(--ok) / 0.1);
  color: hsl(var(--ok-fg));
  font-size: 13px;
}

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
