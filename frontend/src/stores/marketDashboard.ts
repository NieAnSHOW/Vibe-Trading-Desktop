import { create } from "zustand";
import type { PriceBar, MarketSummaryResponse, MarketSnapshotRequest } from "@/lib/api";
import { fetchWatchlistStocks, api } from "@/lib/api";
import {
  fetchDashboardIndexes,
  fetchMarketPulse,
  fetchDashboardQuotes,
  fetchDashboardDailyBars,
  fetchDashboardMarketSnapshot,
} from "@/lib/stockSdk";
import type { DashboardIndex, MarketPulseItem, DashboardQuote, DashboardMarketSnapshot } from "@/lib/stockSdk";

export interface MarketDashboardState {
  indexes: DashboardIndex[];
  pulse: MarketPulseItem[];
  quotes: Record<string, DashboardQuote>;
  selectedCode: string | null;
  selectedBars: PriceBar[];
  summary: MarketSummaryResponse | null;
  marketSnapshot: DashboardMarketSnapshot | null;

  indexesLoading: boolean;
  pulseLoading: boolean;
  quotesLoading: boolean;
  summaryLoading: boolean;
  barsLoading: boolean;
  marketSnapshotLoading: boolean;

  indexesError: string | null;
  pulseError: string | null;
  quotesError: string | null;
  summaryError: string | null;
  barsError: string | null;
  marketSnapshotError: string | null;

  pollingTimerId: ReturnType<typeof setInterval> | null;
  visibilityHandler: (() => void) | null;

  initialize: () => Promise<void>;
  refreshMarketData: () => Promise<void>;
  refreshSummary: (force?: boolean) => Promise<void>;
  setSelectedCode: (code: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

const POLL_INTERVAL = 15000;

export const useMarketDashboardStore = create<MarketDashboardState>((set, get) => ({
  indexes: [],
  pulse: [],
  quotes: {},
  selectedCode: null,
  selectedBars: [],
  summary: null,
  marketSnapshot: null,

  indexesLoading: false,
  pulseLoading: false,
  quotesLoading: false,
  summaryLoading: false,
  barsLoading: false,
  marketSnapshotLoading: false,

  indexesError: null,
  pulseError: null,
  quotesError: null,
  summaryError: null,
  barsError: null,
  marketSnapshotError: null,

  pollingTimerId: null,
  visibilityHandler: null,

  initialize: async () => {
    await get().refreshMarketData();
    await get().refreshSummary(false);
  },

  refreshMarketData: async () => {
    set({
      indexesLoading: true,
      pulseLoading: true,
      quotesLoading: true,
      marketSnapshotLoading: true,
    });

    const [indexesResult, pulseResult, stocksResult, marketSnapshotResult] = await Promise.allSettled([
      fetchDashboardIndexes(),
      fetchMarketPulse(),
      fetchWatchlistStocks(),
      fetchDashboardMarketSnapshot(),
    ]);

    // Indexes
    if (indexesResult.status === "fulfilled") {
      set({ indexes: indexesResult.value.data, indexesError: null });
    } else {
      set({ indexesError: (indexesResult.reason as Error)?.message ?? "indexes failed" });
    }

    // Pulse
    if (pulseResult.status === "fulfilled") {
      set({ pulse: pulseResult.value.data, pulseError: null });
    } else {
      set({ pulseError: (pulseResult.reason as Error)?.message ?? "pulse failed" });
    }

    // Full-market snapshot
    if (marketSnapshotResult.status === "fulfilled") {
      set({
        marketSnapshot: marketSnapshotResult.value.data,
        marketSnapshotError: marketSnapshotResult.value.error ?? null,
      });
    } else {
      set({ marketSnapshotError: (marketSnapshotResult.reason as Error)?.message ?? "market snapshot failed" });
    }

    // Watchlist → Quotes
    if (stocksResult.status === "fulfilled") {
      const codes = stocksResult.value.stocks.map((s) => s.code);
      if (codes.length > 0) {
        try {
          const quotesResult = await fetchDashboardQuotes(codes);
          set({ quotes: quotesResult.data, quotesError: null });
        } catch (e) {
          set({ quotesError: (e as Error)?.message ?? "quotes failed" });
        }
      } else {
        set({ quotes: {}, quotesError: null });
      }
    } else {
      set({ quotesError: (stocksResult.reason as Error)?.message ?? "watchlist failed" });
    }

    set({
      indexesLoading: false,
      pulseLoading: false,
      quotesLoading: false,
      marketSnapshotLoading: false,
    });
  },

  refreshSummary: async (force = false) => {
    set({ summaryLoading: true });

    const state = get();
    const snapshot: MarketSnapshotRequest = {
      market: "a_share",
      market_as_of: new Date().toISOString(),
      force_refresh: force,
      indices: state.indexes.map((i) => ({
        code: i.code,
        name: i.name,
        price: i.price ?? 0,
        change_pct: i.changePct ?? 0,
      })),
      sectors: [],
      watchlist: Object.values(state.quotes).map((q) => ({
        code: q.code,
        name: q.name,
        change_pct: q.changePct,
      })),
    };

    try {
      const response = await api.createMarketSummary(snapshot);
      set({
        summary: response,
        summaryError: response.available ? null : (response.error_code ?? "unavailable"),
      });
    } catch (e) {
      set({ summaryError: (e as Error)?.message ?? "summary failed" });
    }

    set({ summaryLoading: false });
  },

  setSelectedCode: async (code: string) => {
    set({ selectedCode: code, barsLoading: true, barsError: null });

    try {
      const result = await fetchDashboardDailyBars(code);
      set({ selectedBars: result.data, barsError: null });
    } catch (e) {
      set({ barsError: (e as Error)?.message ?? "bars failed" });
    }

    set({ barsLoading: false });
  },

  startPolling: () => {
    const { pollingTimerId } = get();

    // Already polling
    if (pollingTimerId) return;

    const handler = () => {
      if (document.visibilityState === "visible") {
        get().refreshMarketData();
      }
    };

    document.addEventListener("visibilitychange", handler);

    // Start interval only when visible
    let timerId: ReturnType<typeof setInterval> | null = null;
    if (document.visibilityState === "visible") {
      timerId = setInterval(() => {
        get().refreshMarketData();
      }, POLL_INTERVAL);
    }

    set({ pollingTimerId: timerId, visibilityHandler: handler });
  },

  stopPolling: () => {
    const { pollingTimerId, visibilityHandler } = get();

    if (pollingTimerId) {
      clearInterval(pollingTimerId);
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
    }

    set({ pollingTimerId: null, visibilityHandler: null });
  },
}));
