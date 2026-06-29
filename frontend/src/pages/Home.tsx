import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle2,
  FileText,
  Gauge,
  LineChart,
  LockKeyhole,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export function Home() {
  const { t } = useTranslation();

  const WORKFLOWS = [
    { icon: Bot, title: t("home.workflowResearch"), desc: t("home.workflowResearchDesc") },
    { icon: BarChart3, title: t("home.workflowBacktest"), desc: t("home.workflowBacktestDesc") },
    { icon: FileText, title: t("home.workflowReports"), desc: t("home.workflowReportsDesc") },
  ];

  const CAPABILITIES = [
    t("home.capabilityAgentTeams"),
    t("home.capabilityPortfolio"),
    t("home.capabilityJournal"),
    t("home.capabilityResearch"),
  ];

  const QUEUE = [
    { label: t("home.queueStrategy"), meta: t("home.queueStrategyMeta"), tone: "text-primary" },
    { label: t("home.queueRisk"), meta: t("home.queueRiskMeta"), tone: "text-info" },
    { label: t("home.queueReport"), meta: t("home.queueReportMeta"), tone: "text-success" },
  ];

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10 lg:py-10">
        <section className="grid min-h-[520px] gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <div className="flex flex-col justify-between rounded-2xl border bg-card p-6 sm:p-8 lg:p-10">
            <div className="max-w-3xl space-y-7">
              <div className="inline-flex items-center gap-2 rounded-full border bg-muted/60 px-3 py-1 text-sm font-medium text-muted-foreground">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                {t("home.badge")}
              </div>

              <div className="space-y-4">
                <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                  {t("home.title")}
                </h1>
                <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                  {t("home.subtitle")}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  to="/agent"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <PlayCircle className="h-4 w-4" aria-hidden="true" />
                  {t("home.startResearch")}
                </Link>
                <Link
                  to="/reports"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border bg-background px-5 text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  {t("home.reviewReports")}
                </Link>
              </div>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {CAPABILITIES.map((capability) => (
                <div
                  key={capability}
                  className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <span>{capability}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4">
            <div className="rounded-2xl border bg-card p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{t("home.deskLabel")}</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight">{t("home.deskTitle")}</h2>
                </div>
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <LineChart className="h-5 w-5" aria-hidden="true" />
                </div>
              </div>

              <div className="mt-6 space-y-3">
                {QUEUE.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-4 rounded-lg border bg-background px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{item.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.meta}</p>
                    </div>
                    <Zap className={`h-4 w-4 shrink-0 ${item.tone}`} aria-hidden="true" />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <div className="rounded-2xl border bg-card p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
                  {t("home.safetyTitle")}
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("home.safetyDesc")}</p>
              </div>

              <div className="rounded-2xl border bg-card p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <LockKeyhole className="h-4 w-4 text-primary" aria-hidden="true" />
                  {t("home.mandateTitle")}
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("home.mandateDesc")}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {WORKFLOWS.map(({ icon: Icon, title, desc }) => (
            <article key={title} className="rounded-2xl border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-muted p-2 text-primary">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h2 className="text-base font-semibold text-foreground">{title}</h2>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">{desc}</p>
            </article>
          ))}
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">{t("home.statusTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("home.statusDesc")}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <Link
                to="/runtime"
                className="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Gauge className="h-4 w-4" aria-hidden="true" />
                {t("home.viewRuntime")}
              </Link>
              <Link
                to="/alpha-zoo"
                className="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {t("home.browseAlpha")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
