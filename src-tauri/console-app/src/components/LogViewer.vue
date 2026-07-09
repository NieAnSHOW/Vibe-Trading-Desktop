<script setup lang="ts">
import { ref, nextTick } from "vue";

const lines = ref<string[]>([]);
const el = ref<HTMLDivElement | null>(null);

defineEmits<{ (e: "open-logs"): void; (e: "clear-logs"): void }>();

function append(line: string) {
  const atBottom =
    el.value && el.value.scrollHeight - el.value.scrollTop - el.value.clientHeight < 40;
  lines.value.push(line);
  if (atBottom) nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight; });
}
function clear() {
  lines.value = [];
}

defineExpose({ append, clear });
</script>

<template>
  <div>
    <div class="log-head">
      <span class="log-title">运行日志</span>
      <div>
        <button class="log-clear" @click="$emit('open-logs')">打开日志目录</button>
        <button class="log-clear" type="button" @click="$emit('clear-logs')">清理日志文件</button>
        <button class="log-clear" type="button" @click="clear">清空</button>
      </div>
    </div>
    <div
      id="log"
      ref="el"
      role="log"
      aria-live="polite"
      :class="{ empty: lines.length === 0 }"
    >
      <template v-if="lines.length">
        <span v-for="(l, i) in lines" :key="i">{{ l }}<br /></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 占位符样式由全局 console.css 接管;此处仅保留 empty 伪元素的兜底。 */
#log.empty::after {
  content: "等待操作输出…";
  color: hsl(0 0% 60% / 0.55);
}
</style>
