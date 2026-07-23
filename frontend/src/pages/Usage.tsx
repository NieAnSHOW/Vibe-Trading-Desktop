import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  api,
  type LLMUsageAggregateResponse,
  type LLMUsageDailyBucket,
  type LLMUsageModelBucket,
  type LLMUsageQuery,
} from "@/lib/api";
import { echarts } from "@/lib/echarts";
import { getChartTheme } from "@/lib/chart-theme";
import { useDarkMode } from "@/hooks/useDarkMode";
import { cn } from "@/lib/utils";

type Range = "all" | "last7" | "last30" | "month" | "custom";

type LoadOverrides = {
  range?: Range;
  page?: number;
  query?: string;
  customStart?: string;
  customEnd?: string;
};

type AppliedState = {
  range: Range;
  query: string;
  customStart: string;
  customEnd: string;
};

type RequestState = AppliedState & {
  page: number;
};

const PAGE_SIZE = 25;

function localMidnight(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function formatNumber(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

function TrendChart({
  data,
  label,
  dark,
}: {
  data: LLMUsageDailyBucket[];
  label: string;
  dark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = getChartTheme();
    const chart = echarts.init(ref.current);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.tooltipText },
      },
      grid: { left: 12, right: 16, top: 16, bottom: 24, containLabel: true },
      xAxis: {
        type: "category",
        data: data.map((bucket) => bucket.date),
        axisLine: { lineStyle: { color: theme.axisColor } },
        axisLabel: { color: theme.textColor },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: theme.gridColor } },
        axisLabel: { color: theme.textColor },
      },
      series: [
        {
          type: "line",
          smooth: true,
          showSymbol: data.length < 32,
          data: data.map((bucket) => bucket.totals.total_tokens),
          lineStyle: { color: theme.infoColor, width: 2 },
          itemStyle: { color: theme.infoColor },
          areaStyle: { color: `${theme.infoColor}18` },
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [data, dark]);

  return (
    <div
      ref={ref}
      className="min-h-[18rem] w-full"
      role="img"
      aria-label={label}
    />
  );
}

function BreakdownChart({
  data,
  label,
  dark,
}: {
  data: LLMUsageModelBucket[];
  label: string;
  dark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = getChartTheme();
    const sorted = [...data].sort(
      (left, right) => right.totals.total_tokens - left.totals.total_tokens,
    );
    const chart = echarts.init(ref.current);
    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        textStyle: { color: theme.tooltipText },
      },
      grid: { left: 12, right: 20, top: 16, bottom: 20, containLabel: true },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: theme.gridColor } },
        axisLabel: { color: theme.textColor },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: sorted.map((bucket) =>
          bucket.model
            ? `${bucket.provider} / ${bucket.model}`
            : bucket.provider,
        ),
        axisLine: { lineStyle: { color: theme.axisColor } },
        axisLabel: { color: theme.textColor, width: 150, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((bucket, index) => ({
            value: bucket.totals.total_tokens,
            itemStyle: { color: theme.maColors[index % theme.maColors.length] },
          })),
          itemStyle: { borderRadius: [0, 3, 3, 0] },
          barMaxWidth: 22,
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [data, dark]);

  return (
    <div
      ref={ref}
      className="min-h-[18rem] w-full"
      role="img"
      aria-label={label}
    />
  );
}

