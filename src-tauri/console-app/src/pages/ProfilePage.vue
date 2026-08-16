<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useAuthStore } from "../stores/auth";
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { consoleLogout, consoleMemberBenefits, consoleMemberUsage } from "../ipc/commands";
import type { MemberBenefit, MemberUsageView } from "../ipc/types";
import AppButton from "../components/AppButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useBusy } from "../composables/useBusy";
import { config as ProdConfig } from "../config/prod";
import { CircleUserRound, Gift, Headset, RefreshCw } from "@lucide/vue";

const router = useRouter();
const auth = useAuthStore();
const env = useEnvStore();
const service = useServiceStore();
const { serviceRunning } = storeToRefs(env);
const benefits = ref<MemberBenefit[]>([]);
const loading = ref(true);
const loadError = ref("");
const actionError = ref("");
const logoutOpen = ref(false);
const logoutBusy = useBusy();
const accountName = computed(() => auth.userInfo?.nickName || auth.userInfo?.phone || "已登录");
const level = computed(() => auth.userInfo?.memberLevel);
const memberTier = computed(() => {
  const current = level.value;
  if (!current) return null;
  const name = current.name?.trim() || "会员";
  const identity = `${current.code ?? ""} ${name}`.toLowerCase();
  const tone = /vip|elite|ultimate|diamond|至尊/.test(identity) || current.levelValue >= 50
    ? "signature"
    : /pro|premium|plus|gold|高级/.test(identity) || current.levelValue >= 20
      ? "pro"
      : "member";
  return { name, tone, label: name.includes("会员") ? name : `${name} 会员` };
});
const logoutText = computed(() => serviceRunning.value ? "若您退出登录，当前服务将会重启，正在任务中的智能体也会被强制关闭，确认操作吗？" : "若您退出登录，则需要您手动配置大模型，确认操作吗？");
const kefuDialogOpen = ref(false);
const rewardDialogOpen = ref(false);
const membershipUpdateNotice = ref(false);
const membershipRestartDialogOpen = ref(false);
const memberUsage = ref<MemberUsageView | null>(null);
const usageRefreshing = ref(false);
const membershipRefreshBusy = useBusy();
const usageNumberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const kefuQrCode = computed(() => ProdConfig.kefuQrCode.trim());
const rewardQrCode = computed(() => ProdConfig.rewardQrCode.trim());
let usageTimer: ReturnType<typeof setInterval> | null = null;

function formatUsageAmount(value: number) {
  return usageNumberFormatter.format(value);
}

const remainingPercent = computed(() => {
  const usage = memberUsage.value;
  if (!usage || usage.total_granted <= 0) return 0;
  return Math.min(100, Math.max(0, (usage.total_available / usage.total_granted) * 100));
});

