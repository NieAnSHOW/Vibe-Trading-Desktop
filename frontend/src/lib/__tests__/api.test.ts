import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, parseWatchlistFeedResponse } from "../api";

async function loadApiModule() {
  vi.resetModules();
  return import("../api");
}

describe("api request helper", () => {
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

  it("rejects non-JSON responses with a descriptive error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<!doctype html><html><body>SPA</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const { api } = await loadApiModule();

    await expect(api.getLLMSettings()).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      message: expect.stringContaining("Expected JSON from /settings/llm, got text/html"),
    } satisfies Partial<ApiError>);
  });

  it("wraps malformed JSON responses in ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{\"status\": true", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { api } = await loadApiModule();

    await expect(api.getLLMSettings()).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      message: "Invalid JSON response from /settings/llm",
    } satisfies Partial<ApiError>);
  });

});

// --- Watchlist feed parser（exact-key 校验风格同 newsRecord）---
const validFeed = {
  items: [
    {
      id: "eastmoney:1", source: "eastmoney", type: "flash",
      published_at: "2026-08-29T12:00:00+00:00", title: "央行开展逆回购", summary: "500亿",
      url: null,
      matched_stocks: [{ code: "600519", name: "贵州茅台", match_rule: "structured_field" }],
      confidence: "high",
    },
  ],
  new_cursor: "watermark",
  next_cursor: null,
  source_health: [
    { source_id: "eastmoney", state: "ok", last_success_at: "2026-08-29T12:00:00+00:00", last_error: null },
    { source_id: "sina", state: "failed", last_success_at: null, last_error: "timeout" },
  ],
  last_updated_at: null,
  watchlist_version: "a".repeat(64),
  reset_required: false,
};

describe("parseWatchlistFeedResponse", () => {
  it("parses a valid payload", () => {
    const feed = parseWatchlistFeedResponse(validFeed);
    expect(feed.items[0].matched_stocks[0].code).toBe("600519");
    expect(feed.new_cursor).toBe("watermark");
    expect(feed.watchlist_version).toHaveLength(64);
    expect(feed.reset_required).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    expect(() => parseWatchlistFeedResponse({ ...validFeed, extra: 1 })).toThrow();
  });

  it("rejects missing keys", () => {
    const { reset_required: _dropped, ...partial } = validFeed;
    expect(() => parseWatchlistFeedResponse(partial)).toThrow();
  });

  it("rejects non-http item urls", () => {
    const bad = { ...validFeed, items: [{ ...validFeed.items[0], url: "javascript:alert(1)" }] };
    expect(() => parseWatchlistFeedResponse(bad)).toThrow();
  });

  it("rejects more than 50 items", () => {
    const item = validFeed.items[0];
    expect(() => parseWatchlistFeedResponse({ ...validFeed, items: Array.from({ length: 51 }, () => item) })).toThrow();
  });

  it("rejects malformed watchlist_version", () => {
    expect(() => parseWatchlistFeedResponse({ ...validFeed, watchlist_version: "xyz" })).toThrow();
  });

  it("rejects low-confidence enum violation", () => {
    const bad = { ...validFeed, items: [{ ...validFeed.items[0], confidence: "low" }] };
    expect(() => parseWatchlistFeedResponse(bad)).toThrow();
  });
});
