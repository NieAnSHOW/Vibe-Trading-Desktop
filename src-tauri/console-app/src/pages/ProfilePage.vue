<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useAuthStore } from "../stores/auth";
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { consoleLogout, consoleMemberBenefits } from "../ipc/commands";
import type { MemberBenefit } from "../ipc/types";
import AppButton from "../components/AppButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useBusy } from "../composables/useBusy";

const router = useRouter();
const auth = useAuthStore();
const env = useEnvStore();
const service = useServiceStore();
const { serviceRunning } = storeToRefs(env);
const benefits = ref<MemberBenefit[]>([]);
const loading = ref(true);
const loadError = ref("");
const logoutOpen = ref(false);
const logoutBusy = useBusy();
const accountName = computed(() => auth.userInfo?.nickName || auth.userInfo?.phone || "已登录");
const level = computed(() => auth.userInfo?.memberLevel);
const logoutText = computed(() => serviceRunning.value ? "若您退出登录，当前服务将会重启，正在任务中的智能体也会被强制关闭，确认操作吗？" : "若您退出登录，则需要您手动配置大模型，确认操作吗？");
const tierTone = computed(() => {
  const value = `${level.value?.code ?? ""} ${level.value?.name ?? ""}`.toLowerCase();
  if (/normal|普通/.test(value)) return "normal";
  if (/vip|elite|ultimate|diamond|至尊/.test(value) || (level.value?.levelValue ?? 0) >= 50) return "signature";
  if (/pro|premium|plus|gold|高级/.test(value) || (level.value?.levelValue ?? 0) >= 20) return "pro";
  return "member";
});

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
onMounted(async () => { await auth.refresh(); if (!auth.authenticated) return router.replace("/login"); await loadBenefits(); });
</script>

<template>
  <main class="profile">
    <AppButton variant="ghost" @click="router.push('/')">返回控制台</AppButton>
    <section class="profile-card">
      <h1 class="profile-title">{{ accountName }}</h1>
      <p v-if="auth.userInfo?.phone" class="profile-meta">{{ auth.userInfo.phone }}</p>
      <span v-if="level" class="member-tier" :class="`member-tier--${tierTone}`"><span class="member-tier-mark">V</span><span class="member-tier-name">{{ level.name }}</span></span>
      <p v-if="level?.expireTime" class="profile-meta">有效期至 {{ level.expireTime }}</p>
    </section>
    <section class="profile-card" aria-label="当前会员权益">
      <h2 class="profile-title">当前会员权益</h2>
      <p v-if="loading" class="profile-meta">正在加载会员权益...</p>
      <template v-else-if="loadError"><p class="profile-meta">{{ loadError }}</p><AppButton variant="ghost" @click="loadBenefits">重试</AppButton></template>
      <p v-else-if="benefits.length === 0" class="profile-meta">当前会员暂无可展示权益</p>
      <ul v-else class="benefit-list"><li v-for="benefit in benefits" :key="benefit.id" class="benefit-item"><b>{{ benefit.title }}</b><p v-if="benefit.description">{{ benefit.description }}</p></li></ul>
      <div class="profile-danger-zone"><AppButton variant="danger" :busy="logoutBusy.busy.value" @click="logoutOpen = true">退出登录</AppButton></div>
    </section>
    <ConfirmDialog :open="logoutOpen" title="确认退出登录？" @close="onLogout">{{ logoutText }}<template #confirm-text>确认退出</template></ConfirmDialog>
  </main>
</template>
