import { create } from "zustand";
import type { PriceBar } from "@/lib/api";
import { fetchWatchlistStocks } from "@/lib/api";
import {
  fetchDashboardIndexes,
  fetchMarketPulse,
  fetchDashboardQuotes,
  fetchDashboardDailyBars,
  fetchDashboardIntradayBars,
  fetchDashboardMarketSnapshot,
} from "@/lib/stockSdk";
import type { DashboardIndex, MarketPulseItem, DashboardQuote, DashboardMarketSnapshot } from "@/lib/stockSdk";

export interface MarketDashboardState {
  indexes: DashboardIndex[];
  pulse: MarketPulseItem[];
  pulseAsOf: string | null;
  pulseStale: boolean;
  quotes: Record<string, DashboardQuote>;
  selectedCode: string | null;
  selectedBars: PriceBar[];
  selectedIntradayBars: PriceBar[];
  marketSnapshot: DashboardMarketSnapshot | null;

  indexesLoading: boolean;
  pulseLoading: boolean;
  quotesLoading: boolean;
  barsLoading: boolean;
  intradayLoading: boolean;
  marketSnapshotLoading: boolean;

  indexesError: string | null;
  pulseError: string | null;
  quotesError: string | null;
  barsError: string | null;
  intradayError: string | null;
  intradayStale: boolean;
  marketSnapshotError: string | null;

  pollingTimerId: ReturnType<typeof setInterval> | null;
  visibilityHandler: (() => void) | null;

  initialize: () => Promise<void>;
  refreshMarketData: () => Promise<void>;
  refreshPulse: () => Promise<void>;
  setSelectedCode: (code: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

const POLL_INTERVAL = 15000;
let selectedCodeRequestId = 0;

export const useMarketDashboardStore = create<MarketDashboardState>((set, get) => ({
  indexes: [],
  pulse: [],
  pulseAsOf: null,
  pulseStale: false,
  quotes: {},
  selectedCode: null,
  selectedBars: [],
  selectedIntradayBars: [],
  marketSnapshot: null,

  indexesLoading: false,
  pulseLoading: false,
  quotesLoading: false,
  barsLoading: false,
  intradayLoading: false,
  marketSnapshotLoading: false,

  indexesError: null,
  pulseError: null,
  quotesError: null,
  barsError: null,
  intradayError: null,
  intradayStale: false,
  marketSnapshotError: null,

  pollingTimerId: null,
  visibilityHandler: null,

  initialize: async () => {
    await get().refreshMarketData();
  },

  refreshPulse: async () => {
    set({ pulseLoading: true });
    try {
      const result = await fetchMarketPulse();
      if (result.stale || result.error) {
        set({ pulseError: result.error ?? "pulse failed", pulseStale: true });
        return;
      }
      set({
        pulse: result.data,
        pulseAsOf: result.asOf,
        pulseStale: false,
        pulseError: null,
      });
    } catch (error) {
      set({
        pulseError: (error as Error)?.message ?? "pulse failed",
        pulseStale: true,
      });
    } finally {
      set({ pulseLoading: false });
    }
  },

  refreshMarketData: async () => {
    set({
      indexesLoading: true,
      quotesLoading: true,
      marketSnapshotLoading: true,
    });

    const [indexesResult, stocksResult, marketSnapshotResult] = await Promise.allSettled([
      fetchDashboardIndexes(),
      fetchWatchlistStocks(),
      fetchDashboardMarketSnapshot(),
    ]);

    // Indexes
    if (indexesResult.status === "fulfilled") {
      set({ indexes: indexesResult.value.data, indexesError: null });
    } else {
      set({ indexesError: (indexesResult.reason as Error)?.message ?? "indexes failed" });
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
      quotesLoading: false,
      marketSnapshotLoading: false,
    });
  },

  setSelectedCode: async (code: string) => {
    const requestId = ++selectedCodeRequestId;
    const isActiveRequest = () =>
      get().selectedCode === code && selectedCodeRequestId === requestId;

    set({
      selectedCode: code,
      selectedBars: [],
      selectedIntradayBars: [],
      barsLoading: true,
      intradayLoading: true,
      barsError: null,
      intradayError: null,
      intradayStale: false,
    });

    const loadDaily = async () => {
      try {
        const result = await fetchDashboardDailyBars(code);
        if (isActiveRequest()) {
          set({ selectedBars: result.data, barsError: result.error ?? null });
        }
      } catch (error) {
        if (isActiveRequest()) {
          set({ barsError: (error as Error)?.message ?? "bars failed" });
        }
      } finally {
        if (isActiveRequest()) set({ barsLoading: false });
      }
    };

    const loadIntraday = async () => {
      try {
        const result = await fetchDashboardIntradayBars(code);
        if (isActiveRequest()) {
          set({
            selectedIntradayBars: result.data,
            intradayError: result.error ?? null,
            intradayStale: result.stale,
          });
        }
      } catch (error) {
        if (isActiveRequest()) {
          set({
            intradayError: (error as Error)?.message ?? "intraday bars failed",
            intradayStale: true,
          });
        }
      } finally {
        if (isActiveRequest()) set({ intradayLoading: false });
      }
    };

    await Promise.all([loadDaily(), loadIntraday()]);
  },

  startPolling: () => {
    if (get().visibilityHandler) return;

    const startInterval = () => {
      if (get().pollingTimerId) return;
      const timerId = setInterval(() => {
        if (document.visibilityState === "visible") {
          get().refreshMarketData();
        }
      }, POLL_INTERVAL);
      set({ pollingTimerId: timerId });
    };

    const handler = () => {
      if (document.visibilityState !== "visible") {
        const { pollingTimerId } = get();
        if (pollingTimerId) {
          clearInterval(pollingTimerId);
          set({ pollingTimerId: null });
        }
        return;
      }

      get().refreshMarketData();
      startInterval();
    };

    document.addEventListener("visibilitychange", handler);
    set({ visibilityHandler: handler });
    if (document.visibilityState === "visible") {
      startInterval();
    }
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
