<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  image?: string;
  imageAlt?: string;
  // 单按钮信息型(如客服二维码展示):隐藏取消,文字/图片居中,确认按钮用品牌色
  hideCancel?: boolean;
}>();
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
  <dialog ref="dlg" class="confirm" :class="{ 'confirm--info': hideCancel }" @close="onClose">
    <form method="dialog">
      <h3>{{ title }}</h3>
      <img v-if="image" class="confirm-image" :src="image" :alt="imageAlt ?? ''" />
      <p>
        <slot />
      </p>
      <div class="confirm-actions">
        <button v-if="!hideCancel" value="cancel" class="btn-ghost">取消</button>
        <button value="ok" :class="hideCancel ? 'btn-primary' : 'btn-danger'" type="submit">
          <slot name="confirm-text">确认</slot>
        </button>
      </div>
    </form>
  </dialog>
</template>
