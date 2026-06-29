import { useTranslation } from "react-i18next";
import { useEffect, useState, useRef } from "react";
import { Link, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { track } from "@/lib/telemetry";
import {
  Activity,
  BarChart3,
  Bot,
  FileText,
  Languages,
  Moon,
  Sun,
  Plus,
  Trash2,
  Pencil,
  MessageSquare,
  ChevronsLeft,
  ChevronsRight,
  Settings,
  Layers,
  Loader2,
  ExternalLink,
  RefreshCw,
  X,
  Globe2,
  LineChart,
  Newspaper,
  Search,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDarkMode } from "@/hooks/useDarkMode";
import { UserMenu } from "@/components/layout/UserMenu";
import { api, type SessionItem } from "@/lib/api";
import { useAgentStore } from "@/stores/agent";
import { ConnectionBanner } from "@/components/layout/ConnectionBanner";

// Bump on each release; one place keeps the footer in sync with package.json.
const APP_VERSION = "v0.1.10";
const WEB_UI_TAB_ID = "web-ui";
const SHORTCUTS_TAB_ID = "shortcuts";

type FixedTabId = typeof WEB_UI_TAB_ID | typeof SHORTCUTS_TAB_ID;
type ActiveTabId = FixedTabId | `external-${string}`;

type ExternalShortcut = {
  id: string;
  labelKey: string;
  url: string;
  descriptionKey: string;
  icon: LucideIcon;
};

type ExternalTab = ExternalShortcut & {
  tabId: `external-${string}`;
  reloadKey: number;
};

const EXTERNAL_SHORTCUTS: ExternalShortcut[] = [
  {
    id: "tonghuashun",
    labelKey: "layout.externalShortcuts.sites.tonghuashun.label",
    url: "https://www.10jqka.com.cn/",
    descriptionKey: "layout.externalShortcuts.sites.tonghuashun.description",
    icon: LineChart,
  },
  {
    id: "tencent-finance",
    labelKey: "layout.externalShortcuts.sites.tencentFinance.label",
    url: "https://stockapp.finance.qq.com/",
    descriptionKey: "layout.externalShortcuts.sites.tencentFinance.description",
    icon: Newspaper,
  },
  {
    id: "eastmoney",
    labelKey: "layout.externalShortcuts.sites.eastmoney.label",
    url: "https://www.eastmoney.com/",
    descriptionKey: "layout.externalShortcuts.sites.eastmoney.description",
    icon: Search,
  },
  {
    id: "sina-finance",
    labelKey: "layout.externalShortcuts.sites.sinaFinance.label",
    url: "https://finance.sina.com.cn/",
    descriptionKey: "layout.externalShortcuts.sites.sinaFinance.description",
    icon: Globe2,
  },
];

export function Layout() {
  const { t, i18n: i18nHook } = useTranslation();

  const NAV = [
    { to: "/", icon: BarChart3, label: t("layout.home") },
    { to: "/agent", icon: Bot, label: t("layout.agent") },
    { to: "/runtime", icon: Activity, label: t("layout.runtime") },
    { to: "/reports", icon: FileText, label: t("layout.reports") },
    { to: "/alpha-zoo", icon: Layers, label: t("layout.alphaZoo") },
    { to: "/settings", icon: Settings, label: t("layout.settings") },
    { to: "/correlation", icon: BarChart3, label: t("layout.correlation") },
  ];
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  // ── telemetry: session_start, page_view, session_end ──
  const startedAtRef = useRef(Date.now());
  useEffect(() => {
    try { track("session_start", {}); } catch {}
    const onHide = () => {
      try { track("session_end", { duration_ms: Date.now() - startedAtRef.current }); } catch {}
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  useEffect(() => {
    try { track("page_view", { route: pathname }); } catch {}
  }, [pathname]);
  const { dark, toggle } = useDarkMode();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const sseStatus = useAgentStore((s) => s.sseStatus);
  const sseRetryAttempt = useAgentStore((s) => s.sseRetryAttempt);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("qa-sidebar") === "collapsed"
  );
  const [isNarrowScreen, setIsNarrowScreen] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabId>(WEB_UI_TAB_ID);
  const [externalTabs, setExternalTabs] = useState<ExternalTab[]>([]);

  const activeSessionId = searchParams.get("session");
  const streamingSessionId = useAgentStore((s) => s.streamingSessionId);

  useEffect(() => {
    localStorage.setItem("qa-sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const syncNarrowScreen = () => setIsNarrowScreen(mediaQuery.matches);
    syncNarrowScreen();
    mediaQuery.addEventListener("change", syncNarrowScreen);
    return () => mediaQuery.removeEventListener("change", syncNarrowScreen);
  }, []);

  const loadSessions = () => {
    api
      .listSessions()
      .then((list) => setSessions(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  };

  // Load sessions on mount. Also refresh when navigating TO /agent or when
  // the active session changes (covers new session creation from Agent).
  const isAgentPage = pathname.startsWith("/agent");
  useEffect(() => {
    loadSessions();
  }, [isAgentPage, activeSessionId]);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const deleteSession = async (sid: string) => {
    try {
      await api.deleteSession(sid);
      setSessions((prev) => prev.filter((s) => s.session_id !== sid));
    } catch {
      /* ignore */
    }
    setDeleteTarget(null);
  };

  const renameSession = async (sid: string) => {
    if (!renameValue.trim()) {
      setRenameTarget(null);
      return;
    }
    try {
      await api.renameSession(sid, renameValue.trim());
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === sid ? { ...s, title: renameValue.trim() } : s
        )
      );
    } catch {
      /* ignore */
    }
    setRenameTarget(null);
  };

  const openShortcut = (shortcut: ExternalShortcut) => {
    const tabId = `external-${shortcut.id}` as const;
    setExternalTabs((prev) =>
      prev.some((tab) => tab.tabId === tabId)
        ? prev
        : [...prev, { ...shortcut, tabId, reloadKey: 0 }]
    );
    setActiveTab(tabId);
  };

  const refreshExternalTab = (tabId: ExternalTab["tabId"]) => {
    setExternalTabs((prev) =>
      prev.map((tab) =>
        tab.tabId === tabId ? { ...tab, reloadKey: tab.reloadKey + 1 } : tab
      )
    );
  };

  const closeExternalTab = (tabId: ExternalTab["tabId"]) => {
    setExternalTabs((prev) => prev.filter((tab) => tab.tabId !== tabId));
    if (activeTab === tabId) {
      setActiveTab(SHORTCUTS_TAB_ID);
    }
  };

  const openExternalUrl = async (url: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external_url", { url });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const fixedTabs: Array<{ id: FixedTabId; label: string; icon: LucideIcon }> =
    [
      {
        id: WEB_UI_TAB_ID,
        label: t("layout.desktopTabs.webUi"),
        icon: BarChart3,
      },
      {
        id: SHORTCUTS_TAB_ID,
        label: t("layout.desktopTabs.shortcuts"),
        icon: Globe2,
      },
    ];
  const sidebarCollapsed = collapsed || isNarrowScreen;

  const webUiPanel = (
    <div
      data-testid="web-ui-shell"
      className="flex h-full w-full min-h-0 min-w-0 bg-background"
    >
      {/* Sidebar */}
      <aside
        data-testid="web-ui-sidebar"
        className={cn(
          "border-r bg-card flex flex-col shrink-0 transition-all duration-200",
          sidebarCollapsed ? "w-12" : "w-64"
        )}
      >
        {/* Nav */}
        <nav className={cn("space-y-0.5", sidebarCollapsed ? "p-1" : "p-2")}>
          {NAV.map(({ to, icon: Icon, label }) => {
            const text = label;
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "flex items-center rounded-md text-sm transition-colors",
                  sidebarCollapsed ? "justify-center p-2" : "gap-3 px-3 py-2",
                  (to === "/" ? pathname === "/" : pathname.startsWith(to))
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                title={sidebarCollapsed ? text : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!sidebarCollapsed && text}
              </Link>
            );
          })}
          <a
            href="https://agent.nieanshow.cn/column/04-ai-trading/"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center rounded-md text-sm transition-colors text-muted-foreground hover:bg-muted hover:text-foreground",
              sidebarCollapsed ? "justify-center p-2" : "gap-3 px-3 py-2"
            )}
            title={sidebarCollapsed ? t("layout.docs") : undefined}
          >
            <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            {!sidebarCollapsed && t("layout.docs")}
          </a>
        </nav>

        {/* Sessions — hidden when collapsed */}
        {!sidebarCollapsed && (
          <div className="flex-1 overflow-auto border-t mt-2 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                {t('layout.sessions')}
              </span>
              <Link
                to="/agent"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                title={t("layout.newChat")}
              >
                <Plus className="h-3.5 w-3.5" />
              </Link>
            </div>

            <div className="px-2 pb-2 space-y-0.5 overflow-auto flex-1">
              {sessionsLoading ? (
                <div className="space-y-1.5 px-2 py-1">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-7 rounded-md bg-muted/50 animate-pulse"
                    />
                  ))}
                </div>
              ) : sessions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground/60">
                  {t("layout.noSessions")}
                </p>
              ) : null}
              {sessions.map((s) => {
                const isActive = s.session_id === activeSessionId;
                const isDeleting = deleteTarget === s.session_id;
                const isRenaming = renameTarget === s.session_id;
                return (
                  <div
                    key={s.session_id}
                    className="group relative flex items-center"
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameSession(s.session_id);
                          if (e.key === "Escape") setRenameTarget(null);
                        }}
                        onBlur={() => renameSession(s.session_id)}
                        className="flex-1 min-w-0 pl-3 pr-2 py-1 rounded-md text-xs border border-primary bg-background outline-none"
                      />
                    ) : (
                      <Link
                        to={`/agent?session=${s.session_id}`}
                        className={cn(
                          "flex-1 min-w-0 pl-3 pr-14 py-1.5 rounded-md text-xs transition-colors truncate block border-l-2",
                          isActive
                            ? "border-l-primary bg-primary/10 text-primary font-medium"
                            : "border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                        title={s.title || s.session_id}
                      >
                        <span className="flex items-center gap-1.5">
                          {streamingSessionId === s.session_id ? (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                          ) : (
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full shrink-0",
                                isActive
                                  ? "bg-primary/70"
                                  : "bg-muted-foreground/40"
                              )}
                            />
                          )}
                          {s.title || s.session_id.slice(0, 16)}
                        </span>
                      </Link>
                    )}
                    {!isRenaming && isDeleting ? (
                      <div className="absolute right-0.5 flex items-center gap-0.5">
                        <button
                          onClick={() => deleteSession(s.session_id)}
                          className="p-1 text-danger hover:bg-danger/10 rounded text-[10px] font-medium"
                        >
                          {t("layout.confirm")}
                        </button>
                        <button
                          onClick={() => setDeleteTarget(null)}
                          className="p-1 text-muted-foreground hover:bg-muted rounded text-[10px]"
                        >
                          {t("layout.cancel")}
                        </button>
                      </div>
                    ) : !isRenaming ? (
                      <div className="absolute right-1 opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setRenameTarget(s.session_id);
                            setRenameValue(s.title || "");
                          }}
                          className="p-1 text-muted-foreground hover:text-foreground rounded"
                          title={t("layout.rename")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleteTarget(s.session_id);
                          }}
                          className="p-1 text-muted-foreground hover:text-danger rounded"
                          title={t("layout.delete")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Spacer when collapsed */}
        {sidebarCollapsed && <div className="flex-1" />}

        {/* Footer */}
        <div
          className={cn(
            "border-t",
            sidebarCollapsed ? "p-1 flex flex-col items-center gap-1" : "p-3 space-y-2"
          )}
        >
          {sidebarCollapsed ? (
            <>
              <button
                onClick={toggle}
                className="p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
                title={dark ? t("layout.light") : t("layout.dark")}
              >
                {dark ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </button>
              {!isNarrowScreen && (
                <button
                  onClick={() => setCollapsed(false)}
                  className="p-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
                  title={t("layout.expand")}
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  onClick={toggle}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                  {dark ? t("layout.light") : t("layout.dark")}
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setCollapsed(true)}
                    className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                    title={t("layout.collapse")}
                  >
                    <ChevronsLeft className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    i18nHook.changeLanguage(
                      i18nHook.language === "zh-CN" ? "en" : "zh-CN"
                    );
                  }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Languages className="h-3.5 w-3.5" />
                  {i18nHook.language === "zh-CN" ? "English" : "中文"}
                </button>
                <p className="text-xs text-muted-foreground/60">
                  {APP_VERSION}
                </p>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Main */}
      <div
        data-testid="web-ui-main"
        className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden"
      >
        <ConnectionBanner status={sseStatus} retryAttempt={sseRetryAttempt} />
        <main
          data-testid="web-ui-outlet"
          className="flex-1 min-h-0 min-w-0 overflow-auto"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-11 shrink-0 items-end gap-1 border-b bg-card px-2 pt-1">
        <div
          role="tablist"
          aria-label="Desktop tabs"
          className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto"
        >
          {fixedTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-t-md border px-3 text-sm transition-colors",
                activeTab === id
                  ? "border-b-background bg-background text-foreground font-medium"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
          {externalTabs.map((tab) => {
            const Icon = tab.icon;
            const label = t(tab.labelKey);
            return (
              <div
                key={tab.tabId}
                className={cn(
                  "group flex h-9 max-w-56 shrink-0 items-center rounded-t-md border text-sm transition-colors",
                  activeTab === tab.tabId
                    ? "border-b-background bg-background text-foreground font-medium"
                    : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.tabId}
                  onClick={() => setActiveTab(tab.tabId)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("layout.externalShortcuts.close", { label })}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeExternalTab(tab.tabId);
                  }}
                  className="mr-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center pl-2">
          <UserMenu />
        </div>
      </header>

      <section
        data-testid="web-ui-tab-panel"
        className={cn(
          activeTab === WEB_UI_TAB_ID ? "flex" : "hidden",
          "h-full w-full min-h-0 min-w-0 flex-1"
        )}
      >
        {webUiPanel}
      </section>

      <section
        data-testid="shortcuts-tab-panel"
        className={cn(
          activeTab === SHORTCUTS_TAB_ID ? "flex" : "hidden",
          "h-full w-full min-h-0 min-w-0 flex-1 overflow-auto bg-background"
        )}
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {t("layout.externalShortcuts.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("layout.externalShortcuts.description")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {EXTERNAL_SHORTCUTS.map((shortcut) => {
              const Icon = shortcut.icon;
              const label = t(shortcut.labelKey);
              const description = t(shortcut.descriptionKey);
              return (
                <button
                  key={shortcut.id}
                  type="button"
                  onClick={() => openShortcut(shortcut)}
                  className="flex min-h-36 flex-col items-start gap-3 rounded-md border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
                  aria-label={t("layout.externalShortcuts.open", { label })}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {externalTabs.map((tab) => {
        const isActive = activeTab === tab.tabId;
        const label = t(tab.labelKey);
        return (
          <section
            key={tab.tabId}
            data-testid={`external-tab-panel-${tab.id}`}
            className={cn(
              isActive ? "flex" : "hidden",
              "h-full w-full min-h-0 min-w-0 flex-1 bg-background"
            )}
          >
            <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-3">
                <button
                  type="button"
                  onClick={() => refreshExternalTab(tab.tabId)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={t("layout.externalShortcuts.refresh", { label })}
                  aria-label={t("layout.externalShortcuts.refresh", { label })}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </button>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground">
                  <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{tab.url}</span>
                </div>
                <button
                  type="button"
                  onClick={() => openExternalUrl(tab.url)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("layout.externalShortcuts.openExternally")}
                </button>
              </div>
              <div className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t("layout.externalShortcuts.embeddedHint")}
              </div>
              <iframe
                key={`${tab.tabId}-${tab.reloadKey}`}
                title={label}
                src={tab.url}
                className="min-h-0 flex-1 border-0 bg-background"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
