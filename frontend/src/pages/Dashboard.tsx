import { useEffect, useCallback, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw, Send, TrendingUp, TrendingDown, Minus, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMarketDashboardStore } from "@/stores/marketDashboard";
import { CandlestickChart } from "@/components/charts/CandlestickChart";
import type { DashboardIndex, MarketPulseItem, DashboardQuote } from "@/lib/stockSdk";
import type { MarketSummaryResponse, PriceBar } from "@/lib/api";

// ── Helpers ───────────────────────────────────────────────────

function changeColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground";
  if (pct > 0) return "text-red-500";
  if (pct < 0) return "text-green-500";
  return "text-muted-foreground";
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(2);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtAmt(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

// ── Sub-components ────────────────────────────────────────────

/** Horizontal strip of major A-share index cards */
function IndexStrip({ indexes }: { indexes: DashboardIndex[] }) {
  const { t } = useTranslation();

  if (indexes.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">{t("dashboard.noIndexes")}</p>;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 xl:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
      {indexes.map((idx) => {
        const color = changeColor(idx.changePct);
        return (
          <div key={idx.code} className="rounded-lg border bg-card px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground truncate">{idx.name}</span>
              <span className={cn("text-[11px] tabular-nums font-mono", color)}>
                {fmtPct(idx.changePct)}
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums font-mono leading-none">
                {fmtPrice(idx.price)}
              </span>
              <span className={cn("text-xs tabular-nums font-mono", color)}>
                {fmtAmt(idx.changeAmt)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Market pulse / 异动 section */
const PULSE_PAGE_SIZES = [200, 500, 1000] as const;

function MarketPulseSection({
  items,
  loading,
  error,
}: {
  items: MarketPulseItem[];
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PULSE_PAGE_SIZES)[number]>(200);

  // Reset to first page when data refreshes
  useEffect(() => {
    setPage(0);
  }, [items.length]);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = useMemo(
    () => items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [items, safePage, pageSize],
  );

  if (loading && items.length === 0) {
    return (
      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t("dashboard.marketPulse")}</h2>
        <p className="text-xs text-muted-foreground">{t("dashboard.loading")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-sm font-semibold">{t("dashboard.marketPulse")}</h2>
      {error && items.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}
      {items.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">{t("dashboard.noPulse")}</p>
      )}
      {items.length > 0 && (
        <>
          <ul className="space-y-1.5 max-h-[340px] overflow-auto">
            {pageItems.map((item, i) => (
              <li key={`${item.code}-${safePage * pageSize + i}`} className="text-xs border-b border-border/50 pb-1.5 last:border-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground">{item.code}</span>
                  <span
                    className={cn(
                      "px-1 py-0.5 rounded text-[10px] font-medium",
                      item.changeType.includes("涨") ? "bg-red-500/10 text-red-500" : "bg-green-500/10 text-green-500",
                    )}
                  >
                    {item.changeType}
                  </span>
                </div>
                {item.info && (
                  <p className="text-muted-foreground mt-0.5">{item.info}</p>
                )}
                <span className="text-muted-foreground/60 text-[10px]">{item.time}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between pt-1 border-t border-border/50">
            <span className="text-[10px] text-muted-foreground">
              {t("dashboard.pulseRange", {
                from: safePage * pageSize + 1,
                to: Math.min((safePage + 1) * pageSize, items.length),
                total: items.length,
              })}
            </span>
            <div className="flex items-center gap-1">
              <div className="flex items-center gap-0.5 mr-1">
                {PULSE_PAGE_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => {
                      setPageSize(size);
                      setPage(0);
                    }}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] transition-colors",
                      pageSize === size
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30"
                aria-label={t("dashboard.prevPage")}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] text-muted-foreground min-w-[3rem] text-center">
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30"
                aria-label={t("dashboard.nextPage")}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** AI Market Summary section */
function AiSummarySection({
  summary,
  loading,
  error,
  onRefresh,
}: {
  summary: MarketSummaryResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("dashboard.aiSummary")}</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
          title={t("dashboard.refreshSummary")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {loading && !summary && (
        <p className="text-xs text-muted-foreground">{t("dashboard.loading")}</p>
      )}

      {error && !summary && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {t("dashboard.summaryUnavailable")}
        </div>
      )}

      {summary?.available && summary.summary && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{summary.summary.headline}</p>

          {summary.summary.drivers.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("dashboard.drivers")}
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.drivers.map((d, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{d}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.summary.risks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("dashboard.risks")}
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.risks.map((r, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{r}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.summary.focus.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("dashboard.focus")}
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.focus.map((f, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{f}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.stale && (
            <p className="text-[10px] text-muted-foreground/60">{t("dashboard.staleData")}</p>
          )}
        </div>
      )}

      {summary && !summary.available && (
        <p className="text-xs text-muted-foreground">
          {t("dashboard.summaryUnavailable")}
        </p>
      )}

      {error && summary && (
        <p className="text-[10px] text-muted-foreground/60">{t("dashboard.staleData")}</p>
      )}
    </div>
  );
}

/** Price change icon based on pct value */
function PctIcon({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (pct > 0) return <TrendingUp className="h-3 w-3 text-red-500" />;
  if (pct < 0) return <TrendingDown className="h-3 w-3 text-green-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

/** Watchlist quotes table section */
function WatchlistQuotesSection({
  quotes,
  selectedCode,
  loading,
  error,
  onSelect,
}: {
  quotes: Record<string, DashboardQuote>;
  selectedCode: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (code: string) => void;
}) {
  const { t } = useTranslation();
  const rows = Object.values(quotes).sort((a, b) => a.code.localeCompare(b.code));

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("dashboard.watchlistQuotes")}</h2>
        {rows.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
        )}
      </div>

      {loading && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("dashboard.loading")}</p>
      )}

      {error && rows.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      {rows.length === 0 && !loading && !error && (
        <p className="text-xs text-muted-foreground">{t("dashboard.noWatchlist")}</p>
      )}

      {rows.length > 0 && (
        <div className="max-h-[400px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1.5 pr-2 font-medium">{t("dashboard.col.code")}</th>
                <th className="text-left py-1.5 pr-2 font-medium">{t("dashboard.col.name")}</th>
                <th className="text-right py-1.5 pr-2 font-medium">{t("dashboard.col.price")}</th>
                <th className="text-right py-1.5 font-medium">{t("dashboard.col.changePct")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr
                  key={q.code}
                  onClick={() => onSelect(q.code)}
                  className={cn(
                    "border-b border-border/30 cursor-pointer transition-colors hover:bg-muted/50",
                    selectedCode === q.code && "bg-primary/5",
                  )}
                >
                  <td className="py-1.5 pr-2 font-mono">{q.code}</td>
                  <td className="py-1.5 pr-2">{q.name}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-mono">
                    {fmtPrice(q.price)}
                  </td>
                  <td
                    className={cn(
                      "py-1.5 text-right tabular-nums font-mono flex items-center justify-end gap-1",
                      changeColor(q.changePct),
                    )}
                  >
                    <PctIcon pct={q.changePct} />
                    {fmtPct(q.changePct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Stock detail section with K-line chart and Send to Agent button */
function StockDetailSection({
  code,
  name,
  bars,
  loading,
  error,
  onAnalyze,
}: {
  code: string | null;
  name: string | null;
  bars: PriceBar[];
  loading: boolean;
  error: string | null;
  onAnalyze: (code: string, name: string) => void;
}) {
  const { t } = useTranslation();

  if (!code) {
    return (
      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t("dashboard.stockDetail")}</h2>
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <TrendingUp className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{t("dashboard.selectStockHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {name || code} <span className="text-muted-foreground font-normal text-xs">({code})</span>
        </h2>
        <button
          type="button"
          onClick={() => onAnalyze(code, name || code)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          aria-label={t("dashboard.sendToAgent")}
        >
          <Send className="h-3 w-3" />
          {t("dashboard.sendToAgent")}
        </button>
      </div>

      {loading && (
        <p className="text-xs text-muted-foreground">{t("dashboard.loading")}</p>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      {!loading && !error && bars.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("charts.noPriceData")}</p>
      )}

      {bars.length > 0 && (
        <CandlestickChart data={bars} height={440} />
      )}
    </div>
  );
}

// ── Main Dashboard Component ──────────────────────────────────

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const indexes = useMarketDashboardStore((s) => s.indexes);
  const pulse = useMarketDashboardStore((s) => s.pulse);
  const quotes = useMarketDashboardStore((s) => s.quotes);
  const selectedCode = useMarketDashboardStore((s) => s.selectedCode);
  const selectedBars = useMarketDashboardStore((s) => s.selectedBars);
  const summary = useMarketDashboardStore((s) => s.summary);

  const indexesLoading = useMarketDashboardStore((s) => s.indexesLoading);
  const pulseLoading = useMarketDashboardStore((s) => s.pulseLoading);
  const quotesLoading = useMarketDashboardStore((s) => s.quotesLoading);
  const summaryLoading = useMarketDashboardStore((s) => s.summaryLoading);
  const barsLoading = useMarketDashboardStore((s) => s.barsLoading);

  const indexesError = useMarketDashboardStore((s) => s.indexesError);
  const pulseError = useMarketDashboardStore((s) => s.pulseError);
  const quotesError = useMarketDashboardStore((s) => s.quotesError);
  const summaryError = useMarketDashboardStore((s) => s.summaryError);
  const barsError = useMarketDashboardStore((s) => s.barsError);

  const initialize = useMarketDashboardStore((s) => s.initialize);
  const refreshSummary = useMarketDashboardStore((s) => s.refreshSummary);
  const setSelectedCode = useMarketDashboardStore((s) => s.setSelectedCode);
  const startPolling = useMarketDashboardStore((s) => s.startPolling);
  const stopPolling = useMarketDashboardStore((s) => s.stopPolling);

  // Lifecycle
  useEffect(() => {
    initialize();
    startPolling();
    return () => {
      stopPolling();
    };
  }, [initialize, startPolling, stopPolling]);

  // Find selected stock name
  const selectedName = selectedCode ? (quotes[selectedCode]?.name ?? null) : null;

  // Navigate to Agent with prefill (do not submit)
  const navigateToAgent = useCallback(
    (code: string, name: string) => {
      const message = `请分析 ${name} (${code}) 的近期走势和技术指标`;
      navigate(`/agent?prefill=${encodeURIComponent(message)}`);
    },
    [navigate],
  );

  return (
    <div className="p-4 lg:p-6 space-y-6 lg:space-y-8 max-w-[1440px] mx-auto">
      {/* Market Overview */}
      <section aria-labelledby="market-overview" className="space-y-4">
        <div className="flex items-baseline gap-3">
          <h1 id="market-overview" className="text-xl font-bold tracking-tight">
            {t("dashboard.title")}
          </h1>
          {indexesLoading && (
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <IndexStrip indexes={indexes} />
        {indexesError && indexes.length > 0 && (
          <p className="text-[10px] text-muted-foreground/60">{t("dashboard.staleData")}</p>
        )}
      </section>

      {/* Market Pulse + AI Summary */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(22rem,1.08fr)]">
        <MarketPulseSection items={pulse} loading={pulseLoading} error={pulseError} />
        <AiSummarySection
          summary={summary}
          loading={summaryLoading}
          error={summaryError}
          onRefresh={() => refreshSummary(true)}
        />
      </div>

      {/* Watchlist Quotes + Stock Detail */}
      <div className="grid gap-4 xl:grid-cols-[minmax(16rem,0.7fr)_minmax(0,1.3fr)]">
        <WatchlistQuotesSection
          quotes={quotes}
          selectedCode={selectedCode}
          loading={quotesLoading}
          error={quotesError}
          onSelect={setSelectedCode}
        />
        <StockDetailSection
          code={selectedCode}
          name={selectedName}
          bars={selectedBars}
          loading={barsLoading}
          error={barsError}
          onAnalyze={navigateToAgent}
        />
      </div>
    </div>
  );
}
