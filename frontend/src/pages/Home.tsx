import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, BarChart3, Zap, UserCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { track } from "@/lib/telemetry";
import { AiSummarySection } from "@/components/dashboard/AiSummarySection";
import { useMarketDashboardStore } from "@/stores/marketDashboard";

export function Home() {
  const { t } = useTranslation();
  const summary = useMarketDashboardStore((s) => s.summary);
  const summaryLoading = useMarketDashboardStore((s) => s.summaryLoading);
  const summaryError = useMarketDashboardStore((s) => s.summaryError);
  const initialize = useMarketDashboardStore((s) => s.initialize);
  const refreshSummary = useMarketDashboardStore((s) => s.refreshSummary);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const FEATURES = [
    { icon: Bot, title: t("home.featureAgent"), desc: t("home.featureAgentDesc") },
    { icon: BarChart3, title: t("home.featureBacktest"), desc: t("home.featureBacktestDesc") },
    { icon: Zap, title: t("home.featureStreaming"), desc: t("home.featureStreamingDesc") },
    { icon: UserCircle2, title: t("home.featureReplay"), desc: t("home.featureReplayDesc") },
  ];

  return (
    <div className="flex min-h-screen w-full flex-col items-center p-8">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">{t("home.title")}</h1>
        <p className="text-lg text-muted-foreground">{t("home.subtitle")}</p>
        <Link
          to="/agent"
          onClick={() => {
            try { track("feature_use", {}, { name: "home_start_research" }); } catch {}
          }}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition"
        >
          {t("home.startResearch")} <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-16 max-w-5xl w-full">
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="border rounded-lg p-6 space-y-3">
            <Icon className="h-8 w-8 text-primary" />
            <h3 className="font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>

      <section className="mt-10 w-full max-w-5xl" aria-label={t("dashboard.aiSummary")}>
        <AiSummarySection
          summary={summary}
          loading={summaryLoading}
          error={summaryError}
          onRefresh={() => void refreshSummary(true)}
        />
      </section>
    </div>
  );
}