export function Usage() {
  const { t, i18n } = useTranslation();
  const { dark } = useDarkMode();
  const locale = i18n.resolvedLanguage || i18n.language;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [snapshot, setSnapshot] = useState<LLMUsageAggregateResponse | null>(
    null,
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<Date | null>(null);
  const [appliedState, setAppliedState] = useState<AppliedState>({
    range: "all",
    query: "",
    customStart: "",
    customEnd: "",
  });
  const [rangeDraft, setRangeDraft] = useState<Range>("all");
  const [queryDraft, setQueryDraft] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [chartDark, setChartDark] = useState(dark);
  const initialLoadStartedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const queryDraftGenerationRef = useRef(0);
  const rangeDraftGenerationRef = useRef(0);
  const requestedStateRef = useRef<RequestState>({
    range: "all",
    query: "",
    customStart: "",
    customEnd: "",
    page: 1,
  });

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setChartDark(root.classList.contains("dark"));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [dark]);

  const buildQuery = (requestState: RequestState): LLMUsageQuery => {
    const now = new Date();
    const params: LLMUsageQuery = {
      timezone,
      page: requestState.page,
      page_size: PAGE_SIZE,
    };

    if (requestState.range === "last7" || requestState.range === "last30") {
      const days = requestState.range === "last7" ? 7 : 30;
      const start = new Date(now);
      start.setDate(start.getDate() - days);
      params.start_at = start.toISOString();
      params.end_at = now.toISOString();
    } else if (requestState.range === "month") {
      params.start_at = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).toISOString();
      params.end_at = now.toISOString();
    } else if (requestState.range === "custom") {
      const { customStart: start, customEnd: end } = requestState;
      if (start) params.start_at = localMidnight(start).toISOString();
      if (end) {
        const exclusiveEnd = localMidnight(end);
        exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);
        params.end_at = exclusiveEnd.toISOString();
      }
    }
    if (requestState.query.trim()) params.query = requestState.query.trim();
    return params;
  };

  const loadUsage = async (
    preserveSnapshot: boolean,
    overrides: LoadOverrides = {},
  ) => {
    const requestGeneration = ++requestGenerationRef.current;
    const queryDraftGeneration = queryDraftGenerationRef.current;
    const rangeDraftGeneration = rangeDraftGenerationRef.current;
    const previousRequestedState = requestedStateRef.current;
    const requestState: RequestState = {
      range: overrides.range ?? previousRequestedState.range,
      query: overrides.query ?? previousRequestedState.query,
      customStart: overrides.customStart ?? previousRequestedState.customStart,
      customEnd: overrides.customEnd ?? previousRequestedState.customEnd,
      page: overrides.page ?? previousRequestedState.page,
    };
    requestedStateRef.current = requestState;
    setIsLoading(true);
    setRefreshError(null);
    try {
      const next = await api.getLLMUsage(buildQuery(requestState));
      if (requestGeneration !== requestGenerationRef.current) return;
      setSnapshot(next);
      setAppliedState({
        range: requestState.range,
        query: requestState.query,
        customStart: requestState.customStart,
        customEnd: requestState.customEnd,
      });
      requestedStateRef.current = { ...requestState, page: next.sessions.page };
      if (
        rangeDraftGeneration === rangeDraftGenerationRef.current &&
        overrides.range !== undefined
      ) {
        setRangeDraft(requestState.range);
      }
      if (
        queryDraftGeneration === queryDraftGenerationRef.current &&
        overrides.query !== undefined
      ) {
        setQueryDraft(requestState.query);
      }
      if (
        overrides.range !== undefined ||
        overrides.query !== undefined ||
        overrides.page !== undefined
      ) {
        setSelectedSessionId(null);
      }
      setLastSuccessfulAt(new Date());
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return;
      setRefreshError(
        error instanceof Error ? error.message : t("usageCenter.loadFailed"),
      );
      requestedStateRef.current = {
        ...appliedState,
        page: snapshot?.sessions.page ?? 1,
      };
      if (rangeDraftGeneration === rangeDraftGenerationRef.current) {
        if (
          requestState.range !== appliedState.range ||
          requestState.customStart !== appliedState.customStart ||
          requestState.customEnd !== appliedState.customEnd
        ) {
          setRangeDraft(appliedState.range);
          setCustomStart(appliedState.customStart);
          setCustomEnd(appliedState.customEnd);
        }
      }
      if (queryDraftGeneration === queryDraftGenerationRef.current) {
        if (requestState.query !== appliedState.query)
          setQueryDraft(appliedState.query);
      }
      if (!preserveSnapshot) setSnapshot(null);
    } finally {
      if (requestGeneration === requestGenerationRef.current)
        setIsLoading(false);
    }
  };

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    void loadUsage(false);
    // Loading is intentionally mount-only; every later request is user initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectRange = (nextRange: Range) => {
    rangeDraftGenerationRef.current += 1;
    setRangeDraft(nextRange);
    if (nextRange === "custom") {
      return;
    }
    void loadUsage(true, { range: nextRange, page: 1 });
  };

  const submitCustomRange = (event: FormEvent) => {
    event.preventDefault();
    void loadUsage(true, { range: "custom", page: 1, customStart, customEnd });
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const nextQuery = queryDraft.trim();
    void loadUsage(true, { query: nextQuery, page: 1 });
  };

  const changePage = (nextPage: number) => {
    void loadUsage(true, { page: nextPage });
  };

  const metricClass = "min-w-0 rounded-lg border bg-card px-3 py-2.5";
  const selectedSession = snapshot
    ? (snapshot.sessions.items.find(
        (session) => session.session_id === selectedSessionId,
      ) ??
      snapshot.sessions.items[0] ??
      null)
    : null;

  return (
    <div className="flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">
            {t("usageCenter.title")}
          </h1>
          {lastSuccessfulAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("usageCenter.lastUpdated")}{" "}
              {lastSuccessfulAt.toLocaleString(locale)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void loadUsage(true)}
          disabled={isLoading}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw
            className={cn("h-4 w-4", isLoading && "animate-spin")}
            aria-hidden="true"
          />
          {isLoading ? t("usageCenter.refreshing") : t("usageCenter.refresh")}
        </button>
      </header>

      {refreshError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{refreshError}</span>
          {!snapshot && (
            <button
              type="button"
              onClick={() => void loadUsage(false)}
              className="rounded-md border border-danger/30 px-2 py-1 font-medium"
            >
              {t("usageCenter.retry")}
            </button>
          )}
        </div>
      )}

      {!snapshot && isLoading && (
        <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
          {t("usageCenter.refreshing")}
        </div>
      )}

      {snapshot && (
        <>
          {(snapshot.totals.missing_usage_runs > 0 ||
            snapshot.totals.invalid_usage_runs > 0) && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-foreground">
              <p className="font-medium">{t("usageCenter.partialData")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("usageCenter.missingUsageRuns")}:{" "}
                {formatNumber(snapshot.totals.missing_usage_runs, locale)} ·{" "}
                {t("usageCenter.invalidUsageRuns")}:{" "}
                {formatNumber(snapshot.totals.invalid_usage_runs, locale)}
              </p>
            </div>
          )}

          {snapshot.totals.runs === 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
              {t("usageCenter.empty")}
            </div>
          )}

          <section
            data-usage-summary
            className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6"
            aria-label={t("usageCenter.totalTokens")}
          >
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.totalTokens")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatNumber(snapshot.totals.total_tokens, locale)}
              </p>
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.inputTokens")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatNumber(snapshot.totals.input_tokens, locale)}
              </p>
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.outputTokens")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatNumber(snapshot.totals.output_tokens, locale)}
              </p>
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.calls")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatNumber(snapshot.totals.calls, locale)}
              </p>
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.sessions")}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatNumber(snapshot.totals.sessions, locale)}
              </p>
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("llmUsage.cacheReadTokens")}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {snapshot.totals.cache_read_tokens === undefined
                  ? t("usageCenter.notProvided")
                  : formatNumber(snapshot.totals.cache_read_tokens, locale)}
              </p>
            </div>
            {/* TODO: 暂时不需要 <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.cacheRead")}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {snapshot.totals.cache_read_tokens === undefined
                  ? t("usageCenter.notProvided")
                  : formatNumber(snapshot.totals.cache_read_tokens, locale)}
              </p>
              {snapshot.totals.cache_read_tokens !== undefined && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("usageCenter.cacheCoverage")}:{" "}
                  {formatNumber(
                    snapshot.totals.cache_read_reported_runs,
                    locale,
                  )}{" "}
                  / {formatNumber(snapshot.totals.runs, locale)}
                </p>
              )}
            </div>
            <div className={metricClass}>
              <p className="text-xs text-muted-foreground">
                {t("usageCenter.cacheWrite")}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {snapshot.totals.cache_write_tokens === undefined
                  ? t("usageCenter.notProvided")
                  : formatNumber(snapshot.totals.cache_write_tokens, locale)}
              </p>
              {snapshot.totals.cache_write_tokens !== undefined && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("usageCenter.cacheCoverage")}:{" "}
                  {formatNumber(
                    snapshot.totals.cache_write_reported_runs,
                    locale,
                  )}{" "}
                  / {formatNumber(snapshot.totals.runs, locale)}
                </p>
              )}
            </div> */}
          </section>

          <div
            data-usage-workspace
            className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]"
          >
            <section
              data-usage-detail
              className="order-last min-w-0 rounded-lg border bg-card p-4 lg:col-start-2 lg:row-start-1 lg:overflow-auto"
            >
              {selectedSession ? (
                <div className="mb-4 border-b pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">
                        {selectedSession.title || selectedSession.session_id}
                      </h2>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {selectedSession.session_id}
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-right font-mono tabular-nums">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {t("usageCenter.runs")}
                        </p>
                        <p className="mt-1 text-base font-semibold">
                          {formatNumber(selectedSession.runs.length, locale)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {t("usageCenter.calls")}
                        </p>
                        <p className="mt-1 text-base font-semibold">
                          {formatNumber(selectedSession.totals.calls, locale)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {t("usageCenter.totalTokens")}
                        </p>
                        <p className="mt-1 text-base font-semibold">
                          {formatNumber(
                            selectedSession.totals.total_tokens,
                            locale,
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                  {selectedSession.runs.length > 0 && (
                    <div className="mt-3 divide-y divide-border border-y border-border">
                      {selectedSession.runs.map((run) => (
                        <div
                          key={run.run_id}
                          className="flex flex-col gap-1 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                        >
                          <Link
                            to={`/runs/${run.run_id}`}
                            className="min-w-0 truncate font-medium text-primary hover:underline"
                          >
                            {run.run_id}
                          </Link>
                          <span className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                            <span>
                              {run.provider}
                              {run.model ? ` / ${run.model}` : ""}
                            </span>
                            <span>
                              {formatNumber(run.totals.total_tokens, locale)}
                            </span>
                            <span>
                              {new Date(run.occurred_at).toLocaleString(locale)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3">
                <div className="min-w-0 pb-3 ">
                  <h2 className="text-sm font-medium text-foreground">
                    {t("usageCenter.trend")}
                  </h2>
                  <TrendChart
                    data={snapshot.trend}
                    label={t("usageCenter.trend")}
                    dark={chartDark}
                  />
                </div>
                <div className="min-w-0 pt-3 xl:pt-0">
                  <h2 className="text-sm font-medium text-foreground">
                    {t("usageCenter.breakdown")}
                  </h2>
                  <BreakdownChart
                    data={snapshot.breakdown}
                    label={t("usageCenter.breakdown")}
                    dark={chartDark}
                  />
                </div>
              </div>
            </section>

            <aside
              data-usage-navigator
              className="order-first space-y-3 rounded-lg border bg-card p-3 lg:col-start-1 lg:row-start-1 lg:overflow-auto"
              role="region"
              aria-label={t("usageCenter.sessionDetails")}
            >
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t("usageCenter.sessionDetails")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatNumber(snapshot.sessions.total_items, locale)}{" "}
                  {t("usageCenter.sessions")}
                </p>
              </div>
              <div
                className="grid grid-cols-4 gap-1 rounded-md bg-muted p-1"
                role="group"
                aria-label={t("usageCenter.customRange")}
              >
                {(
                  [
                    ["all", "usageCenter.allTime"],
                    ["last7", "usageCenter.last7Days"],
                    ["last30", "usageCenter.last30Days"],
                    ["month", "usageCenter.thisMonth"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => selectRange(value)}
                    aria-pressed={appliedState.range === value}
                    className={cn(
                      "min-w-0 rounded px-1 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      appliedState.range === value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>

              {rangeDraft === "custom" && (
                <form
                  onSubmit={submitCustomRange}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                    {t("usageCenter.startDate")}
                    <input
                      type="date"
                      value={customStart}
                      onChange={(event) => {
                        rangeDraftGenerationRef.current += 1;
                        setCustomStart(event.target.value);
                      }}
                      className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                    {t("usageCenter.endDate")}
                    <input
                      type="date"
                      value={customEnd}
                      onChange={(event) => {
                        rangeDraftGenerationRef.current += 1;
                        setCustomEnd(event.target.value);
                      }}
                      className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    />
                  </label>
                  <button
                    type="submit"
                    className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground sm:col-span-2"
                  >
                    {t("usageCenter.apply")}
                  </button>
                </form>
              )}

              <form
                onSubmit={submitSearch}
                className="flex w-full items-center rounded-md border border-border bg-background"
              >
                <input
                  type="search"
                  aria-label={t("usageCenter.searchSessions")}
                  placeholder={t("usageCenter.searchSessions")}
                  value={queryDraft}
                  onChange={(event) => {
                    queryDraftGenerationRef.current += 1;
                    setQueryDraft(event.target.value);
                  }}
                  className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
                />
                <button
                  type="submit"
                  aria-label={t("usageCenter.searchSessions")}
                  className="grid h-9 w-9 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>

              <div className="py-2 border-t border-border">
                {snapshot.sessions.items.map((session) => {
                  const selected =
                    selectedSession?.session_id === session.session_id;
                  return (
                    <button
                      key={session.session_id}
                      type="button"
                      aria-pressed={selected}
                      aria-label={session.title || session.session_id}
                      onClick={() => setSelectedSessionId(session.session_id)}
                      className={cn(
                        "flex w-full flex-col gap-2 border rounded-md px-2 py-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:flex-row sm:items-center sm:justify-between",
                        selected
                          ? "!border-primary/30 bg-primary/10"
                          : "border-transparent hover:bg-muted/60",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {session.title || session.session_id}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {new Date(session.last_run_at).toLocaleString(locale)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          {t("usageCenter.runs")}:{" "}
                          {formatNumber(session.runs.length, locale)}
                        </span>
                        <span>
                          {formatNumber(session.totals.total_tokens, locale)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {snapshot.sessions.total_pages > 1 && (
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    aria-label={t("usageCenter.previousPage")}
                    disabled={snapshot.sessions.page <= 1 || isLoading}
                    onClick={() => changePage(snapshot.sessions.page - 1)}
                    className="grid h-8 w-8 place-items-center rounded-md border border-border disabled:opacity-40"
                  >
                    <ChevronLeft
                      className="h-4 w-4 rtl:flip-x"
                      aria-hidden="true"
                    />
                  </button>
                  <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
                    {formatNumber(snapshot.sessions.page, locale)} /{" "}
                    {formatNumber(snapshot.sessions.total_pages, locale)}
                  </span>
                  <button
                    type="button"
                    aria-label={t("usageCenter.nextPage")}
                    disabled={
                      snapshot.sessions.page >= snapshot.sessions.total_pages ||
                      isLoading
                    }
                    onClick={() => changePage(snapshot.sessions.page + 1)}
                    className="grid h-8 w-8 place-items-center rounded-md border border-border disabled:opacity-40"
                  >
                    <ChevronRight
                      className="h-4 w-4 rtl:flip-x"
                      aria-hidden="true"
                    />
                  </button>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
