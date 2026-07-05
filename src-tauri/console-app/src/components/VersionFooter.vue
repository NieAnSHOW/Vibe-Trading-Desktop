<script setup lang="ts">
import { onMounted, ref } from "vue";

// 读 index.html footer 的 data-console-version 锚点(由 console-version.mjs 维护)。
const version = ref("");
onMounted(() => {
  const el = document.querySelector<HTMLDivElement>(".console-version");
  version.value = el?.dataset.consoleVersion ?? "";
});
</script>

<template>
  <footer v-if="version" class="console-version-text">控制台 {{ version }}</footer>
</template>
