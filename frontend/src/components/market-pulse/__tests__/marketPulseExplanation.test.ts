import { describe, expect, it } from "vitest";
import type { MarketPulseItem } from "@/lib/stockSdk";
import { getMarketPulseExplanation } from "../marketPulseExplanation";

const event = (changeType: string): MarketPulseItem => ({
  code: "600519",
  name: "Guizhou Moutai",
  time: "10:00",
  changeType,
  info: "test",
  source: "test",
  stale: false,
});

describe("getMarketPulseExplanation", () => {
  it.each([
    ["封涨停板", "涨停异动"],
    ["火箭发射", "上涨异动"],
    ["高台跳水", "下跌异动"],
    ["打开涨停板", "跌停/炸板"],
    ["成交放量", "成交/资金"],
    ["未知事件", "未归类盘中变化"],
  ])("describes %s", (changeType, signal) => {
    const result = getMarketPulseExplanation(event(changeType));

    expect(result.signal).toContain(signal);
    expect(result.interpretation).not.toHaveLength(0);
    expect(result.risk).not.toHaveLength(0);
  });
});
