<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import AppButton from "../components/AppButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBusy } from "../composables/useBusy";
import {
  THEME_COLORS,
  THEME_COLOR_EVENT,
  THEME_MODES,
  THEME_MODE_EVENT,
  type ThemeColorId,
  type ThemeMode,
} from "../components/Rail.vue";
import {
  consoleGetSettings,
  // consoleSetThemeColor,
  consoleSetThemeMode,
  consoleOpenLogs,
  consoleClearLogs,
  consoleClearVenv,
  consoleUninstallLegacyApp,
  consoleOpenExternalUrl,
  consoleCheckEnvironment,
  consoleRepairEnvironment,
} from "../ipc/commands";
import type { EnvironmentReport } from "../ipc/types";
import { config as ProdConfig } from "../config/prod";
import douyinPng from "../assets/douyin.png";
import tauriConf from "../../../tauri.conf.json";

const env = useEnvStore();
const service = useServiceStore();
const { serviceRunning } = storeToRefs(env);

const notice = ref("");
const loadError = ref("");

// ── 外观:主题模式(初次启动默认浅色)+ 主题色;经 window 事件交给 Rail 主题引擎 ──
const themeMode = ref<ThemeMode>("light");
const themeColor = ref<ThemeColorId>("teal");

async function selectThemeMode(mode: ThemeMode) {
  try {
    await consoleSetThemeMode(mode);
    themeMode.value = mode;
    window.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: mode }));
  } catch (error) {
    notice.value = `保存失败：${String(error)}`;
  }
}

// async function selectThemeColor(color: ThemeColorId) {
//   try {
//     await consoleSetThemeColor(color);
//     themeColor.value = color;
//     window.dispatchEvent(new CustomEvent(THEME_COLOR_EVENT, { detail: color }));
//   } catch (error) {
//     notice.value = `保存失败：${String(error)}`;
//   }
// }

function onThemeModeEvent(e: Event) {
  const mode = (e as CustomEvent<ThemeMode>).detail;
  if (mode === "system" || mode === "light" || mode === "dark") themeMode.value = mode;
}

function onThemeColorEvent(e: Event) {
  const color = (e as CustomEvent<ThemeColorId>).detail;
  if (THEME_COLORS.some((option) => option.id === color)) themeColor.value = color;
}

const version = computed(() => tauriConf.version);
// 官网链接：App.vue 启动时 loadPublicConfig() 拉取，空则隐藏入口
const officialUrl = computed(() => ProdConfig.officialUrl.trim());

async function load() {
  loadError.value = "";
  try {
    const settings = await consoleGetSettings();
    if (settings.theme_mode === "system" || settings.theme_mode === "light" || settings.theme_mode === "dark") {
      themeMode.value = settings.theme_mode;
    }
    if (THEME_COLORS.some((option) => option.id === settings.theme_color)) {
      themeColor.value = settings.theme_color;
    }
  } catch (error) {
    loadError.value = String(error);
  }
}

// ── 维护工具(自控制台迁入) ───────────────────────────────────────
const maintenanceNotice = ref("");
const maintenanceError = ref("");
const clearVenvBusy = useBusy();
const clearLogsBusy = useBusy();
const uninstallLegacyBusy = useBusy();
const clearVenvDialogOpen = ref(false);
const clearLogsDialogOpen = ref(false);
const uninstallLegacyDialogOpen = ref(false);

// ── 环境检查（依赖完整性 + 运行时代码版本） ───────────────────────
const envReport = ref<EnvironmentReport | null>(null);
const envCheckBusy = useBusy();
const envRepairBusy = useBusy();

const envSummary = computed(() => {
  const r = envReport.value;
  if (!r) return "";
  const parts: string[] = [];
  parts.push(r.depsOk ? "依赖完整" : "依赖不完整");
  parts.push(
    r.runtimeOk
      ? "运行时代码已是最新"
      : `运行时代码版本落后（${r.installedVersion ?? "无"} → ${r.bundleVersion}）`,
  );
  return parts.join("；");
});
const envAllOk = computed(() => envReport.value?.depsOk && envReport.value.runtimeOk);

