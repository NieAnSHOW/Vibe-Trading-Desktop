import { getConsent, setConsent, flushNow } from "@/lib/telemetry";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Database, KeyRound, Loader2, LogIn, Package, RotateCcw, Save, Server, ShieldCheck, SlidersHorizontal, Upload, Zap } from "lucide-react";
import { toast } from "sonner";
import { api, isAuthRequiredError, type DataSourceSettings, type LLMProviderOption, type LLMSettings } from "@/lib/api";
import { getApiAuthKey, setApiAuthKey } from "@/lib/apiAuth";
import { OptionalDepsManager } from "@/components/settings/OptionalDepsManager";
import { useAuthStore } from "@/stores/auth";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

interface LLMFormState {
  provider: string;
  model_name: string;
  base_url: string;
  temperature: number;
  timeout_seconds: number;
  max_retries: number;
  reasoning_effort: string;
}

const fieldClass =
  "w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const sectionCardClass = "rounded-xl border bg-card p-5";
const panelClass = "rounded-lg bg-muted/25 p-4";
const labelClass = "text-sm font-medium text-foreground";
const hintClass = "text-xs leading-5 text-muted-foreground";
const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70";

function toForm(settings: LLMSettings): LLMFormState {
  return {
    provider: settings.provider,
    model_name: settings.model_name,
    base_url: settings.base_url,
    temperature: settings.temperature,
    timeout_seconds: settings.timeout_seconds,
    max_retries: settings.max_retries,
    reasoning_effort: settings.reasoning_effort || "",
  };
}

function SectionHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
      )}
    >
      {children}
    </span>
  );
}

