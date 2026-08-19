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
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBusy } from "../composables/useBusy";
import SetPasswordModal from "../components/SetPasswordModal.vue";
import logoPng from "../assets/128x128@2x.png";
import { Layers, MessageCircle, ShieldCheck } from "@lucide/vue";

const router = useRouter();
const auth = useAuthStore();
const env = useEnvStore();
const service = useServiceStore();

const tab = ref<"sms" | "password" | "register">("sms");
const captcha = ref<Captcha | null>(null);
const phone = ref("");
const phoneTouched = ref(false);
const captchaCode = ref("");
const captchaTouched = ref(false);
const smsCode = ref("");
const smsTouched = ref(false);
const password = ref("");
const passwordTouched = ref(false);
const registerPhone = ref("");
const registerPhoneTouched = ref(false);
const registerPassword = ref("");
const registerPwdTouched = ref(false);
const registerCaptchaCode = ref("");
const registerCaptchaTouched = ref(false);
const registerSmsCode = ref("");
const registerSmsTouched = ref(false);
const rememberLogin = ref(true);
const countdown = ref(0);
const err = ref("");
const notice = ref("");
const showSetPwd = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const PHONE_RE = /^1\d{10}$/;
const isCode4 = (s: string) => /^\d{4}$/.test(s) || /^[0-9a-zA-Z]{4}$/.test(s);
const PASSWORD_RE = /^(?=.{6,10}$)(?=.*[A-Z])(?=.*\d).+$/;
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

// 失焦校验:输入框有内容且格式不合法时,显示对应错误提示
const touched = (t: boolean, filled: boolean) => t && filled;
const phoneError = computed(() => touched(phoneTouched.value, phone.value !== "") && !phoneValid.value);
const captchaError = computed(() => touched(captchaTouched.value, captchaCode.value !== "") && !captchaValid.value);
const smsError = computed(() => touched(smsTouched.value, smsCode.value !== "") && !smsValid.value);
const passwordError = computed(() => touched(passwordTouched.value, password.value !== "") && !passwordValid.value);
const registerPhoneError = computed(
  () => touched(registerPhoneTouched.value, registerPhone.value !== "") && !registerPhoneValid.value,
);
const registerPwdError = computed(
  () => touched(registerPwdTouched.value, registerPassword.value !== "") && !registerPasswordValid.value,
);
const registerCaptchaError = computed(
  () => touched(registerCaptchaTouched.value, registerCaptchaCode.value !== "") && !registerCaptchaValid.value,
);
const registerSmsError = computed(
  () => touched(registerSmsTouched.value, registerSmsCode.value !== "") && !registerSmsValid.value,
);

function responseMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

async function loadCaptcha(clearFeedback = true) {
  if (clearFeedback) {
    err.value = "";
    notice.value = "";
  }
  try {
    captcha.value = await consoleLoginCaptcha();
  } catch (e) {
    if (clearFeedback) err.value = responseMessage(e, "验证码加载失败");
  }
}

function refreshCaptcha() {
  void loadCaptcha();
}

function setErr(e: unknown, fallback: string) {
  notice.value = "";
  err.value = responseMessage(e, fallback);
  // 刷新图形验证码不能清掉刚捕获的接口错误，也不能用刷新失败覆盖它。
  void loadCaptcha(false);
}

function setNotice(message: string, fallback: string) {
  err.value = "";
  notice.value = message || fallback;
}