async function onCheckEnvironment() {
  maintenanceNotice.value = "";
  maintenanceError.value = "";
  try {
    envReport.value = await consoleCheckEnvironment();
  } catch (e) {
    setMaintenanceError(e);
  }
}

async function onRepairEnvironment() {
  maintenanceNotice.value = "";
  maintenanceError.value = "";
  // 修复会同步代码并在需要时重装依赖，期间服务须处于停止状态。
  if (serviceRunning.value) {
    await service.stop();
    env.setPort(null);
    serviceRunning.value = false;
  }
  await envRepairBusy.run("修复中", async () => {
    try {
      await consoleRepairEnvironment();
      // 修复完成后立即复查，反馈是否已达标。
      envReport.value = await consoleCheckEnvironment();
      maintenanceNotice.value = envAllOk.value
        ? "环境检查通过：依赖完整，运行时代码已是最新。"
        : "修复完成，但环境仍未达标，请查看下方检查结果。";
    } catch (e) {
      setMaintenanceError(e);
    }
  });
}

function setMaintenanceError(m: unknown) {
  maintenanceError.value = m ? String(m) : "";
  if (m) maintenanceNotice.value = "";
}

async function onClearVenv() {
  maintenanceNotice.value = "";
  maintenanceError.value = "";
  // 更新用户点击时的真实服务状态，避免仅依赖页面挂载时的快照。
  await env.refresh();
  clearVenvDialogOpen.value = true;
}
async function onClearVenvDialogClose(v: "ok" | "cancel") {
  clearVenvDialogOpen.value = false;
  if (v !== "ok") return;
  await clearVenvBusy.run("清理中", async () => {
    maintenanceError.value = "";
    try {
      // venv 被占用时(Win)删除会失败,先停服务释放进程
      if (serviceRunning.value) {
        await service.stop();
        env.setPort(null);
        serviceRunning.value = false;
      }
      await consoleClearVenv();
      maintenanceNotice.value = "运行环境和过时代码已清理，请重新安装依赖";
      await env.refresh();
    } catch (e) {
      setMaintenanceError(e);
    }
  });
}

async function onOpenLogs() {
  try {
    await consoleOpenLogs();
  } catch (e) {
    setMaintenanceError(e);
  }
}

function onClearLogs() {
  maintenanceNotice.value = "";
  clearLogsDialogOpen.value = true;
}
async function onClearLogsDialogClose(v: "ok" | "cancel") {
  clearLogsDialogOpen.value = false;
  if (v !== "ok") return;
  await clearLogsBusy.run("清理中", async () => {
    maintenanceError.value = "";
    try {
      const n = await consoleClearLogs();
      maintenanceNotice.value = `已清理 ${n} 个日志文件`;
    } catch (e) {
      setMaintenanceError(e);
    }
  });
}

function onUninstallLegacy() {
  maintenanceNotice.value = "";
  maintenanceError.value = "";
  uninstallLegacyDialogOpen.value = true;
}

async function onUninstallLegacyDialogClose(v: "ok" | "cancel") {
  uninstallLegacyDialogOpen.value = false;
  if (v !== "ok") return;
  await uninstallLegacyBusy.run("卸载中", async () => {
    maintenanceError.value = "";
    try {
      if (serviceRunning.value) {
        await service.stop();
        env.setPort(null);
        serviceRunning.value = false;
      }
      await consoleUninstallLegacyApp();
      maintenanceNotice.value = "旧版 Vibe Trading 卸载操作已完成或已启动，用户数据已保留。";
    } catch (e) {
      setMaintenanceError(e);
    }
  });
}

onMounted(async () => {
  window.addEventListener(THEME_MODE_EVENT, onThemeModeEvent);
  window.addEventListener(THEME_COLOR_EVENT, onThemeColorEvent);
  await load();
  // 取真实服务状态:清理运行环境时若服务在跑需先停,venv 占用删除会失败
  await env.refresh();
});

onUnmounted(() => {
  window.removeEventListener(THEME_MODE_EVENT, onThemeModeEvent);
  window.removeEventListener(THEME_COLOR_EVENT, onThemeColorEvent);
});
</script>

