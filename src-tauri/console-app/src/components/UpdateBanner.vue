<script setup lang="ts">
import { ref, computed } from "vue";
import type { UpdateInfo, DownloadProgress } from "../ipc/types";
import {
  consoleCheckUpdate,
  consoleDownloadUpdate,
  consoleInstallUpdate,
} from "../ipc/commands";
import { onUpdateProgress } from "../ipc/events";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onMounted, onUnmounted } from "vue";

// ── 状态机 ──────────────────────────────────────────────────────────
// idle → checking → has_update / up_to_date → downloading → ready_to_install
type Phase =
  | "idle"          // 初始，未检查
  | "checking"      // 正在请求 GitHub API
  | "up_to_date"    // 已是最新版本（短暂展示后自动隐藏）
  | "has_update"    // 有新版本，等待用户点"下载"
  | "downloading"   // 下载中
  | "ready"         // 下载完成，等待用户点"安装"
  | "error";        // 出错

const phase = ref<Phase>("idle");
const updateInfo = ref<UpdateInfo | null>(null);
const errorMsg = ref("");
const progress = ref<DownloadProgress | null>(null);
const localPath = ref("");         // 下载完成后的本地路径
const installDialogOpen = ref(false);

// 进度百分比（0-100），total=0 时显示动画条
const pct = computed(() => {
  if (!progress.value || !progress.value.total) return 0;
  return Math.round((progress.value.downloaded / progress.value.total) * 100);
});

const indeterminate = computed(
  () => !!progress.value && !progress.value.total
);

// 展示更新提示横幅的条件
const visible = computed(
  () => phase.value !== "idle" && phase.value !== "up_to_date"
);

// ── 事件监听 ────────────────────────────────────────────────────────
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await onUpdateProgress((p) => {
    progress.value = p;
    if (p.done && p.path) {
      localPath.value = p.path;
      phase.value = "ready";
    }
  });
});

onUnmounted(() => {
  unlisten?.();
});

// ── 操作 ────────────────────────────────────────────────────────────
async function checkUpdate() {
  phase.value = "checking";
  errorMsg.value = "";
  try {
    const info = await consoleCheckUpdate();
    updateInfo.value = info;
    if (info.hasUpdate) {
      phase.value = "has_update";
    } else {
      phase.value = "up_to_date";
      // 3s 后自动回到 idle，不一直占空间
      setTimeout(() => {
        if (phase.value === "up_to_date") phase.value = "idle";
      }, 3000);
    }
  } catch (e) {
    phase.value = "error";
    errorMsg.value = String(e);
  }
}

async function startDownload() {
  if (!updateInfo.value) return;
  phase.value = "downloading";
  progress.value = null;
  errorMsg.value = "";
  try {
    const path = await consoleDownloadUpdate(updateInfo.value);
    localPath.value = path;
    phase.value = "ready";
  } catch (e) {
    phase.value = "error";
    errorMsg.value = String(e);
  }
}

function openInstallDialog() {
  installDialogOpen.value = true;
}

async function onInstallDialogClose(v: "ok" | "cancel") {
  installDialogOpen.value = false;
  if (v !== "ok") return;
  try {
    await consoleInstallUpdate(localPath.value);
    // 安装包已打开，重置状态
    phase.value = "idle";
  } catch (e) {
    phase.value = "error";
    errorMsg.value = String(e);
  }
}

function dismiss() {
  phase.value = "idle";
}

// 暴露给父组件手动触发检查（ConsolePage 启动时调用）
defineExpose({ checkUpdate });
</script>

