<script setup lang="ts">
import { computed } from "vue";
import type { AdItem } from "../ipc/types";
import ProdConfig from "../config/prod.ts";
import AdCarousel from "./AdCarousel.vue";

const props = defineProps<{
  ad: AdItem | null;
  variant: "banner" | "bottom";
}>();

function imgUrl(u: string) {
  return `${ProdConfig.imgBase}${u}`;
}
function openLink(link?: string | null) {
  if (link) window.open(link, "_blank", "noopener");
}

// banner 轮播图(拼好完整 url + 每张图独立 link,缺省回退到广告条目 link)
const carouselImages = computed(() => {
  const a = props.ad;
  if (!a?.images?.length) return [];
  return a.images.map((im) => ({ url: imgUrl(im.url), link: im.link ?? a.link }));
});
const bottomImg = computed(() => {
  const a = props.ad;
  return a?.images?.length ? { url: imgUrl(a.images[0].url), link: a.images[0].link ?? a.link } : null;
});
</script>

<template>
  <div v-if="ad" :class="variant === 'banner' ? 'ad-banner' : 'ad-bottom'">
    <!-- 标题:仅 banner 且广告条目自带 title 时展示 -->
    <h3 v-if="variant === 'banner' && ad.title" class="ad-title">{{ ad.title }}</h3>
    <h3 v-else class="ad-title" style="margin-bottom: 0; font-size: 18px;">{{ ad.title }}</h3>

    <!-- 文字广告(type=2):banner 用 p(居中换行),bottom 用 span(横排) -->
    <template v-if="ad.type === 2">
      <component :is="variant === 'banner' ? 'p' : 'span'">{{ ad.content }}</component>
      <a v-if="ad.link" :href="ad.link" target="_blank" class="ad-link">查看详情 →</a>
    </template>

    <!-- 图片广告:banner 走轮播(多图自动切换);bottom 保持原单图 -->
    <AdCarousel v-else-if="variant === 'banner' && carouselImages.length" :images="carouselImages" />
    <img v-else-if="variant === 'bottom' && bottomImg" :src="bottomImg?.url" :alt="ad.title"
      :style="{ maxWidth: '100%', cursor: bottomImg?.link ? 'pointer' : 'default' }"
      @click="openLink(bottomImg?.link)" />
  </div>
</template>
