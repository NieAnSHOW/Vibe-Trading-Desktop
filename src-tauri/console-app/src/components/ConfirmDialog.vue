<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ (e: "close", value: "ok" | "cancel"): void }>();
const dlg = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (o) => {
    if (o && dlg.value && !dlg.value.open) dlg.value.showModal();
    if (!o && dlg.value && dlg.value.open) dlg.value.close();
  },
);

function onClose() {
  emit("close", (dlg.value?.returnValue as "ok" | "cancel") ?? "cancel");
}
</script>

<template>
  <dialog ref="dlg" class="confirm" @close="onClose">
    <form method="dialog">
      <h3>{{ title }}</h3>
      <p>
        <slot />
      </p>
      <div class="confirm-actions">
        <button value="cancel" class="btn-ghost">取消</button>
        <button value="ok" class="btn-danger" type="submit">
          <slot name="confirm-text">确认</slot>
        </button>
      </div>
    </form>
  </dialog>
</template>
