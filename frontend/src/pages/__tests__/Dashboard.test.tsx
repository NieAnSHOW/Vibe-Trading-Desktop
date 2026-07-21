import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import i18n from "@/i18n";
import Dashboard from "@/pages/Dashboard";

// ── Mocks ─────────────────────────────────────────────────────

const mockStoreRef = {
  indexes: [] as unknown[],
  quotes: {} as Record<string, unknown>,
  selectedCode: null as string | null,
  selectedBars: [] as unknown[],
  marketSnapshot: null as Record<string, unknown> | null,
  indexesLoading: false,
  quotesLoading: false,
  barsLoading: false,
  marketSnapshotLoading: false,
  indexesError: null as string | null,
  quotesError: null as string | null,
  barsError: null as string | null,
  marketSnapshotError: null as string | null,
  initialize: vi.fn(),
  refreshMarketData: vi.fn(),
  setSelectedCode: vi.fn(),
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
};

const MARKET_SNAPSHOT = {
  breadth: {
    total: 4,
    up: 2,
    flat: 1,
    down: 1,
    upPct: 50,
    strongUp: 1,
    strongDown: 1,
    avgChangePct: 0.25,
    distribution: [
      { label: "-3~0%", count: 1, tone: "down" },
      { label: "0%", count: 1, tone: "flat" },
      { label: "0~3%", count: 1, tone: "up" },
      { label: "3~7%", count: 1, tone: "up" },
    ],
  },
  emotion: {
    score: 62,
    label: "warm",
    dimensions: [
      { key: "breadth", value: 50 },
      { key: "strength", value: 60 },
      { key: "highLow", value: 70 },
      { key: "limit", value: 80 },
      { key: "quality", value: 50 },
    ],
  },
  trend: { strongUp: 1, strongDown: 1, nearHigh: 2, nearLow: 1, highLowRatio: 67 },
  limit: { limitUp: 2, limitDown: 1, broken: 1, tiers: [{ boards: 3, count: 1 }, { boards: 2, count: 1 }] },
  concepts: [{ code: "BK001", name: "人工智能", changePct: 3.2, riseCount: 12, fallCount: 2, leadingStock: "龙头A", leadingStockChangePct: 8.8 }],
  industries: [{ code: "BK901", name: "半导体", changePct: 2.1, riseCount: 8, fallCount: 3, leadingStock: "龙头B", leadingStockChangePct: 6.5 }],
  topGainers: [{ code: "600519", name: "贵州茅台", price: 1500, changePct: 9.98, amount: 123456, turnoverRate: 0.5 }],
  topLosers: [{ code: "000002", name: "万科A", price: 10, changePct: -9.97, amount: 54321, turnoverRate: 1.2 }],
  turnoverLeaders: [{ code: "601318", name: "中国平安", price: 50, changePct: 1.5, amount: 999999, turnoverRate: 0.8 }],
  activeLeaders: [{ code: "300750", name: "宁德时代", price: 200, changePct: 2.3, amount: 234567, turnoverRate: 5.6 }],
  source: "stock-sdk",
  asOf: "2026-07-13T10:00:00Z",
  stale: false,
  areas: {
    market: { source: "market-source", asOf: "2026-07-13T10:00:00Z", stale: false, available: true },
    concepts: { source: "concept-source", asOf: "2026-07-13T10:01:00Z", stale: false, available: true },
    industries: { source: "industry-source", asOf: "2026-07-13T10:03:00Z", stale: false, available: true },
    limit: { source: "limit-source", asOf: "2026-07-13T10:02:00Z", stale: false, available: true },
  },
};

vi.mock("@/stores/marketDashboard", () => ({
  useMarketDashboardStore: (selector: (s: typeof mockStoreRef) => unknown) => selector(mockStoreRef),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: { ...original.api, listSessions: vi.fn().mockResolvedValue([]) } };
});

