import { Bell, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/common/Skeleton";
import { useWatchlistFeed } from "@/hooks/useWatchlistFeed";
import type { FeedItem, FeedMatchedStock, WatchlistFeed } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";

function safeArticleUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function formatTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale);
}

function StockBadge({ stock }: { stock: FeedMatchedStock }) {
  return (
    <Link
      to="/watchlist"
      className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
    >
      {stock.code} {stock.name}
    </Link>
  );
}

function FeedRow({ item, locale }: { item: FeedItem; locale: string | undefined }) {
  const { t } = useTranslation();
  const url = item.url ? safeArticleUrl(item.url) : null;
  const timeText = formatTime(item.published_at, locale) || t("news.unknownTime");
  return (
    <article className="border-b border-border/60 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {item.type === "announcement" && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600">
            <Bell className="size-3" aria-hidden />
            {t("news.announcement")}
          </span>
        )}
        <span>{t(`news.sources.${item.source}`)}</span>
        <span aria-hidden>·</span>
        <time dateTime={item.published_at}>{timeText}</time>
      </div>
      <h3 className="mt-1 text-sm font-medium leading-6">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
            {item.title}
            <ExternalLink className="ml-1 inline size-3.5 text-muted-foreground" aria-hidden />
          </a>
        ) : (
          item.title
        )}
      </h3>
      {item.summary && <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>}
      {item.matched_stocks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.matched_stocks.map((stock) => (
            <StockBadge key={`${stock.code}-${stock.match_rule}`} stock={stock} />
          ))}
        </div>
      )}
    </article>
  );
}

function HealthHints({ feed }: { feed: WatchlistFeed }) {
  const { t } = useTranslation();
  const allFailed = feed.source_health.length > 0 && feed.source_health.every((health) => health.state === "failed");
  const degraded = feed.source_health.filter((health) => health.state === "degraded");
  return (
    <>
      {allFailed && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600" role="alert">
          <p className="font-medium">{t("news.delayedBanner")}</p>
          {feed.last_updated_at && (
            <p className="mt-0.5 text-xs">{t("news.lastUpdated", { time: formatTime(feed.last_updated_at, undefined) || t("news.unknownTime") })}</p>
          )}
        </div>
      )}
      {degraded.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {degraded.map((health) => t("news.sourceDegraded", { source: t(`news.sources.${health.source_id}`) })).join("；")}
        </p>
      )}
    </>
  );
}

export function News() {
  const { t, i18n } = useTranslation();
  const { feed, isLoading, isRefreshing, error, refresh, loadMore } = useWatchlistFeed();
  const locale = i18n.resolvedLanguage;
  const allFailed = (feed?.source_health.length ?? 0) > 0 && feed!.source_health.every((health) => health.state === "failed");
  const emptyNoWatchlist = feed !== null && feed.items.length === 0 && !allFailed && !error;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="News"
        title={t("news.title")}
        sub={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} aria-hidden />
            {isRefreshing ? t("news.refreshing") : t("news.refresh")}
          </button>
        }
      />
      <div className="space-y-2">
        {feed && <HealthHints feed={feed} />}
        {error && <p className="text-sm text-red-600">{t("news.error")}</p>}
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {emptyNoWatchlist && (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm font-medium">{t("news.emptyNoWatchlist")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("news.emptyNoWatchlistHint")}</p>
            <Link to="/watchlist" className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
              {t("news.goWatchlist")}
            </Link>
          </div>
        )}
        {feed && feed.items.length > 0 && (
          <>
            {feed.items.map((item) => (
              <FeedRow key={item.id} item={item} locale={locale} />
            ))}
            {feed.next_cursor && (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="w-full rounded-md border py-2 text-sm hover:bg-muted"
              >
                {t("news.loadMore")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default News;
