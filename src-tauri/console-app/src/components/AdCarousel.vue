<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";

// ponytail: fade 轮播,无依赖。单图自动隐藏控件、停定时器。
interface Slide {
  url: string;
  link?: string | null;
}

const props = defineProps<{ images: Slide[] }>();

const current = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const multi = computed(() => props.images.length > 1);

function go(i: number) {
  if (!props.images.length) return;
  current.value = (i + props.images.length) % props.images.length;
}
const next = () => go(current.value + 1);
const prev = () => go(current.value - 1);

function openLink(link?: string | null) {
  if (link) window.open(link, "_blank", "noopener");
}

function start() {
  stop();
  if (!multi.value) return;
  timer = setInterval(next, 4000);
}
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// 广告轮询替换数据时,索引可能越界 → 归零并重启定时器
watch(
  () => props.images.length,
  () => {
    if (current.value >= props.images.length) current.value = 0;
    start();
  },
);

onMounted(start);
onUnmounted(stop);
</script>

<template>
  <div class="ad-carousel" @mouseenter="stop" @mouseleave="start">
    <div
      v-for="(img, i) in images"
      :key="i"
      class="ad-slide"
      :class="{ active: i === current, clickable: !!img.link }"
      @click="openLink(img.link)"
    >
      <img :src="img.url" :alt="`ad-${i + 1}`" draggable="false" />
    </div>

    <template v-if="multi">
      <button class="ad-nav prev" type="button" aria-label="上一张" @click="prev">‹</button>
      <button class="ad-nav next" type="button" aria-label="下一张" @click="next">›</button>
      <div class="ad-dots">
        <button
          v-for="i in images.length"
          :key="i"
          type="button"
          class="ad-dot"
          :class="{ active: i - 1 === current }"
          :aria-label="`第 ${i} 张`"
          @click="go(i - 1)"
        ></button>
      </div>
    </template>
  </div>
</template>
