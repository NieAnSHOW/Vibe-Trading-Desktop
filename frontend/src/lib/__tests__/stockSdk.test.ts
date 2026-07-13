import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock fns so vi.mock's factory can reference them
const { mockCnSimple, mockCn, mockKlineCn, mockStockChanges } = vi.hoisted(() => ({
  mockCnSimple: vi.fn(),
  mockCn: vi.fn(),
  mockKlineCn: vi.fn(),
  mockStockChanges: vi.fn(),
}));

vi.mock("stock-sdk", () => ({
  StockSDK: vi.fn(function () {
    return {
      quotes: { cnSimple: mockCnSimple, cn: mockCn },
      kline: { cn: mockKlineCn },
      marketEvent: { stockChanges: mockStockChanges },
    };
  }),
}));

import {
  fetchDashboardIndexes,
  fetchMarketPulse,
  fetchDashboardQuotes,
  fetchDashboardDailyBars,
} from "../stockSdk";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchDashboardQuotes
// ---------------------------------------------------------------------------
describe("fetchDashboardQuotes", () => {
  it("normalizes A-share quote fields and source metadata", async () => {
    mockCnSimple.mockResolvedValueOnce([
      { code: "600519", name: "贵州茅台", price: 1500, change: 5.2, changePercent: 1.2 },
    ]);

    const result = await fetchDashboardQuotes(["600519"]);

    expect(result.data["600519"]).toMatchObject({
      code: "600519",
      price: 1500,
      changePct: 1.2,
      source: "stock-sdk",
    });
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.stale).toBe(false);
  });

  it("strips sh/sz prefixes and .SH/.SZ suffixes from codes", async () => {
    mockCnSimple.mockResolvedValueOnce([
      { code: "sh600519", name: "贵州茅台", price: 1500, change: 5.2, changePercent: 1.2 },
      { code: "000858.SZ", name: "五粮液", price: 130, change: 2.0, changePercent: 0.8 },
    ]);

    const result = await fetchDashboardQuotes(["sh600519", "000858.SZ"]);

    expect(result.data["600519"]).toBeDefined();
    expect(result.data["000858"]).toBeDefined();
  });

  it("returns a recoverable stale result when the SDK rejects", async () => {
    mockCnSimple.mockRejectedValueOnce(new Error("timeout"));

    const result = await fetchDashboardQuotes(["600519"]);

    expect(result).toMatchObject({ data: {}, stale: true, error: "timeout" });
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles non-Error rejections gracefully", async () => {
    mockCnSimple.mockRejectedValueOnce("network failure");

    const result = await fetchDashboardQuotes(["600519"]);

    expect(result.stale).toBe(true);
    expect(result.error).toBe("stock-sdk request failed");
  });

  it("handles rows with invalid/missing number fields", async () => {
    mockCnSimple.mockResolvedValueOnce([
      { code: "600519", name: "贵州茅台", price: NaN, change: undefined, changePercent: null },
      { code: "000858", name: "五粮液", price: 130, change: 2.0, changePercent: Infinity },
    ]);

    const result = await fetchDashboardQuotes(["600519", "000858"]);

    expect(result.data["600519"]).toMatchObject({ price: null, changePct: null, changeAmt: null });
    expect(result.data["000858"]).toMatchObject({ price: 130, changePct: null, changeAmt: 2.0 });
  });

  it("does not leak SDK internal fields to consumers", async () => {
    mockCnSimple.mockResolvedValueOnce([
      { code: "600519", name: "贵州茅台", price: 1500, change: 5.2, changePercent: 1.2,
        volume: 1000, amount: 1500000, marketCap: 20000, marketType: "GP-A", market: "CN", assetType: "stock" },
    ]);

    const result = await fetchDashboardQuotes(["600519"]);
    const quote = result.data["600519"];

    expect(quote).not.toHaveProperty("volume");
    expect(quote).not.toHaveProperty("amount");
    expect(quote).not.toHaveProperty("marketCap");
    expect(quote).not.toHaveProperty("marketType");
    expect(quote).not.toHaveProperty("market");
    expect(quote).not.toHaveProperty("assetType");
    expect(Object.keys(quote).sort()).toEqual(
      ["code", "name", "price", "changePct", "changeAmt", "source", "stale"].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// fetchDashboardDailyBars
// ---------------------------------------------------------------------------
describe("fetchDashboardDailyBars", () => {
  it("maps HistoryKline rows to PriceBar shape", async () => {
    mockKlineCn.mockResolvedValueOnce([
      { date: "2026-07-13", open: 1490, close: 1500, high: 1510, low: 1488, volume: 1200 },
      { date: "2026-07-12", open: 1480, close: 1490, high: 1495, low: 1478, volume: 1000 },
    ]);

    const result = await fetchDashboardDailyBars("600519");

    expect(result.stale).toBe(false);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      time: "2026-07-13",
      open: 1490,
      close: 1500,
      high: 1510,
      low: 1488,
      volume: 1200,
    });
  });

  it("handles nullable kline fields", async () => {
    mockKlineCn.mockResolvedValueOnce([
      { date: "2026-07-13", open: null, close: null, high: null, low: null, volume: null },
    ]);

    const result = await fetchDashboardDailyBars("600519");

    expect(result.data[0]).toMatchObject({
      time: "2026-07-13",
      open: 0,
      close: 0,
      high: 0,
      low: 0,
      volume: 0,
    });
  });

  it("returns stale on SDK error", async () => {
    mockKlineCn.mockRejectedValueOnce(new Error("network error"));

    const result = await fetchDashboardDailyBars("600519");

    expect(result.stale).toBe(true);
    expect(result.error).toBe("network error");
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchDashboardIndexes
// ---------------------------------------------------------------------------
describe("fetchDashboardIndexes", () => {
  it("returns normalized DashboardIndex array for major indices", async () => {
    mockCn.mockResolvedValueOnce([
      { code: "sh000001", name: "上证指数", price: 3250, change: 15.3, changePercent: 0.47 },
      { code: "sz399001", name: "深证成指", price: 10800, change: -50.2, changePercent: -0.46 },
    ]);

    const result = await fetchDashboardIndexes();

    expect(result.stale).toBe(false);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      code: "000001",
      name: "上证指数",
      price: 3250,
      source: "stock-sdk",
    });
  });

  it("strips sh/sz prefixes from index codes", async () => {
    mockCn.mockResolvedValueOnce([
      { code: "sh000001", name: "上证指数", price: 3250, change: 15.3, changePercent: 0.47 },
    ]);

    const result = await fetchDashboardIndexes();

    expect(result.data[0].code).toBe("000001");
  });

  it("returns stale on SDK error", async () => {
    mockCn.mockRejectedValueOnce(new Error("timeout"));

    const result = await fetchDashboardIndexes();

    expect(result.stale).toBe(true);
    expect(result.error).toBe("timeout");
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchMarketPulse
// ---------------------------------------------------------------------------
describe("fetchMarketPulse", () => {
  it("returns MarketPulseItem array from stockChanges", async () => {
    mockStockChanges.mockResolvedValueOnce([
      { code: "600519", name: "贵州茅台", time: "10:30", changeTypeLabel: "涨停", info: "封单1.2亿" },
      { code: "000858", name: "五粮液", time: "10:25", changeTypeLabel: "大涨", info: "涨超7%" },
    ]);

    const result = await fetchMarketPulse();

    expect(result.stale).toBe(false);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      code: "600519",
      name: "贵州茅台",
      time: "10:30",
      changeType: "涨停",
      source: "stock-sdk",
    });
  });

  it("returns stale on SDK error", async () => {
    mockStockChanges.mockRejectedValueOnce(new Error("network error"));

    const result = await fetchMarketPulse();

    expect(result.stale).toBe(true);
    expect(result.error).toBe("network error");
    expect(result.data).toEqual([]);
  });

  it("handles missing optional fields gracefully", async () => {
    mockStockChanges.mockResolvedValueOnce([
      { code: "600519", name: "贵州茅台" },
    ]);

    const result = await fetchMarketPulse();
    const item = result.data[0];

    expect(item).toMatchObject({
      code: "600519",
      time: "",
      changeType: "",
      info: "",
      source: "stock-sdk",
    });
  });
});
