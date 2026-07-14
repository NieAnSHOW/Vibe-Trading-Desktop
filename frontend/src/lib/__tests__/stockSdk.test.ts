import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock fns so vi.mock's factory can reference them
const {
  mockCnSimple,
  mockCn,
  mockKlineCn,
  mockStockChanges,
  mockBatchCn,
  mockConceptList,
  mockIndustryList,
  mockZtPool,
} = vi.hoisted(() => ({
  mockCnSimple: vi.fn(),
  mockCn: vi.fn(),
  mockKlineCn: vi.fn(),
  mockStockChanges: vi.fn(),
  mockBatchCn: vi.fn(),
  mockConceptList: vi.fn(),
  mockIndustryList: vi.fn(),
  mockZtPool: vi.fn(),
}));

vi.mock("stock-sdk", () => ({
  StockSDK: vi.fn(function () {
    return {
      quotes: { cnSimple: mockCnSimple, cn: mockCn },
      batch: { cn: mockBatchCn },
      board: { concept: { list: mockConceptList }, industry: { list: mockIndustryList } },
      kline: { cn: mockKlineCn },
      marketEvent: { stockChanges: mockStockChanges, ztPool: mockZtPool },
    };
  }),
}));

import * as dashboardSdk from "../stockSdk";
import {
  fetchDashboardIndexes,
  fetchMarketPulse,
  fetchDashboardQuotes,
  fetchDashboardDailyBars,
} from "../stockSdk";

