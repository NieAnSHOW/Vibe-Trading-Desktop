<script setup lang="ts">
import { ref } from "vue";
import tauriConf from "../../../tauri.conf.json";

const version = ref(tauriConf.version);
</script>

<template>
  <footer v-if="version" class="console-version-text">控制台 v{{ version }}</footer>
</template>
