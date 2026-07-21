import {
  AlertCircle,
  Clock3,
  ExternalLink,
  Newspaper,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/common/Skeleton";
import { useNews } from "@/hooks/useNews";
import type { NewsArticle, NewsPublicError, NewsTrackId } from "@/lib/api";
import { cn } from "@/lib/utils";

const TRACK_IDS: NewsTrackId[] = [
  "ai",
  "semi",
  "robot",
  "auto",
  "energy",
  "bio",
  "space",
  "security",
  "tech",
  "consumer",
  "macro",
  "science",
];

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

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }
  return null;
}

function publicErrorMessage(error: NewsPublicError | null | undefined): string | null {
  return error?.message ?? null;
}

function ArticleRow({ article }: { article: NewsArticle }) {
  const { t, i18n } = useTranslation();
  const url = safeArticleUrl(article.url);
  const title = article.title_zh || article.title;

  return (
    <article
      data-testid={article.id}
      className="min-w-0 border-t border-border/70 py-5 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">
            {title}
          </h3>
          <p className="mt-2 break-words text-sm leading-6 text-muted-foreground [text-wrap:pretty]">
            {article.summary ?? t("news.noSummary")}
          </p>
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium text-primary transition-colors hover:text-primary/75 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("news.viewOriginal")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{article.source.name}</span>
        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-border" />
        {article.published_at ? (
          <time dateTime={article.published_at}>
            {new Date(article.published_at).toLocaleString(i18n.resolvedLanguage)}
          </time>
        ) : (
          <span>{t("news.unknownTime")}</span>
        )}
      </div>
    </article>
  );
}

