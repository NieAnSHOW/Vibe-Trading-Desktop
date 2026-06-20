import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, Newspaper, RefreshCw } from "lucide-react";
import { api, type FinanceNewsItem } from "@/lib/api";
import { cn } from "@/lib/utils";

export function News() {
  const [items, setItems] = useState<FinanceNewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNews = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const response = await api.listFinanceNews();
      setItems(response.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "财经资讯暂不可用");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadNews("initial");
  }, [loadNews]);

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <Newspaper className="h-3.5 w-3.5" aria-hidden="true" />
              AKTools stock_news_main_cx
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">财经精选</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              来自 AKTools API 的 AKShare 财经内容精选接口，按瀑布流排版快速扫读。
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadNews("refresh")}
            disabled={loading || refreshing}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新
          </button>
        </section>

        {loading ? <NewsSkeleton /> : null}

        {!loading && error ? (
          <section className="rounded-md border border-amber-500/30 bg-amber-500/5 p-5">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              财经资讯暂不可用
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => loadNews("refresh")}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              重试
            </button>
          </section>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <section className="rounded-md border border-dashed p-10 text-center">
            <Newspaper className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-3 font-medium">暂无财经精选资讯</h2>
            <p className="mt-1 text-sm text-muted-foreground">AKTools 当前没有返回可展示的内容。</p>
          </section>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <section data-testid="news-masonry" className="columns-1 gap-4 md:columns-2 xl:columns-3">
            {items.map((item, index) => (
              <NewsCard key={`${item.url}-${index}`} item={item} index={index} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function NewsSkeleton() {
  return (
    <div className="columns-1 gap-4 md:columns-2 xl:columns-3">
      {[120, 168, 136, 192, 148, 176].map((height, index) => (
        <div
          key={index}
          className="mb-4 break-inside-avoid rounded-md border bg-card p-4"
          style={{ minHeight: height }}
        >
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="mt-5 space-y-2">
            <div className="h-4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NewsCard({ item, index }: { item: FinanceNewsItem; index: number }) {
  return (
    <article
      className={cn(
        "mb-4 break-inside-avoid rounded-md border bg-card p-4 transition-colors hover:border-primary/50",
        index % 5 === 1 && "pt-6",
        index % 5 === 3 && "pb-6",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
          {item.tag || "财经"}
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 text-card-foreground">{item.summary}</p>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        阅读原文
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </article>
  );
}
