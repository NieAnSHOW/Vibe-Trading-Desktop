<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { useRouter } from "vue-router";

import {
  consoleLoginCaptcha,
  consoleLoginSendSms,
  consoleLoginByPhone,
  consoleLoginByPassword,
} from "../ipc/commands";
import type { Captcha } from "../ipc/types";
import { useAuthStore } from "../stores/auth";
import { useBusy } from "../composables/useBusy";
import SetPasswordModal from "../components/SetPasswordModal.vue";

const router = useRouter();
const auth = useAuthStore();

const tab = ref<"sms" | "password">("sms");
const captcha = ref<Captcha | null>(null);
const phone = ref("");
const captchaCode = ref("");
const smsCode = ref("");
const password = ref("");
const countdown = ref(0);
const err = ref("");
const showSetPwd = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const PHONE_RE = /^1\d{10}$/;
const isCode4 = (s: string) => /^\d{4}$/.test(s) || /^[0-9a-zA-Z]{4}$/.test(s);
const phoneValid = computed(() => PHONE_RE.test(phone.value));
const captchaValid = computed(() => isCode4(captchaCode.value));
const smsValid = computed(() => isCode4(smsCode.value));
const passwordValid = computed(() => password.value.length >= 6);

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

const submitBusy = useBusy();

async function finishLogin(
  view: { userInfo: any; hasPassword: boolean; expireAt: number },
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
    <div class="card">
      <h1>Vibe Trading</h1>
      <p class="sub">登录后启动服务，自动配置 vip 大模型</p>

      <div class="tabs">
        <button :class="['tab', tab === 'sms' && 'active']" @click="tab = 'sms'">
          短信登录
        </button>
        <button :class="['tab', tab === 'password' && 'active']" @click="tab = 'password'">
          密码登录
        </button>
      </div>

      <div v-if="tab === 'sms'" class="form">
        <label>
          <span>手机号</span>
          <input
            class="field"
            v-model="phone"
            inputmode="numeric"
            placeholder="13800000000"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)"
          />
        </label>

        <label>
          <span>图形验证码</span>
          <div class="inline">
            <input
              class="field"
              v-model="captchaCode"
              placeholder="abcd"
              @input="captchaCode = captchaCode.trim().slice(0, 4)"
            />
            <button
              class="captcha-btn"
              title="刷新验证码"
              @click="loadCaptcha"
            >
              <img
                v-if="captcha"
                :src="
                  captcha.data.startsWith('data:')
                    ? captcha.data
                    : `data:image/svg+xml;base64,${captcha.data}`
                "
                alt="captcha"
              />
              <span v-else>…</span>
            </button>
          </div>
        </label>

        <label>
          <span>短信验证码</span>
          <div class="inline">
            <input
              class="field"
              v-model="smsCode"
              inputmode="numeric"
              placeholder="1234"
              @input="smsCode = smsCode.trim().slice(0, 4)"
            />
            <button
              class="code-btn"
              :disabled="!phoneValid || !captchaValid || countdown > 0"
              @click="sendCode"
            >
              {{ countdown > 0 ? `${countdown}s` : "获取" }}
            </button>
          </div>
        </label>

        <button
          class="submit"
          :disabled="!phoneValid || !smsValid || submitBusy.busy.value"
          @click="submitSms"
        >
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
      </div>

      <div v-else class="form">
        <label>
          <span>手机号</span>
          <input
            class="field"
            v-model="phone"
            inputmode="numeric"
            placeholder="13800000000"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)"
          />
        </label>
        <label>
          <span>密码</span>
          <input
            class="field"
            type="password"
            v-model="password"
            placeholder="******"
          />
        </label>
        <button
          class="submit"
          :disabled="!phoneValid || !passwordValid || submitBusy.busy.value"
          @click="submitPassword"
        >
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>
    </div>

    <SetPasswordModal :open="showSetPwd" @close="onPwdModalClose" />
  </main>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card, #fff);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
h1 {
  margin: 0 0 4px;
  font-size: 20px;
}
.sub {
  margin: 0 0 16px;
  font-size: 12px;
  color: #666;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.tab {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.tab.active {
  border-bottom-color: #2563eb;
  color: #2563eb;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.field {
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
}
.inline {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.inline .field {
  flex: 1;
}
.captcha-btn {
  width: 100px;
  border: 1px solid #ccc;
  background: #70634e;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
}
.captcha-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.code-btn {
  width: 100px;
  border: 1px solid #ccc;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.code-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.submit {
  width: 100%;
  padding: 10px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.err {
  color: #dc2626;
  font-size: 12px;
  margin-top: 8px;
}
</style>
