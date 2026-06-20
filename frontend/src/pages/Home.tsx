import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, MessageSquare, FlaskConical, LineChart, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

const WORKFLOW_STEPS = [
  { icon: MessageSquare, titleKey: "home.featureAgent", descKey: "home.featureAgentDesc" },
  { icon: FlaskConical, titleKey: "home.featureBacktest", descKey: "home.featureBacktestDesc" },
  { icon: LineChart, titleKey: "home.featureStreaming", descKey: "home.featureStreamingDesc" },
  { icon: Zap, titleKey: "home.featureReplay", descKey: "home.featureReplayDesc" },
] as const;

const METRICS = [
  { valueKey: "home.metricMarketsValue", labelKey: "home.metricMarketsLabel" },
  { valueKey: "home.metricSourcesValue", labelKey: "home.metricSourcesLabel" },
  { valueKey: "home.metricIndicatorsValue", labelKey: "home.metricIndicatorsLabel" },
] as const;

export function Home() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Hero ────────────────────────────────────────── */}
      <section className="flex flex-1 items-center px-8 lg:px-16">
        <div className="max-w-2xl space-y-8">
          <h1 className="text-4xl lg:text-5xl font-bold tracking-tight leading-tight">
            {t("home.title")}
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
            {t("home.subtitle")}
          </p>
          <div className="flex items-center gap-3">
            <Link
              to="/agent"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition"
            >
              {t("home.startResearch")} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/runtime"
              className="inline-flex items-center gap-1.5 px-5 py-3 rounded-md border border-border text-sm font-medium text-foreground hover:bg-accent transition"
            >
              {t("home.viewRuntime")} <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Metrics ─────────────────────────────────────── */}
      <section className="px-8 lg:px-16 pb-10">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-6">
          {t("home.capabilityLabel")}
        </p>
        <div className="flex flex-wrap gap-x-12 gap-y-4">
          {METRICS.map((m) => (
            <div key={m.labelKey} className="flex items-baseline gap-2">
              <span className="text-3xl lg:text-4xl font-semibold tabular-nums tracking-tight">
                {t(m.valueKey)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t(m.labelKey)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Workflow strip ──────────────────────────────── */}
      <section className="px-8 lg:px-16 pb-16">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-6">
          {t("home.workflowLabel")}
        </p>
        <div className="flex flex-col sm:flex-row gap-0 divide-y sm:divide-y-0 sm:divide-x divide-border border rounded-md">
          {WORKFLOW_STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.titleKey} className="flex-1 px-5 py-4 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <Icon className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">{t(step.titleKey)}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed pl-[28px]">
                  {t(step.descKey)}
                </p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
