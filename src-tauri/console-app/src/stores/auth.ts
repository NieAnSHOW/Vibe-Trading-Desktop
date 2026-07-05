import { defineStore } from "pinia";
import { ref } from "vue";
import type { AuthStatusView, UserInfo } from "../ipc/types";
import { consoleAuthStatus } from "../ipc/commands";

// 只存展示态：userInfo / authenticated / expireAt。token 永不进 store（保留在 Rust）。
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const userInfo = ref<UserInfo | null>(null);
  const expireAt = ref<number | null>(null);

  function setFromLogin(view: { userInfo: UserInfo; expireAt: number }) {
    authenticated.value = true;
    userInfo.value = view.userInfo;
    expireAt.value = view.expireAt;
  }

  function clear() {
    authenticated.value = false;
    userInfo.value = null;
    expireAt.value = null;
  }

  /** console 启动时从 Rust 恢复登录态（Rust 内存或 .env）。 */
  async function refresh() {
    try {
      const s: AuthStatusView = await consoleAuthStatus();
      authenticated.value = s.authenticated;
      userInfo.value = s.userInfo ?? null;
      expireAt.value = s.expireAt ?? null;
    } catch {
      clear();
    }
  }

  return { authenticated, userInfo, expireAt, setFromLogin, clear, refresh };
});
