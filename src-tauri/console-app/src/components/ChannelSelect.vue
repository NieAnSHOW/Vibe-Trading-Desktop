<script setup lang="ts">
// 当前无消费者，多渠道扩展预留
defineProps<{ modelValue: string }>();
defineEmits<{ (e: "update:modelValue", v: string): void }>();
const OPTIONS = ["weixin", "wecom", "telegram", "slack", "discord", "qq", "napcat", "feishu", "dingtalk"];
</script>

<template>
  <select
    class="channel-select"
    aria-label="消息渠道"
    :value="modelValue"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="o in OPTIONS" :key="o" :value="o">{{ o }}</option>
  </select>
</template>
