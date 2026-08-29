import { describe, expect, it } from "vitest";
import ar from "../locales/ar.json";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import zhCN from "../locales/zh-CN.json";

const requiredPaths = [
  "layout.news",
  "news.title",
  "news.refresh",
  "news.refreshing",
  "news.loading",
  "news.error",
  "news.emptyNoWatchlist",
  "news.emptyNoWatchlistHint",
  "news.goWatchlist",
  "news.announcement",
  "news.noSummary",
  "news.unknownTime",
  "news.viewOriginal",
  "news.delayedBanner",
  "news.lastUpdated",
  "news.sourceDegraded",
  "news.loadMore",
  "news.sources.eastmoney",
  "news.sources.sina",
  "news.sources.sse",
  "news.sources.szse",
];

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

describe("i18n - investment news", () => {
  it.each([
    ["zh-CN", zhCN],
    ["en", en],
    ["ja", ja],
    ["ko", ko],
    ["ar", ar],
  ])("%s has the complete investment-news key structure", (_language, locale) => {
    for (const path of requiredPaths) {
      const value = readPath(locale, path);
      expect(value, path).toBeTypeOf("string");
      expect((value as string).trim(), path).not.toHaveLength(0);
    }
  });
});
