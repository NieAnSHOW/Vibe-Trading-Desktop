import { defineStore } from "pinia";
import { ref } from "vue";
import type { BootstrapStage } from "../ipc/types";

// 算法原样搬自 console-dist/index.html 的 STAGE 表 + advanceProgress:
// venv/installing/smoke/done/failed 五阶段;installing 期间渐近逼近 ceil(92),
// 每步行走「剩余距离」的 6%,越接近越慢,永不倒退、永不到 100%。

interface StageDef {
  base: number;
  ceil: number;
  label: string;
}

const STAGE: Record<BootstrapStage, StageDef> = {
  venv: { base: 5, ceil: 15, label: "创建虚拟环境" },
  installing: { base: 15, ceil: 92, label: "安装依赖包" },
  smoke: { base: 93, ceil: 98, label: "校验关键依赖" },
  done: { base: 100, ceil: 100, label: "安装完成" },
  failed: { base: 100, ceil: 100, label: "安装失败" },
};

export const useBootstrapStore = defineStore("bootstrap", () => {
  const pct = ref(0);
  const stageLabel = ref("准备中…");
  const spinning = ref(false);
  const state = ref<"idle" | "running" | "done" | "failed">("idle");
  const visible = ref(false);

  function setProgress(nextPct: number, label: string, spin: boolean) {
    // 单调不倒退:取 max(当前, 新值),并 clamp 到 [0,100]。
    pct.value = Math.max(pct.value, Math.min(100, nextPct));
    stageLabel.value = label;
    spinning.value = spin;
  }

  function start() {
    pct.value = 0;
    visible.value = true;
    state.value = "running";
    setProgress(2, "准备中…", true);
  }

  function advance(stage: BootstrapStage, _message: string) {
    const s = STAGE[stage];
    if (!s) return;
    if (stage === "installing") {
      // 渐近逼近 ceil:每步行剩余距离的 6%,越接近越慢。
      const target = s.ceil;
      const next = pct.value + (target - pct.value) * 0.06;
      // ponytail: 进度条只显示阶段状态("安装依赖包"),不显示具体包名;明细走 ConsolePage 日志区
      setProgress(Math.max(next, s.base), s.label, true);
    } else if (stage === "done") {
      state.value = "done";
      setProgress(100, s.label, false);
    } else if (stage === "failed") {
      state.value = "failed";
      // 失败时停在当前百分比,不强推 100。
      setProgress(pct.value, s.label, false);
    } else {
      // venv / smoke:直接跳到该阶段基准(但受单调约束)。
      setProgress(s.base, s.label, true);
    }
  }

  function reset() {
    pct.value = 0;
    stageLabel.value = "准备中…";
    spinning.value = false;
    state.value = "idle";
    visible.value = false;
  }

  return { pct, stageLabel, spinning, state, visible, start, advance, reset };
});
