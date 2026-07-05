<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useBootstrapStore } from "../stores/bootstrap";

const bootstrap = useBootstrapStore();
const { pct, stageLabel, spinning, state, visible } = storeToRefs(bootstrap);
</script>

<template>
  <div v-if="visible" id="progress" :class="{ done: state === 'done', failed: state === 'failed' }">
    <div class="progress-meta">
      <span class="progress-stage">
        <span v-if="spinning" class="spinner"></span>{{ stageLabel }}
      </span>
      <span class="progress-pct">{{ state === "failed" ? "已中断" : Math.round(pct) + "%" }}</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" :style="{ width: pct + '%' }"></div>
    </div>
  </div>
</template>
