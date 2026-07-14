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

export interface DashboardDistributionBucket {
  label: string;
  count: number;
  tone: "up" | "down" | "flat";
}

export interface DashboardMarketBreadth {
  total: number;
  up: number;
  flat: number;
  down: number;
  upPct: number;
  strongUp: number;
  strongDown: number;
  avgChangePct: number;
  distribution: DashboardDistributionBucket[];
}

export interface DashboardEmotionDimension {
  key: "breadth" | "strength" | "highLow" | "limit" | "quality";
  value: number;
}

export interface DashboardMarketEmotion {
  score: number;
  label: "hot" | "warm" | "neutral" | "cool" | "cold";
  dimensions: DashboardEmotionDimension[];
}

export interface DashboardMarketTrend {
  strongUp: number;
  strongDown: number;
  nearHigh: number;
  nearLow: number;
  highLowRatio: number;
}

export interface DashboardLimitTier {
  boards: number;
  count: number;
}

export interface DashboardLimitLadder {
  limitUp: number;
  limitDown: number;
  broken: number;
  tiers: DashboardLimitTier[];
}

export interface DashboardConceptHeat {
  code: string;
  name: string;
  changePct: number | null;
  riseCount: number | null;
  fallCount: number | null;
  leadingStock: string | null;
  leadingStockChangePct: number | null;
}

export interface DashboardMarketSnapshot {
  breadth: DashboardMarketBreadth;
  emotion: DashboardMarketEmotion;
  trend: DashboardMarketTrend;
  limit: DashboardLimitLadder;
  concepts: DashboardConceptHeat[];
  source: string;
  asOf: string;
  stale: boolean;
  errors?: Partial<Record<"market" | "concepts" | "limit", string>>;
}

/** ponytail: alias existing PriceBar — duplicate shape would drift */
export type DashboardPriceBar = PriceBar;

export interface DashboardDataResult<T> {
  data: T;
  asOf: string;
  stale: boolean;
  error?: string;
}

type SnapshotQuote = {
  code: unknown;
  name: unknown;
  price: unknown;
  changePercent: unknown;
  high52w: unknown;
  low52w: unknown;
};

type SnapshotConcept = {
  code: unknown;
  name: unknown;
  changePercent: unknown;
  riseCount: unknown;
  fallCount: unknown;
  leadingStock: unknown;
  leadingStockChangePercent: unknown;
};

type SnapshotLimitItem = {
  continuousBoardCount: unknown;
};

// ── Helpers ─────────────────────────────────────────────────

const now = () => new Date().toISOString();

const MARKET_SNAPSHOT_TTL_MS = 60_000;

let marketSnapshotCache: {
  expiresAt: number;
  result: DashboardDataResult<DashboardMarketSnapshot>;
} | null = null;

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

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const emptyBreadth = (): DashboardMarketBreadth => ({
  total: 0,
  up: 0,
  flat: 0,
  down: 0,
  upPct: 0,
  strongUp: 0,
  strongDown: 0,
  avgChangePct: 0,
  distribution: [],
});

const emptyTrend = (): DashboardMarketTrend => ({
  strongUp: 0,
  strongDown: 0,
  nearHigh: 0,
  nearLow: 0,
  highLowRatio: 50,
});

const emptyLimit = (): DashboardLimitLadder => ({
  limitUp: 0,
  limitDown: 0,
  broken: 0,
  tiers: [],
});

function buildBreadth(rows: SnapshotQuote[]): DashboardMarketBreadth {
  const changes = rows.map((row) => fin(row.changePercent)).filter((value): value is number => value != null);
  const distribution = [
    { label: "<=-7%", count: 0, tone: "down" as const },
    { label: "-7~-3%", count: 0, tone: "down" as const },
    { label: "-3~0%", count: 0, tone: "down" as const },
    { label: "0%", count: 0, tone: "flat" as const },
    { label: "0~3%", count: 0, tone: "up" as const },
    { label: "3~7%", count: 0, tone: "up" as const },
    { label: ">=7%", count: 0, tone: "up" as const },
  ];

  for (const change of changes) {
    if (change <= -7) distribution[0].count += 1;
    else if (change <= -3) distribution[1].count += 1;
    else if (change < 0) distribution[2].count += 1;
    else if (change === 0) distribution[3].count += 1;
    else if (change < 3) distribution[4].count += 1;
    else if (change < 7) distribution[5].count += 1;
    else distribution[6].count += 1;
  }

  const total = changes.length;
  const up = changes.filter((change) => change > 0).length;
  const flat = changes.filter((change) => change === 0).length;
  const down = changes.filter((change) => change < 0).length;
  return {
    total,
    up,
    flat,
    down,
    upPct: total > 0 ? (up / total) * 100 : 0,
    strongUp: changes.filter((change) => change >= 3).length,
    strongDown: changes.filter((change) => change <= -3).length,
    avgChangePct: total > 0 ? changes.reduce((sum, change) => sum + change, 0) / total : 0,
    distribution,
  };
}

function buildTrend(rows: SnapshotQuote[], breadth: DashboardMarketBreadth): DashboardMarketTrend {
  let nearHigh = 0;
  let nearLow = 0;
  for (const row of rows) {
    const price = fin(row.price);
    const high = fin(row.high52w);
    const low = fin(row.low52w);
    if (price != null && high != null && high > 0 && price >= high * 0.98) nearHigh += 1;
    if (price != null && low != null && low > 0 && price <= low * 1.02) nearLow += 1;
  }
  const highLowTotal = nearHigh + nearLow;
  return {
    strongUp: breadth.strongUp,
    strongDown: breadth.strongDown,
    nearHigh,
    nearLow,
    highLowRatio: highLowTotal > 0 ? (nearHigh / highLowTotal) * 100 : 50,
  };
}