function UsageSwitch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 rounded-full transition",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [dataSettings, setDataSettings] = useState<DataSourceSettings | null>(null);
  const [form, setForm] = useState<LLMFormState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [localApiKey, setLocalApiKeyState] = useState(() => getApiAuthKey());
  const [clearApiKey, setClearApiKey] = useState(false);
  const [tushareToken, setTushareToken] = useState("");
  const [clearTushareToken, setClearTushareToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dataSaving, setDataSaving] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [usageDataOn, setUsageDataOn] = useState(getConsent());
  const [flushing, setFlushing] = useState(false);

  const toggleUsageData = async (on: boolean) => {
    setUsageDataOn(on);
    await setConsent(on);
    toast.success(on ? t("settings.usageData.on") : t("settings.usageData.off"));
  };

  const handleTestUpload = async () => {
    setFlushing(true);
    try {
      const { uploaded, retained } = await flushNow({ forceAll: true });
      if (uploaded > 0) {
        toast.success(t("settings.usageData.uploaded", { uploaded, retained }));
      } else if (retained > 0) {
        toast.error(t("settings.usageData.retained", { retained }));
      } else {
        toast.info(t("settings.usageData.noPending"));
      }
    } catch (error) {
      toast.error(t("settings.usageData.uploadFailed", { message: error instanceof Error ? error.message : t("common.unknown") }));
    } finally {
      setFlushing(false);
    }
  };

  const navigate = useNavigate();
  const authStatus = useAuthStore((s) => s.status);
  const userInfo = useAuthStore((s) => s.userInfo);
  const isAuthenticated = authStatus === "authenticated";

  useEffect(() => {
    let alive = true;
    Promise.all([api.getLLMSettings(), api.getDataSourceSettings()])
      .then(([llmData, dataSourceData]) => {
        if (!alive) return;
        setSettings(llmData);
        setForm(toForm(llmData));
        setDataSettings(dataSourceData);
        setSettingsLoadError(null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : t("common.unknown");
        setSettingsLoadError(message);
        if (isAuthRequiredError(error)) {
          toast.error(message);
        } else {
          toast.error(t("settings.loadLlmSettingsFailed", { message }));
          toast.error(t("settings.loadDataSourceSettingsFailed", { message }));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [t]);

  const providers = settings?.providers ?? [];
  const selectedProvider = useMemo<LLMProviderOption | undefined>(
    () => providers.find((provider) => provider.name === form?.provider),
    [form?.provider, providers],
  );

  const applyProviderDefaults = (provider = selectedProvider) => {
    if (!provider || !form) return;
    setForm({
      ...form,
      model_name: provider.default_model,
      base_url: provider.default_base_url,
    });
  };

  const onProviderChange = (name: string) => {
    const provider = providers.find((item) => item.name === name);
    if (!provider || !form) return;
    setForm({
      ...form,
      provider: provider.name,
      model_name: provider.default_model,
      base_url: provider.default_base_url,
    });
    setApiKey("");
    setClearApiKey(false);
  };

  const submitLocalApiKey = (event: FormEvent) => {
    event.preventDefault();
    setApiAuthKey(localApiKey);
    toast.success(t("settings.localApiKeySaved"));
    window.location.reload();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const updated = await api.updateLLMSettings({
        ...form,
        api_key: apiKey.trim() || undefined,
        clear_api_key: clearApiKey,
      });
      setSettings(updated);
      setForm(toForm(updated));
      setApiKey("");
      setClearApiKey(false);
      toast.success(t("settings.llmSettingsSaved"));
    } catch (error) {
      toast.error(t("settings.saveLlmSettingsFailed", { message: error instanceof Error ? error.message : t("common.unknown") }));
    } finally {
      setSaving(false);
    }
  };

  const submitDataSources = async (event: FormEvent) => {
    event.preventDefault();
    setDataSaving(true);
    try {
      const updated = await api.updateDataSourceSettings({
        tushare_token: tushareToken.trim() || undefined,
        clear_tushare_token: clearTushareToken,
      });
      setDataSettings(updated);
      setTushareToken("");
      setClearTushareToken(false);
      toast.success(t("settings.dataSourceSettingsSaved"));
    } catch (error) {
      toast.error(t("settings.saveDataSourceSettingsFailed", { message: error instanceof Error ? error.message : t("common.unknown") }));
    } finally {
      setDataSaving(false);
    }
  };

  const identityAccessSection = (
    <section className={sectionCardClass}>
      <SectionHeader
        icon={<KeyRound className="h-4 w-4" />}
        title={t("settings.identityAccess")}
        description={t("settings.identityAccessDesc")}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
        <form onSubmit={submitLocalApiKey} className={panelClass}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("settings.localApiAccess")}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("settings.localApiAccessCompactDesc")}
              </p>
            </div>
            <StatusBadge>{localApiKey ? t("settings.storedInBrowserBadge") : t("settings.optional")}</StatusBadge>
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-2">
              <span className={labelClass}>{t("settings.serverApiKey")}</span>
              <input
                type="password"
                value={localApiKey}
                onChange={(event) => setLocalApiKeyState(event.target.value)}
                className={fieldClass}
                placeholder={t("settings.clearBrowserKeyPlaceholder")}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className={cn(primaryButtonClass, "self-end")}>
              <Save className="h-4 w-4" />
              {t("settings.saveKey")}
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t("settings.localApiAccessReloadHint")}
          </p>
        </form>

        {isAuthenticated ? (
          <div className={panelClass}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success/10 text-success">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{t("settings.vipActive")}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t("settings.vipActiveDesc", { name: userInfo?.nickName ? `${userInfo.nickName}, ` : "" })}
                  </p>
                </div>
              </div>
              <StatusBadge tone="success">{t("settings.signedIn")}</StatusBadge>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-warning" />
              <span>{t("settings.maasEndpoint", { model: "deepseek-v4-flash" })}</span>
            </div>
          </div>
        ) : (
          <div className={panelClass}>
            <div className="mb-3 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">{t("settings.needFasterModelAccess")}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {t("settings.vipLoginDesc")}
                </p>
              </div>
            </div>
            <button type="button" onClick={() => navigate("/login")} className={primaryButtonClass}>
              <LogIn className="h-4 w-4" />
              {t("settings.goToLogin")}
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const usageDataSection = (
    <section className={sectionCardClass}>
      <SectionHeader
        icon={<Upload className="h-4 w-4" />}
        title={t("settings.usageData.title")}
        description={t("settings.usageData.description")}
        action={<UsageSwitch checked={usageDataOn} onChange={() => toggleUsageData(!usageDataOn)} label={t("settings.usageData.toggle")} />}
      />
      <button type="button" onClick={handleTestUpload} disabled={flushing} className={secondaryButtonClass}>
        {flushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {t("settings.usageData.testUpload")}
      </button>
    </section>
  );

  if (loading || !form || !settings || !dataSettings) {
    return (
      <div className="mx-auto max-w-6xl space-y-5 p-6 lg:p-8">
        <div className="border-b pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {t("settings.pageSubtitle")}
          </p>
        </div>
        {identityAccessSection}
        {usageDataSection}
        <div className="flex min-h-32 items-center justify-center rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          {settingsLoadError ? (
            <div className="text-center">
              <div className="font-medium text-foreground">{t("settings.unavailable")}</div>
              <div className="mt-1">{settingsLoadError}</div>
            </div>
          ) : (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.loadingSettings")}
            </>
          )}
        </div>
      </div>
    );
  }

  const keyStatus = settings.api_key_configured
    ? t("settings.configured")
    : settings.api_key_required
      ? t("settings.keepCurrentKey")
      : selectedProvider?.auth_type === "oauth" && selectedProvider.login_command
        ? t("settings.providerUsesOauth", { command: selectedProvider.login_command })
        : t("settings.noApiKeyRequired");
  const apiKeyDisabled = !selectedProvider?.api_key_required || clearApiKey;
  const tushareStatus = dataSettings.tushare_token_configured
    ? t("settings.configured")
    : t("settings.keepCurrentToken");

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6 lg:p-8">
      <div className="border-b pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {t("settings.pageSubtitle")}
        </p>
      </div>

      {identityAccessSection}

      {/* LLM Settings — 仅未登录时可见 */}
      {!isAuthenticated && (
        <section className={sectionCardClass}>
          <SectionHeader
            icon={<Server className="h-4 w-4" />}
            title={t("settings.llmBackend")}
            description={t("settings.llmBackendDesc")}
          />

          <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.85fr)]">
            <section className={panelClass}>
              <div className="mb-4 flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t("settings.connection")}</h3>
              </div>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.provider")}</span>
                  <select
                    value={form.provider}
                    onChange={(event) => onProviderChange(event.target.value)}
                    className={fieldClass}
                  >
                    {providers.map((provider) => (
                      <option key={provider.name} value={provider.name}>{provider.label}</option>
                    ))}
                  </select>
                  <span className={hintClass}>{t("settings.providerChangeHint")}</span>
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.model")}</span>
                  <div className="flex gap-2">
                    <input
                      value={form.model_name}
                      onChange={(event) => setForm({ ...form, model_name: event.target.value })}
                      className={fieldClass}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => applyProviderDefaults()}
                      className={cn(secondaryButtonClass, "shrink-0")}
                      title={t("settings.useProviderDefaults")}
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span className="hidden sm:inline">{t("settings.useProviderDefaults")}</span>
                    </button>
                  </div>
                  <span className={hintClass}>{t("settings.modelIdHint")}</span>
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.baseUrl")}</span>
                  <input
                    value={form.base_url}
                    onChange={(event) => setForm({ ...form, base_url: event.target.value })}
                    className={fieldClass}
                    placeholder={selectedProvider?.default_base_url}
                    disabled={selectedProvider?.auth_type === "oauth"}
                  />
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>
                    {selectedProvider?.auth_type === "oauth" ? "OAuth" : t("settings.apiKey")}
                  </span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      className={`${fieldClass} pl-9`}
                      placeholder={keyStatus}
                      autoComplete="current-password"
                      disabled={apiKeyDisabled}
                    />
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className={hintClass}>{keyStatus}</span>
                    {selectedProvider?.api_key_required ? (
                      <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearApiKey}
                          onChange={(event) => {
                            setClearApiKey(event.target.checked);
                            if (event.target.checked) setApiKey("");
                          }}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        {t("settings.clearApiKey")}
                      </label>
                    ) : null}
                  </div>
                </label>
              </div>
            </section>

            <section className={panelClass}>
              <div className="mb-4 flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t("settings.generation")}</h3>
              </div>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.temperature")}</span>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })}
                    className={fieldClass}
                  />
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.timeoutSeconds")}</span>
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    step={1}
                    value={form.timeout_seconds}
                    onChange={(event) => setForm({ ...form, timeout_seconds: Number(event.target.value) })}
                    className={fieldClass}
                  />
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.maxRetries")}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={1}
                    value={form.max_retries}
                    onChange={(event) => setForm({ ...form, max_retries: Number(event.target.value) })}
                    className={fieldClass}
                  />
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{t("settings.reasoningEffort")}</span>
                  <select
                    value={form.reasoning_effort}
                    onChange={(event) => setForm({ ...form, reasoning_effort: event.target.value })}
                    className={fieldClass}
                  >
                    <option value="">{t("settings.off")}</option>
                    <option value="low">{t("settings.reasoningEffortLow")}</option>
                    <option value="medium">{t("settings.reasoningEffortMedium")}</option>
                    <option value="high">{t("settings.reasoningEffortHigh")}</option>
                    <option value="max">{t("settings.reasoningEffortMax")}</option>
                  </select>
                  <span className={hintClass}>{t("settings.reasoningEffortDesc")}</span>
                </label>

                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t("settings.saved")}: </span>
                  <span className="break-all font-mono">{settings.env_path}</span>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className={primaryButtonClass}
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? t("settings.saving") : t("settings.save")}
                </button>
              </div>
            </section>
          </form>
        </section>
      )}

      <form onSubmit={submitDataSources} className={sectionCardClass}>
        <SectionHeader
          icon={<Database className="h-4 w-4" />}
          title={t("settings.marketData")}
          description={t("settings.dataSourceSettingsDesc")}
        />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
          <div className={cn(panelClass, "grid gap-4")}>
            <label className="grid gap-2">
              <span className={labelClass}>{t("settings.tushareToken")}</span>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="password"
                  value={tushareToken}
                  onChange={(event) => setTushareToken(event.target.value)}
                  className={`${fieldClass} pl-9`}
                  placeholder={tushareStatus}
                  autoComplete="current-password"
                  disabled={clearTushareToken}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className={hintClass}>{t("settings.tushareDataHint")}</span>
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={clearTushareToken}
                    onChange={(event) => {
                      setClearTushareToken(event.target.checked);
                      if (event.target.checked) setTushareToken("");
                    }}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t("settings.clearTushareToken")}
                </label>
              </div>
            </label>

            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t("settings.saved")}: </span>
              <span className="break-all font-mono">{dataSettings.env_path}</span>
            </div>

            <button
              type="submit"
              disabled={dataSaving}
              className={primaryButtonClass}
            >
              {dataSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {dataSaving ? t("settings.saving") : t("settings.saveDataSourceSettings")}
            </button>
          </div>

          <div className={panelClass}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{t("settings.baostock")}</span>
              <StatusBadge tone={dataSettings.baostock_supported ? "success" : "warning"}>
                {dataSettings.baostock_supported ? t("settings.loaderAvailable") : t("settings.noProjectLoader")}
              </StatusBadge>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{dataSettings.baostock_message}</p>
              <p>
                {dataSettings.baostock_installed
                  ? t("settings.pythonPackageInstalled")
                  : t("settings.pythonPackageNotInstalled")}
              </p>
            </div>
          </div>
        </div>
      </form>

      {/* Desktop: optional broker SDK management */}
      <section className={sectionCardClass}>
        <SectionHeader
          icon={<Package className="h-4 w-4" />}
          title={t("settings.optionalBrokerDependencies")}
          description={t("settings.optionalBrokerDependenciesDesc")}
        />
        <OptionalDepsManager />
      </section>

      {usageDataSection}
    </div>
  );
}
