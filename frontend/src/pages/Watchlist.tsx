import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Eye,
  Trash2,
  Send,
  RefreshCw,
  CandlestickChart as CandlestickIcon,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWatchlistStore } from "@/stores/watchlist";
import { useMarketDashboardStore } from "@/stores/marketDashboard";
import { CandlestickChart as CandlestickChartView } from "@/components/charts/CandlestickChart";
import { IntradayChart } from "@/components/charts/IntradayChart";
import type { PriceBar, QuoteData } from "@/lib/api";
import { toast } from "sonner";

/** A 股代码：6 位数字 */
const A_STOCK_RE = /^\d{6}$/;

/** 涨跌颜色：A 股惯例，上涨红，下跌绿 */
function changeColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground";
  if (pct > 0) return "text-red-500";
  if (pct < 0) return "text-green-500";
  return "text-muted-foreground";
}

/** 涨跌幅 chip：柔和背景色块，一眼可辨涨跌方向 */
function pctChipClass(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground";
  if (pct > 0) return "bg-red-500/10 text-red-500";
  if (pct < 0) return "bg-green-500/10 text-green-500";
  return "bg-muted text-muted-foreground";
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

function WatchlistStockCardSkeleton() {
  return (
    <li className="h-[4.5rem] rounded-md border bg-card p-3">
      <div className="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <div className="h-3.5 w-3.5 rounded bg-muted/60 animate-pulse" />
        <div className="space-y-2">
          <div className="h-3.5 w-28 rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-40 rounded bg-muted/60 animate-pulse" />
        </div>
        <div className="h-7 w-14 rounded bg-muted/60 animate-pulse" />
      </div>
    </li>
  );
}

function WatchlistStockCard({
  stock,
  quote,
  isSelected,
  isActive,
  confirmingDelete,
  labels,
  detailLabel,
  onToggleSelection,
  onSelectDetail,
  onDelete,
  onCancelDelete,
}: {
  stock: { code: string; name?: string | null };
  quote?: QuoteData;
  isSelected: boolean;
  isActive: boolean;
  confirmingDelete: boolean;
  labels: Record<string, string>;
  detailLabel: string;
  onToggleSelection: () => void;
  onSelectDetail: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const name = quote?.name ?? stock.name ?? "—";
  const pct = quote?.change_pct;

  return (
    <li>
      <article
        data-testid={`watchlist-card-${stock.code}`}
        title={quote?.stale ? labels.stale : undefined}
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40",
          isSelected && "bg-primary/[0.06]",
          isActive && "bg-primary/[0.1] ring-1 ring-inset ring-primary/40",
          quote?.stale && "opacity-50",
        )}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelection}
          className="accent-primary"
          aria-label={`${labels.select} ${stock.code}`}
        />
        <button
          type="button"
          onClick={onSelectDetail}
          data-testid={`watchlist-card-select-${stock.code}`}
          aria-pressed={isActive}
          aria-label={detailLabel}
          className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <span className="min-w-0 truncate">{name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {stock.code}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-2 font-mono text-xs tabular-nums">
            <span className={changeColor(pct)}>{fmtPrice(quote?.price)}</span>
            <span className={changeColor(pct)}>
              {fmtAmt(quote?.change_amt)}
            </span>
            <span
              className={cn(
                "inline-block min-w-[3.75rem] rounded px-1.5 py-0.5 text-right font-mono tabular-nums",
                pctChipClass(pct),
              )}
            >
              {fmtPct(pct)}
            </span>
          </span>
        </button>
        <div className="flex items-center gap-1">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="rounded px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 hover:text-red-700"
                data-testid={`confirm-delete-${stock.code}`}
              >
                {labels.confirmDelete}
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                {labels.cancelDelete}
              </button>
            </>
          ) : (
            <>
              <a
                href={`https://stockpage.10jqka.com.cn/${stock.code}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title={labels.kline}
                aria-label={labels.kline}
                data-testid={`kline-${stock.code}`}
              >
                <CandlestickIcon size={14} />
              </a>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title={labels.delete}
                aria-label={labels.delete}
                data-testid={`delete-${stock.code}`}
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </article>
    </li>
  );
}

function StockDetailSection({
  code,
  name,
  bars,
  loading,
  error,
  intradayBars,
  intradayLoading,
  intradayError,
  intradayStale,
  onAnalyze,
}: {
  code: string | null;
  name: string | null;
  bars: PriceBar[];
  loading: boolean;
  error: string | null;
  intradayBars: PriceBar[];
  intradayLoading: boolean;
  intradayError: string | null;
  intradayStale: boolean;
  onAnalyze: (code: string, name: string) => void;
}) {
  const { t } = useTranslation();

  if (!code) {
    return (
      <div className="flex h-full flex-col space-y-3">
        <h2 className="text-sm font-semibold">{t("dashboard.stockDetail")}</h2>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <TrendingUp className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">
            {t("dashboard.selectStockHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col space-y-3 lg:min-h-0 lg:flex-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {name || code}{" "}
          <span className="text-muted-foreground font-normal text-xs">
            ({code})
          </span>
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

      <div
        data-testid="watchlist-chart-stack"
        className="space-y-3 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:space-y-0 lg:gap-4"
      >
      <div
        data-testid="watchlist-daily-chart-region"
        className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
      >
      {loading && (
        <p className="text-xs text-muted-foreground">
          {t("dashboard.loading")}
        </p>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}
      {!loading && !error && bars.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("charts.noPriceData")}
        </p>
      )}
      {bars.length > 0 && (
        <CandlestickChartView data={bars} height={440} fill defaultRange="3M" />
      )}
      </div>

      <div
        data-testid="watchlist-intraday-chart-region"
        className="border-t pt-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">
            {t("watchlist.intradayHistory", "分时走势")}
          </h3>
          {intradayStale && (
            <span role="status" className="text-xs text-muted-foreground">
              {t("watchlist.stale", "行情延迟")}
            </span>
          )}
        </div>
        {intradayLoading && (
          <p className="min-h-32 text-center text-xs text-muted-foreground">
            {t("watchlist.intradayLoading", "分时数据加载中")}
          </p>
        )}
        {!intradayLoading && intradayError && (
          <div
            role="alert"
            className="flex min-h-32 items-center justify-center gap-1.5 rounded-md bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            {t("watchlist.intradayError", "分时数据加载失败")}
          </div>
        )}
        {!intradayLoading && !intradayError && intradayBars.length === 0 && (
          <div className="flex min-h-32 flex-col items-center justify-center rounded-md bg-muted p-3 text-center">
            <p className="text-xs font-medium">
              {t("watchlist.intradayUnavailable", "暂无分时数据")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "watchlist.intradayUnavailableHint",
                "当前交易时段可能暂无可用数据",
              )}
            </p>
          </div>
        )}
        {intradayBars.length > 0 && (
          <IntradayChart data={intradayBars} height={300} fill />
        )}
      </div>
      </div>
    </div>
  );
}

export default function WatchlistPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const {
    stocks,
    quotes,
    selected,
    loading,
    error,
    refresh,
    add,
    remove,
    refreshQuotes,
    toggleSelection,
    clearSelection,
  } = useWatchlistStore();

  const [inputCode, setInputCode] = useState("");
  const [inputError, setInputError] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedCode = useMarketDashboardStore((s) => s.selectedCode);
  const selectedBars = useMarketDashboardStore((s) => s.selectedBars);
  const barsLoading = useMarketDashboardStore((s) => s.barsLoading);
  const barsError = useMarketDashboardStore((s) => s.barsError);
  const selectedIntradayBars = useMarketDashboardStore(
    (s) => s.selectedIntradayBars,
  );
  const intradayLoading = useMarketDashboardStore((s) => s.intradayLoading);
  const intradayError = useMarketDashboardStore((s) => s.intradayError);
  const intradayStale = useMarketDashboardStore((s) => s.intradayStale);
  const setSelectedCode = useMarketDashboardStore((s) => s.setSelectedCode);
  const activeSelectedCode =
    selectedCode && stocks.some((stock) => stock.code === selectedCode)
      ? selectedCode
      : null;

  // 初始加载
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 行情轮询：3s，Page Visibility API 暂停/恢复
  useEffect(() => {
    if (stocks.length === 0) return;

    function startPolling() {
      refreshQuotes();
      pollingRef.current = setInterval(() => {
        if (!document.hidden) refreshQuotes();
      }, 3000);
    }

    function handleVisibility() {
      if (!document.hidden && stocks.length > 0) {
        // 切回立即刷一次
        refreshQuotes();
      }
    }

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [stocks.length, refreshQuotes]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const code = inputCode.trim();
    if (!A_STOCK_RE.test(code)) {
      setInputError(t("watchlist.invalidCode", "请输入 6 位数字股票代码"));
      return;
    }
    setInputError("");
    setAdding(true);
    try {
      const result = await add(code);
      if (result.exists) {
        toast.info(
          t("watchlist.alreadyAdded", "{{code}} 已在自选股中", { code }),
        );
      } else {
        setInputCode("");
        toast.success(t("watchlist.added", "已添加 {{code}}", { code }));
      }
    } catch {
      toast.error(t("watchlist.addError", "添加失败，请稍后重试"));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(code: string) {
    if (confirmDelete !== code) {
      setConfirmDelete(code);
      return;
    }
    setConfirmDelete(null);
    try {
      await remove(code);
      toast.success(t("watchlist.removed", "已删除 {{code}}", { code }));
    } catch {
      toast.error(t("watchlist.removeError", "删除失败，请稍后重试"));
    }
  }

  function handleSelectAll() {
    if (selected.size === stocks.length) clearSelection();
    else
      stocks.forEach((s) => {
        if (!selected.has(s.code)) toggleSelection(s.code);
      });
  }

  function handleSendToAgent() {
    const selectedStocks = stocks.filter((s) => selected.has(s.code));
    if (selectedStocks.length === 0) return;
    const names = selectedStocks.map((s) => {
      const q = quotes[s.code];
      return q?.name ? `${s.code} ${q.name}` : s.code;
    });
    const prefill =
      selectedStocks.length === 1
        ? `帮我分析 ${names[0]} 的走势和投资机会`
        : `帮我分析以下股票的走势和投资机会：${names.join("、")}`;
    clearSelection();
    navigate(`/agent?prefill=${encodeURIComponent(prefill)}`);
  }

  function handleAnalyze(code: string, name: string) {
    const message = `请分析 ${name} (${code}) 的近期走势和技术指标`;
    navigate(`/agent?prefill=${encodeURIComponent(message)}`);
  }

  const cardLabels = {
    selectAll: t("watchlist.selectAll", "全选"),
    select: t("watchlist.select", "选择"),
    stale: t("watchlist.stale", "行情延迟"),
    kline: t("watchlist.kline", "同花顺 K 线"),
    delete: t("watchlist.delete", "删除"),
    confirmDelete: t("watchlist.confirmDelete", "确认删除"),
    cancelDelete: t("watchlist.cancelDelete", "取消"),
  };
  const allSelected = selected.size === stocks.length && stocks.length > 0;
  const showSkeleton = loading && stocks.length === 0;
  const marketSummary = (() => {
    const changes = stocks
      .map((stock) => quotes[stock.code]?.change_pct)
      .filter((change): change is number => change != null);
    const rising = changes.filter((change) => change > 0).length;
    const falling = changes.filter((change) => change < 0).length;
    const averageChange =
      changes.length > 0
        ? changes.reduce((sum, change) => sum + change, 0) / changes.length
        : null;

    return { rising, falling, averageChange };
  })();
  const addForm = (
    <form onSubmit={handleAdd} className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="text"
          value={inputCode}
          onChange={(e) => {
            setInputCode(e.target.value);
            setInputError("");
          }}
          placeholder={t("watchlist.placeholder", "输入 6 位股票代码")}
          maxLength={6}
          inputMode="numeric"
          className="h-9 w-full border rounded-md bg-background px-3 text-sm placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
          aria-label={t("watchlist.placeholder", "输入 6 位股票代码")}
          aria-invalid={!!inputError}
        />
        {inputError && (
          <span className="flex items-center gap-1 text-xs text-red-500">
            <AlertCircle size={12} />
            {inputError}
          </span>
        )}
      </div>
      <button
        type="submit"
        disabled={adding}
        className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background transition-colors"
      >
        {adding ? t("watchlist.adding", "添加中…") : t("watchlist.add", "添加")}
      </button>
      {selected.size > 0 && (
        <button
          onClick={handleSendToAgent}
          data-testid="send-to-agent"
          className="flex text-center justify-center items-center gap-2  h-9 shrink-0 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background transition-colors"
        >
          <span>{t("watchlist.sendToAgent", "发给 AI")}</span>
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-primary-foreground/25 text-xs font-medium tabular-nums">
            {selected.size}
          </span>
        </button>
      )}
    </form>
  );

  return (
    <div className="flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-bold tracking-tight">
            {t("watchlist.title", "A股自选")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("watchlist.description", "关注股票的实时行情与日线走势")}
          </p>
        </div>
        <button
          onClick={() => {
            refresh();
            refreshQuotes();
          }}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
          title={t("watchlist.refresh", "刷新")}
          aria-label={t("watchlist.refresh", "刷新")}
        >
          <RefreshCw size={16} className={cn(loading && "animate-spin")} />
        </button>
      </header>

      <section
        aria-label={t("watchlist.marketOverview", "市场概览")}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("watchlist.total", "自选总数")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums">
            {stocks.length}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("watchlist.rising", "上涨")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-red-500">
            {marketSummary.rising}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("watchlist.falling", "下跌")}
          </p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-green-500">
            {marketSummary.falling}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("watchlist.averageChange", "平均涨跌幅")}
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-lg font-semibold tabular-nums",
              changeColor(marketSummary.averageChange),
            )}
          >
            {fmtPct(marketSummary.averageChange)}
          </p>
        </div>
      </section>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {stocks.length === 0 && addForm}

      {showSkeleton && (
        <ul role="list" className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <WatchlistStockCardSkeleton key={i} />
          ))}
        </ul>
      )}

      {!loading && stocks.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 py-16 text-center">
          <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
            <Eye
              size={28}
              strokeWidth={1.5}
              className="text-muted-foreground"
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-medium">
              {t("watchlist.empty", "暂无自选股，请添加股票代码")}
            </p>
            <p className="text-sm text-muted-foreground max-w-xs">
              {t("watchlist.emptyHint", "盯盘你关注的股票，涨跌实时刷新")}
            </p>
          </div>
        </div>
      )}

      {stocks.length > 0 && (
        <div
          data-testid="watchlist-workspace"
          className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(19rem,0.42fr)_minmax(0,1fr)]"
        >
          <aside
            data-testid="watchlist-list-panel"
            className="min-h-0 min-w-0 space-y-3 rounded-lg border bg-card p-3 lg:overflow-auto"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  {t("watchlist.listTitle", "自选列表")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("watchlist.showing", "共 {{count}} 只股票", {
                    count: stocks.length,
                  })}
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={handleSelectAll}
                  className="accent-primary"
                />
                {cardLabels.selectAll}
              </label>
            </div>

            {addForm}

            <ul role="list" className="space-y-2">
              {stocks.map((stock) => (
                <WatchlistStockCard
                  key={stock.code}
                  stock={stock}
                  quote={quotes[stock.code]}
                  isSelected={selected.has(stock.code)}
                  isActive={activeSelectedCode === stock.code}
                  confirmingDelete={confirmDelete === stock.code}
                  labels={cardLabels}
                  detailLabel={t(
                    "watchlist.viewDetail",
                    "查看 {{name}}（{{code}}）详情",
                    {
                      name: quotes[stock.code]?.name ?? stock.name ?? "—",
                      code: stock.code,
                    },
                  )}
                  onToggleSelection={() => toggleSelection(stock.code)}
                  onSelectDetail={() => void setSelectedCode(stock.code)}
                  onDelete={() => void handleDelete(stock.code)}
                  onCancelDelete={() => setConfirmDelete(null)}
                />
              ))}
            </ul>
          </aside>

          <section
            data-testid="watchlist-chart-panel"
            className="min-h-0 min-w-0 rounded-lg border bg-card p-4 lg:flex lg:flex-col"
          >
            <StockDetailSection
              code={activeSelectedCode}
              name={
                activeSelectedCode
                  ? (quotes[activeSelectedCode]?.name ?? null)
                  : null
              }
              bars={selectedBars}
              loading={barsLoading}
              error={barsError}
              intradayBars={selectedIntradayBars}
              intradayLoading={intradayLoading}
              intradayError={intradayError}
              intradayStale={intradayStale}
              onAnalyze={handleAnalyze}
            />
          </section>
        </div>
      )}
    </div>
  );
}
