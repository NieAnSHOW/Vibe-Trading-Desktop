import i18n from '@/i18n';
import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { track } from "@/lib/telemetry";
import { CorrelationMatrix } from "@/components/charts/CorrelationMatrix";

const WINDOWS = [30, 60, 90, 180, 365] as const;

export function Correlation() {
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
      setError(e instanceof Error ? e.message : i18n.t("correlation.failedToCompute"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5">
      <header className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-primary" aria-hidden="true" />
        <h1 className="text-xl font-bold tracking-tight">
          {i18n.t("correlation.title")}
        </h1>
      </header>

      <div
        data-testid="correlation-workspace"
        className="grid min-w-0 min-h-0 flex-1 gap-3 lg:grid lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)] lg:gap-3"
      >
        <aside
          data-testid="correlation-controls"
          className="flex flex-col gap-4 rounded-lg border bg-card p-3 lg:min-h-0 lg:overflow-auto"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{i18n.t("correlation.assetCodes")}</label>
            <input
              type="text"
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
              placeholder="000001.SZ,600519.SH,000858.SZ"
              className="w-full px-3 py-2 rounded-md border bg-background text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {i18n.t("correlation.assetCodesHint")}
            </p>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{i18n.t("correlation.windowDays")}</label>
              <div
                data-testid="correlation-windows"
                className="flex flex-wrap gap-1.5"
              >
                {WINDOWS.map((w) => (
                  <button
                    key={w}
                    onClick={() => setDays(w)}
                    className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                      days === w
                        ? "bg-primary text-primary-foreground"
                        : "border-muted-foreground/30 hover:border-primary"
                    }`}
                  >
                    {w}d
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{i18n.t("correlation.method")}</label>
              <div
                data-testid="correlation-methods"
                className="flex flex-wrap gap-1.5"
              >
                {(["pearson", "spearman"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`px-3 py-1.5 rounded text-sm border transition-colors capitalize ${
                      method === m
                        ? "bg-primary text-primary-foreground"
                        : "border-muted-foreground/30 hover:border-primary"
                    }`}
                  >
                    {i18n.t(`correlation.method_${m}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={compute}
            disabled={loading}
            className="self-start px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? i18n.t("correlation.loading") : i18n.t("correlation.compute")}
          </button>
        </aside>

        <section
          data-testid="correlation-results"
          className="min-h-[20rem] rounded-lg border bg-card p-3 lg:min-h-0 lg:overflow-auto"
        >
          {error && (
            <div className="rounded border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              {error}
            </div>
          )}
          {labels.length > 0 && <CorrelationMatrix labels={labels} matrix={matrix} height={520} />}
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
