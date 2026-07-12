import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Eye, Trash2, Send, RefreshCw, CandlestickChart } from "lucide-react";
import { useWatchlistStore } from "@/stores/watchlist";
import type { QuoteData } from "@/lib/api";
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

  return (
    <div className="flex flex-col h-full p-4 gap-4 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {t("watchlist.title", "A股自选")}
        </h1>
        <button
          onClick={() => {
            refresh();
            refreshQuotes();
          }}
          className="p-1.5 rounded hover:bg-accent"
          title={t("watchlist.refresh", "刷新")}
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Add Form */}
      <form onSubmit={handleAdd} className="flex gap-2 items-start">
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={inputCode}
            onChange={(e) => {
              setInputCode(e.target.value);
              setInputError("");
            }}
            placeholder={t("watchlist.placeholder", "输入 6 位股票代码")}
            maxLength={6}
            className="border rounded px-3 py-1.5 text-sm w-40 bg-background"
            aria-label={t("watchlist.placeholder", "输入 6 位股票代码")}
            aria-invalid={!!inputError}
          />
          {inputError && (
            <span className="text-xs text-red-500">{inputError}</span>
          )}
        </div>
        <button
          type="submit"
          disabled={adding}
          className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {adding
            ? t("watchlist.adding", "添加中…")
            : t("watchlist.add", "添加")}
        </button>
      </form>

      {/* Error */}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Empty State */}
      {!loading && stocks.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-muted-foreground">
          <Eye size={40} strokeWidth={1} />
          <p>{t("watchlist.empty", "暂无自选股，请添加股票代码")}</p>
        </div>
      )}

      {/* Quotes Table */}
      {stocks.length > 0 && (
        <>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={
                        selected.size === stocks.length && stocks.length > 0
                      }
                      onChange={() => {
                        if (selected.size === stocks.length) clearSelection();
                        else
                          stocks.forEach((s) => {
                            if (!selected.has(s.code)) toggleSelection(s.code);
                          });
                      }}
                      aria-label={t("watchlist.selectAll", "全选")}
                    />
                  </th>
                  <th className="px-3 py-2 text-left">
                    {t("watchlist.col.code", "代码")}
                  </th>
                  <th className="px-3 py-2 text-left">
                    {t("watchlist.col.name", "名称")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {t("watchlist.col.price", "最新价")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {t("watchlist.col.changeAmt", "涨跌额")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {t("watchlist.col.changePct", "涨跌幅")}
                  </th>
                  <th className="px-3 py-2 text-center">
                    {t("watchlist.col.actions", "操作")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((stock) => {
                  const q: QuoteData | undefined = quotes[stock.code];
                  const pct = q?.change_pct;
                  return (
                    <tr
                      key={stock.code}
                      className={`border-t hover:bg-muted/30 cursor-pointer ${selected.has(stock.code) ? "bg-muted/40" : ""}`}
                      onClick={() => toggleSelection(stock.code)}
                    >
                      <td
                        className="px-3 py-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(stock.code)}
                          onChange={() => toggleSelection(stock.code)}
                          aria-label={`${t("watchlist.select", "选择")} ${stock.code}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">{stock.code}</td>
                      <td className="px-3 py-2">
                        {q?.name ?? stock.name ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${changeColor(pct)}`}
                      >
                        {fmtPrice(q?.price)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${changeColor(pct)}`}
                      >
                        {fmtAmt(q?.change_amt)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${changeColor(pct)}`}
                      >
                        {fmtPct(pct)}
                      </td>
                      <td
                        className="px-3 py-2 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {confirmDelete === stock.code ? (
                          <span className="flex items-center gap-1 justify-center">
                            <button
                              onClick={() => handleDelete(stock.code)}
                              className="text-xs text-red-500 hover:underline"
                              data-testid={`confirm-delete-${stock.code}`}
                            >
                              {t("watchlist.confirmDelete", "确认删除")}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-xs text-muted-foreground hover:underline ml-1"
                            >
                              {t("watchlist.cancelDelete", "取消")}
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-center gap-2 justify-center">
                            <a
                              href={`https://stockpage.10jqka.com.cn/${stock.code}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground"
                              title={t("watchlist.kline", "同花顺 K 线")}
                              data-testid={`kline-${stock.code}`}
                            >
                              <CandlestickChart size={14} />
                            </a>
                            <button
                              onClick={() => handleDelete(stock.code)}
                              className="text-muted-foreground hover:text-red-500"
                              title={t("watchlist.delete", "删除")}
                              data-testid={`delete-${stock.code}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Send to Agent */}
          {selected.size > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleSendToAgent}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="send-to-agent"
              >
                <Send size={14} />
                {t("watchlist.sendToAgent", "发给 Agent 分析")}（{selected.size}
                ）
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