<template>
  <main class="tw-page settings">
    <header>
      <p class="tw-kicker">Preferences</p>
      <h1 class="tw-page-title">设置</h1>
      <p class="tw-page-sub">外观偏好与本地运行时维护。</p>
    </header>

    <!-- DOM 顺序 = 窄屏优先级流:外观 → 维护 → 关于;桌面位由网格指定 -->
    <div class="tw-grid">
      <section class="tw-panel st-appearance" aria-label="外观">
        <header class="tw-panel__head">
          <h2 class="tw-panel__label">外观</h2>
        </header>
        <div class="settings-rows">
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">主题模式</p>
              <p class="settings-row__desc">初次启动默认浅色；也可跟随系统或固定深色，手动选择后以手动为准。</p>
            </div>
            <div class="theme-segment" role="group" aria-label="主题模式" data-test="theme-mode">
              <button
                v-for="m in THEME_MODES"
                :key="m.id"
                type="button"
                :class="{ active: themeMode === m.id }"
                :data-mode="m.id"
                :aria-pressed="themeMode === m.id"
                @click="selectThemeMode(m.id)"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
          <!-- <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">主题色</p>
              <p class="settings-row__desc">选择应用主色，用于高亮与选中态。</p>
            </div>
            <div class="theme-colors" role="group" aria-label="主题色" data-test="theme-color">
              <button
                v-for="c in THEME_COLORS"
                :key="c.id"
                type="button"
                class="theme-swatch"
                :class="{ active: themeColor === c.id }"
                :data-color="c.id"
                :title="c.label"
                :aria-label="`主题色：${c.label}`"
                :aria-pressed="themeColor === c.id"
                :style="{ '--swatch': `hsl(${c.hsl})` }"
                @click="selectThemeColor(c.id)"
              ></button>
            </div>
          </div> -->
        </div>
        <p v-if="loadError" class="settings-notice settings-notice--bad">
          设置加载失败：{{ loadError }}
        </p>
        <p v-else-if="notice" class="settings-notice">{{ notice }}</p>
      </section>

      <section class="tw-panel st-maintenance" aria-label="维护">
        <header class="tw-panel__head">
          <h2 class="tw-panel__label">维护</h2>
        </header>
        <div class="settings-rows">
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">环境检查</p>
              <p class="settings-row__desc">
                检查依赖是否完整、运行时代码是否为最新版本；不达标时点击修复。
              </p>
              <p v-if="envReport" class="env-summary">
                <span :class="['env-badge', { ok: envAllOk }]">{{ envAllOk ? "正常" : "异常" }}</span>
                {{ envSummary }}
              </p>
            </div>
            <div class="settings-row__actions">
              <AppButton variant="ghost" :busy="envCheckBusy.busy.value" busy-label="检查中"
                data-test="check-environment-action" @click="onCheckEnvironment">检查</AppButton>
              <AppButton v-if="envReport && !envAllOk" variant="danger" :busy="envRepairBusy.busy.value"
                busy-label="修复中" data-test="repair-environment-action" @click="onRepairEnvironment">
                修复
              </AppButton>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">清理运行环境</p>
              <p class="settings-row__desc">
                删除 ~/.vibe-trading/venv 虚拟环境（含已安装依赖），不影响配置与会话数据。清理后需重新安装依赖。
              </p>
            </div>
            <AppButton variant="danger" :busy="clearVenvBusy.busy.value" busy-label="清理中"
              data-test="clear-environment-action" @click="onClearVenv">清理</AppButton>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">打开日志目录</p>
              <p class="settings-row__desc">在系统文件管理器中打开 ~/.vibe-trading/logs。</p>
            </div>
            <AppButton variant="ghost" data-test="open-logs-action" @click="onOpenLogs">打开</AppButton>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">清理日志文件</p>
              <p class="settings-row__desc">删除 ~/.vibe-trading/logs 下的日志文件，不影响配置与会话数据。</p>
            </div>
            <AppButton variant="danger" :busy="clearLogsBusy.busy.value" busy-label="清理中" data-test="clear-logs-action"
              @click="onClearLogs">清理</AppButton>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">Vibe Trading</p>
              <p class="settings-row__desc">卸载老版本应用程序，不会删除 ~/.vibe-trading 中的用户数据。</p>
            </div>
            <AppButton variant="danger" :busy="uninstallLegacyBusy.busy.value" busy-label="卸载中"
              data-test="uninstall-legacy-action" @click="onUninstallLegacy">
              卸载老版本
            </AppButton>
          </div>
        </div>
        <p v-if="maintenanceError" class="settings-notice settings-notice--bad">{{ maintenanceError }}</p>
        <p v-else-if="maintenanceNotice" class="settings-notice">{{ maintenanceNotice }}</p>
      </section>

      <section class="tw-panel st-about" aria-label="关于">
        <header class="tw-panel__head">
          <h2 class="tw-panel__label">关于</h2>
        </header>
        <div class="settings-rows">
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">版本</p>
              <p class="settings-row__desc">Trading Worker 桌面版</p>
            </div>
            <span class="settings-version">v{{ version }}</span>
          </div>
          <div v-if="officialUrl" class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">官方网站</p>
              <p class="settings-row__desc">查看产品介绍与最新动态。</p>
            </div>
            <AppButton variant="ghost" @click="consoleOpenExternalUrl(officialUrl)">前往官网</AppButton>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <p class="settings-row__name">关于作者</p>
              <p class="settings-row__desc">扫码关注抖音号，获取更多使用技巧与动态。</p>
            </div>
            <img class="author-qr" :src="douyinPng" alt="作者抖音号二维码" />
          </div>
        </div>
      </section>
    </div>

    <ConfirmDialog :open="clearVenvDialogOpen"
      :title="serviceRunning ? '服务正在运行，确认停止后清理？' : '确认强制清理环境？'"
      @close="onClearVenvDialogClose">
      <template v-if="serviceRunning">
        当前服务正在运行。确认后会先停止当前服务，再同步清理可能存在的过时代码和
        <b>~/.vibe-trading/venv</b> 虚拟环境；配置、会话等用户数据不会删除。
      </template>
      <template v-else>
        将同步清理可能存在的过时代码并删除 <b>~/.vibe-trading/venv</b> 虚拟环境(含已安装依赖)，
        <b>不会删除您的配置、会话等数据</b>。清理后需重新完整安装依赖，确认操作吗？
      </template>
      <template #confirm-text>{{ serviceRunning ? "停止并清理" : "确认清理" }}</template>
    </ConfirmDialog>

    <ConfirmDialog :open="clearLogsDialogOpen" title="确认清理日志文件？" @close="onClearLogsDialogClose">
      将删除 <b>~/.vibe-trading/logs</b> 下的所有日志文件（sidecar-*.log），<b>不影响配置、会话等数据</b>。服务运行中当天日志可能被占用而跳过，确认操作吗？
      <template #confirm-text>确认清理</template>
    </ConfirmDialog>

    <ConfirmDialog :open="uninstallLegacyDialogOpen" title="确认卸载旧版 Vibe Trading？" @close="onUninstallLegacyDialogClose">
      仅移除旧版 <b>Vibe Trading</b> 应用程序，不会删除 <b>~/.vibe-trading</b> 中的配置、会话等用户数据，确认操作吗？
      <template #confirm-text>确认卸载</template>
    </ConfirmDialog>
  </main>
