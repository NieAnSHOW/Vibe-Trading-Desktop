<script setup lang="ts">
import { CircleCheck, CircleX } from "@lucide/vue";
import { useToast } from "../composables/useToast";

const { toasts, dismiss } = useToast();
</script>

<template>
  <!-- 全局消息提醒:固定顶部居中,点击任意 toast 提前关闭 -->
  <div class="toast-host" role="region" aria-label="消息提醒">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast--${t.kind}`"
        :role="t.kind === 'error' ? 'alert' : 'status'" @click="dismiss(t.id)">
        <CircleX v-if="t.kind === 'error'" :size="16" aria-hidden="true" />
        <CircleCheck v-else :size="16" aria-hidden="true" />
        <span class="toast__msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: min(420px, calc(100vw - 48px));
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 8px 24px hsl(var(--ink) / 0.18);
  cursor: pointer;
  pointer-events: auto;
  word-break: break-word;
}

.toast svg {
  flex: none;
  margin-top: 1px;
}

.toast--error {
  background: hsl(var(--surface-2));
  border: 1px solid hsl(var(--bad) / 0.45);
  color: hsl(var(--bad-fg));
}

.toast--success {
  background: hsl(var(--surface-2));
  border: 1px solid hsl(var(--ok) / 0.45);
  color: hsl(var(--ok-fg));
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 离场保持占位:绝对定位会让 toast 脱流后收缩到极窄宽度(文本被挤成一列) */
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

/* 剩余 toast 平滑上移(离场元素移除后由 move 过渡接管) */
.toast-move {
  transition: transform 0.22s ease;
}
</style>
