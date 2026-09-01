<script setup lang="ts">
import { onBeforeUnmount, onUnmounted, ref, watch } from "vue";
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
// 离场动画进行中:真正的 close() 与 close 事件延迟到 animationend(兜底计时器)
const closing = ref(false);
/** 与 CSS confirm-out 时长保持一致,兜底计时器另加余量 */
const OUT_MS = 170;
let closeTimer: number | undefined;
// close 事件只派发一次:真浏览器由原生 close 事件触发,jsdom 由 finishClose 补发
let closeEmitted = false;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function onClose() {
  if (closeEmitted) return;
  closeEmitted = true;
  emit("close", (dlg.value?.returnValue as "ok" | "cancel") ?? "cancel");
}

function finishClose() {
  window.clearTimeout(closeTimer);
  closeTimer = undefined;
  closing.value = false;
  // 真浏览器:close() 会派发原生 close 事件 → onClose;
  // jsdom 的 close() stub 不派发事件,直接补调(标志位防真浏览器二次派发)
  dlg.value?.close();
  onClose();
}

/** 所有常规关闭路径统一走这里:先播离场动画,结束后真正关闭并派发 close */
function animatedClose(value: "ok" | "cancel") {
  const d = dlg.value;
  if (!d || !d.open || closing.value) return;
  d.returnValue = value;
  if (prefersReducedMotion()) {
    finishClose();
    return;
  }
  closing.value = true;
  // animationend 之外的兜底:动画被打断或环境不支持动画时也能关闭
  closeTimer = window.setTimeout(finishClose, OUT_MS + 120);
}

function onAnimEnd(event: AnimationEvent) {
  if (closing.value && event.target === dlg.value) finishClose();
}

// Esc:原生 cancel 会直接关闭,改为带动画离场
function onCancel(event: Event) {
  event.preventDefault();
  animatedClose("cancel");
}

// 表单按钮(method=dialog)原生会直接关闭,同样改为动画离场
function onSubmit(event: Event) {
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  animatedClose((submitter?.value as "ok" | "cancel") ?? "cancel");
}

watch(
  () => props.open,
  (o) => {
    if (o) {
      // 重新打开:复位一次性标志;若离场途中被重开,取消离场保持显示
      closeEmitted = false;
      if (closing.value) {
        window.clearTimeout(closeTimer);
        closeTimer = undefined;
        closing.value = false;
        return;
      }
      if (dlg.value && !dlg.value.open) dlg.value.showModal();
      return;
    }
    animatedClose("cancel");
  },
);

onBeforeUnmount(() => {
  // 必须在 beforeUnmount:Vue 卸载序列先置空模板 ref 再调 unmounted 钩子,
  // 放 onUnmounted 时 ref 恒为 null,守卫是死代码(已用探针测试证实)。
  // WebKit 已知问题族:open 态 modal dialog 被移出 DOM 后 top layer 不清理,
  // 页面永久 inert(Chromium 自愈)。卸载前真正 close() 即免疫——恢复会话时
  // 公告弹窗与 auth.refresh→router.replace 存在竞态,LoginPage 可能带着
  // open dialog 被卸载。
  if (closing.value) finishClose();
  else if (dlg.value?.open) dlg.value.close();
});
onUnmounted(() => window.clearTimeout(closeTimer));
</script>

<template>
  <dialog
    ref="dlg"
    class="confirm"
    :class="{ 'confirm--info': hideCancel, 'confirm--closing': closing }"
    @close="onClose"
    @cancel="onCancel"
    @submit="onSubmit"
    @animationend="onAnimEnd"
  >
    <form method="dialog">
      <h3>{{ title }}</h3>
      <img v-if="image" class="confirm-image" :src="image" :alt="imageAlt ?? ''" />
      <p>
        <slot />
      </p>
      <div class="confirm-actions">
        <button v-if="!hideCancel" value="cancel" class="btn-ghost"><slot name="cancel-text">取消</slot></button>
        <button value="ok" :class="hideCancel ? 'btn-primary' : 'btn-danger'" type="submit">
          <slot name="confirm-text">确认</slot>
        </button>
      </div>
    </form>
  </dialog>
</template>
