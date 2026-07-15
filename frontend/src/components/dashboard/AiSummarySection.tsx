import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { MarketSummaryResponse } from "@/lib/api";

export function AiSummarySection({
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
    <div className="rounded-lg border p-4 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("dashboard.aiSummary")}</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
          title={t("dashboard.refreshSummary")}
          aria-label={t("dashboard.refreshSummary")}
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
              <p className="text-xs font-medium text-muted-foreground mb-1">{t("dashboard.drivers")}</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.drivers.map((driver, index) => (
                  <li key={index} className="text-xs text-muted-foreground">{driver}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.summary.risks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">{t("dashboard.risks")}</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.risks.map((risk, index) => (
                  <li key={index} className="text-xs text-muted-foreground">{risk}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.summary.focus.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">{t("dashboard.focus")}</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {summary.summary.focus.map((focus, index) => (
                  <li key={index} className="text-xs text-muted-foreground">{focus}</li>
                ))}
              </ul>
            </div>
          )}
          {summary.stale && <p className="text-[10px] text-muted-foreground/60">{t("dashboard.staleData")}</p>}
        </div>
      )}

      {summary && !summary.available && (
        <p className="text-xs text-muted-foreground">{t("dashboard.summaryUnavailable")}</p>
      )}
      {error && summary && <p className="text-[10px] text-muted-foreground/60">{t("dashboard.staleData")}</p>}
    </div>
  );
}
