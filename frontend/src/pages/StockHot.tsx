import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Flame, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { api, type StockHotSection } from "@/lib/api";
import { cn } from "@/lib/utils";

export function StockHot() {
  const [sections, setSections] = useState<StockHotSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStockHot = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const response = await api.getStockHot();
      setSections(response.sections);
    } catch (err) {
      setSections([]);
      setError(err instanceof Error ? err.message : "股票热度暂不可用");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadStockHot("initial");
  }, [loadStockHot]);

  const groupedSections = useMemo(() => groupSections(sections), [sections]);

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <Flame className="h-3.5 w-3.5" aria-hidden="true" />
              AKTools stock hotness
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">股票热度</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              汇总 AKTools API 的 AKShare 股票热度相关接口，按来源和类型快速查看各榜单预览。
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadStockHot("refresh")}
            disabled={loading || refreshing}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新
          </button>
        </section>

        {loading ? <StockHotSkeleton /> : null}

        {!loading && error ? (
          <section className="rounded-md border border-amber-500/30 bg-amber-500/5 p-5">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              股票热度暂不可用
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => loadStockHot("refresh")}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              重试
            </button>
          </section>
        ) : null}

        {!loading && !error && sections.length === 0 ? (
          <section className="rounded-md border border-dashed p-10 text-center">
            <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-3 font-medium">暂无股票热度数据</h2>
            <p className="mt-1 text-sm text-muted-foreground">AKTools 当前没有返回可展示的股票热度内容。</p>
          </section>
        ) : null}

        {!loading && !error && groupedSections.length > 0 ? (
          <div className="space-y-8">
            {groupedSections.map(([category, items]) => (
              <section key={category} className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold tracking-tight">{category}</h2>
                  <span className="text-xs text-muted-foreground">{items.length} 个接口</span>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {items.map((section) => (
                    <StockHotCard key={section.id} section={section} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function groupSections(sections: StockHotSection[]): Array<[string, StockHotSection[]]> {
  const groups = new Map<string, StockHotSection[]>();
  for (const section of sections) {
    const group = groups.get(section.category) ?? [];
    group.push(section);
    groups.set(section.category, group);
  }
  return Array.from(groups.entries());
}

function StockHotSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="rounded-md border bg-card p-4">
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
          <div className="mt-4 space-y-2">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="h-7 animate-pulse rounded bg-muted" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StockHotCard({ section }: { section: StockHotSection }) {
  const visibleColumns = section.columns.slice(0, 6);
  const hasRows = section.rows.length > 0 && visibleColumns.length > 0;

  return (
    <article className="rounded-md border bg-card">
      <header className="flex flex-col gap-2 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{section.title}</h3>
          <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
            {section.source}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5">{section.function}</code>
          <span>{section.rows.length} 条预览</span>
        </div>
      </header>

      {section.error ? (
        <div className="p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            接口暂不可用
          </div>
          <p className="mt-2 break-words text-muted-foreground">{section.error}</p>
        </div>
      ) : null}

      {!section.error && !hasRows ? (
        <div className="p-4 text-sm text-muted-foreground">暂无可展示数据。</div>
      ) : null}

      {!section.error && hasRows ? (
        <div className="overflow-x-auto">
          <table aria-label={section.title} className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                {visibleColumns.map((column) => (
                  <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={cn("border-t", rowIndex % 2 === 1 && "bg-muted/25")}>
                  {visibleColumns.map((column) => (
                    <td key={column} className="max-w-48 truncate px-3 py-2" title={formatCell(row[column])}>
                      {formatCell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </article>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