function clearMemberUsage() {
  memberUsage.value = null;
  if (usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

async function refreshMemberUsage() {
  if (!auth.authenticated || usageRefreshing.value) return;
  usageRefreshing.value = true;
  try {
    memberUsage.value = await consoleMemberUsage();
  } catch (error: any) {
    if (error?.variant === "LoginExpired") {
      auth.clear();
      clearMemberUsage();
    }
  } finally {
    usageRefreshing.value = false;
  }
}

async function refreshAuthForMembership() {
  await auth.refresh();
  if (!auth.authenticated) {
    clearMemberUsage();
    return false;
  }
  if (auth.membershipChanged) {
    membershipUpdateNotice.value = true;
    memberUsage.value = null;
  }
  return true;
}

async function refreshMembershipUsageManually() {
  if (!await refreshAuthForMembership()) return;
  await refreshMemberUsage();
  if (!serviceRunning.value && auth.authenticated) {
    membershipUpdateNotice.value = false;
    auth.acknowledgeMembershipChange();
  }
}

async function doRestartForMembershipUpdate() {
  await membershipRefreshBusy.run("刷新中", async () => {
    try {
      await service.stop();
      env.setPort(null);
      serviceRunning.value = false;
      const p = await service.start();
      env.setPort(p);
      serviceRunning.value = true;
      membershipUpdateNotice.value = false;
      auth.acknowledgeMembershipChange();
      await refreshMemberUsage();
    } catch (error) {
      actionError.value = String(error);
    }
  });
}

async function onMembershipRestartDialogClose(value: "ok" | "cancel") {
  membershipRestartDialogOpen.value = false;
  if (value === "ok") await doRestartForMembershipUpdate();
}

function onKefuDialogClose() {
  kefuDialogOpen.value = false;
}

function onRewardDialogClose() {
  rewardDialogOpen.value = false;
}

async function loadBenefits() {
  loading.value = true; loadError.value = "";
  try { benefits.value = (await consoleMemberBenefits()).benefits; }
  catch (error: any) {
    if (error?.variant === "LoginExpired" || error?.variant === "NotAuthenticated") { auth.clear(); await router.replace("/login"); return; }
    loadError.value = "权益暂时无法加载";
  } finally { loading.value = false; }
}
async function onLogout(v: "ok" | "cancel") {
  logoutOpen.value = false;
  if (v !== "ok") return;
  await logoutBusy.run("退出中", async () => {
    await consoleLogout(); auth.clear();
    if (serviceRunning.value) { await service.stop(); env.setPort(null); env.setPort(await service.start()); }
    await router.replace("/");
  });
}
onMounted(async () => {
  await auth.refresh();
  if (!auth.authenticated) return router.replace("/login");
  if (auth.membershipChanged) {
    membershipUpdateNotice.value = true;
    memberUsage.value = null;
  }
  void refreshMemberUsage();
  usageTimer = setInterval(async () => {
    if (await refreshAuthForMembership()) void refreshMemberUsage();
  }, 300_000);
  await loadBenefits();
});

onUnmounted(() => clearMemberUsage());
</script>

<template>
  <main class="profile">
    <AppButton variant="ghost" @click="router.push('/')">返回控制台</AppButton>
    <section class="profile-card profile-member-card">
      <div class="profile-identity">
        <CircleUserRound :size="48" stroke-width="1.3" aria-hidden="true" />
        <div>
          <h1 class="profile-title">{{ memberTier?.label ?? "会员账户" }}</h1>
          <p class="profile-meta">{{ accountName }}</p>
        </div>
      </div>
      <p v-if="auth.userInfo?.phone" class="profile-meta">{{ auth.userInfo.phone }}</p>
      <span v-if="level" class="member-tier" :class="`member-tier--${memberTier?.tone ?? 'member'}`">
        <span class="member-tier-mark">V</span><span class="member-tier-name">{{ level.name }}</span>
      </span>
      <p v-if="level?.expireTime" class="profile-meta">有效期至 {{ level.expireTime }}</p>

      <div v-if="membershipUpdateNotice" class="login-notice" role="status">
        会员权益已更新，当前服务仍在使用旧配置。
        <AppButton v-if="serviceRunning" variant="ghost" :busy="membershipRefreshBusy.busy.value"
          data-test="membership-refresh-service" @click="membershipRestartDialogOpen = true">
          重启服务并刷新
        </AppButton>
        <AppButton v-else variant="ghost" data-test="membership-refresh-usage" @click="refreshMembershipUsageManually">
          刷新会员用量
        </AppButton>
      </div>

      <section class="member-usage-section" data-test="member-usage-section" aria-label="会员用量">
        <div class="member-usage-head">
          <span class="member-usage-title">剩余用量</span>
          <AppButton variant="ghost" :busy="usageRefreshing" busy-label="刷新中" data-test="member-usage-refresh"
            @click="refreshMembershipUsageManually">
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

      <div class="profile-support-actions">
        <AppButton v-if="kefuQrCode" variant="ghost" class="member-kefu-entry" data-test="member-kefu-entry"
          @click="kefuDialogOpen = true">
          <Headset :size="15" aria-hidden="true" />联系客服
        </AppButton>
        <AppButton v-if="rewardQrCode" variant="ghost" class="member-kefu-entry" data-test="member-reward-entry"
          @click="rewardDialogOpen = true">
          <Gift :size="15" aria-hidden="true" />支持作者领中级会员
        </AppButton>
      </div>
      <p v-if="actionError" class="profile-meta" role="alert">{{ actionError }}</p>
    </section>
    <section class="profile-card" aria-label="当前会员权益">
      <h2 class="profile-title">当前会员权益</h2>
      <p v-if="loading" class="profile-meta">正在加载会员权益...</p>
      <template v-else-if="loadError"><p class="profile-meta">{{ loadError }}</p><AppButton variant="ghost" @click="loadBenefits">重试</AppButton></template>
      <p v-else-if="benefits.length === 0" class="profile-meta">当前会员暂无可展示权益</p>
      <ul v-else class="benefit-list"><li v-for="benefit in benefits" :key="benefit.id" class="benefit-item"><b>{{ benefit.title }}</b><p v-if="benefit.description">{{ benefit.description }}</p></li></ul>
      <div class="profile-danger-zone"><AppButton variant="danger" :busy="logoutBusy.busy.value" @click="logoutOpen = true">退出登录</AppButton></div>
    </section>
    <ConfirmDialog data-test="kefu-dialog" :open="kefuDialogOpen" title="联系客服"
      :image="ProdConfig.imgBase + kefuQrCode" image-alt="客服微信二维码" hide-cancel @close="onKefuDialogClose">
      <p style="margin-top: 8px;">请使用微信扫描上方二维码添加专属客服</p>
      <template #confirm-text>我知道了</template>
    </ConfirmDialog>
    <ConfirmDialog data-test="reward-dialog" :open="rewardDialogOpen" title="支持作者领专业会员"
      :image="ProdConfig.imgBase + rewardQrCode" image-alt="支持作者二维码" hide-cancel @close="onRewardDialogClose">
      <p style="margin-top: 8px;">将打赏后的截图私发客服领取会员</p>
      <template #confirm-text>我知道了</template>
    </ConfirmDialog>
    <ConfirmDialog data-test="membership-restart-dialog" :open="membershipRestartDialogOpen" title="确认刷新会员服务？"
      @close="onMembershipRestartDialogClose">
      会员权益已更新，需要重启本地服务才能使用新的会员配置。<b>重启会中断正在执行的任务</b>，确认继续吗？
      <template #confirm-text>重启并刷新</template>
    </ConfirmDialog>
    <ConfirmDialog :open="logoutOpen" title="确认退出登录？" @close="onLogout">{{ logoutText }}<template #confirm-text>确认退出</template></ConfirmDialog>
  </main>
</template>

<style>
.profile-identity {
  display: flex;
  align-items: center;
  gap: 12px;
}

.profile-identity > svg {
  flex: none;
  color: hsl(var(--ink-dim));
}

.profile-support-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
</style>