</template>

<style>
/* 页面根保持流体(App.test 以此守护 Rail 画布);共享词汇(tw-*)见 console.css。
   桌面位:维护为主列,外观/关于为右侧上下文列 */
.settings {
  width: 100%;
}

@media (min-width: 900px) {
  .st-appearance { grid-area: 1 / 2; }
  .st-maintenance { grid-area: 1 / 1; }
  .st-about { grid-area: 2 / 2; }

  /* 右侧上下文列窄(≤316px),"文字+控件"同行会把文字压成竖排;
     与 WebUI 侧栏卡片同构,改为纵向堆叠:文字在上、控件在下 */
  .st-appearance .settings-row,
  .st-about .settings-row {
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 9px;
  }
}

/* 面板内行列表:细分隔线 + 充足行高,数值/动作右对齐 */
.settings-rows {
  display: grid;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
}

.settings-row + .settings-row {
  border-top: 1px solid hsl(var(--line) / 0.6);
}

.settings-row__text {
  min-width: 0;
}

.settings-row__name {
  font-size: 13px;
  font-weight: 600;
}

.settings-row__desc {
  margin-top: 3px;
  color: hsl(var(--ink-dim));
  font-size: 12px;
  line-height: 1.55;
}

.settings-row__actions {
  flex: none;
  display: flex;
  gap: 8px;
}

