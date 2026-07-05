<script setup lang="ts">
// variant: primary | ghost | danger;busy 期间显示 spinner + busyLabel。
const props = defineProps<{
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}>();

defineEmits<{ (e: "click"): void }>();

const btnClass = `btn-${props.variant ?? "primary"}`;
</script>

<template>
  <button
    :class="[btnClass, { busy: busy }]"
    :disabled="disabled || busy"
    @click="$emit('click')"
  >
    <template v-if="busy">
      <span class="spinner"></span>{{ busyLabel }}
    </template>
    <slot v-else />
  </button>
</template>