<template>
  <!-- 顶部更新通知横幅 -->
  <div v-if="visible" class="update-banner" :class="phase">
    <!-- 有新版本 -->
    <template v-if="phase === 'has_update' && updateInfo">
      <span class="update-icon">🔔</span>
      <span class="update-text">
        发现新版本 <b>v{{ updateInfo.latest }}</b>（当前 v{{ updateInfo.current }}）
        <span v-if="updateInfo.releaseNotes" class="update-notes">{{ updateInfo.releaseNotes }}</span>
      </span>
      <div class="update-actions">
        <button class="btn-update-primary" @click="startDownload">下载更新</button>
        <button class="btn-update-ghost" @click="dismiss">忽略</button>
      </div>
    </template>

    <!-- 检查中 -->
    <template v-else-if="phase === 'checking'">
      <span class="update-spinner"></span>
      <span class="update-text">正在检查更新…</span>
    </template>

    <!-- 下载中 -->
    <template v-else-if="phase === 'downloading'">
      <span class="update-text">
        下载中{{ updateInfo ? ' v' + updateInfo.latest : '' }}…
        <span v-if="progress && progress.total">
          {{ Math.round(progress.downloaded / 1024 / 1024 * 10) / 10 }} /
          {{ Math.round(progress.total / 1024 / 1024 * 10) / 10 }} MB
        </span>
      </span>
      <div class="update-progress-wrap">
        <div
          class="update-progress-fill"
          :class="{ indeterminate: indeterminate }"
          :style="indeterminate ? {} : { width: pct + '%' }"
        ></div>
      </div>
    </template>

    <!-- 下载完成，等待安装 -->
    <template v-else-if="phase === 'ready' && updateInfo">
      <span class="update-icon">✅</span>
      <span class="update-text">
        v{{ updateInfo.latest }} 已下载完成，是否现在安装？
      </span>
      <div class="update-actions">
        <button class="btn-update-primary" @click="openInstallDialog">现在安装</button>
        <button class="btn-update-ghost" @click="dismiss">稍后</button>
      </div>
    </template>

    <!-- 出错 -->
    <template v-else-if="phase === 'error'">
      <span class="update-icon">⚠️</span>
      <span class="update-text update-error">{{ errorMsg }}</span>
      <div class="update-actions">
        <button class="btn-update-ghost" @click="checkUpdate">重试</button>
        <button class="btn-update-ghost" @click="dismiss">关闭</button>
      </div>
    </template>
  </div>

  <!-- 安装确认弹窗 -->
  <dialog
    ref="dlg"
    class="confirm"
    :open="installDialogOpen"
    @close="onInstallDialogClose((($event.target as HTMLDialogElement).returnValue as 'ok' | 'cancel') ?? 'cancel')"
  >
    <form method="dialog">
      <h3>确认安装更新？</h3>
      <p>
        将打开安装包 <b>{{ updateInfo?.assetName }}</b>。
        <template v-if="updateInfo?.releaseNotes">
          <br /><br />
          <b>更新内容：</b><br />
          <span style="white-space:pre-wrap;font-size:12px;color:#aaa">{{ updateInfo.releaseNotes }}</span>
        </template>
      </p>
      <div class="confirm-actions">
        <button value="cancel" class="btn-ghost">稍后</button>
        <button value="ok" class="btn-danger" type="submit">现在安装</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 13px;
  background: #1a1f2e;
  border: 1px solid #2e3550;
  flex-wrap: wrap;
}
.update-banner.has_update { border-color: #4a6cf7; background: #111827; }
.update-banner.ready       { border-color: #22c55e; background: #0f1f14; }
.update-banner.error       { border-color: #ef4444; background: #1f1010; }

.update-icon { font-size: 15px; flex-shrink: 0; }

.update-text {
  flex: 1;
  color: #c8ccd8;
  line-height: 1.5;
}
.update-notes {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: #888;
  max-height: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.update-error { color: #f87171; }

.update-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn-update-primary {
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  background: #4a6cf7;
  color: #fff;
  border: none;
  cursor: pointer;
}
.btn-update-primary:hover { background: #3a5ce7; }

.btn-update-ghost {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: transparent;
  color: #888;
  border: 1px solid #444;
  cursor: pointer;
}
.btn-update-ghost:hover { color: #ccc; border-color: #888; }

/* 下载进度条 */
.update-progress-wrap {
  width: 100%;
  height: 4px;
  background: #2a3040;
  border-radius: 2px;
  overflow: hidden;
  margin-top: 6px;
}
.update-progress-fill {
  height: 100%;
  background: #4a6cf7;
  border-radius: 2px;
  transition: width 0.3s ease;
}
.update-progress-fill.indeterminate {
  width: 40%;
  animation: slide 1.2s infinite linear;
}
@keyframes slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

/* 检查中旋转器 */
.update-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #444;
  border-top-color: #4a6cf7;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
