import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  BarChart3,
  Loader2,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { CandlestickChart } from "@/components/charts/CandlestickChart";
import { IntradayChart } from "@/components/charts/IntradayChart";
import {
  fetchDashboardDailyBars,
  fetchDashboardIndexes,
  fetchDashboardIntradayBars,
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

type IndexFilter = "all" | "up" | "down";

export default function Indices() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [indexes, setIndexes] = useState<DashboardIndex[]>([]);
  const [indexesLoading, setIndexesLoading] = useState(true);
  const [indexesError, setIndexesError] = useState<string | null>(null);
  const [indexesStale, setIndexesStale] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [indexFilter, setIndexFilter] = useState<IndexFilter>("all");
  const [bars, setBars] = useState<PriceBar[]>([]);
  const [barsLoading, setBarsLoading] = useState(false);
  const [barsError, setBarsError] = useState<string | null>(null);
  const [barsStale, setBarsStale] = useState(false);
  const [intradayBars, setIntradayBars] = useState<PriceBar[]>([]);
  const [intradayLoading, setIntradayLoading] = useState(false);
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const [intradayStale, setIntradayStale] = useState(false);

  const requestedCode = searchParams.get("symbol");
  const selectedIndex = useMemo(
    () =>
      indexes.find((index) => index.code === requestedCode) ??
      indexes[0] ??
      null,
    [indexes, requestedCode],
  );
  const selectedCode = selectedIndex?.code ?? "";
  const selectedSymbol = selectedIndex?.symbol ?? "";
  const marketSummary = useMemo(() => {
    const rising = indexes.filter((index) => (index.changePct ?? 0) > 0).length;
    const falling = indexes.filter(
      (index) => (index.changePct ?? 0) < 0,
    ).length;
    const changes = indexes
      .map((index) => index.changePct)
      .filter((change): change is number => change != null);
    const averageChange =
      changes.length > 0
        ? changes.reduce((sum, change) => sum + change, 0) / changes.length
        : null;

    return { rising, falling, averageChange };
  }, [indexes]);
  const filteredIndexes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    return indexes.filter((index) => {
      const matchesQuery =
        !normalizedQuery ||
        index.name.toLocaleLowerCase().includes(normalizedQuery) ||
        index.code.toLocaleLowerCase().includes(normalizedQuery);
      const matchesFilter =
        indexFilter === "all" ||
        (indexFilter === "up" && (index.changePct ?? 0) > 0) ||
        (indexFilter === "down" && (index.changePct ?? 0) < 0);
      return matchesQuery && matchesFilter;
    });
  }, [indexFilter, indexes, searchQuery]);

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
      setIntradayBars([]);
      setIntradayError(null);
      setIntradayStale(false);
      setIntradayLoading(false);
      return;
    }

    let active = true;
    setBars([]);
    setBarsLoading(true);
    setBarsError(null);
    setBarsStale(false);
    setIntradayBars([]);
    setIntradayLoading(true);
    setIntradayError(null);
    setIntradayStale(false);

    void fetchDashboardDailyBars(selectedSymbol)
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

    void fetchDashboardIntradayBars(selectedSymbol)
      .then((result) => {
        if (!active) return;
        setIntradayBars(result.data);
        setIntradayStale(result.stale);
        setIntradayError(result.error ?? null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setIntradayBars([]);
        setIntradayStale(true);
        setIntradayError(errorMessage(error));
      })
      .finally(() => {
        if (active) setIntradayLoading(false);
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
    <div className="flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5">
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight">
          {t("indices.title", "指数")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "indices.description",
            "查看主要 A 股宽基指数的当日行情和日线走势",
          )}
        </p>
      </header>

      <section
        aria-labelledby="indices-overview-title"
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <h2 id="indices-overview-title" className="sr-only">
          {t("indices.marketOverview", "市场概览")}
        </h2>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("indices.total", "指数总数")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums">
            {indexes.length}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <TrendingUp
              className="h-3.5 w-3.5 text-red-500"
              aria-hidden="true"
            />
            {t("indices.rising", "上涨")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-red-500">
            {marketSummary.rising}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <TrendingDown
              className="h-3.5 w-3.5 text-green-500"
              aria-hidden="true"
            />
            {t("indices.falling", "下跌")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-green-500">
            {marketSummary.falling}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("indices.averageChange", "平均涨跌幅")}
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-lg font-semibold tabular-nums",
              changeClass(marketSummary.averageChange),
            )}
          >
            {formatChange(marketSummary.averageChange, "%")}
          </p>
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)] lg:gap-3">
        <aside
          aria-labelledby="indices-list-title"
          className="min-h-0 rounded-lg border bg-card p-3 lg:overflow-auto"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 id="indices-list-title" className="text-sm font-semibold">
                {t("indices.supported", "支持的指数")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("indices.showing", "显示 {{count}} / {{total}}", {
                  count: filteredIndexes.length,
                  total: indexes.length,
                })}
              </p>
            </div>
            {indexesLoading && (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label={t("indices.loading", "指数行情加载中")}
              />
            )}
          </div>

          <label className="relative block">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">{t("indices.search", "搜索指数")}</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("indices.searchPlaceholder", "按名称或代码搜索")}
              aria-label={t("indices.search", "搜索指数")}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>

          <div
            className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
            role="group"
            aria-label={t("indices.filter", "筛选指数")}
          >
            {(
              [
                ["all", t("indices.all", "全部")],
                ["up", t("indices.rising", "上涨")],
                ["down", t("indices.falling", "下跌")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setIndexFilter(value)}
                aria-pressed={indexFilter === value}
                className={cn(
                  "rounded px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  indexFilter === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {indexesError && indexes.length === 0 && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>{t("indices.quotesError", "指数行情加载失败")}</span>
            </div>
          )}

          {!indexesLoading && !indexesError && indexes.length === 0 && (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              {t("indices.unavailable", "暂无可用指数")}
            </p>
          )}

          <div className="mt-3 space-y-1" aria-busy={indexesLoading}>
            {filteredIndexes.map((index) => {
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
                    active
                      ? "border-primary/30 bg-primary/10"
                      : "border-transparent hover:bg-muted",
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {index.name}
                      </span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {index.code}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono tabular-nums">
                      <span className="block text-sm font-medium">
                        {formatNumber(index.price)}
                      </span>
                      <span
                        className={cn(
                          "block text-xs",
                          changeClass(index.changePct),
                        )}
                      >
                        {formatChange(index.changePct, "%")}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
            {!indexesLoading &&
              indexes.length > 0 &&
              filteredIndexes.length === 0 && (
                <div className="rounded-md bg-muted p-3 text-center text-sm text-muted-foreground">
                  <p>{t("indices.noMatches", "未找到匹配指数")}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setIndexFilter("all");
                    }}
                    className="mt-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("indices.clearFilters", "清除筛选")}
                  </button>
                </div>
              )}
          </div>

          {(indexesStale || (indexesError && indexes.length > 0)) && (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {t("indices.stale", "行情数据可能已过期")}
            </p>
          )}
        </aside>

        <section
          aria-labelledby="index-detail-title"
          className="min-h-0 rounded-lg border bg-card p-4 lg:overflow-auto"
        >
          {selectedIndex ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <BarChart3
                      className="h-5 w-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <h2
                      id="index-detail-title"
                      className="truncate text-lg font-semibold"
                    >
                      {selectedIndex.name}
                    </h2>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {selectedIndex.code}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-4 text-right font-mono tabular-nums">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("indices.price", "最新价")}
                    </p>
                    <p className="mt-1 text-base font-semibold">
                      {formatNumber(selectedIndex.price)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("indices.change", "涨跌额")}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-base font-semibold",
                        changeClass(selectedIndex.changeAmt),
                      )}
                    >
                      {formatChange(selectedIndex.changeAmt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("indices.changePercent", "涨跌幅")}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-base font-semibold",
                        changeClass(selectedIndex.changePct),
                      )}
                    >
                      {formatChange(selectedIndex.changePct, "%")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    {t("indices.dailyHistory", "日线走势")}
                  </h3>
                  {barsStale && (
                    <span
                      role="status"
                      className="text-xs text-muted-foreground"
                    >
                      {t("indices.stale", "行情数据可能已过期")}
                    </span>
                  )}
                </div>

                {barsLoading && (
                  <div className="flex min-h-60 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    {t("indices.historyLoading", "日线数据加载中")}
                  </div>
                )}

                {!barsLoading && barsError && (
                  <div
                    role="alert"
                    className="flex min-h-60 flex-col items-center justify-center gap-2 rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive"
                  >
                    <AlertCircle className="h-5 w-5" aria-hidden="true" />
                    <p>{t("indices.historyError", "日线数据加载失败")}</p>
                  </div>
                )}

                {!barsLoading && !barsError && bars.length === 0 && (
                  <div className="flex min-h-60 flex-col items-center justify-center gap-1 rounded-md bg-muted p-4 text-center">
                    <p className="text-sm font-medium">
                      {t("indices.historyUnavailable", "暂无日线数据")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "indices.historyUnavailableHint",
                        "请选择其他指数后重试",
                      )}
                    </p>
                  </div>
                )}

                {bars.length > 0 && (
                  <CandlestickChart data={bars} height={460} />
                )}

                <div className="mt-5 border-t pt-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">
                      {t("indices.intradayHistory", "分时走势")}
                    </h3>
                    {intradayStale && (
                      <span
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {t("indices.stale", "行情数据可能已过期")}
                      </span>
                    )}
                  </div>

                  {intradayLoading && (
                    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                      {t("indices.intradayLoading", "分时数据加载中")}
                    </div>
                  )}

                  {!intradayLoading && intradayError && (
                    <div
                      role="alert"
                      className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive"
                    >
                      <AlertCircle className="h-5 w-5" aria-hidden="true" />
                      <p>{t("indices.intradayError", "分时数据加载失败")}</p>
                    </div>
                  )}

                  {!intradayLoading && !intradayError && intradayBars.length === 0 && (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-md bg-muted p-4 text-center">
                      <p className="text-sm font-medium">
                        {t("indices.intradayUnavailable", "暂无分时数据")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "indices.intradayUnavailableHint",
                          "当前交易时段可能暂无可用数据",
                        )}
                      </p>
                    </div>
                  )}

                  {intradayBars.length > 0 && (
                    <IntradayChart data={intradayBars} height={300} />
                  )}
                </div>
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