.settings-row .btn-ghost,
.settings-row .btn-danger {
  flex: none;
  white-space: nowrap;
}

/* 行内破坏性操作弱化为描边款,与 notice--bad 同系;确认弹窗内仍为实心负向色 */
.settings-row .btn-danger {
  background: hsl(var(--bad) / 0.1);
  color: hsl(var(--bad-fg));
  border-color: hsl(var(--bad) / 0.4);
}

.settings-row .btn-danger:hover:not(:disabled) {
  background: hsl(var(--bad) / 0.18);
  border-color: hsl(var(--bad) / 0.6);
}

.settings-notice {
  margin: 0 16px 14px;
  padding: 8px 12px;
  border: 1px solid hsl(var(--ok) / 0.3);
  border-radius: 8px;
  background: hsl(var(--ok) / 0.1);
  color: hsl(var(--ok-fg));
  font-size: 12.5px;
}

.settings-notice--bad {
  border-color: hsl(var(--bad) / 0.3);
  background: hsl(var(--bad) / 0.1);
  color: hsl(var(--bad-fg));
}

/* 环境检查:小圆点 + 等宽标签(设计系统状态表达) */
.env-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  color: hsl(var(--ink-dim));
  font-size: 12px;
}

.env-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border: 1px solid hsl(var(--bad) / 0.4);
  border-radius: 999px;
  background: hsl(var(--bad) / 0.1);
  color: hsl(var(--bad-fg));
  font-family: var(--tw-mono);
  font-size: 11px;
  font-weight: 600;
}

.env-badge::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.env-badge.ok {
  border-color: hsl(var(--ok) / 0.3);
  background: hsl(var(--ok) / 0.1);
  color: hsl(var(--ok-fg));
}

.settings-version {
  flex: none;
  padding: 3px 9px;
  border: 1px solid hsl(var(--line));
  border-radius: 6px;
  background: hsl(var(--surface-2) / 0.6);
  color: hsl(var(--ink-dim));
  font-family: var(--tw-mono);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 外观:主题模式分段控件 + 主题色色块 */
.theme-segment {
  flex: none;
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid hsl(var(--line));
  border-radius: 9px;
  background: hsl(var(--surface-2));
}

.theme-segment button {
  padding: 4px 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: hsl(var(--ink-dim));
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition:
    background 0.16s var(--ease),
    color 0.16s var(--ease);
}

.theme-segment button.active {
  background: hsl(var(--surface-1));
  color: hsl(var(--ink));
  box-shadow: 0 1px 4px hsl(0 0% 0% / 0.18);
}

.theme-segment button:focus-visible,
.theme-swatch:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}

.theme-colors {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.theme-swatch {
  width: 22px;
  height: 22px;
  border: 1px solid hsl(var(--line));
  border-radius: 7px;
  background: var(--swatch, hsl(var(--brand)));
  cursor: pointer;
  transition:
    transform 0.16s var(--ease),
    outline-color 0.16s var(--ease);
}

.theme-swatch:hover {
  transform: scale(1.08);
}

.theme-swatch.active {
  outline: 2px solid hsl(var(--ink));
  outline-offset: 2px;
}

/* 作者抖音号二维码:装裱为边框资产,靠右与版本号/按钮对齐 */
.author-qr {
  flex: none;
  width: 96px;
  height: auto;
  padding: 5px;
  border: 1px solid hsl(var(--line));
  border-radius: 10px;
  background: hsl(var(--surface-2));
}

/* 窄屏:长描述换行后,控件落到下一行并靠右对齐 */
@media (max-width: 560px) {
  .settings-row {
    flex-wrap: wrap;
  }

  .settings-row__actions,
  .theme-segment,
  .theme-colors,
  .settings-version {
    margin-left: auto;
  }
}
</style>
