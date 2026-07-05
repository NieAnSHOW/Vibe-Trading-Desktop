import { defineStore } from "pinia";
import { ref } from "vue";
import { consoleChannelsStatus } from "../ipc/commands";
import type { ChannelInfo, ChannelStatus } from "../ipc/types";

// 状态机搬自 console-dist/index.html 的 renderCh:
// expired → bad live "登录失效";running → ok live "运行中";
// enabled/loaded → warn "未登录";else → warn "未启用";服务未运行 → warn "未运行"。

export const useChannelsStore = defineStore("channels", () => {
  const info = ref<ChannelInfo | null>(null);
  const text = ref("未运行");
  const cls = ref("warn");
  const live = ref(false);

  function render(wx: ChannelInfo | null) {
    info.value = wx;
    live.value = false;
    if (!wx) {
      text.value = "未运行";
      cls.value = "warn";
      return;
    }
    if (wx.health === "expired") {
      cls.value = "bad"; live.value = true; text.value = "登录失效 · 需重新扫码";
    } else if (wx.running) {
      cls.value = "ok"; live.value = true; text.value = "运行中";
    } else if (wx.enabled || wx.loaded) {
      cls.value = "warn"; text.value = "未登录";
    } else {
      cls.value = "warn"; text.value = "未启用";
    }
  }

  async function refresh(port: number | null, serviceRunning: boolean) {
    if (!serviceRunning || port == null) {
      render(null);
      return;
    }
    try {
      const raw = await consoleChannelsStatus(port);
      const data: ChannelStatus = JSON.parse(raw);
      render(data.channels?.weixin ?? null);
    } catch {
      render(null);
    }
  }

  return { info, text, cls, live, render, refresh };
});
