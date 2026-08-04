import { defineStore } from "pinia";
import { ref } from "vue";
import type { AuthStatusView, UserInfo } from "../ipc/types";
import { consoleAuthStatus } from "../ipc/commands";

// 只存展示态：userInfo / authenticated / expireAt。token 永不进 store（保留在 Rust）。
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const userInfo = ref<UserInfo | null>(null);
  const expireAt = ref<number | null>(null);
  const membershipChanged = ref(false);

  function setFromLogin(view: { userInfo: UserInfo; expireAt: number }) {
    authenticated.value = true;
    userInfo.value = view.userInfo;
    expireAt.value = view.expireAt;
    membershipChanged.value = false;
  }

  function clear() {
    authenticated.value = false;
    userInfo.value = null;
    expireAt.value = null;
    membershipChanged.value = false;
  }

  /** console 启动时从 Rust 恢复登录态（Rust 内存或 .env）。 */
  async function refresh() {
    try {
      const s: AuthStatusView = await consoleAuthStatus();
      authenticated.value = s.authenticated;
      userInfo.value = s.userInfo ?? null;
      expireAt.value = s.expireAt ?? null;
      membershipChanged.value = membershipChanged.value || s.membershipChanged === true;
    } catch {
      clear();
    }
  }

  function acknowledgeMembershipChange() {
    membershipChanged.value = false;
  }

  return {
    authenticated,
    userInfo,
    expireAt,
    membershipChanged,
    setFromLogin,
    clear,
    refresh,
    acknowledgeMembershipChange,
  };
});