// ── Helpers ───────────────────────────────────────────────────

/** Build a minimal store snapshot with market data. */
function stateWithMarketData(overrides?: Partial<typeof mockStoreRef>) {
  Object.assign(mockStoreRef, {
    indexes: [
      { code: "000001", name: "上证指数", price: 3000, changePct: 0.5, changeAmt: 15, source: "test", stale: false },
      { code: "399001", name: "深证成指", price: 10000, changePct: -0.3, changeAmt: -30, source: "test", stale: false },
    ],
    quotes: {
      "600519": { code: "600519", name: "贵州茅台", price: 1500, changePct: 1.2, changeAmt: 18, source: "test", stale: false },
    },
    selectedCode: null,
    selectedBars: [],
    marketSnapshot: MARKET_SNAPSHOT,
    indexesError: null,
    quotesError: null,
    barsError: null,
    ...overrides,
  });
}

/** Render Dashboard in a MemoryRouter */
function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mockStoreRef fields
    Object.assign(mockStoreRef, {
      indexes: [],
      quotes: {},
      selectedCode: null,
      selectedBars: [],
      indexesLoading: false,
      quotesLoading: false,
      barsLoading: false,
      marketSnapshotLoading: false,
      indexesError: null,
      quotesError: null,
      barsError: null,
      marketSnapshotError: null,
    });
  });

  describe("lifecycle", () => {
    it("calls initialize and startPolling on mount", () => {
      renderDashboard();

      expect(mockStoreRef.initialize).toHaveBeenCalledOnce();
      expect(mockStoreRef.startPolling).toHaveBeenCalledOnce();
    });

    it("calls stopPolling on unmount", () => {
      const { unmount } = renderDashboard();
      unmount();

      expect(mockStoreRef.stopPolling).toHaveBeenCalledOnce();
    });
  });

  describe("market-first layout", () => {
    it("uses the full available width", () => {
      stateWithMarketData();
      const { container } = renderDashboard();

      expect(container.firstElementChild).toHaveClass("w-full");
      expect(container.firstElementChild).not.toHaveClass("max-w-[1440px]");
    });

    it("renders market-first sections before watchlist detail", () => {
      stateWithMarketData();
      renderDashboard();

      // The market overview section heading appears
      expect(screen.getByRole("heading", { name: /市场概览|Market Overview/i })).toBeInTheDocument();

      // Dashboard no longer owns the watchlist workflow.
      expect(screen.queryByText(/自选股|Watchlist/i)).toBeNull();
    });

    it("shows indexes in the market overview section", () => {
      stateWithMarketData();
      renderDashboard();

      expect(screen.getByText("上证指数")).toBeInTheDocument();
      expect(screen.getByText("深证成指")).toBeInTheDocument();
    });

    it("renders breadth, emotion, trend, limit ladder, and concept heat cards from the snapshot", () => {
      stateWithMarketData();
      renderDashboard();

      expect(screen.getByTestId("market-breadth-card")).toHaveTextContent("4");
      expect(screen.getByTestId("market-emotion-card")).toHaveTextContent("62");
      expect(screen.getByTestId("market-trend-card")).toHaveTextContent("2");
      expect(screen.getByTestId("market-limit-card")).toHaveTextContent("3");
      expect(screen.getByTestId("market-concepts-card")).toHaveTextContent("人工智能");
    });

    it("renders industry heat and ranking cards from the snapshot", () => {
      stateWithMarketData();
      renderDashboard();

      expect(screen.getByTestId("market-industries-card")).toHaveTextContent("半导体");
      expect(screen.queryByTestId("market-pulse-card")).toBeNull();
      expect(screen.getByTestId("top-gainers-card")).toHaveTextContent("贵州茅台");
      expect(screen.getByTestId("top-losers-card")).toHaveTextContent("万科A");
      expect(screen.getByTestId("turnover-leaders-card")).toHaveTextContent("中国平安");
      expect(screen.getByTestId("active-leaders-card")).toHaveTextContent("宁德时代");
    });

    it("lets dashboard data-card lists expand without internal scrolling", () => {
      stateWithMarketData();
      renderDashboard();

      const cardIds = [
        "market-concepts-card",
        "market-industries-card",
        "top-gainers-card",
        "top-losers-card",
        "turnover-leaders-card",
        "active-leaders-card",
      ];

      for (const cardId of cardIds) {
        const list = screen.getByTestId(cardId).querySelector("ul");
        expect(list).not.toBeNull();
        expect(list).not.toHaveClass("overflow-auto");
        expect(list?.className).not.toMatch(/max-h-/);
      }
    });

    it("anchors each rendered market card source footer to the card bottom", () => {
      stateWithMarketData();
      renderDashboard();

      const cardIds = [
        "market-breadth-card",
        "market-emotion-card",
        "market-trend-card",
        "market-limit-card",
        "market-concepts-card",
        "market-industries-card",
        "top-gainers-card",
        "top-losers-card",
        "turnover-leaders-card",
        "active-leaders-card",
      ];

      for (const cardId of cardIds) {
        const footer = screen.getByTestId(cardId).querySelector("footer");
        expect(footer).toHaveClass("mt-auto");
      }
    });

    it("marks only the concept card stale when concept data is unavailable", () => {
      stateWithMarketData({
        marketSnapshot: { ...MARKET_SNAPSHOT, stale: true, errors: { concepts: "concept source unavailable" } },
        marketSnapshotError: "concept source unavailable",
      });
      renderDashboard();

      const conceptCard = screen.getByTestId("market-concepts-card");
      expect(conceptCard).toHaveTextContent("concept source unavailable");
      expect(conceptCard.querySelector("footer")).toHaveClass("mt-auto");
      expect(screen.getByTestId("market-breadth-card")).not.toHaveTextContent("concept source unavailable");
    });

    it("shows source and last successful time for every market snapshot card", () => {
      stateWithMarketData();
      renderDashboard();

      const expectations = [
        ["market-breadth-card", "market-source", "2026-07-13T10:00:00Z"],
        ["market-emotion-card", "market-source", "2026-07-13T10:00:00Z"],
        ["market-trend-card", "market-source", "2026-07-13T10:00:00Z"],
        ["market-limit-card", "limit-source", "2026-07-13T10:02:00Z"],
        ["market-concepts-card", "concept-source", "2026-07-13T10:01:00Z"],
        ["market-industries-card", "industry-source", "2026-07-13T10:03:00Z"],
      ] as const;

      for (const [testId, source, asOf] of expectations) {
        const card = screen.getByTestId(testId);
        expect(card).toHaveTextContent(source);
        expect(card.querySelector("time")).toHaveAttribute("dateTime", asOf);
      }
    });
  });

  describe("watchlist migration", () => {
    it("does not render watchlist quotes or K-line detail", () => {
      stateWithMarketData();
      renderDashboard();

      expect(screen.queryByText(/自选股|Watchlist/i)).toBeNull();
      expect(screen.queryByText(/K-line chart/i)).toBeNull();
    });
  });

  describe("i18n labels", () => {
    it("shows dashboard navigation label in Chinese", () => {
      i18n.changeLanguage("zh-CN");
      stateWithMarketData();
      renderDashboard();

      expect(screen.getByRole("heading", { name: /市场概览/i })).toBeInTheDocument();
    });

    it("shows dashboard navigation label in English", () => {
      i18n.changeLanguage("en");
      stateWithMarketData();
      renderDashboard();

      expect(screen.getByRole("heading", { name: /Market Overview/i })).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows compact empty states when no data", () => {
      renderDashboard();

      // Should still render without crashing
      expect(screen.getByRole("heading", { name: /市场概览|Market Overview/i })).toBeInTheDocument();
    });
  });
});
