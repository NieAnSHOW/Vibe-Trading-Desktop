import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, BarChart3, Loader2 } from "lucide-react";
import { CandlestickChart } from "@/components/charts/CandlestickChart";
import {
  fetchDashboardDailyBars,
  fetchDashboardIndexes,
  type DashboardIndex,
} from "@/lib/stockSdk";
import type { PriceBar } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatNumber(value: number | null | undefined): string {
  return value == null ? "--" : value.toFixed(2);
}

function formatChange(value: number | null | undefined, suffix = ""): string {
  if (value == null) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function changeClass(value: number | null | undefined): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-red-500" : "text-green-500";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export default function Indices() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [indexes, setIndexes] = useState<DashboardIndex[]>([]);
  const [indexesLoading, setIndexesLoading] = useState(true);
  const [indexesError, setIndexesError] = useState<string | null>(null);
  const [indexesStale, setIndexesStale] = useState(false);
  const [bars, setBars] = useState<PriceBar[]>([]);
  const [barsLoading, setBarsLoading] = useState(false);
  const [barsError, setBarsError] = useState<string | null>(null);
  const [barsStale, setBarsStale] = useState(false);

  const requestedCode = searchParams.get("symbol");
  const selectedIndex = useMemo(
    () => indexes.find((index) => index.code === requestedCode) ?? indexes[0] ?? null,
    [indexes, requestedCode],
  );
  const selectedCode = selectedIndex?.code ?? "";
  const selectedSymbol = selectedIndex?.symbol ?? "";

  useEffect(() => {
    let active = true;
    setIndexesLoading(true);
    setIndexesError(null);

    fetchDashboardIndexes()
      .then((result) => {
        if (!active) return;
        setIndexes(result.data);
        setIndexesStale(result.stale);
        setIndexesError(result.error ?? null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setIndexes([]);
        setIndexesStale(false);
        setIndexesError(errorMessage(error));
      })
      .finally(() => {
        if (active) setIndexesLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedCode || requestedCode === selectedCode) return;

    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("symbol", selectedCode);
        return next;
      },
      { replace: true },
    );
  }, [requestedCode, selectedCode, setSearchParams]);

  useEffect(() => {
    if (!selectedSymbol) {
      setBars([]);
      setBarsError(null);
      setBarsStale(false);
      setBarsLoading(false);
      return;
    }

    let active = true;
    setBars([]);
    setBarsLoading(true);
    setBarsError(null);
    setBarsStale(false);

    fetchDashboardDailyBars(selectedSymbol)
      .then((result) => {
        if (!active) return;
        setBars(result.data);
        setBarsStale(result.stale);
        setBarsError(result.error ?? null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBars([]);
        setBarsStale(false);
        setBarsError(errorMessage(error));
      })
      .finally(() => {
        if (active) setBarsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedSymbol]);

  const selectIndex = (code: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("symbol", code);
      return next;
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight">{t("indices.title", "指数")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("indices.description", "查看主要 A 股指数的当日行情和日线走势")}
        </p>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)] lg:gap-6">
        <aside aria-labelledby="indices-list-title" className="min-h-0 rounded-lg border bg-card p-3 lg:overflow-auto">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="indices-list-title" className="text-sm font-semibold">
              {t("indices.supported", "支持的指数")}
            </h2>
            {indexesLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t("indices.loading", "指数行情加载中")} />}
          </div>

          {indexesError && indexes.length === 0 && (
            <div role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t("indices.quotesError", "指数行情加载失败")}</span>
            </div>
          )}

          {!indexesLoading && !indexesError && indexes.length === 0 && (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              {t("indices.unavailable", "暂无可用指数")}
            </p>
          )}

          <div className="space-y-1" aria-busy={indexesLoading}>
            {indexes.map((index) => {
              const active = index.code === selectedCode;
              return (
                <button
                  key={index.code}
                  type="button"
                  onClick={() => selectIndex(index.code)}
                  aria-pressed={active}
                  aria-label={`${index.name} ${index.code}`}
                  className={cn(
                    "w-full rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    active ? "border-primary/30 bg-primary/10" : "border-transparent hover:bg-muted",
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{index.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{index.code}</span>
                    </span>
                    <span className="shrink-0 text-right font-mono tabular-nums">
                      <span className="block text-sm font-medium">{formatNumber(index.price)}</span>
                      <span className={cn("block text-xs", changeClass(index.changePct))}>
                        {formatChange(index.changePct, "%")}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {(indexesStale || (indexesError && indexes.length > 0)) && (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {t("indices.stale", "行情数据可能已过期")}
            </p>
          )}
        </aside>

        <section aria-labelledby="index-detail-title" className="min-h-0 rounded-lg border bg-card p-4 lg:overflow-auto">
          {selectedIndex ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                    <h2 id="index-detail-title" className="truncate text-lg font-semibold">
                      {selectedIndex.name}
                    </h2>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{selectedIndex.code}</p>
                </div>
                <div className="grid grid-cols-3 gap-4 text-right font-mono tabular-nums">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("indices.price", "最新价")}</p>
                    <p className="mt-1 text-base font-semibold">{formatNumber(selectedIndex.price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("indices.change", "涨跌额")}</p>
                    <p className={cn("mt-1 text-base font-semibold", changeClass(selectedIndex.changeAmt))}>
                      {formatChange(selectedIndex.changeAmt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("indices.changePercent", "涨跌幅")}</p>
                    <p className={cn("mt-1 text-base font-semibold", changeClass(selectedIndex.changePct))}>
                      {formatChange(selectedIndex.changePct, "%")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t("indices.dailyHistory", "日线走势")}</h3>
                  {barsStale && <span role="status" className="text-xs text-muted-foreground">{t("indices.stale", "行情数据可能已过期")}</span>}
                </div>

                {barsLoading && (
                  <div className="flex min-h-60 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t("indices.historyLoading", "日线数据加载中")}
                  </div>
                )}

                {!barsLoading && barsError && (
                  <div role="alert" className="flex min-h-60 flex-col items-center justify-center gap-2 rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive">
                    <AlertCircle className="h-5 w-5" aria-hidden="true" />
                    <p>{t("indices.historyError", "日线数据加载失败")}</p>
                  </div>
                )}

                {!barsLoading && !barsError && bars.length === 0 && (
                  <div className="flex min-h-60 flex-col items-center justify-center gap-1 rounded-md bg-muted p-4 text-center">
                    <p className="text-sm font-medium">{t("indices.historyUnavailable", "暂无日线数据")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("indices.historyUnavailableHint", "请选择其他指数后重试")}
                    </p>
                  </div>
                )}

                {bars.length > 0 && <CandlestickChart data={bars} height={460} />}
              </div>
            </>
          ) : (
            <div className="flex min-h-60 items-center justify-center text-sm text-muted-foreground">
              {t("indices.selectPrompt", "请选择一个指数")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
