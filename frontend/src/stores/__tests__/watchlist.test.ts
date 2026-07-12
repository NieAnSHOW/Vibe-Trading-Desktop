import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWatchlistStore } from "../watchlist";

// Mock API module
vi.mock("@/lib/api", () => ({
  fetchWatchlistStocks: vi.fn(),
  addWatchlistStock: vi.fn(),
  deleteWatchlistStock: vi.fn(),
  fetchWatchlistQuotes: vi.fn(),
}));

import {
  fetchWatchlistStocks,
  addWatchlistStock,
  deleteWatchlistStock,
  fetchWatchlistQuotes,
} from "@/lib/api";

const mockFetchStocks = vi.mocked(fetchWatchlistStocks);
const mockAdd = vi.mocked(addWatchlistStock);
const mockDelete = vi.mocked(deleteWatchlistStock);
const mockFetchQuotes = vi.mocked(fetchWatchlistQuotes);

beforeEach(() => {
  vi.clearAllMocks();
  useWatchlistStore.setState({
    stocks: [],
    quotes: {},
    selected: new Set<string>(),
    loading: false,
    error: null,
  });
});

describe("initial state", () => {
  it("has empty defaults", () => {
    const s = useWatchlistStore.getState();
    expect(s.stocks).toEqual([]);
    expect(s.quotes).toEqual({});
    expect(s.selected.size).toBe(0);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("refresh", () => {
  it("loads stocks on success", async () => {
    mockFetchStocks.mockResolvedValue({
      stocks: [{ code: "000001", name: "平安银行", market: "a_stock", added_at: "2026-07-11T00:00:00" }],
    });
    await useWatchlistStore.getState().refresh();
    expect(useWatchlistStore.getState().stocks).toHaveLength(1);
    expect(useWatchlistStore.getState().loading).toBe(false);
  });

  it("sets error on failure", async () => {
    mockFetchStocks.mockRejectedValue(new Error("network error"));
    await useWatchlistStore.getState().refresh();
    expect(useWatchlistStore.getState().error).toBe("network error");
    expect(useWatchlistStore.getState().loading).toBe(false);
  });
});

describe("add", () => {
  it("calls add API and refreshes on success", async () => {
    mockAdd.mockResolvedValue({ added: true, exists: false });
    mockFetchStocks.mockResolvedValue({ stocks: [] });
    const result = await useWatchlistStore.getState().add("000001");
    expect(result.added).toBe(true);
    expect(mockFetchStocks).toHaveBeenCalled();
  });

  it("returns exists=true without refresh on duplicate", async () => {
    mockAdd.mockResolvedValue({ added: false, exists: true });
    const result = await useWatchlistStore.getState().add("000001");
    expect(result.exists).toBe(true);
    expect(mockFetchStocks).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("removes stock from list and clears selection", async () => {
    mockDelete.mockResolvedValue({ deleted: true });
    useWatchlistStore.setState({
      stocks: [{ code: "000001", name: "平安银行", market: "a_stock", added_at: "2026-07-11T00:00:00" }],
      selected: new Set(["000001"]),
    });
    await useWatchlistStore.getState().remove("000001");
    expect(useWatchlistStore.getState().stocks).toHaveLength(0);
    expect(useWatchlistStore.getState().selected.size).toBe(0);
  });
});

describe("toggleSelection", () => {
  it("selects then deselects", () => {
    useWatchlistStore.getState().toggleSelection("000001");
    expect(useWatchlistStore.getState().selected.has("000001")).toBe(true);
    useWatchlistStore.getState().toggleSelection("000001");
    expect(useWatchlistStore.getState().selected.has("000001")).toBe(false);
  });
});

describe("refreshQuotes", () => {
  it("fetches quotes for all stocks", async () => {
    useWatchlistStore.setState({
      stocks: [{ code: "000001", name: "平安银行", market: "a_stock", added_at: "" }],
    });
    mockFetchQuotes.mockResolvedValue({ "000001": { code: "000001", price: 10.5, change_pct: 1.2, change_amt: 0.12 } });
    await useWatchlistStore.getState().refreshQuotes();
    expect(useWatchlistStore.getState().quotes["000001"]?.price).toBe(10.5);
  });

  it("skips refresh if no stocks", async () => {
    await useWatchlistStore.getState().refreshQuotes();
    expect(mockFetchQuotes).not.toHaveBeenCalled();
  });
});