beforeEach(() => {
  vi.clearAllMocks();
  mockIndustryList.mockResolvedValue([]);
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
      symbol: "sh000001",
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

// ---------------------------------------------------------------------------
// fetchDashboardMarketSnapshot
// ---------------------------------------------------------------------------
describe("fetchDashboardMarketSnapshot", () => {
  const snapshotFetcher = () => (
    dashboardSdk as typeof dashboardSdk & {
      fetchDashboardMarketSnapshot?: () => Promise<{ data: Record<string, unknown>; stale: boolean }>;
    }
  ).fetchDashboardMarketSnapshot;

  function seedMarketSnapshotSources() {
    mockBatchCn.mockResolvedValue([
      { code: "600001", name: "强势股", price: 10, changePercent: 4, high52w: 10.1, low52w: 5 },
      { code: "600002", name: "普通上涨", price: 10, changePercent: 1, high52w: 12, low52w: 6 },
      { code: "600003", name: "平盘股", price: 10, changePercent: 0, high52w: 12, low52w: 8 },
      { code: "600004", name: "弱势股", price: 5, changePercent: -4, high52w: 12, low52w: 5.05 },
    ]);
    mockConceptList.mockResolvedValue([
      { code: "BK001", name: "人工智能", changePercent: 3.2, riseCount: 12, fallCount: 2, leadingStock: "龙头A", leadingStockChangePercent: 8.8 },
      { code: "BK002", name: "半导体", changePercent: 1.4, riseCount: 8, fallCount: 5, leadingStock: "龙头B", leadingStockChangePercent: 5.2 },
    ]);
    mockZtPool.mockImplementation((type: string) => {
      if (type === "zt") {
        return Promise.resolve([
          { code: "600001", name: "三连板", continuousBoardCount: 3 },
          { code: "600005", name: "二连板", continuousBoardCount: 2 },
        ]);
      }
      if (type === "dt") return Promise.resolve([{ code: "600004", name: "跌停股" }]);
      return Promise.resolve([{ code: "600006", name: "炸板股" }]);
    });
  }

  it("marks an initially failed source unavailable instead of returning placeholder market values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    try {
      mockBatchCn.mockRejectedValueOnce(new Error("market source unavailable"));
      mockConceptList.mockResolvedValueOnce([]);
      mockZtPool.mockResolvedValue([]);
      const fetchSnapshot = snapshotFetcher();

      expect(fetchSnapshot).toEqual(expect.any(Function));
      if (!fetchSnapshot) return;

      const result = await fetchSnapshot();

      expect(result.data.breadth).toBeNull();
      expect(result.data.trend).toBeNull();
      expect(result.data.emotion).toBeNull();
      expect(result.data.errors?.market).toBe("market source unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aggregates breadth, ladder, and concepts and reuses the snapshot within 60 seconds", async () => {
    seedMarketSnapshotSources();
    const fetchSnapshot = snapshotFetcher();

    expect(fetchSnapshot).toEqual(expect.any(Function));
    if (!fetchSnapshot) return;

    const first = await fetchSnapshot();
    const second = await fetchSnapshot();
    const breadth = first.data.breadth as Record<string, unknown>;
    const limit = first.data.limit as Record<string, unknown>;
    const concepts = first.data.concepts as Array<Record<string, unknown>>;

    expect(breadth).toMatchObject({ total: 4, up: 2, flat: 1, down: 1, strongUp: 1, strongDown: 1 });
    expect(limit).toMatchObject({ limitUp: 2, limitDown: 1, broken: 1 });
    expect(limit.tiers).toEqual([
      { boards: 3, count: 1 },
      { boards: 2, count: 1 },
    ]);
    expect(concepts[0]).toMatchObject({ code: "BK001", name: "人工智能", changePct: 3.2 });
    expect(second).toBe(first);
    expect(mockBatchCn).toHaveBeenCalledTimes(1);
  });

  it("keeps only concepts stale when their source fails after cache expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    try {
      seedMarketSnapshotSources();
      const fetchSnapshot = snapshotFetcher();

      expect(fetchSnapshot).toEqual(expect.any(Function));
      if (!fetchSnapshot) return;

      const first = await fetchSnapshot();
      mockConceptList.mockRejectedValueOnce(new Error("concept source unavailable"));
      mockBatchCn.mockResolvedValueOnce([
        { code: "600001", name: "强势股", price: 10, changePercent: 4, high52w: 10.1, low52w: 5 },
        { code: "600002", name: "普通上涨", price: 10, changePercent: 1, high52w: 12, low52w: 6 },
        { code: "600003", name: "平盘股", price: 10, changePercent: 0, high52w: 12, low52w: 8 },
        { code: "600004", name: "转强股", price: 5, changePercent: 2, high52w: 12, low52w: 5.05 },
      ]);
      vi.advanceTimersByTime(61000);
      const fallback = await fetchSnapshot();

      expect(fallback.stale).toBe(true);
      expect(fallback.error).toBe("concept source unavailable");
      expect(fallback.data.concepts).toEqual(first.data.concepts);
      expect(fallback.data.breadth).toMatchObject({ up: 3, down: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains each area's latest successful data across later partial failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
    try {
      seedMarketSnapshotSources();
      const fetchSnapshot = snapshotFetcher();

      expect(fetchSnapshot).toEqual(expect.any(Function));
      if (!fetchSnapshot) return;

      await fetchSnapshot();
      mockConceptList.mockRejectedValueOnce(new Error("concept source unavailable"));
      mockBatchCn.mockResolvedValueOnce([
        { code: "600001", name: "强势股", price: 10, changePercent: 4, high52w: 10.1, low52w: 5 },
        { code: "600002", name: "转强股", price: 10, changePercent: 2, high52w: 12, low52w: 6 },
      ]);
      vi.advanceTimersByTime(61_000);
      const conceptFallback = await fetchSnapshot();
      expect(conceptFallback.data.breadth).toMatchObject({ up: 2, down: 0 });

      mockBatchCn.mockRejectedValueOnce(new Error("market source unavailable"));
      vi.advanceTimersByTime(61_000);
      const marketFallback = await fetchSnapshot();

      expect(marketFallback.data.breadth).toMatchObject({ up: 2, down: 0 });
      expect(marketFallback.data.errors?.market).toBe("market source unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a partial snapshot before the successful snapshot TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2200-01-01T00:00:00Z"));
    try {
      seedMarketSnapshotSources();
      const fetchSnapshot = snapshotFetcher();

      expect(fetchSnapshot).toEqual(expect.any(Function));
      if (!fetchSnapshot) return;

      await fetchSnapshot();
      vi.advanceTimersByTime(61_000);
      mockConceptList.mockRejectedValueOnce(new Error("concept source unavailable"));
      const partial = await fetchSnapshot();
      expect(partial.stale).toBe(true);

      mockBatchCn.mockResolvedValueOnce([
        { code: "600001", name: "转强股", price: 10, changePercent: 2, high52w: 10.1, low52w: 5 },
      ]);
      mockConceptList.mockResolvedValueOnce([
        { code: "BK001", name: "人工智能", changePercent: 4, riseCount: 12, fallCount: 2, leadingStock: "龙头A", leadingStockChangePercent: 8.8 },
      ]);
      vi.advanceTimersByTime(15_000);
      const recovered = await fetchSnapshot();

      expect(mockBatchCn).toHaveBeenCalledTimes(3);
      expect(recovered.stale).toBe(false);
      expect(recovered.data.breadth).toMatchObject({ total: 1, up: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one in-flight full-market request across concurrent callers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2300-01-01T00:00:00Z"));
    try {
      let resolveBatch: ((rows: Array<Record<string, unknown>>) => void) | undefined;
      mockBatchCn.mockImplementationOnce(() => new Promise((resolve) => {
        resolveBatch = resolve;
      }));
      mockConceptList.mockResolvedValueOnce([]);
      mockZtPool.mockResolvedValue([]);
      const fetchSnapshot = snapshotFetcher();

      expect(fetchSnapshot).toEqual(expect.any(Function));
      if (!fetchSnapshot) return;

      const first = fetchSnapshot();
      const second = fetchSnapshot();
      expect(mockBatchCn).toHaveBeenCalledOnce();

      resolveBatch?.([]);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult).toBe(firstResult);
    } finally {
      vi.useRealTimers();
    }
  });

});
