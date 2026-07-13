import { StockSDK } from "stock-sdk";
import type { PriceBar } from "@/lib/api";

const sdk = new StockSDK();
const SOURCE = "stock-sdk";

// ── DTO interfaces ──────────────────────────────────────────

export interface DashboardQuote {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  source: string;
  stale: boolean;
  error?: string;
}

export interface DashboardIndex {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  source: string;
  stale: boolean;
  error?: string;
}

export interface MarketPulseItem {
  code: string;
  name: string;
  time: string;
  changeType: string;
  info: string;
  source: string;
  stale: boolean;
  error?: string;
}

/** ponytail: alias existing PriceBar — duplicate shape would drift */
export type DashboardPriceBar = PriceBar;

export interface DashboardDataResult<T> {
  data: T;
  asOf: string;
  stale: boolean;
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────

const now = () => new Date().toISOString();

const codeOf = (value: unknown) =>
  String(value ?? "").replace(/^(sh|sz)/i, "").replace(/\.(SH|SZ)$/i, "");

const fin = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const msgOf = (error: unknown) =>
  error instanceof Error ? error.message : "stock-sdk request failed";

const staleResult = <T>(fallback: T, error: unknown): DashboardDataResult<T> => ({
  data: fallback,
  asOf: now(),
  stale: true,
  error: msgOf(error),
});

// ── Major A-share indexes for dashboard header ───────────────

const INDEX_CODES = ["sh000001", "sz399001", "sz399006"];

// ── Public API ──────────────────────────────────────────────

export async function fetchDashboardQuotes(
  codes: string[],
): Promise<DashboardDataResult<Record<string, DashboardQuote>>> {
  try {
    const rows = await sdk.quotes.cnSimple(codes);
    const data: Record<string, DashboardQuote> = {};
    for (const row of rows) {
      const code = codeOf(row.code);
      data[code] = {
        code,
        name: String(row.name ?? code),
        price: fin(row.price),
        changePct: fin(row.changePercent),
        changeAmt: fin(row.change),
        source: SOURCE,
        stale: false,
      };
    }
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult({}, error);
  }
}

export async function fetchDashboardIndexes(): Promise<
  DashboardDataResult<DashboardIndex[]>
> {
  try {
    const rows = await sdk.quotes.cn(INDEX_CODES);
    const data = rows.map((row) => ({
      code: codeOf(row.code),
      name: String(row.name ?? row.code),
      price: fin(row.price),
      changePct: fin(row.changePercent),
      changeAmt: fin(row.change),
      source: SOURCE,
      stale: false,
    }));
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult([], error);
  }
}

export async function fetchMarketPulse(): Promise<
  DashboardDataResult<MarketPulseItem[]>
> {
  try {
    const rows = await sdk.marketEvent.stockChanges("all");
    const data = rows.map((row) => ({
      code: codeOf(row.code),
      name: String((row as { name?: string }).name ?? row.code),
      time: String((row as { time?: string }).time ?? ""),
      changeType: String((row as { changeTypeLabel?: string }).changeTypeLabel ?? ""),
      info: String((row as { info?: string }).info ?? ""),
      source: SOURCE,
      stale: false,
    }));
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult([], error);
  }
}

export async function fetchDashboardDailyBars(
  code: string,
): Promise<DashboardDataResult<PriceBar[]>> {
  try {
    const rows = await sdk.kline.cn(code, { period: "daily" });
    const data: PriceBar[] = rows.map((row) => ({
      time: String(row.date),
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
      volume: Number(row.volume ?? 0),
    }));
    return { data, asOf: now(), stale: false };
  } catch (error) {
    return staleResult([], error);
  }
}
