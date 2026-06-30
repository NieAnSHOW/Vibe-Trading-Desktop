import { getConsent, setConsent, flushNow } from "@/lib/telemetry";
import i18n from "@/i18n";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Database, KeyRound, Loader2, LogIn, MessageSquareMore, Package, Play, RefreshCw, RotateCcw, Save, Server, ShieldCheck, SlidersHorizontal, Square, Upload, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, isAuthRequiredError, type ChannelRuntimeStatus, type DataSourceSettings, type LLMProviderOption, type LLMSettings } from "@/lib/api";
import { getApiAuthKey, setApiAuthKey } from "@/lib/apiAuth";
import { OptionalDepsManager } from "@/components/settings/OptionalDepsManager";
import { useAuthStore } from "@/stores/auth";
import { useNavigate } from "react-router-dom";

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
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelClass = "text-sm font-medium";
const hintClass = "text-xs text-muted-foreground";

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

export function Settings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [dataSettings, setDataSettings] = useState<DataSourceSettings | null>(null);
  const [channelStatus, setChannelStatus] = useState<ChannelRuntimeStatus | null>(null);
  const [form, setForm] = useState<LLMFormState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [localApiKey, setLocalApiKeyState] = useState(() => getApiAuthKey());
  const [clearApiKey, setClearApiKey] = useState(false);
  const [tushareToken, setTushareToken] = useState("");
  const [clearTushareToken, setClearTushareToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dataSaving, setDataSaving] = useState(false);
  const [channelRefreshing, setChannelRefreshing] = useState(false);
  const [channelAction, setChannelAction] = useState<"start" | "stop" | null>(null);
  const [pairingChannel, setPairingChannel] = useState("weixin");
  const [pairingCommand, setPairingCommand] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [usageDataOn, setUsageDataOn] = useState(getConsent());
  const [flushing, setFlushing] = useState(false);

  const toggleUsageData = async (on: boolean) => {
    setUsageDataOn(on);
    await setConsent(on);
    toast.success(on ? i18n.t("settings.usageData.on") : i18n.t("settings.usageData.off"));
  };

  // 手动触发一次埋点上传（含当天），用于验证上传通路；正常流程是隔天启动自动 flush。
  const handleTestUpload = async () => {
    setFlushing(true);
    try {
      const { uploaded, retained } = await flushNow({ forceAll: true });
      if (uploaded > 0) {
        toast.success(`已上传 ${uploaded} 个埋点批次${retained ? `,${retained} 个保留重试` : ""}`);
      } else if (retained > 0) {
        toast.error(`上传失败,${retained} 个批次保留待重试`);
      } else {
        toast.info("没有待上传的埋点数据");
      }
    } catch (error) {
      toast.error(`上传失败:${error instanceof Error ? error.message : "Unknown error"}`);
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
    Promise.all([api.getLLMSettings(), api.getDataSourceSettings(), api.getChannelStatus()])
      .then(([llmData, dataSourceData, channelData]) => {
        if (!alive) return;
        setSettings(llmData);
        setForm(toForm(llmData));
        setDataSettings(dataSourceData);
        setChannelStatus(channelData);
        setSettingsLoadError(null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        setSettingsLoadError(message);
        if (isAuthRequiredError(error)) {
          toast.error(message);
        } else {
          toast.error(`Failed to load LLM settings: ${message}`);
          toast.error(`Failed to load data source settings: ${message}`);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const refreshChannelStatus = async () => {
    setChannelRefreshing(true);
    try {
      setChannelStatus(await api.getChannelStatus());
    } catch (error) {
      toast.error(`${t("settings.channels.refreshFailed")}: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setChannelRefreshing(false);
    }
  };

  const setChannelsRunning = async (action: "start" | "stop") => {
    setChannelAction(action);
    try {
      const updated = action === "start" ? await api.startChannels() : await api.stopChannels();
      setChannelStatus(updated);
      toast.success(action === "start" ? t("settings.channels.started") : t("settings.channels.stoppedToast"));
    } catch (error) {
      toast.error(`${action === "start" ? t("settings.channels.startFailed") : t("settings.channels.stopFailed")}: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setChannelAction(null);
    }
  };

  const submitPairingCommand = async (event: FormEvent) => {
    event.preventDefault();
    const command = pairingCommand.trim();
    if (!command) return;
    setPairingBusy(true);
    try {
      const updated = await api.runChannelPairingCommand({
        channel: pairingChannel.trim() || "weixin",
        command,
      });
      toast.success(updated.reply);
      setPairingCommand("");
    } catch (error) {
      toast.error(`Failed to run pairing command: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setPairingBusy(false);
    }
  };

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
    toast.success("Local API key saved");
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
      toast.success("LLM settings saved");
    } catch (error) {
      toast.error(`Failed to save LLM settings: ${error instanceof Error ? error.message : "Unknown error"}`);
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
      toast.success("Data source settings saved");
    } catch (error) {
      toast.error(`Failed to save data source settings: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setDataSaving(false);
    }
  };

  const localApiAccessSection = (
    <form onSubmit={submitLocalApiKey} className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="mb-4 space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold">{"Local API access"}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{"For remote or private Web UI deployments, enter the server API key once in this browser. Localhost use can stay blank."}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="grid gap-2">
          <span className={labelClass}>{"Server API key"}</span>
          <input
            type="password"
            value={localApiKey}
            onChange={(event) => setLocalApiKeyState(event.target.value)}
            className={fieldClass}
            placeholder={"Stored only in this browser. Leave blank to clear it."}
            autoComplete="current-password"
          />
        </label>
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 self-end rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          {i18n.t("settings.save")}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{"Stored only in this browser. Leave blank to clear it."}</p>
    </form>
  );

  if (loading || !form || !settings || !dataSettings || !channelStatus) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{"Settings"}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{"Configure model credentials and market data source tokens for this local project."}</p>
        </div>
        {localApiAccessSection}
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">{i18n.t("settings.usageData.title")}</h2>
            <button
              type="button"
              role="switch"
              aria-checked={usageDataOn}
              onClick={() => toggleUsageData(!usageDataOn)}
              className={`relative h-6 w-11 rounded-full transition ${usageDataOn ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${usageDataOn ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>
          <p className="text-sm text-muted-foreground">{i18n.t("settings.usageData.description")}</p>
        </div>
        <div className="flex min-h-32 items-center justify-center rounded-lg border bg-card p-5 text-sm text-muted-foreground">
          {settingsLoadError ? (
            <div className="text-center">
              <div className="font-medium text-foreground">{"Settings are unavailable"}</div>
              <div className="mt-1">{settingsLoadError}</div>
            </div>
          ) : (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {"Loading..."}
            </>
          )}
        </div>
      </div>
    );
  }

  const keyStatus = settings.api_key_configured
    ? "Configured"
    : settings.api_key_required
      ? "Leave blank to keep the current key"
      : selectedProvider?.auth_type === "oauth" && selectedProvider.login_command
        ? `This provider uses OAuth. Run: ${selectedProvider.login_command}`
        : "This provider does not require an API key.";
  const apiKeyDisabled = !selectedProvider?.api_key_required || clearApiKey;
  const tushareStatus = dataSettings.tushare_token_configured
    ? "Configured"
    : "Leave blank to keep the current token";
  const channelRows = Object.entries(channelStatus.channels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const channelEnabledCount = channelRows.filter(([, item]) => item.enabled).length;
  const channelLoadedCount = channelRows.filter(([, item]) => item.loaded).length;
  const channelUnavailableCount = channelRows.filter(([, item]) => item.available === false).length;
  const channelBusy = channelRefreshing || channelAction !== null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{"Settings"}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{"Configure model credentials and market data source tokens for this local project."}</p>
      </div>

      {localApiAccessSection}

      {/* Usage data consent */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">{i18n.t("settings.usageData.title")}</h2>
          <button
            type="button"
            role="switch"
            aria-checked={usageDataOn}
            onClick={() => toggleUsageData(!usageDataOn)}
            className={`relative h-6 w-11 rounded-full transition ${usageDataOn ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${usageDataOn ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">{i18n.t("settings.usageData.description")}</p>
        <button
          type="button"
          onClick={handleTestUpload}
          disabled={flushing}
          className="mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {flushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          测试上传埋点数据
        </button>
      </div>

      {/* IM channels */}
      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <MessageSquareMore className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold">{t("settings.channels.title")}</h2>
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">{t("settings.channels.description")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshChannelStatus}
              disabled={channelBusy}
              className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {channelRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("settings.channels.refresh")}
            </button>
            <button
              type="button"
              onClick={() => setChannelsRunning("start")}
              disabled={channelBusy}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {channelAction === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t("settings.channels.start")}
            </button>
            <button
              type="button"
              onClick={() => setChannelsRunning("stop")}
              disabled={channelBusy}
              className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {channelAction === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              {t("settings.channels.stop")}
            </button>
          </div>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("settings.channels.runtime")}</div>
            <div className="text-sm font-medium">{channelStatus.running ? t("settings.channels.running") : t("settings.channels.stopped")}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("settings.channels.enabled")}</div>
            <div className="text-sm font-medium">{channelEnabledCount}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("settings.channels.loaded")}</div>
            <div className="text-sm font-medium">{channelLoadedCount}</div>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("settings.channels.unavailable")}</div>
            <div className="text-sm font-medium">{channelUnavailableCount}</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t("settings.channels.channel")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("settings.channels.state")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("settings.channels.recovery")}</th>
              </tr>
            </thead>
            <tbody>
              {channelRows.map(([name, item]) => (
                <tr key={name} className="border-t">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{item.display_name || name}</div>
                    <div className="text-xs text-muted-foreground">{name}</div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${item.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                        {item.enabled ? t("settings.channels.enabled") : t("settings.channels.disabled")}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${item.loaded ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {item.loaded ? t("settings.channels.loaded") : t("settings.channels.notLoaded")}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${item.running ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {item.running ? t("settings.channels.running") : t("settings.channels.stopped")}
                      </span>
                    </div>
                  </td>
                  <td className="max-w-md px-3 py-2 align-top text-xs text-muted-foreground">
                    {item.install_hint || item.error || t("settings.channels.noRecovery")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={submitPairingCommand} className="mt-4 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
          <label className="grid gap-2">
            <span className={labelClass}>{"Channel"}</span>
            <select
              value={pairingChannel}
              onChange={(event) => setPairingChannel(event.target.value)}
              className={fieldClass}
            >
              {["weixin", "wecom", "telegram", "slack", "discord", "qq", "napcat", "feishu", "dingtalk"].map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2">
            <span className={labelClass}>{"Pairing command"}</span>
            <input
              value={pairingCommand}
              onChange={(event) => setPairingCommand(event.target.value)}
              className={fieldClass}
              placeholder={"approve UM59-EGIT"}
            />
          </label>
          <button
            type="submit"
            disabled={pairingBusy || !pairingCommand.trim()}
            className="inline-flex items-center justify-center gap-2 self-end rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pairingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareMore className="h-4 w-4" />}
            {"Run pairing"}
          </button>
        </form>
      </section>

      {/* VIP 登录状态 / 登录引导 */}
      {isAuthenticated ? (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold">VIP 已激活</h2>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                  已登录
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {userInfo?.nickName ? `${userInfo.nickName}，` : ""}LLM 已通过 VIP 服务自动配置为高速模型，无需手动设置。
              </p>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                <span>使用 Maas 加速端点 · deepseek-v4-flash</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold">登录获取 VIP 模型加速</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                登录后自动配置高速 LLM 端点，无需手动填写 API Key 和模型参数。
              </p>
              <button
                type="button"
                onClick={() => navigate("/login")}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                <LogIn className="h-4 w-4" />
                前往登录
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LLM Settings — 仅未登录时可见 */}
      {!isAuthenticated && (
        <>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold tracking-tight">{"LLM Settings"}</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{"Choose the model used by the agent and save it to the project-local agent/.env file."}</p>
          </div>

          <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
            <section className="rounded-lg border bg-card p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold">{"Connection"}</h2>
              </div>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className={labelClass}>{i18n.t("settings.provider")}</span>
                  <select
                    value={form.provider}
                    onChange={(event) => onProviderChange(event.target.value)}
                    className={fieldClass}
                  >
                    {providers.map((provider) => (
                      <option key={provider.name} value={provider.name}>{provider.label}</option>
                    ))}
                  </select>
                  <span className={hintClass}>{"Changing providers updates the recommended model and endpoint."}</span>
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{"Model"}</span>
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
                      className="inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      title={"Use provider defaults"}
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span className="hidden sm:inline">{"Use provider defaults"}</span>
                    </button>
                  </div>
                  <span className={hintClass}>{"Use the exact model id required by your provider."}</span>
                </label>

                <label className="grid gap-2">
                  <span className={labelClass}>{i18n.t("settings.baseUrl")}</span>
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
                    {selectedProvider?.auth_type === "oauth" ? "OAuth" : "API key"}
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
                  <div className="flex items-center justify-between gap-3">
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
                        {"Clear saved API key"}
                      </label>
                    ) : null}
                  </div>
                </label>
              </div>
            </section>

            <section className="rounded-lg border bg-card p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold">{"Generation"}</h2>
              </div>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className={labelClass}>{i18n.t("settings.temperature")}</span>
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
                  <span className={labelClass}>{i18n.t("settings.timeoutSeconds")}</span>
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
                  <span className={labelClass}>{"Max retries"}</span>
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
                  <span className={labelClass}>{i18n.t("settings.reasoningEffort")}</span>
                  <select
                    value={form.reasoning_effort}
                    onChange={(event) => setForm({ ...form, reasoning_effort: event.target.value })}
                    className={fieldClass}
                  >
                    <option value="">{"Off"}</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="max">max</option>
                  </select>
                  <span className={hintClass}>{"How hard the model thinks before answering. Higher is more thorough but slower; leave Off for fastest replies."}</span>
                </label>

                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{i18n.t("settings.saved")}: </span>
                  <span className="break-all font-mono">{settings.env_path}</span>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? i18n.t("settings.saving") : i18n.t("settings.save")}
                </button>
              </div>
            </section>
          </form>
        </>
      )}

      <form onSubmit={submitDataSources} className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="mb-5 space-y-1">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">{"Data Source Settings"}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{"Configure optional market data credentials used by backtests and research agents."}</p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
          <div className="grid gap-4">
            <label className="grid gap-2">
              <span className={labelClass}>{"Tushare token"}</span>
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
              <div className="flex items-center justify-between gap-3">
                <span className={hintClass}>{"Used for China A-share, futures, fund, and macro data. If unset, the project falls back to AKShare where available."}</span>
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
                  {"Clear saved Tushare token"}
                </label>
              </div>
            </label>

            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{i18n.t("settings.saved")}: </span>
              <span className="break-all font-mono">{dataSettings.env_path}</span>
            </div>

            <button
              type="submit"
              disabled={dataSaving}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {dataSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {dataSaving ? i18n.t("settings.saving") : "Save data source settings"}
            </button>
          </div>

          <div className="rounded-md border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{"BaoStock"}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${dataSettings.baostock_supported ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                {dataSettings.baostock_supported ? "Loader available" : "No project loader"}
              </span>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{dataSettings.baostock_message}</p>
              <p>
                {dataSettings.baostock_installed
                  ? "Python package installed"
                  : "Python package not installed"}
              </p>
            </div>
          </div>
        </div>
      </form>

      {/* Desktop: optional broker SDK management */}
      <section className="mt-6 rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5" />
          <h2 className="text-lg font-semibold">券商支持 (可选依赖)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          按需安装券商 SDK。安装到本地可写目录，不影响核心依赖。
        </p>
        <OptionalDepsManager />
      </section>
    </div>
  );
}
