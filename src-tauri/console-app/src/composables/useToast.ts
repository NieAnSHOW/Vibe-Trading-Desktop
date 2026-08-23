import { ref } from "vue";

export type ToastKind = "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

// ponytail: 模块级单例,全局共享一个 toast 队列(上限 4 条,桌面表单反馈足够)。
const toasts = ref<ToastItem[]>([]);
let nextId = 0;

export function useToast() {
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function clear() {
    toasts.value = [];
  }

  function push(kind: ToastKind, message: string) {
    const id = ++nextId;
    toasts.value = [...toasts.value, { id, kind, message }].slice(-4);
    setTimeout(() => dismiss(id), kind === "error" ? 4500 : 2600);
  }

  return {
    toasts,
    dismiss,
    clear,
    success: (message: string) => push("success", message),
    error: (message: string) => push("error", message),
  };
}