function buildLimit(upRows: SnapshotLimitItem[], downRows: SnapshotLimitItem[], brokenRows: SnapshotLimitItem[]): DashboardLimitLadder {
  const tierCounts = new Map<number, number>();
  for (const row of upRows) {
    const boards = fin(row.continuousBoardCount);
    if (boards != null && boards > 0) tierCounts.set(boards, (tierCounts.get(boards) ?? 0) + 1);
  }
  return {
    limitUp: upRows.length,
    limitDown: downRows.length,
    broken: brokenRows.length,
    tiers: [...tierCounts.entries()]
      .map(([boards, count]) => ({ boards, count }))
      .sort((a, b) => b.boards - a.boards),
  };
}

function buildConcepts(rows: SnapshotConcept[]): DashboardConceptHeat[] {
  return rows
    .map((row) => ({
      code: String(row.code ?? ""),
      name: String(row.name ?? row.code ?? ""),
      changePct: fin(row.changePercent),
      riseCount: fin(row.riseCount),
      fallCount: fin(row.fallCount),
      leadingStock: row.leadingStock == null ? null : String(row.leadingStock),
      leadingStockChangePct: fin(row.leadingStockChangePercent),
    }))
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity))
    .slice(0, 10);
}

function buildEmotion(
  breadth: DashboardMarketBreadth,
  trend: DashboardMarketTrend,
  limit: DashboardLimitLadder,
): DashboardMarketEmotion {
  const breadthScore = breadth.total > 0 ? breadth.upPct : 50;
  const strengthScore = breadth.total > 0
    ? clampPercent(50 + ((breadth.strongUp - breadth.strongDown) / breadth.total) * 300)
    : 50;
  const highLowScore = trend.highLowRatio;
  const limitDenominator = limit.limitUp + limit.limitDown;
  const limitScore = limitDenominator > 0 ? (limit.limitUp / limitDenominator) * 100 : 50;
  const qualityDenominator = limit.limitUp + limit.broken;
  const qualityScore = qualityDenominator > 0 ? (limit.limitUp / qualityDenominator) * 100 : 50;
  const score = Math.round((breadthScore + strengthScore + highLowScore + limitScore + qualityScore) / 5);
  const label = score >= 70 ? "hot" : score >= 55 ? "warm" : score >= 45 ? "neutral" : score >= 30 ? "cool" : "cold";
  return {
    score,
    label,
    dimensions: [
      { key: "breadth", value: Math.round(breadthScore) },
      { key: "strength", value: Math.round(strengthScore) },
      { key: "highLow", value: Math.round(highLowScore) },
      { key: "limit", value: Math.round(limitScore) },
      { key: "quality", value: Math.round(qualityScore) },
    ],
  };
}

function rejectionMessage(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? msgOf(result.reason) : null;
}

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

export async function fetchDashboardMarketSnapshot(): Promise<
  DashboardDataResult<DashboardMarketSnapshot>
> {
  if (marketSnapshotCache && Date.now() < marketSnapshotCache.expiresAt) {
    return marketSnapshotCache.result;
  }

  const [marketResult, conceptsResult, limitUpResult, limitDownResult, brokenResult] = await Promise.allSettled([
    sdk.batch.cn(),
    sdk.board.concept.list(),
    sdk.marketEvent.ztPool("zt"),
    sdk.marketEvent.ztPool("dt"),
    sdk.marketEvent.ztPool("broken"),
  ]);
  const previous = marketSnapshotCache?.result.data;
  const errors: Partial<Record<"market" | "concepts" | "limit", string>> = {};

  let breadth = previous?.breadth ?? emptyBreadth();
  let trend = previous?.trend ?? emptyTrend();
  if (marketResult.status === "fulfilled") {
    breadth = buildBreadth(marketResult.value);
    trend = buildTrend(marketResult.value, breadth);
  } else {
    errors.market = rejectionMessage(marketResult) ?? "market snapshot unavailable";
  }

  let concepts = previous?.concepts ?? [];
  if (conceptsResult.status === "fulfilled") {
    concepts = buildConcepts(conceptsResult.value);
  } else {
    errors.concepts = rejectionMessage(conceptsResult) ?? "concept snapshot unavailable";
  }

  let limit = previous?.limit ?? emptyLimit();
  const limitError = [limitUpResult, limitDownResult, brokenResult]
    .map(rejectionMessage)
    .find((message): message is string => message != null);
  if (limitError) {
    errors.limit = limitError;
  } else if (
    limitUpResult.status === "fulfilled"
    && limitDownResult.status === "fulfilled"
    && brokenResult.status === "fulfilled"
  ) {
    limit = buildLimit(limitUpResult.value, limitDownResult.value, brokenResult.value);
  }

  const stale = Object.keys(errors).length > 0;
  const asOf = now();
  const data: DashboardMarketSnapshot = {
    breadth,
    emotion: buildEmotion(breadth, trend, limit),
    trend,
    limit,
    concepts,
    source: SOURCE,
    asOf,
    stale,
    ...(stale ? { errors } : {}),
  };
  const result: DashboardDataResult<DashboardMarketSnapshot> = {
    data,
    asOf,
    stale,
    ...(stale ? { error: errors.market ?? errors.concepts ?? errors.limit } : {}),
  };

  if (!stale) {
    marketSnapshotCache = {
      expiresAt: Date.now() + MARKET_SNAPSHOT_TTL_MS,
      result,
    };
  }

  return result;
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
