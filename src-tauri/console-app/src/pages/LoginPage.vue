<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { useRouter } from "vue-router";

import {
  consoleLoginCaptcha,
  consoleLoginSendSms,
  consoleLoginByPhone,
  consoleLoginByPassword,
  consoleLoginRegister,
} from "../ipc/commands";
import type { Captcha, LoginResultView } from "../ipc/types";
import { useAuthStore } from "../stores/auth";
import { useBusy } from "../composables/useBusy";
import SetPasswordModal from "../components/SetPasswordModal.vue";
import logoPng from "../assets/128x128@2x.png";

const router = useRouter();
const auth = useAuthStore();

const tab = ref<"sms" | "password" | "register">("sms");
const captcha = ref<Captcha | null>(null);
const phone = ref("");
const captchaCode = ref("");
const smsCode = ref("");
const password = ref("");
const registerPhone = ref("");
const registerPassword = ref("");
const registerCaptchaCode = ref("");
const registerSmsCode = ref("");
const countdown = ref(0);
const err = ref("");
const showSetPwd = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const PHONE_RE = /^1\d{10}$/;
const isCode4 = (s: string) => /^\d{4}$/.test(s) || /^[0-9a-zA-Z]{4}$/.test(s);
const PASSWORD_RE = /^(?=.{6,10}$)(?=.*[A-Z])(?=.*\d)(?=.*[!-/:-@[-`{-~])[!-~]+$/;
const phoneValid = computed(() => PHONE_RE.test(phone.value));
const captchaValid = computed(() => isCode4(captchaCode.value));
const smsValid = computed(() => isCode4(smsCode.value));
const passwordValid = computed(() => password.value.length >= 6);
const registerPhoneValid = computed(() => PHONE_RE.test(registerPhone.value));
const registerPasswordValid = computed(() => PASSWORD_RE.test(registerPassword.value));
const registerCaptchaValid = computed(() => isCode4(registerCaptchaCode.value));
const registerSmsValid = computed(() => isCode4(registerSmsCode.value));
const registerValid = computed(
  () => registerPhoneValid.value && registerPasswordValid.value && registerCaptchaValid.value && registerSmsValid.value,
);

async function loadCaptcha() {
  err.value = "";
  try {
    captcha.value = await consoleLoginCaptcha();
  } catch (e: any) {
    err.value = e?.message || "验证码加载失败";
  }
}

function setErr(e: unknown, fallback: string) {
  const ae = e as { message?: string };
  err.value = ae?.message || fallback;
  void loadCaptcha();
}

async function sendCode() {
  if (!phoneValid.value || !captchaValid.value || countdown.value > 0) return;
  if (!captcha.value) return;
  try {
    await consoleLoginSendSms(phone.value, captcha.value.captchaId, captchaCode.value);
    countdown.value = 60;
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
  } catch (e) {
    setErr(e, "短信发送失败");
  }
}

async function sendRegisterCode() {
  if (
    !registerPhoneValid.value ||
    !registerPasswordValid.value ||
    !registerCaptchaValid.value ||
    countdown.value > 0 ||
    !captcha.value
  ) return;
  try {
    await consoleLoginSendSms(
      registerPhone.value,
      captcha.value.captchaId,
      registerCaptchaCode.value,
    );
    countdown.value = 60;
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
  } catch (e) {
    setErr(e, "短信发送失败");
  }
}

const submitBusy = useBusy();

async function finishLogin(
  view: LoginResultView,
) {
  auth.setFromLogin(view);
  if (!view.hasPassword) {
    showSetPwd.value = true;
    return;
  }
  router.replace("/");
}

async function submitSms() {
  if (!phoneValid.value || !smsValid.value) return;
  await submitBusy.run("登录中", async () => {
    err.value = "";
    try {
      const view = await consoleLoginByPhone(phone.value, smsCode.value);
      await finishLogin(view);
    } catch (e) {
      setErr(e, "登录失败");
    }
  });
}

async function submitPassword() {
  if (!phoneValid.value || !passwordValid.value) return;
  await submitBusy.run("登录中", async () => {
    err.value = "";
    try {
      const view = await consoleLoginByPassword(phone.value, password.value);
      await finishLogin(view);
    } catch (e) {
      setErr(e, "密码登录失败");
    }
  });
}

async function submitRegister() {
  if (!registerValid.value) return;
  await submitBusy.run("注册中", async () => {
    err.value = "";
    try {
      const view = await consoleLoginRegister(
        registerPhone.value,
        registerSmsCode.value,
        registerPassword.value,
      );
      await finishLogin(view);
    } catch (e) {
      setErr(e, "注册失败");
    }
  });
}

function onPwdModalClose() {
  showSetPwd.value = false;
  router.replace("/");
}

onMounted(() => {
  void loadCaptcha();
  // 已登录直接跳走
  if (auth.authenticated) router.replace("/");
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <main class="login-wrap">
    <section class="card">
      <header class="brand">
        <img class="mark" :src="logoPng" alt="" />
        <div class="brand-text">
          <h1>Vibe Trading</h1>
          <p class="sub">登录后启动服务，自动配置 VIP 大模型</p>
        </div>
      </header>

      <nav class="tabs" role="tablist" aria-label="登录方式">
        <button :class="['tab', tab === 'sms' && 'active']" role="tab" :aria-selected="tab === 'sms'"
          @click="tab = 'sms'">
          短信登录
        </button>
        <button :class="['tab', tab === 'password' && 'active']" role="tab" :aria-selected="tab === 'password'"
          @click="tab = 'password'">
          密码登录
        </button>
        <button data-test="register-tab" :class="['tab', tab === 'register' && 'active']" role="tab"
          :aria-selected="tab === 'register'" @click="tab = 'register'">
          注册
        </button>
      </nav>

      <form v-if="tab === 'sms'" class="form" @submit.prevent="submitSms">
        <label class="row">
          <span class="lbl">手机号</span>
          <input class="field" v-model="phone" inputmode="numeric" placeholder="13800000000" autocomplete="tel"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)" />
        </label>

        <label class="row">
          <span class="lbl">图形验证码</span>
          <div class="inline">
            <input class="field" v-model="captchaCode" placeholder="abcd" autocomplete="off"
              @input="captchaCode = captchaCode.trim().slice(0, 4)" />
            <button type="button" class="captcha-btn" title="刷新验证码" aria-label="刷新验证码" @click="loadCaptcha">
              <img v-if="captcha" :src="captcha.data.startsWith('data:')
                ? captcha.data
                : `data:image/svg+xml;base64,${captcha.data}`
                " alt="图形验证码" />
              <span v-else class="captcha-loading">…</span>
            </button>
          </div>
        </label>

        <label class="row">
          <span class="lbl">短信验证码</span>
          <div class="inline">
            <input class="field" v-model="smsCode" inputmode="numeric" placeholder="1234" autocomplete="one-time-code"
              @input="smsCode = smsCode.trim().slice(0, 4)" />
            <button type="button" class="code-btn" :disabled="!phoneValid || !captchaValid || countdown > 0"
              @click="sendCode">
              {{ countdown > 0 ? `${countdown}s` : "获取" }}
            </button>
          </div>
        </label>

        <button type="button" class="submit" :disabled="!phoneValid || !smsValid || submitBusy.busy.value"
          @click="submitSms">
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
        <button type="button" class="skip-btn" @click="router.replace('/')">
          回到首页
        </button>
      </form>

      <form v-else-if="tab === 'password'" class="form" @submit.prevent="submitPassword">
        <label class="row">
          <span class="lbl">手机号</span>
          <input class="field" v-model="phone" inputmode="numeric" placeholder="13800000000" autocomplete="tel"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)" />
        </label>
        <label class="row">
          <span class="lbl">密码</span>
          <input class="field" type="password" v-model="password" placeholder="请输入密码" autocomplete="current-password" />
        </label>
        <button type="button" class="submit" :disabled="!phoneValid || !passwordValid || submitBusy.busy.value"
          @click="submitPassword">
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
        <button type="button" class="skip-btn" @click="router.replace('/')">
          回到首页
        </button>
      </form>

      <form v-else class="form" @submit.prevent="submitRegister">
        <label class="row">
          <span class="lbl">手机号</span>
          <input data-test="register-phone" class="field" v-model="registerPhone" inputmode="numeric"
            placeholder="13800000000" autocomplete="tel"
            @input="registerPhone = registerPhone.replace(/\D/g, '').slice(0, 11)" />
        </label>
        <label class="row">
          <span class="lbl">密码</span>
          <input data-test="register-password" class="field" type="password" v-model="registerPassword"
            placeholder="6-10 位，含大写、数字和符号" autocomplete="new-password" />
        </label>
        <label class="row">
          <span class="lbl">图形验证码</span>
          <div class="inline">
            <input data-test="register-captcha" class="field" v-model="registerCaptchaCode" placeholder="abcd"
              autocomplete="off" @input="registerCaptchaCode = registerCaptchaCode.trim().slice(0, 4)" />
            <button type="button" class="captcha-btn" title="刷新验证码" aria-label="刷新验证码" @click="loadCaptcha">
              <img v-if="captcha" :src="captcha.data.startsWith('data:')
                ? captcha.data
                : `data:image/svg+xml;base64,${captcha.data}`" alt="图形验证码" />
              <span v-else class="captcha-loading">…</span>
            </button>
          </div>
        </label>
        <label class="row">
          <span class="lbl">短信验证码</span>
          <div class="inline">
            <input data-test="register-sms" class="field" v-model="registerSmsCode" inputmode="numeric"
              placeholder="1234" autocomplete="one-time-code"
              @input="registerSmsCode = registerSmsCode.trim().slice(0, 4)" />
            <button data-test="register-send-code" type="button" class="code-btn"
              :disabled="!registerPhoneValid || !registerPasswordValid || !registerCaptchaValid || countdown > 0"
              @click="sendRegisterCode">
              {{ countdown > 0 ? `${countdown}s` : "获取" }}
            </button>
          </div>
        </label>
        <button data-test="register-submit" type="button" class="submit"
          :disabled="!registerValid || submitBusy.busy.value" @click="submitRegister">
          {{ submitBusy.busy.value ? "注册中…" : "注册" }}
        </button>
        <button type="button" class="skip-btn" @click="router.replace('/')">
          回到首页
        </button>
      </form>

      <p v-if="err" class="err" role="alert">{{ err }}</p>
    </section>

    <SetPasswordModal :open="showSetPwd" @close="onPwdModalClose" />
  </main>
</template>

<style scoped>
/* 卡片不继承 body 的 580px .console 宽度:登录页是独立全屏门面。*/
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  position: relative;
  z-index: 1;
}

.card {
  width: 480px;
  background: hsl(var(--surface-1));
  border: 1px solid hsl(var(--line));
  border-radius: 16px;
  padding: 28px 26px 24px;
  box-shadow:
    0 1px 0 hsl(0 0% 100% / 0.04) inset,
    0 24px 60px hsl(0 0% 0% / 0.45),
    0 6px 18px hsl(220 70% 4% / 0.6);
  position: relative;
}

/* 卡片顶部一条极细的 brand 光晕——门面仪式感,静态,不抢戏。
   降级友好:不支持 mask-composite 时仅丢失这条描边,卡片边框仍在。*/
.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(180deg,
      hsl(var(--brand) / 0.55),
      hsl(var(--brand) / 0) 32%);
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-bottom: 22px;
}

.mark {
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  filter: drop-shadow(0 4px 12px hsl(var(--brand) / 0.25));
}

.brand-text {
  min-width: 0;
}

h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.sub {
  margin-top: 3px;
  font-size: 12.5px;
  color: hsl(var(--ink-dim));
  line-height: 1.45;
}

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  border-bottom: 1px solid hsl(var(--line));
}

.tab {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 9px 4px 11px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  border-radius: 0;
  color: hsl(var(--ink-dim));
  font-size: 13.5px;
  font-weight: 550;
  cursor: pointer;
  transition:
    color 0.18s var(--ease),
    border-color 0.18s var(--ease);
}

.tab:hover:not(.active) {
  color: hsl(var(--ink));
}

.tab.active {
  color: hsl(var(--brand));
  border-bottom-color: hsl(var(--brand));
}

.tab:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 4px;
  border-radius: 4px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lbl {
  font-size: 12.5px;
  font-weight: 550;
  color: hsl(var(--ink-dim));
}

.field {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: hsl(var(--ink));
  background: hsl(var(--surface-2));
  border: 1px solid hsl(var(--line));
  border-radius: 9px;
  transition:
    border-color 0.16s var(--ease),
    box-shadow 0.16s var(--ease),
    background 0.16s var(--ease);
}

.field::placeholder {
  color: hsl(var(--ink-dim) / 0.7);
}

.field:hover {
  border-color: hsl(var(--ink-dim) / 0.4);
}

.field:focus {
  outline: none;
  border-color: hsl(var(--brand) / 0.7);
  background: hsl(var(--surface-2) / 0.92);
  box-shadow: 0 0 0 3px hsl(var(--brand) / 0.16);
}

.inline {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.inline .field {
  flex: 1;
  min-width: 0;
}

.captcha-btn {
  flex: none;
  width: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: hsl(var(--surface-2));
  border: 1px solid hsl(var(--line));
  border-radius: 9px;
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color 0.16s var(--ease),
    transform 0.12s var(--ease);
}

.captcha-btn:hover {
  border-color: hsl(var(--brand) / 0.5);
}

.captcha-btn:active {
  transform: translateY(1px);
}

.captcha-btn:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}

.captcha-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.captcha-loading {
  font-size: 13px;
  color: hsl(var(--ink-dim));
}

.code-btn {
  flex: none;
  width: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 10px;
  background: hsl(var(--surface-2));
  color: hsl(var(--brand));
  border: 1px solid hsl(var(--line));
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.16s var(--ease),
    border-color 0.16s var(--ease),
    transform 0.12s var(--ease);
}

.code-btn:hover:not(:disabled) {
  border-color: hsl(var(--brand) / 0.5);
  background: hsl(var(--brand) / 0.08);
}

.code-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.code-btn:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}

.code-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.submit {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 4px;
  padding: 11px 14px;
  background: hsl(var(--brand));
  color: hsl(var(--on-brand));
  border: 0;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.01em;
  cursor: pointer;
  box-shadow: 0 6px 18px hsl(var(--brand) / 0.28);
  transition:
    background 0.18s var(--ease),
    box-shadow 0.18s var(--ease),
    transform 0.12s var(--ease),
    opacity 0.18s var(--ease);
}

.submit:hover:not(:disabled) {
  background: hsl(var(--brand-strong));
  box-shadow: 0 8px 22px hsl(var(--brand) / 0.36);
}

.submit:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 4px 12px hsl(var(--brand) / 0.24);
}

.submit:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 3px;
}

.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.skip-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 9px 12px;
  background: transparent;
  color: hsl(var(--ink-dim));
  border: 1px solid hsl(var(--line));
  border-radius: 999px;
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  transition:
    color 0.16s var(--ease),
    border-color 0.16s var(--ease),
    background 0.16s var(--ease);
}

.skip-btn:hover {
  color: hsl(var(--ink));
  border-color: hsl(var(--ink-dim) / 0.5);
  background: hsl(var(--surface-2) / 0.5);
}

.skip-btn:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}

.err {
  margin-top: 14px;
  padding: 10px 12px;
  background: hsl(var(--bad) / 0.1);
  border: 1px solid hsl(var(--bad) / 0.3);
  border-radius: 9px;
  color: hsl(var(--bad-fg));
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-word;
}
</style>
