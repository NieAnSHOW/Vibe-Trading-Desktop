<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import type { AdItem } from "../ipc/types";
import { consoleOpenExternalUrl } from "../ipc/commands";
import { ArrowUpRight, Megaphone } from "@lucide/vue";

const props = defineProps<{
  ads: AdItem[];
  variant: "banner" | "bottom";
}>();

// 展示文本:优先 content,缺省回退 title;跳转链接优先条目 link,再回退到首图 link
function adText(a: AdItem): string {
  return a.content || a.title || "";
}
function adLink(a: AdItem): string | null {
  return a.link ?? a.images?.[0]?.link ?? null;
}

const current = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const multi = computed(() => props.ads.length > 1);
const active = computed(() => props.ads[current.value]);
const hasLink = computed(() => !!(active.value && adLink(active.value)));

function next() {
  if (!multi.value) return;
  current.value = (current.value + 1) % props.ads.length;
}
function start() {
  stop();
  if (!multi.value) return; // 单条公告不滚动
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
  () => props.ads.length,
  () => {
    if (current.value >= props.ads.length) current.value = 0;
    start();
  },
);

async function onClick() {
  const link = active.value && adLink(active.value);
  if (link) await consoleOpenExternalUrl(link);
}

onMounted(start);
onUnmounted(stop);
</script>

<template>
  <!-- 公告条:上下轮播,一次只露一条;悬停暂停;仅一条时静态;带链接则整条可点击,
       常驻品牌色 + 末尾跳转箭头,键盘 Enter/Space 也可激活 -->
  <div v-if="ads.length" :class="[variant === 'banner' ? 'ad-banner' : 'ad-bottom', { 'ad--link': hasLink }]"
    :role="hasLink ? 'button' : undefined" :tabindex="hasLink ? 0 : undefined"
    :title="adText(active)" @mouseenter="stop" @mouseleave="start"
    @click="onClick" @keydown.enter="onClick" @keydown.space.prevent="onClick">
    <div class="ad-viewport">
      <Transition name="ad-slide">
        <p :key="current" class="ad-row" :class="{ 'ad-row--link': hasLink }">
          <Megaphone class="ad-mark" :size="13" aria-hidden="true" />
          <span class="ad-text">{{ adText(active) }}</span>
          <ArrowUpRight v-if="hasLink" class="ad-link-icon" :size="13" aria-hidden="true" />
        </p>
      </Transition>
    </div>
  </div>
</template>
