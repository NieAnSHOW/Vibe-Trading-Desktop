<script setup lang="ts">
// cls: "ok" | "warn" | "bad";live 控制是否加呼吸动画类。
defineProps<{ cls: string; text: string; live?: boolean }>();
</script>

<template>
  <span class="badge" :class="[cls, { live }]">
    <span class="dot"></span>{{ text }}
  </span>
</template>
