<script setup lang="ts">
import { ref, onErrorCaptured } from "vue";

const errMsg = ref("");
onErrorCaptured((e) => {
  errMsg.value = String(e);
  return false; // 阻止向上抛
});
</script>

<template>
  <div v-if="errMsg" class="fatal">
    控制台发生错误：{{ errMsg }}
  </div>
  <router-view v-else />
</template>

<style>
.fatal {
  padding: 24px; color: #ff8080; font-family: ui-monospace, Menlo, monospace;
  background: #0e0f13; min-height: 100vh;
}
</style>
