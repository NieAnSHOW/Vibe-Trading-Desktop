<script setup lang="ts">
defineProps<{ hidden: boolean; text?: string }>();
</script>

<template>
  <div id="hint" class="hint" :hidden="hidden">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
    <span>{{ text ?? "首次安装可能需要 5 - 20 分钟，保证良好网络，请勿安装时退出" }}</span>
  </div>
</template>
