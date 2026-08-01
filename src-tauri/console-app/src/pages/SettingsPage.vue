<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppButton from "../components/AppButton.vue";
import {
  consoleGetSettings,
  consoleSetAutostart,
} from "../ipc/commands";
import tauriConf from "../../../tauri.conf.json";

const router = useRouter();

const autostart = ref(false);
const saving = ref(false);
const notice = ref("");
const loadError = ref("");

const version = computed(() => tauriConf.version);

async function load() {
  loadError.value = "";
  try {
    const settings = await consoleGetSettings();
    autostart.value = settings.autostart_service;
  } catch (error) {
    loadError.value = String(error);
  }
}

async function onAutostartChange() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  const next = !autostart.value;
  autostart.value = next; // 乐观更新,失败时回滚
  try {
    await consoleSetAutostart(next);
    notice.value = next ? "已开启：下次启动应用时将自动启动服务" : "已关闭：启动应用时不再自动启动服务";
  } catch (error) {
    autostart.value = !next; // 保存失败回滚开关状态
    notice.value = `保存失败：${String(error)}`;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="settings">
    <AppButton variant="ghost" @click="router.push('/')">返回控制台</AppButton>

    <section class="settings-card" aria-label="启动行为">
      <h1 class="settings-title">启动行为</h1>
      <div class="settings-row">
        <div class="settings-row__text">
          <p class="settings-row__name">启动时自动启动服务</p>
          <p class="settings-row__desc">
            打开应用时若依赖已就绪，自动在后台拉起后端服务，免去手动点击「启动服务」。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="autostart"
          :class="['switch', { on: autostart }]"
          :disabled="saving"
          @click="onAutostartChange"
        >
          <span class="switch__thumb" aria-hidden="true"></span>
          <span class="switch__label">{{ autostart ? "已开启" : "已关闭" }}</span>
        </button>
      </div>
      <p v-if="loadError" class="settings-notice settings-notice--bad">
        设置加载失败：{{ loadError }}
      </p>
      <p v-else-if="notice" class="settings-notice">{{ notice }}</p>
    </section>

    <section class="settings-card" aria-label="关于">
      <h1 class="settings-title">关于</h1>
      <div class="settings-row">
        <div class="settings-row__text">
          <p class="settings-row__name">版本</p>
          <p class="settings-row__desc">Trading Worker 桌面版</p>
        </div>
        <span class="settings-version">v{{ version }}</span>
      </div>
    </section>
  </main>
</template>

<style>
@import "../styles/console.css";

.settings {
  position: relative;
  z-index: 1;
  width: 580px;
}

.settings-card {
  margin-top: 18px;
  padding: 18px;
  border: 1px solid hsl(var(--line));
  border-radius: var(--radius);
  background: hsl(var(--surface-1));
}

.settings-title {
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 6px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0 2px;
}

.settings-row__name {
  font-size: 13.5px;
  font-weight: 550;
}

.settings-row__desc {
  margin-top: 3px;
  font-size: 12.5px;
  color: hsl(var(--ink-dim));
  line-height: 1.5;
}

.settings-version {
  flex: none;
  font-size: 13px;
  font-weight: 550;
  color: hsl(var(--ink-dim));
  font-variant-numeric: tabular-nums;
}

.settings-notice {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  color: hsl(var(--ok-fg));
  background: hsl(var(--ok) / 0.1);
  border: 1px solid hsl(var(--ok) / 0.3);
}

.settings-notice--bad {
  color: hsl(var(--bad-fg));
  background: hsl(var(--bad) / 0.1);
  border-color: hsl(var(--bad) / 0.3);
}

/* Switch — role="switch" 的原生 button,视觉与键盘可达。 */
.switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px 3px 3px;
  border-radius: 999px;
  border: 1px solid hsl(var(--line));
  background: hsl(var(--surface-2));
  color: hsl(var(--ink-dim));
  cursor: pointer;
  font-size: 12px;
  font-weight: 550;
  transition:
    background 0.16s var(--ease),
    border-color 0.16s var(--ease),
    color 0.16s var(--ease);
}

.switch__thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: hsl(var(--ink-dim));
  transition: background 0.16s var(--ease);
}

.switch.on {
  background: hsl(var(--brand) / 0.18);
  border-color: hsl(var(--brand) / 0.5);
  color: hsl(var(--on-brand));
}

.switch.on .switch__thumb {
  background: hsl(var(--brand));
}

.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}
</style>
