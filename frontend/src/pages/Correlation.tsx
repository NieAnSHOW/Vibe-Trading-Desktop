import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { track } from "@/lib/telemetry";
import { LayoutGrid, Loader2 } from "lucide-react";
import { CorrelationMatrix } from "@/components/charts/CorrelationMatrix";
import { PageHeader } from "@/components/common/PageHeader";

const WINDOWS = [30, 60, 90, 180, 365] as const;

export function Correlation() {
  const { t } = useTranslation();
  const [codes, setCodes] = useState("000001.SZ,600519.SH,000858.SZ,601318.SH");

  useEffect(() => {
    try { track("feature_use", {}, { name: "correlation_view" }); } catch {}
  }, []);
  const [days, setDays] = useState<number>(90);
  const [method, setMethod] = useState<"pearson" | "spearman">("pearson");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [labels, setLabels] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<number[][]>([]);

  const compute = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await request<{ labels: string[]; matrix: number[][] }>(
        `/correlation?codes=${encodeURIComponent(codes)}&days=${days}&method=${method}`
      );
      setLabels(result.labels);
      setMatrix(result.matrix);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("correlation.failedToCompute"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tw-page max-w-none flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      <PageHeader
        kicker="Research"
        title={t("correlation.title")}
        sub={t("correlation.subtitle")}
      />

      <div
        data-testid="correlation-workspace"
        className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]"
      >
        <aside
          data-testid="correlation-controls"
          className="tw-panel lg:min-h-0 lg:overflow-auto"
        >
          <header className="tw-panel-head">
            <h2 className="tw-panel-label">{t("correlation.controls")}</h2>
          </header>
          <div className="tw-panel-body space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                {t("correlation.assetCodes")}
              </span>
              <input
                type="text"
                value={codes}
                onChange={(e) => setCodes(e.target.value)}
                placeholder="000001.SZ,600519.SH,000858.SZ"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-primary/40"
              />
              <p className="text-xs text-muted-foreground">
                {t("correlation.assetCodesHint")}
              </p>
            </label>

            <div className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                {t("correlation.windowDays")}
              </span>
              <div
                data-testid="correlation-windows"
                className="flex flex-wrap gap-1.5"
              >
                {WINDOWS.map((w) => (
                  <button
                    key={w}
                    onClick={() => setDays(w)}
                    className={`h-9 rounded-md px-3 text-sm border transition-colors ${
                      days === w
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:border-primary"
                    }`}
                  >
                    {w}d
                  </button>
                ))}
              </div>
            </div>

            <div className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                {t("correlation.method")}
              </span>
              <div
                data-testid="correlation-methods"
                className="flex flex-wrap gap-1.5"
              >
                {(["pearson", "spearman"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`h-9 rounded-md px-3 text-sm border transition-colors ${
                      method === m
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:border-primary"
                    }`}
                  >
                    {t(`correlation.method_${m}`)}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={compute} disabled={loading} className="tw-btn-primary">
              {loading ? t("correlation.loading") : t("correlation.compute")}
            </button>
          </div>
        </aside>

        <section
          data-testid="correlation-results"
          className="tw-panel min-h-0 lg:overflow-auto"
        >
          <header className="tw-panel-head">
            <h2 className="tw-panel-label">{t("correlation.results")}</h2>
            {loading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : null}
          </header>
          <div className="tw-panel-body">
            {error ? (
              <div className="rounded-md border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
                {error}
              </div>
            ) : null}
            {!error && labels.length > 0 ? (
              <CorrelationMatrix labels={labels} matrix={matrix} height={520} />
            ) : null}
            {!error && labels.length === 0 && !loading ? (
              <div className="flex min-h-60 flex-col items-center justify-center rounded-md bg-muted p-4 text-center">
                <LayoutGrid className="h-8 w-8 text-muted-foreground" />
                <h3 className="mt-3 font-medium">{t("correlation.emptyTitle")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("correlation.emptyBody")}
                </p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

// Minimal request helper (avoids importing the full api client which may have path issues)
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const BASE = "";
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || body.message || detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}
