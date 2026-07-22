import type { MarketPulseItem } from "@/lib/stockSdk";
import { categorizeMarketPulse } from "./marketPulse";

export interface MarketPulseExplanation {
  signal: string;
  interpretation: string;
  risk: string;
}

const EXPLANATIONS: Record<Exclude<ReturnType<typeof categorizeMarketPulse>, "all">, MarketPulseExplanation> = {
  limitUp: {
    signal: "涨停异动：封板或冲板信号",
    interpretation: "盘中买方力量增强，需观察封板是否持续。",
    risk: "封单变化和炸板会放大波动，次日表现存在不确定性。",
  },
  upward: {
    signal: "上涨异动：短时上行信号",
    interpretation: "盘中买盘或价格动能增强，需结合后续量价验证。",
    risk: "短时拉升不代表趋势确认，注意追高与回落风险。",
  },
  downward: {
    signal: "下跌异动：短时走弱信号",
    interpretation: "盘中卖压或下行动能增强，需观察后续承接。",
    risk: "支撑失守、流动性变化和情绪扩散可能加剧波动。",
  },
  limitDownBroken: {
    signal: "跌停/炸板：强势价格状态变化",
    interpretation: "封板被打开或下行压力显现，盘中分歧正在扩大。",
    risk: "封单和承接快速变化时，价格波动可能加大。",
  },
  turnoverCapital: {
    signal: "成交/资金：盘中活动异常",
    interpretation: "成交或资金活动出现变化，单一时点不足以确认趋势。",
    risk: "资金与成交信号需要结合持续性和整体行情验证。",
  },
  other: {
    signal: "未归类盘中变化",
    interpretation: "系统检测到尚未归类的异动，需要结合行情进一步判断。",
    risk: "请结合公开信息和后续行情验证，避免仅凭单条信号决策。",
  },
};

export function getMarketPulseExplanation(item: MarketPulseItem): MarketPulseExplanation {
  const category = categorizeMarketPulse(item);
  return EXPLANATIONS[category === "all" ? "other" : category];
}