function NewsLoadingSkeleton() {
  return (
    <div data-testid="news-loading-skeleton" className="min-w-0 py-6" aria-hidden="true">
      <div className="rounded-lg border bg-muted/30 px-4 py-4 sm:px-5">
        <Skeleton className="h-4 w-24" />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-11/12" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      </div>
      <div className="mt-6 space-y-0">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="border-t border-border/70 py-5 first:border-t-0 first:pt-0"
          >
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/5" />
            <Skeleton className="mt-4 h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function News() {
  const { t, i18n } = useTranslation();
  const {
    snapshot,
    stale,
    snapshotError,
    refreshStatus,
    selectedTrackId,
    isLoading,
    isRefreshing,
    error,
    selectTrack,
    refreshNews,
  } = useNews();

  const selectedTrack = snapshot?.tracks.find(
    (track) => track.track_id === selectedTrackId,
  ) ?? null;
  const requestError = errorMessage(error);
  const statusError = publicErrorMessage(refreshStatus?.error);
  const envelopeError = publicErrorMessage(snapshotError);
  const visibleError = requestError ?? statusError ?? envelopeError;
  const refreshLabel = t("news.refresh");
  const activeTrackId = selectedTrackId ?? TRACK_IDS[0];

  const handleTrackKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    trackId: NewsTrackId,
  ) => {
    const currentIndex = TRACK_IDS.indexOf(trackId);
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % TRACK_IDS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + TRACK_IDS.length) % TRACK_IDS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TRACK_IDS.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextTrackId = TRACK_IDS[nextIndex];
    selectTrack(nextTrackId);
    document.getElementById(`news-tab-${nextTrackId}`)?.focus();
  };

  return (
    <div
      data-testid="news-workspace"
      className="mx-auto flex min-h-full w-full min-w-0 max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8"
    >
      <header className="flex min-w-0 items-start justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Newspaper className="h-5 w-5" />
          </div>
          <div className="min-w-0 pt-0.5">
            <h1 className="break-words text-xl font-semibold leading-6 sm:text-2xl">
              {t("news.title")}
            </h1>
            {snapshot && (
              <time
                dateTime={snapshot.generated_at}
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                {new Date(snapshot.generated_at).toLocaleString(i18n.resolvedLanguage)}
              </time>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={refreshLabel}
          title={refreshLabel}
          disabled={isRefreshing}
          onClick={() => void refreshNews()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      </header>

      <div data-testid="news-desktop-tracks" className="hidden border-b border-border md:block">
        <div
          role="tablist"
          aria-label={t("news.trackList")}
          className="h-11 overflow-x-auto overscroll-x-contain"
        >
          <div className="flex h-full min-w-max items-stretch gap-1">
            {TRACK_IDS.map((trackId) => (
              <button
                key={trackId}
                id={`news-tab-${trackId}`}
                type="button"
                role="tab"
                aria-selected={activeTrackId === trackId}
                aria-controls={`news-panel-${trackId}`}
                tabIndex={activeTrackId === trackId ? 0 : -1}
                onClick={() => selectTrack(trackId)}
                onKeyDown={(event) => handleTrackKeyDown(event, trackId)}
                className={cn(
                  "relative h-full shrink-0 px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
                  activeTrackId === trackId
                    ? "font-medium text-primary after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
              >
                {t(`news.tracks.${trackId}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div data-testid="news-mobile-tracks" className="border-b border-border py-3 md:hidden">
        <label htmlFor="news-track-select" className="sr-only">
          {t("news.selectTrack")}
        </label>
        <select
          id="news-track-select"
          aria-label={t("news.selectTrack")}
          value={selectedTrackId ?? ""}
          onChange={(event) => selectTrack(event.target.value as NewsTrackId)}
          className="h-10 w-full min-w-0 rounded-md border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {TRACK_IDS.map((trackId) => (
            <option key={trackId} value={trackId}>
              {t(`news.tracks.${trackId}`)}
            </option>
          ))}
        </select>
      </div>

      {isRefreshing && refreshStatus && (
        <div
          role="status"
          className="border-b border-border py-3 text-sm text-muted-foreground"
        >
          {t("news.refreshProgress", {
            processedEndpoints: refreshStatus.processed_endpoints,
            totalEndpoints: refreshStatus.total_endpoints,
            processedTracks: refreshStatus.processed_tracks,
            totalTracks: refreshStatus.total_tracks,
          })}
        </div>
      )}

      {visibleError && (
        <div
          role="alert"
          className="flex min-w-0 items-start gap-2 border-b border-danger/30 py-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium">{t("news.error")}</p>
            <p className="break-words text-xs opacity-80">{visibleError}</p>
          </div>
        </div>
      )}

      {TRACK_IDS.filter((trackId) => trackId !== activeTrackId).map((trackId) => (
        <div
          key={trackId}
          id={`news-panel-${trackId}`}
          role="tabpanel"
          aria-labelledby={`news-tab-${trackId}`}
          hidden
        />
      ))}
      <div
        id={`news-panel-${activeTrackId}`}
        role="tabpanel"
        aria-labelledby={`news-tab-${activeTrackId}`}
        className="flex min-w-0 flex-1 flex-col"
      >
        {isLoading && !snapshot ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="sr-only" role="status">
              {t("news.loading")}
            </p>
            <NewsLoadingSkeleton />
          </div>
        ) : !snapshot ? (
          <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
            {t("news.emptySnapshot")}
          </div>
        ) : selectedTrack ? (
          <div className="min-w-0 py-6">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-4">
              {selectedTrack.state === "unavailable" ? (
                <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {t("news.unavailable")}
                </span>
              ) : stale || selectedTrack.stale ? (
                <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                  {t("news.stale")}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  {t("news.fresh")}
                </span>
              )}
              {selectedTrack.partial && (
                <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                  {t("news.partial")}
                </span>
              )}
            </div>

            <section
              aria-labelledby="news-ai-heading"
              className="mt-5 rounded-lg border bg-muted/30 px-4 py-4 sm:px-5"
            >
              <div className="flex items-center gap-2">
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                  aria-hidden="true"
                >
                  <Sparkles className="h-4 w-4" />
                </div>
                <h2 id="news-ai-heading" className="text-sm font-semibold">
                  {t("news.ai")}
                </h2>
              </div>
              {selectedTrack.ai.available && selectedTrack.ai.highlights.length > 0 ? (
                <ul
                  aria-label={t("news.ai")}
                  className="mt-3 grid min-w-0 gap-x-6 gap-y-2 text-sm leading-6 lg:grid-cols-2"
                >
                  {selectedTrack.ai.highlights.slice(0, 5).map((highlight, index) => (
                    <li key={`${index}-${highlight}`} className="flex min-w-0 items-start gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{highlight}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("news.aiUnavailable")}
                </p>
              )}
            </section>

            {selectedTrack.items.length > 0 ? (
              <section aria-label={t("news.articleList")} className="min-w-0 pt-6">
                {selectedTrack.items.map((item) => (
                  <ArticleRow key={item.id} article={item} />
                ))}
              </section>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("news.emptyTrack")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
            {t("news.emptySnapshot")}
          </div>
        )}
      </div>
    </div>
  );
}

export default News;
