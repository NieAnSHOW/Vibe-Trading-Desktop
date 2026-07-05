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
    <div class="modal-card">
      <h2>设置登录密码</h2>
      <p class="hint">首次登录请设置密码，之后可用密码登录。</p>
      <input
        class="field"
        type="password"
        v-model="pwd"
        placeholder="新密码"
        :disabled="submitting"
      />
      <input
        class="field"
        type="password"
        v-model="confirm"
        placeholder="确认密码"
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
      <p v-if="err" class="err">{{ err }}</p>
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
  background: rgba(0, 0, 0, 0.5);
}
.modal-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card, #fff);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.btn {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid #ccc;
  cursor: pointer;
}
.btn.primary {
  background: #2563eb;
  color: #fff;
}
.btn.ghost {
  background: transparent;
}
.hint {
  font-size: 12px;
  color: #666;
}
.err {
  color: #dc2626;
  font-size: 12px;
}
</style>
