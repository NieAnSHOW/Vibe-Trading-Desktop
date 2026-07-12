import { create } from "zustand";
import type { WatchlistStock, QuoteData } from "@/lib/api";
import {
  fetchWatchlistStocks,
  addWatchlistStock,
  deleteWatchlistStock,
  fetchWatchlistQuotes,
} from "@/lib/api";

export interface WatchlistState {
  /** 自选股列表 */
  stocks: WatchlistStock[];
  /** 行情数据 {code: QuoteData} */
  quotes: Record<string, QuoteData>;
  /** 已勾选的股票代码 */
  selected: Set<string>;
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 刷新自选股列表 */
  refresh: () => Promise<void>;
  /** 添加股票 */
  add: (code: string, market?: string) => Promise<{ added: boolean; exists: boolean }>;
  /** 删除股票 */
  remove: (code: string, market?: string) => Promise<void>;
  /** 刷新行情 */
  refreshQuotes: () => Promise<void>;
  /** 切换选中状态 */
  toggleSelection: (code: string) => void;
  /** 清空选中 */
  clearSelection: () => void;
}

export const useWatchlistStore = create<WatchlistState>((set, get) => ({
  stocks: [],
  quotes: {},
  selected: new Set<string>(),
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const data = await fetchWatchlistStocks();
      set({ stocks: data.stocks, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "加载失败" });
    }
  },

  add: async (code: string, market = "a_stock") => {
    const result = await addWatchlistStock(code, market);
    if (result.added) {
      await get().refresh();
    }
    return result;
  },

  remove: async (code: string, market = "a_stock") => {
    await deleteWatchlistStock(code, market);
    set((s) => ({
      stocks: s.stocks.filter((st) => !(st.code === code && st.market === market)),
      selected: new Set([...s.selected].filter((c) => c !== code)),
    }));
  },

  refreshQuotes: async () => {
    const { stocks } = get();
    if (stocks.length === 0) return;
    const codes = stocks.map((s) => s.code);
    try {
      const data = await fetchWatchlistQuotes(codes);
      set({ quotes: data });
    } catch {
      // 行情刷新失败不更新 error，保留旧数据
    }
  },

  toggleSelection: (code: string) => {
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return { selected: next };
    });
  },

  clearSelection: () => set({ selected: new Set<string>() }),
}));
