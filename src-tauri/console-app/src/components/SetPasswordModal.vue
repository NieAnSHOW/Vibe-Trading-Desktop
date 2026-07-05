<script setup lang="ts">
import { ref } from "vue";
import { consoleLoginSetPassword } from "../ipc/commands";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
}>();

const pwd = ref("");
const confirm = ref("");
const submitting = ref(false);
const err = ref("");

async function submit() {
  err.value = "";
  if (pwd.value.length < 6) {
    err.value = "密码至少 6 位";
    return;
  }
  if (pwd.value !== confirm.value) {
    err.value = "两次输入不一致";
    return;
  }
  if (submitting.value) return;
  submitting.value = true;
  try {
    await consoleLoginSetPassword(pwd.value);
    pwd.value = "";
    confirm.value = "";
    emit("close");
  } catch (e: any) {
    err.value = e?.message || String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="props.open" class="modal-mask">
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="设置登录密码">
      <h2>设置登录密码</h2>
      <p class="hint">首次登录请设置密码，之后可用密码登录。</p>
      <input
        class="field"
        type="password"
        v-model="pwd"
        placeholder="新密码（至少 6 位）"
        autocomplete="new-password"
        :disabled="submitting"
      />
      <input
        class="field"
        type="password"
        v-model="confirm"
        placeholder="确认密码"
        autocomplete="new-password"
        :disabled="submitting"
      />
      <div class="row">
        <button class="btn primary" :disabled="submitting" @click="submit">
          {{ submitting ? "提交中…" : "确认" }}
        </button>
        <button class="btn ghost" :disabled="submitting" @click="emit('close')">
          跳过
        </button>
      </div>
      <p v-if="err" class="err" role="alert">{{ err }}</p>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: hsl(0 0% 0% / 0.55);
  backdrop-filter: blur(2px);
}
.modal-card {
  width: 100%;
  max-width: 360px;
  background: hsl(var(--surface-1));
  border: 1px solid hsl(var(--line));
  border-radius: var(--radius);
  padding: 22px 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 22px 55px hsl(0 0% 0% / 0.55);
}
h2 {
  font-size: 15.5px;
  font-weight: 650;
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
    box-shadow 0.16s var(--ease);
}
.field::placeholder {
  color: hsl(var(--ink-dim) / 0.7);
}
.field:focus {
  outline: none;
  border-color: hsl(var(--brand) / 0.7);
  box-shadow: 0 0 0 3px hsl(var(--brand) / 0.16);
}
.field:disabled {
  opacity: 0.55;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.16s var(--ease),
    border-color 0.16s var(--ease),
    transform 0.12s var(--ease),
    opacity 0.16s var(--ease);
}
.btn:active:not(:disabled) {
  transform: translateY(1px);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.primary {
  background: hsl(var(--brand));
  color: hsl(var(--on-brand));
  border: 0;
  box-shadow: 0 6px 18px hsl(var(--brand) / 0.24);
}
.btn.primary:hover:not(:disabled) {
  background: hsl(var(--brand-strong));
}
.btn.ghost {
  background: hsl(var(--surface-2));
  color: hsl(var(--ink));
  border: 1px solid hsl(var(--line));
}
.btn.ghost:hover:not(:disabled) {
  background: hsl(var(--line));
}
.btn:focus-visible {
  outline: 2px solid hsl(var(--brand));
  outline-offset: 2px;
}
.hint {
  font-size: 12.5px;
  color: hsl(var(--ink-dim));
  line-height: 1.5;
}
.err {
  padding: 9px 12px;
  background: hsl(var(--bad) / 0.1);
  border: 1px solid hsl(var(--bad) / 0.3);
  border-radius: 9px;
  color: hsl(var(--bad-fg));
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-word;
}
</style>
