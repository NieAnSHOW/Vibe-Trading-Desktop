<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import AppButton from "../components/AppButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useEnvStore } from "../stores/env";
import { useServiceStore } from "../stores/service";
import { useBusy } from "../composables/useBusy";
import {
  consoleGetSettings,
  consoleSetAutostart,
  consoleOpenLogs,
  consoleClearLogs,
  consoleClearVenv,
  consoleUninstallLegacyApp,
  consoleOpenExternalUrl,
} from "../ipc/commands";
import { config as ProdConfig } from "../config/prod";
import douyinPng from "../assets/douyin.png";
import tauriConf from "../../../tauri.conf.json";

const router = useRouter();
const env = useEnvStore();
const service = useServiceStore();
const { serviceRunning } = storeToRefs(env);

const autostart = ref(false);
const saving = ref(false);
const notice = ref("");
const loadError = ref("");

const version = computed(() => tauriConf.version);
// 官网链接：App.vue 启动时 loadPublicConfig() 拉取，空则隐藏入口
const officialUrl = computed(() => ProdConfig.officialUrl.trim());

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

// ── 维护工具(自控制台迁入) ───────────────────────────────────────
const maintenanceNotice = ref("");
const maintenanceError = ref("");
const clearVenvBusy = useBusy();
const clearLogsBusy = useBusy();
const uninstallLegacyBusy = useBusy();
const clearVenvDialogOpen = ref(false);
const clearLogsDialogOpen = ref(false);
const uninstallLegacyDialogOpen = ref(false);

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
  await load();
  // 取真实服务状态:清理运行环境时若服务在跑需先停,venv 占用删除会失败
  await env.refresh();
});
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
        <button type="button" role="switch" :aria-checked="autostart" :class="['switch', { on: autostart }]"
          :disabled="saving" @click="onAutostartChange">
          <span class="switch__thumb" aria-hidden="true"></span>
          <span class="switch__label">{{ autostart ? "已开启" : "已关闭" }}</span>
        </button>
      </div>
      <p v-if="loadError" class="settings-notice settings-notice--bad">
        设置加载失败：{{ loadError }}
      </p>
      <p v-else-if="notice" class="settings-notice">{{ notice }}</p>
    </section>

    <section class="settings-card" aria-label="维护">
      <h1 class="settings-title">维护</h1>
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
      <p v-if="maintenanceError" class="settings-notice settings-notice--bad">{{ maintenanceError }}</p>
      <p v-else-if="maintenanceNotice" class="settings-notice">{{ maintenanceNotice }}</p>
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
      <div v-if="officialUrl" class="settings-row">
        <div class="settings-row__text">
          <p class="settings-row__name">官方网站</p>
          <p class="settings-row__desc">查看产品介绍与最新动态。</p>
        </div>
        <AppButton variant="ghost" @click="consoleOpenExternalUrl(officialUrl)">点击前往官网</AppButton>
      </div>
      <div class="settings-row">
        <div class="settings-row__text">
          <p class="settings-row__name">关于作者</p>
          <p class="settings-row__desc">扫码关注抖音号，获取更多使用技巧与动态。</p>
        </div>
        <img class="author-qr" :src="douyinPng" alt="作者抖音号二维码" />
      </div>
    </section>

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

.settings-card .settings-row+.settings-row {
  border-top: 1px solid hsl(var(--line) / 0.6);
  margin-top: 6px;
  padding-top: 12px;
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

/* 作者抖音号二维码：限宽防过大，靠右与版本号/按钮对齐 */
.author-qr {
  flex: none;
  width: 104px;
  height: auto;
  border-radius: 10px;
  border: 1px solid hsl(var(--line));
  background: hsl(var(--surface-2));
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

/* 行内操作按钮不参与压缩,避免长描述把按钮挤变形 */
.settings-row .btn-danger,
.settings-row .btn-ghost {
  flex: none;
  white-space: nowrap;
}

/* 破坏性操作弱化为描边款,与 settings-notice--bad 同系;避免实心红在列表里过于刺眼。
   仅作用于 settings-row 内,不影响 ConfirmDialog 里的实心确认按钮。 */
.settings-row .btn-danger {
  background: hsl(var(--bad) / 0.1);
  color: hsl(var(--bad-fg));
  border-color: hsl(var(--bad) / 0.4);
}

.settings-row .btn-danger:hover:not(:disabled) {
  background: hsl(var(--bad) / 0.18);
  border-color: hsl(var(--bad) / 0.6);
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
