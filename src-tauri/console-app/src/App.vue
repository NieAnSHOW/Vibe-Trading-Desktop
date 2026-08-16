<script setup lang="ts">
import { ref, onMounted, onErrorCaptured } from "vue";
import { loadPublicConfig } from "./config/prod";
import Rail from "./components/Rail.vue";

const errMsg = ref("");
onErrorCaptured((e) => {
  errMsg.value = String(e);
  return false; // 阻止向上抛
});

// 启动即拉取服务端公共配置（enableLogin/enableAd/checkUpdate 等），失败静默降级默认值
onMounted(() => {
  document.getElementById("console-rail-bootstrap")?.remove();
  if (document.documentElement.classList.contains("desktop-shell-entering")) {
    requestAnimationFrame(() => document.documentElement.classList.remove("desktop-shell-entering"));
  }
  void loadPublicConfig();
});
</script>

<template>
  <div v-if="errMsg" class="fatal">
    控制台发生错误：{{ errMsg }}
  </div>
  <template v-else>
    <!-- 壳层级导航(账户/环境/研究/设置),fixed 定位常驻左侧 -->
    <Rail />
    <div class="shell-content" data-test="shell-content">
      <router-view v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </router-view>
    </div>
  </template>
</template>

<style>
.fatal {
  padding: 24px; color: #ff8080; font-family: ui-monospace, Menlo, monospace;
  background: #0e0f13; min-height: 100vh;
}

.page-enter-active,
.page-leave-active {
  transition: opacity 220ms ease, transform 220ms ease;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.shell-content:has(> .page-enter-active),
.shell-content:has(> .page-leave-active),
.shell-content:has(> .console-page--entering) {
  overflow: clip;
}

@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
