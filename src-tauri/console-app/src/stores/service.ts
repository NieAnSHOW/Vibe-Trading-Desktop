import { defineStore } from "pinia";
import { ref } from "vue";
import {
  consoleStartService,
  consoleStopService,
  consoleOpenWebui,
} from "../ipc/commands";

export const useServiceStore = defineStore("service", () => {
  const running = ref(false);

  function setRunning(b: boolean) {
    running.value = b;
  }

  async function start(options: { openWebui?: boolean } = {}) {
    const { openWebui = true } = options;
    // 返回 port;调用方负责 setPort 与自动打开 WebUI。
    const port = await consoleStartService();
    running.value = true;
    if (openWebui) {
      await consoleOpenWebui(port);
    }
    return port;
  }

  async function stop() {
    await consoleStopService();
    running.value = false;
  }

  return { running, setRunning, start, stop };
});