async function sendCode() {
  if (!phoneValid.value || !captchaValid.value || countdown.value > 0) return;
  if (!captcha.value) return;
  try {
    const response = await consoleLoginSendSms(phone.value, captcha.value.captchaId, captchaCode.value);
    setNotice(response.message, "验证码已发送");
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
    const response = await consoleLoginSendSms(
      registerPhone.value,
      captcha.value.captchaId,
      registerCaptchaCode.value,
    );
    setNotice(response.message, "验证码已发送");
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
const continueCustomBusy = useBusy();

async function continueWithCustom() {
  err.value = "";
  await continueCustomBusy.run("启动中", async () => {
    try {
      await env.refresh();
      if (env.error) throw new Error(env.error);
      if (!env.serviceRunning) {
        const port = await service.start({ openWebui: false });
        env.setPort(port);
        env.serviceRunning = true;
      }
      if (env.port == null) throw new Error("无法获取本地服务端口");
      await router.replace("/settings");
    } catch (error) {
      err.value = responseMessage(error, "本地服务启动失败");
    }
  });
}

async function finishLogin(
  view: LoginResultView,
) {
  auth.setFromLogin(view);
  setNotice(view.message, "登录成功");
  if (!view.hasPassword) {
    showSetPwd.value = true;
    return;
  }
  await router.replace({
    path: "/",
    query: { loginMessage: view.message || "登录成功" },
  });
}

async function submitSms() {
  if (!phoneValid.value || !smsValid.value) return;
  await submitBusy.run("登录中", async () => {
    err.value = "";
    notice.value = "";
    try {
      const view = await consoleLoginByPhone(phone.value, smsCode.value, rememberLogin.value);
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
    notice.value = "";
    try {
      const view = await consoleLoginByPassword(phone.value, password.value, rememberLogin.value);
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
    notice.value = "";
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

function showRegister() {
  resetTouched();
  tab.value = "register";
}

function showLogin() {
  resetTouched();
  tab.value = "sms";
}

function switchTab(next: "sms" | "password" | "register") {
  resetTouched();
  tab.value = next;
}

function resetTouched() {
  phoneTouched.value = false;
  captchaTouched.value = false;
  smsTouched.value = false;
  passwordTouched.value = false;
  registerPhoneTouched.value = false;
  registerPwdTouched.value = false;
  registerCaptchaTouched.value = false;
  registerSmsTouched.value = false;
}

onMounted(async () => {
  void loadCaptcha();
  // 从磁盘恢复的会话没有 userInfo，但仍是有效的记住登录。
  if (!auth.authenticated) await auth.refresh();
  if (auth.authenticated) await router.replace("/");
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <main class="login-page">
    <!-- 单列居中门面:标题 → 登录卡 → 卖点,自上而下即任务路径 -->
    <header class="login-intro">
      <h1 class="login-title">用自然语言，做专业级研究</h1>
    </header>

    <section class="card">
      <header class="login-brand">
        <img class="login-brand__mark" :src="logoPng" alt="Trading Worker 图标" />
        <div class="login-brand__copy">
          <span class="login-brand__name">Trading Worker</span>
          <span class="login-brand__tag">Local AI Research Workstation</span>
        </div>
      </header>

      <nav v-if="tab !== 'register'" class="tabs" role="tablist" aria-label="登录方式">
          <button :class="['tab', tab === 'sms' && 'active']" role="tab" :aria-selected="tab === 'sms'"
            @click="switchTab('sms')">
            短信登录
          </button>
          <button :class="['tab', tab === 'password' && 'active']" role="tab" :aria-selected="tab === 'password'"
            @click="switchTab('password')">
            密码登录
          </button>
        </nav>

        <form v-if="tab === 'sms'" class="form" @submit.prevent="submitSms">
          <label class="row">
            <span class="lbl">手机号</span>
            <input class="field" :class="{ invalid: phoneError }" v-model="phone" inputmode="numeric"
              placeholder="请输入 11 位手机号" autocomplete="tel"
              @input="phone = phone.replace(/\D/g, '').slice(0, 11); phoneTouched = false"
              @blur="phoneTouched = true" />
            <span v-if="phoneError" class="field-error" role="alert">请输入正确的手机号,如 13800000000</span>
          </label>

          <label class="remember-row">
            <input data-test="remember-login" v-model="rememberLogin" type="checkbox" />
            <span>记住登录（有效期 14 天）</span>
          </label>

          <label class="row">
            <span class="lbl">图形验证码</span>
            <div class="inline">
              <input class="field" :class="{ invalid: captchaError }" v-model="captchaCode" placeholder="请输入 4 位验证码"
                autocomplete="off" @input="captchaCode = captchaCode.trim().slice(0, 4); captchaTouched = false"
                @blur="captchaTouched = true" />
              <button type="button" class="captcha-btn" title="刷新验证码" aria-label="刷新验证码" @click="refreshCaptcha">
                <img v-if="captcha" :src="captcha.data.startsWith('data:')
                  ? captcha.data
                  : `data:image/svg+xml;base64,${captcha.data}`
                  " alt="图形验证码" />
                <span v-else class="captcha-loading">…</span>
              </button>
            </div>
            <span v-if="captchaError" class="field-error" role="alert">请输入 4 位图形验证码,如 abcd</span>
          </label>

          <label class="row">
            <span class="lbl">短信验证码</span>
            <div class="inline">
              <input class="field" :class="{ invalid: smsError }" v-model="smsCode" inputmode="numeric"
                placeholder="请输入 4 位短信验证码" autocomplete="one-time-code"
                @input="smsCode = smsCode.trim().slice(0, 4); smsTouched = false" @blur="smsTouched = true" />
              <button type="button" class="code-btn" :disabled="!phoneValid || !captchaValid || countdown > 0"
                @click="sendCode">
                {{ countdown > 0 ? `${countdown}s` : "获取" }}
              </button>
            </div>
            <span v-if="smsError" class="field-error" role="alert">请输入 4 位短信验证码,如 1234</span>
          </label>

          <button type="button" class="submit" :disabled="!phoneValid || !smsValid || submitBusy.busy.value"
            @click="submitSms">
            {{ submitBusy.busy.value ? "登录中…" : "登录" }}
          </button>
        </form>

        <form v-else-if="tab === 'password'" class="form" @submit.prevent="submitPassword">
          <label class="row">
            <span class="lbl">手机号</span>
            <input class="field" :class="{ invalid: phoneError }" v-model="phone" inputmode="numeric"
              placeholder="请输入 11 位手机号" autocomplete="tel"
              @input="phone = phone.replace(/\D/g, '').slice(0, 11); phoneTouched = false"
              @blur="phoneTouched = true" />
            <span v-if="phoneError" class="field-error" role="alert">请输入正确的手机号,如 13800000000</span>
          </label>
          <label class="remember-row">
            <input data-test="remember-login" v-model="rememberLogin" type="checkbox" />
            <span>记住登录（有效期 14 天）</span>
          </label>
          <label class="row">
            <span class="lbl">密码</span>
            <input class="field" :class="{ invalid: passwordError }" type="password" v-model="password"
              placeholder="请输入登录密码" autocomplete="current-password"
              @input="passwordTouched = false" @blur="passwordTouched = true" />
            <span v-if="passwordError" class="field-error" role="alert">密码长度至少 6 位</span>
          </label>
          <button type="button" class="submit" :disabled="!phoneValid || !passwordValid || submitBusy.busy.value"
            @click="submitPassword">
            {{ submitBusy.busy.value ? "登录中…" : "登录" }}
          </button>
        </form>

        <form v-else class="form" @submit.prevent="submitRegister">
          <label class="row">
            <span class="lbl">手机号</span>
            <input data-test="register-phone" class="field" :class="{ invalid: registerPhoneError }" v-model="registerPhone"
              inputmode="numeric" placeholder="请输入 11 位手机号" autocomplete="tel"
              @input="registerPhone = registerPhone.replace(/\D/g, '').slice(0, 11); registerPhoneTouched = false"
              @blur="registerPhoneTouched = true" />
            <span v-if="registerPhoneError" class="field-error" role="alert">请输入正确的手机号,如 13800000000</span>
          </label>
          <label class="row">
            <span class="lbl">密码</span>
            <input data-test="register-password" class="field" :class="{ invalid: registerPwdError }" type="password"
              v-model="registerPassword" placeholder="6-10 位，含大写字母和数字" autocomplete="new-password"
              @input="registerPwdTouched = false" @blur="registerPwdTouched = true" />
            <span v-if="registerPwdError" class="field-error" role="alert">
              密码格式不正确，需 6-10 位且同时包含大写字母和数字，示例：Exa123
            </span>
          </label>
          <label class="row">
            <span class="lbl">图形验证码</span>
            <div class="inline">
              <input data-test="register-captcha" class="field" :class="{ invalid: registerCaptchaError }"
                v-model="registerCaptchaCode" placeholder="请输入 4 位验证码" autocomplete="off"
                @input="registerCaptchaCode = registerCaptchaCode.trim().slice(0, 4); registerCaptchaTouched = false"
                @blur="registerCaptchaTouched = true" />
              <button type="button" class="captcha-btn" title="刷新验证码" aria-label="刷新验证码" @click="refreshCaptcha">
                <img v-if="captcha" :src="captcha.data.startsWith('data:')
                  ? captcha.data
                  : `data:image/svg+xml;base64,${captcha.data}`" alt="图形验证码" />
                <span v-else class="captcha-loading">…</span>
              </button>
            </div>
            <span v-if="registerCaptchaError" class="field-error" role="alert">请输入 4 位图形验证码,如 abcd</span>
          </label>
          <label class="row">
            <span class="lbl">短信验证码</span>
            <div class="inline">
              <input data-test="register-sms" class="field" :class="{ invalid: registerSmsError }"
                v-model="registerSmsCode" inputmode="numeric" placeholder="请输入 4 位短信验证码"
                autocomplete="one-time-code"
                @input="registerSmsCode = registerSmsCode.trim().slice(0, 4); registerSmsTouched = false"
                @blur="registerSmsTouched = true" />
              <button data-test="register-send-code" type="button" class="code-btn"
                :disabled="!registerPhoneValid || !registerPasswordValid || !registerCaptchaValid || countdown > 0"
                @click="sendRegisterCode">
                {{ countdown > 0 ? `${countdown}s` : "获取" }}
              </button>
            </div>
            <span v-if="registerSmsError" class="field-error" role="alert">请输入 4 位短信验证码,如 1234</span>
          </label>
          <button data-test="register-submit" type="button" class="submit"
            :disabled="!registerValid || submitBusy.busy.value" @click="submitRegister">
            {{ submitBusy.busy.value ? "注册中…" : "注册" }}
          </button>
        </form>

        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
        <p v-if="err" class="err" role="alert">{{ err }}</p>

        <footer class="login-links">
          <button data-test="continue-custom" type="button" class="skip-btn"
            :disabled="continueCustomBusy.busy.value" @click="continueWithCustom">
            {{ continueCustomBusy.busy.value ? "启动中…" : "使用自定义模型继续" }}
          </button>
          <button v-if="tab !== 'register'" data-test="register-entry" type="button" class="register-entry"
            @click="showRegister">
            没有账号？注册
          </button>
          <button v-else data-test="back-to-login" type="button" class="register-entry" @click="showLogin">
            已有账号？去登录
          </button>
        </footer>
      </section>

      <SetPasswordModal :open="showSetPwd" @close="onPwdModalClose" />

      <ul class="login-points" aria-label="产品要点">
        <li>
          <MessageCircle :size="18" aria-hidden="true" />
          <strong>对话式研究</strong>
          <span>直接问“帮我回测一个均线交叉策略”，不用写代码</span>
        </li>
        <li>
          <Layers :size="18" aria-hidden="true" />
          <strong>70+ 金融技能</strong>
          <span>覆盖技术分析、基本面、策略回测、加密货币等</span>
        </li>
        <li>
          <ShieldCheck :size="18" aria-hidden="true" />
          <strong>本地运行</strong>
          <span>数据与 API Key 只存放在你自己的电脑上</span>
        </li>
      </ul>
  </main>
</template>

<style scoped>
/* 登录页不套引导页外壳:独立全屏门面。
   body 有 18px padding,这里用 min-height 撑满剩余视口。 */
/* 登录页不套引导页外壳:独立全屏门面。
   body 默认是 flex + justify-content:center(为 580px 控制台服务),
   展开逻辑见 console.css 的 body:has(> #app > .shell-content > [data-test="console-surface"] > .login-page)。 */
/* ── 门面:单列居中(标题 → 登录卡 → 卖点)。随全局亮/暗主题切换:
   浅色为设计系统"米白纸面",深色为"近黑蓝研究底";品牌色仍全局生效 ── */
.login-page {
  --login-canvas:
    radial-gradient(
      64% 42% at 50% -6%,
      hsl(var(--brand) / 0.07),
      transparent 62%
    ),
    radial-gradient(
      44% 30% at 6% 104%,
      oklch(0.66 0.04 85 / 0.05),
      transparent 60%
    ),
    linear-gradient(164deg, oklch(0.975 0.008 95) 0%, oklch(0.955 0.01 100) 100%);
  --login-noise-opacity: 0.03;
  --login-card-shadow:
    0 1px 2px hsl(220 20% 30% / 0.05),
    0 16px 40px hsl(220 20% 30% / 0.1);
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: safe center;
  gap: 30px;
  width: 100%;
  min-height: 100dvh;
  padding: 30px 20px 34px;
}

html[data-theme="dark"] .login-page {
  --login-canvas:
    radial-gradient(
      64% 42% at 50% -6%,
      hsl(var(--brand) / 0.14),
      transparent 62%
    ),
    radial-gradient(
      44% 30% at 6% 104%,
      oklch(0.66 0.04 85 / 0.05),
      transparent 60%
    ),
    linear-gradient(164deg, oklch(0.058 0.007 222) 0%, oklch(0.042 0.006 214) 100%);
  --login-noise-opacity: 0.05;
  --login-card-shadow:
    0 1px 0 hsl(0 0% 100% / 0.06) inset,
    0 1px 2px hsl(220 50% 3% / 0.5),
    0 16px 36px hsl(220 60% 3% / 0.5),
    0 40px 90px -20px hsl(220 70% 2% / 0.55);
}

.login-page::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: var(--login-canvas);
}

/* 噪点纹理:消除大面积纯色的“塑料感”,只做氛围,不承载信息。 */
.login-page::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: url("data:image/svg+xml;charset=utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  background-size: 180px 180px;
  opacity: var(--login-noise-opacity);
  mix-blend-mode: overlay;
}

/* 衬线标题:品牌承诺,先于任务被读到 */
.login-title {
  max-width: 18em;
  font-family: var(--tw-display);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 400;
  letter-spacing: 0.01em;
  line-height: 1.25;
  text-align: center;
  text-wrap: balance;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 18px;
  margin-bottom: 4px;
}

.login-brand__mark {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  box-shadow:
    0 1px 0 hsl(0 0% 100% / 0.08) inset,
    0 6px 16px hsl(var(--brand) / 0.18);
}

.login-brand__copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.login-brand__name {
  font-family: var(--tw-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.login-brand__tag {
  font-family: var(--tw-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--tw-gold);
}

/* 卡底链接行:回到首页 / 注册入口 */
.login-links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
  margin-top: 18px;
}

/* 卡下卖点:信任背书,退为暗调 */
.login-points {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px 40px;
  max-width: 780px;
  padding: 0;
  list-style: none;
}

.login-points li {
  display: grid;
  min-width: 168px;
  gap: 6px;
  justify-items: center;
  text-align: center;
}

.login-points svg {
  color: hsl(var(--brand));
}

.login-points strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.login-points span {
  max-width: 22em;
  font-size: 11.5px;
  line-height: 1.5;
  color: hsl(var(--ink-dim));
}

.card {
  width: 100%;
  max-width: 440px;
  background: hsl(var(--surface-1));
  border: 1px solid hsl(var(--line));
  border-radius: 18px;
  padding: 30px 28px 26px;
  box-shadow: var(--login-card-shadow);
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
  border-radius: 8px;
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
  border-color: hsl(var(--brand) / 0.65);
  background: hsl(var(--surface-2));
}

/* 注册密码失焦校验失败:醒目红色边框 + 提示文字 */
.field.invalid {
  border-color: hsl(var(--bad) / 0.75);
}

.field.invalid:focus {
  border-color: hsl(var(--bad));
}

.field-error {
  font-size: 12px;
  line-height: 1.5;
  color: hsl(var(--bad-fg));
}

.inline {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.inline .field {
  flex: 1;
  min-width: 0;
  font-family: var(--tw-mono);
  font-size: 13.5px;
}

.captcha-btn {
  flex: none;
  width: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: hsl(46.67, 0.5%, 29.35%);
  border: 1px solid hsl(var(--line));
  border-radius: 8px;
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
  border-radius: 8px;
  font-family: var(--tw-mono);
  font-size: 12.5px;
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
  padding: 13px 14px;
  background: hsl(var(--brand));
  color: #fff;
  border: 0;
  border-radius: 8px;
  font-family: var(--tw-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  box-shadow:
    0 1px 0 hsl(0 0% 100% / 0.2) inset,
    0 6px 20px hsl(var(--brand) / 0.3),
    0 2px 6px hsl(175 60% 18% / 0.4);
  transition:
    background 0.18s var(--ease),
    box-shadow 0.18s var(--ease),
    transform 0.12s var(--ease),
    opacity 0.18s var(--ease);
}

.submit:hover:not(:disabled) {
  background: hsl(var(--brand-strong));
  box-shadow:
    0 1px 0 hsl(0 0% 100% / 0.24) inset,
    0 10px 28px hsl(var(--brand) / 0.4),
    0 4px 10px hsl(175 60% 18% / 0.5);
}

.submit:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow:
    0 1px 0 hsl(0 0% 100% / 0.15) inset,
    0 4px 12px hsl(var(--brand) / 0.24);
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
  padding: 2px 4px;
  border: 0;
  background: transparent;
  color: hsl(var(--ink-dim));
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: color 0.16s var(--ease);
}

.skip-btn:hover {
  color: hsl(var(--ink));
  text-decoration: underline;
  text-underline-offset: 3px;
}

.skip-btn:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
  border-radius: 4px;
}
.remember-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: hsl(var(--ink-dim));
  font-size: 12.5px;
  cursor: pointer;
}

.remember-row input {
  width: 15px;
  height: 15px;
  accent-color: hsl(var(--brand));
}

.register-entry {
  align-self: center;
  padding: 2px 6px;
  border: 0;
  background: transparent;
  color: hsl(var(--brand));
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.register-entry:hover {
  text-decoration: underline;
}

.register-entry:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
  border-radius: 4px;
}

.err {
  margin-top: 14px;
  padding: 10px 12px;
  background: hsl(var(--bad) / 0.1);
  border: 1px solid hsl(var(--bad) / 0.3);
  border-radius: 8px;
  color: hsl(var(--bad-fg));
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-word;
}

.notice {
  margin-top: 14px;
  padding: 10px 12px;
  background: hsl(var(--ok) / 0.1);
  border: 1px solid hsl(var(--ok) / 0.3);
  border-radius: 8px;
  color: hsl(var(--ok-fg));
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-word;
}

/* ── 响应式:单列流天然自适应;窄屏收紧节奏,极窄卖点转单列 ── */
@media (max-width: 640px) {
  .login-page {
    gap: 22px;
    padding: 22px 16px 26px;
  }

  .login-points {
    gap: 12px 26px;
  }

  .login-points li {
    min-width: 148px;
  }
}

@media (max-width: 400px) {
  .login-points li {
    min-width: 100%;
  }

  .login-links {
    gap: 14px;
  }
}
</style>
