import { defineStore } from "pinia";
import { ref } from "vue";
import { consoleStatus } from "../ipc/commands";
import type { EnvState } from "../ipc/types";

export const useEnvStore = defineStore("env", () => {
  const env = ref<EnvState | null>(null);
  const port = ref<number | null>(null);
  const serviceRunning = ref(false);
  const loading = ref(true);
  const error = ref<string>("");

  async function refresh() {
    loading.value = true;
    try {
      const s = await consoleStatus();
      env.value = s.env;
      serviceRunning.value = s.service_running;
      // port 由 service://started 事件或 startService 返回值设置,此处不覆盖已就绪的 port。
      if (s.port != null) port.value = s.port;
      error.value = "";
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  function setPort(p: number | null) {
    port.value = p;
  }

  return { env, port, serviceRunning, loading, error, refresh, setPort };
});
