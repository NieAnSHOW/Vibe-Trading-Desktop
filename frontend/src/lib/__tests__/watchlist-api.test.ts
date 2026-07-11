import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchlistStock, QuoteData } from "../api";

async function loadApi() {
  vi.resetModules();
  return import("../api");
}

describe("watchlist API functions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => ""),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fetchWatchlistStocks returns stocks array", async () => {
    const stocks: WatchlistStock[] = [
      { code: "000001", name: "平安银行", market: "a_stock", added_at: "2026-07-11T00:00:00" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stocks }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    const { fetchWatchlistStocks } = await loadApi();
    const result = await fetchWatchlistStocks();
    expect(result.stocks).toHaveLength(1);
    expect(result.stocks[0].code).toBe("000001");
  });

  it("addWatchlistStock returns added=true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ added: true, exists: false }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    const { addWatchlistStock } = await loadApi();
    const result = await addWatchlistStock("000001");
    expect(result.added).toBe(true);
    expect(result.exists).toBe(false);
  });

  it("addWatchlistStock returns exists=true on duplicate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ added: false, exists: true }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    const { addWatchlistStock } = await loadApi();
    const result = await addWatchlistStock("000001");
    expect(result.exists).toBe(true);
  });

  it("deleteWatchlistStock returns deleted=true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    const { deleteWatchlistStock } = await loadApi();
    const result = await deleteWatchlistStock("000001");
    expect(result.deleted).toBe(true);
  });

  it("fetchWatchlistQuotes returns quote map", async () => {
    const quotes: Record<string, QuoteData> = {
      "000001": { code: "000001", name: "平安银行", price: 10.5, change_pct: 1.2, change_amt: 0.12 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(quotes), { status: 200, headers: { "content-type": "application/json" } })
    ));
    const { fetchWatchlistQuotes } = await loadApi();
    const result = await fetchWatchlistQuotes(["000001"]);
    expect(result["000001"].price).toBe(10.5);
  });

  it("deleteWatchlistStock throws ApiError on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "股票 999999 不在自选股中" }), { status: 404, headers: { "content-type": "application/json" } })
    ));
    const { deleteWatchlistStock, ApiError } = await loadApi();
    await expect(deleteWatchlistStock("999999")).rejects.toBeInstanceOf(ApiError);
  });
});
