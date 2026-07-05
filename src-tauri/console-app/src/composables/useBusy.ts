import { ref } from "vue";

// 替代原 index.html 的 busy(btn, label, fn):按钮 busy 态期间
// 显示 spinner + label 并禁用;完成或失败后恢复。
export function useBusy() {
  const busy = ref(false);
  const label = ref("");

  async function run<T>(busyLabel: string, fn: () => Promise<T>): Promise<T | undefined> {
    busy.value = true;
    label.value = busyLabel;
    try {
      return await fn();
    } finally {
      busy.value = false;
      label.value = "";
    }
  }

  return { busy, label, run };
}
