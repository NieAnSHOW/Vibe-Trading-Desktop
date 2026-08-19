import { getConsent, setConsent } from "@/lib/telemetry";
import i18n from "@/i18n";
import { useEffect, useState, type FormEvent } from "react";
import {
  KeyRound,
  Loader2,
  MessageSquareMore,
  Play,
  QrCode,
  RefreshCw,
  Save,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  api,
  isAuthRequiredError,
  type ChannelRuntimeStatus,
  type DataSourceSettings,
  type LLMSettings,
} from "@/lib/api";
import { getApiAuthKey, setApiAuthKey } from "@/lib/apiAuth";
import { RuntimeStatus } from "@/components/settings/RuntimeStatus";
import { PageHeader } from "@/components/common/PageHeader";

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

// ponytail: 直接映射后端 GET /settings/llm 的 .env 真实值,不再用前端默认值覆盖。
// 否则换浏览器/清缓存/origin 端口变化时,用户已配置的 temperature 等会被重写成默认值。
function toForm(settings: LLMSettings): LLMFormState {
  return {
    provider: settings.provider,
    model_name: settings.model_name,
    base_url: settings.base_url,
    temperature: settings.temperature,
    timeout_seconds: settings.timeout_seconds,
    max_retries: settings.max_retries,
    reasoning_effort: settings.reasoning_effort,
  };
}

export function Settings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [dataSettings, setDataSettings] = useState<DataSourceSettings | null>(
    null,
  );
  const [channelStatus, setChannelStatus] =
    useState<ChannelRuntimeStatus | null>(null);
  const [form, setForm] = useState<LLMFormState | null>(null);
  const [localApiKey, setLocalApiKeyState] = useState(() => getApiAuthKey());
  const [loading, setLoading] = useState(true);
  const [channelRefreshing, setChannelRefreshing] = useState(false);
  const [channelAction, setChannelAction] = useState<"start" | "stop" | null>(
    null,
  );
  const [pairingCommand, setPairingCommand] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(
    null,
  );
  const [usageDataOn, setUsageDataOn] = useState(getConsent());
  // const [flushing, setFlushing] = useState(false);
  // WeChat QR login state
  const [weixinQr, setWeixinQr] = useState<{
    loginId: string;
    image: string;
  } | null>(null);
  const [weixinPolling, setWeixinPolling] = useState(false);

  const toggleUsageData = async (on: boolean) => {
    setUsageDataOn(on);
    await setConsent(on);
    toast.success(
      on ? i18n.t("settings.usageData.on") : i18n.t("settings.usageData.off"),
    );
  };

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      api.getLLMSettings(),
      api.getDataSourceSettings(),
      api.getChannelStatus(),
    ])
      .then(([llmResult, dataSourceResult, channelResult]) => {
        if (!alive) return;

        // ponytail: allSettled — 单接口失败不拖垮整页 (upstream 容错语义)。
        // LLM 直接信任后端返回的 .env 真实值,不再用本地标记/硬编码默认值覆盖。
        if (llmResult.status === "fulfilled") {
          const llmData = llmResult.value;
          setSettings(llmData);
          setForm(toForm(llmData));
        } else {
          const message =
            llmResult.reason instanceof Error
              ? llmResult.reason.message
              : t("settings.unknownError");
          setSettingsLoadError(message);
          if (isAuthRequiredError(llmResult.reason)) {
            toast.error(message);
          } else {
            toast.error(t("settings.loadLlmSettingsFailed", { message }));
          }
        }

        if (dataSourceResult.status === "fulfilled") {
          setDataSettings(dataSourceResult.value);
        } else {
          const message =
            dataSourceResult.reason instanceof Error
              ? dataSourceResult.reason.message
              : t("settings.unknownError");
          setSettingsLoadError(message);
          if (isAuthRequiredError(dataSourceResult.reason)) {
            toast.error(message);
          } else {
            toast.error(
              t("settings.loadDataSourceSettingsFailed", { message }),
            );
          }
        }

        if (channelResult.status === "fulfilled") {
          setChannelStatus(channelResult.value);
        } else {
          // channel status 失败不拖垮整页: 保留 LLM/data source 可用, channel 区降级为空。
          const message =
            channelResult.reason instanceof Error
              ? channelResult.reason.message
              : t("settings.unknownError");
          toast.error(t("settings.loadChannelStatusFailed", { message }));
          setChannelStatus(null);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshChannelStatus = async () => {
    setChannelRefreshing(true);
    try {
      const channelData = await api.getChannelStatus();
      setChannelStatus(channelData);
    } catch (error) {
      toast.error(
        `${t("settings.channels.refreshFailed")}: ${error instanceof Error ? error.message : t("settings.unknownError")}`,
      );
    } finally {
      setChannelRefreshing(false);
    }
  };

  const setChannelsRunning = async (action: "start" | "stop") => {
    setChannelAction(action);
    try {
      const updated =
        action === "start"
          ? await api.startChannels()
          : await api.stopChannels();
      setChannelStatus(updated);
      toast.success(
        action === "start"
          ? t("settings.channels.started")
          : t("settings.channels.stoppedToast"),
      );
    } catch (error) {
      toast.error(
        `${action === "start" ? t("settings.channels.startFailed") : t("settings.channels.stopFailed")}: ${error instanceof Error ? error.message : t("settings.unknownError")}`,
      );
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
      // ponytail: 仅微信开放,pairing 命令固定走 weixin
      const updated = await api.runChannelPairingCommand({
        channel: "weixin",
        command,
      });
      toast.success(updated.reply);
      setPairingCommand("");
    } catch (error) {
      toast.error(
        t("settings.runPairingFailed", {
          message:
            error instanceof Error ? error.message : t("settings.unknownError"),
        }),
      );
    } finally {
      setPairingBusy(false);
    }
  };

  const startWeixinQrLogin = async () => {
    try {
      const { login_id, qr_image } = await api.startWeixinLogin();
      setWeixinQr({ loginId: login_id, image: qr_image });
      // qr_image 实为微信扫码跳转链接(非图片二进制);新页签打开让用户在微信侧完成扫码,
      // 本页弹窗仅做"等待登录"轮询。async await 后 window.open 可能被浏览器拦弹窗,modal 内有兜底按钮。
      if (qr_image?.startsWith("http")) {
        window.open(qr_image, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      toast.error(
        t("settings.weixin.qrFailed", {
          message:
            error instanceof Error ? error.message : t("settings.unknownError"),
        }),
      );
    }
  };

  // Poll WeChat QR login status
  useEffect(() => {
    if (!weixinQr) return;
    setWeixinPolling(true);
    const id = setInterval(async () => {
      try {
        const { status } = await api.weixinLoginStatus(weixinQr.loginId);
        if (status === "confirmed") {
          clearInterval(id);
          setWeixinQr(null);
          setWeixinPolling(false);
          toast.success(t("settings.weixin.loginSuccess"));
          // 后端在 login/status 确认时已自动重启 weixin 通道加载新身份;
          // 前端只需刷新状态展示。
          await refreshChannelStatus();
        } else if (status === "expired") {
          clearInterval(id);
          setWeixinQr(null);
          setWeixinPolling(false);
          toast.error(t("settings.weixin.qrExpired"));
        }
        // wait / scaned_but_redirect: continue polling
      } catch {
        // network error during poll: keep trying
      }
    }, 2000);
    return () => {
      clearInterval(id);
      setWeixinPolling(false);
    };
  }, [weixinQr]);

  const submitLocalApiKey = (event: FormEvent) => {
    event.preventDefault();
    setApiAuthKey(localApiKey);
    toast.success(t("settings.localApiKeySaved"));
    window.location.reload();
  };

  const localApiAccessSection = (
    <form onSubmit={submitLocalApiKey} className="tw-panel">
      <header className="tw-panel-head">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="tw-panel-label">
            {i18n.t("settings.localApiAccess")}
          </h2>
        </div>
      </header>
      <div className="tw-panel-body">
        <p className="mb-4 text-sm text-muted-foreground">
          {i18n.t("settings.localApiAccessDesc")}
        </p>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <label className="grid gap-2">
            <span className={labelClass}>
              {i18n.t("settings.serverApiKey")}
            </span>
            <input
              type="password"
              value={localApiKey}
              onChange={(event) => setLocalApiKeyState(event.target.value)}
              className={fieldClass}
              placeholder={i18n.t("settings.storedInBrowser")}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="tw-btn-primary self-end">
            <Save className="h-4 w-4" />
            {i18n.t("settings.save")}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {i18n.t("settings.storedInBrowser")}
        </p>
      </div>
    </form>
  );

  if (loading || !form || !settings || !dataSettings) {
    return (
      <div
        data-testid="settings-workspace"
        className="tw-page flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5"
      >
        <PageHeader
          kicker="Preferences"
          title={i18n.t("settings.title")}
          sub={i18n.t("settings.subtitle")}
        />
        {localApiAccessSection}
        <section className="tw-panel">
          <header className="tw-panel-head">
            <h2 className="tw-panel-label">
              {i18n.t("settings.usageData.title")}
            </h2>
            <button
              type="button"
              role="switch"
              aria-checked={usageDataOn}
              onClick={() => toggleUsageData(!usageDataOn)}
              className={`relative h-6 w-11 rounded-full transition ${usageDataOn ? "bg-primary" : "bg-muted"}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${usageDataOn ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
          </header>
          <div className="tw-panel-body">
            <p className="text-sm text-muted-foreground">
              {i18n.t("settings.usageData.description")}
            </p>
          </div>
        </section>
        <div className="tw-panel flex min-h-32 items-center justify-center p-5 text-sm text-muted-foreground">
          {settingsLoadError ? (
            <div className="text-center">
              <div className="font-medium text-foreground">
                {i18n.t("settings.unavailable")}
              </div>
              <div className="mt-1">{settingsLoadError}</div>
            </div>
          ) : (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {i18n.t("settings.loading")}
            </>
          )}
        </div>
      </div>
    );
  }

  // ponytail: 仅展示微信渠道。其他 IM 渠道暂不开放,不在 WebUI 中露出。
  const channelRows = Object.entries(channelStatus?.channels ?? {})
    .filter(([name]) => name === "weixin")
    .sort(([a], [b]) => a.localeCompare(b));
  const channelEnabledCount = channelRows.filter(
    ([, item]) => item.enabled,
  ).length;
  const channelLoadedCount = channelRows.filter(
    ([, item]) => item.loaded,
  ).length;
  const channelUnavailableCount = channelRows.filter(
    ([, item]) => item.available === false,
  ).length;
  const channelBusy = channelRefreshing || channelAction !== null;
  // channel 状态未知时(getChannelStatus 失败, channelStatus=null)禁用启停,
  // 但 Refresh 仍可用 —— 与 upstream 降级语义一致(状态未知不盲目 start/stop)。
  const channelControlsDisabled = channelBusy || !channelStatus;

  return (
    <div
      data-testid="settings-workspace"
      className="tw-page flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5"
    >
      <PageHeader
        kicker="Preferences"
        title={i18n.t("settings.title")}
        sub={i18n.t("settings.subtitle")}
      />

      {/* IM channels */}
      <section className="tw-panel">
        <header className="tw-panel-head">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareMore className="h-4 w-4 shrink-0 text-primary" />
            <h2 className="tw-panel-label">{t("settings.channels.title")}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshChannelStatus}
              disabled={channelBusy}
              className="tw-btn-ghost"
            >
              {channelRefreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("settings.channels.refresh")}
            </button>
            <button
              type="button"
              onClick={() => setChannelsRunning("start")}
              disabled={channelControlsDisabled}
              className="tw-btn-primary"
            >
              {channelAction === "start" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("settings.channels.start")}
            </button>
            <button
              type="button"
              onClick={() => setChannelsRunning("stop")}
              disabled={channelControlsDisabled}
              className="tw-btn-ghost"
            >
              {channelAction === "stop" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {t("settings.channels.stop")}
            </button>
          </div>
        </header>

        <div className="tw-panel-body">
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.channels.runtime")}
              </div>
              <div className="tw-num text-sm font-medium">
                {channelStatus?.running
                  ? t("settings.channels.running")
                  : t("settings.channels.stopped")}
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.channels.enabled")}
              </div>
              <div className="tw-num text-sm font-medium">
                {channelEnabledCount}
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.channels.loaded")}
              </div>
              <div className="tw-num text-sm font-medium">
                {channelLoadedCount}
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.channels.unavailable")}
              </div>
              <div className="tw-num text-sm font-medium">
                {channelUnavailableCount}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.channels.channel")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.channels.state")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.channels.recovery")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {channelRows.map(([name, item]) => (
                  <tr key={name} className="border-t">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">
                        {item.display_name || name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {name}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${item.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                        >
                          {item.enabled
                            ? t("settings.channels.enabled")
                            : t("settings.channels.disabled")}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${item.loaded ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                        >
                          {item.loaded
                            ? t("settings.channels.loaded")
                            : t("settings.channels.notLoaded")}
                        </span>
                        {item.health === "expired" ? (
                          <span className="rounded-full px-2 py-0.5 text-xs bg-destructive/10 text-destructive">
                            {t("settings.channels.loginExpired")}
                          </span>
                        ) : (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${item.running ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                          >
                            {item.running
                              ? t("settings.channels.running")
                              : t("settings.channels.stopped")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="max-w-md px-3 py-2 align-top text-xs text-muted-foreground">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          {item.install_hint ||
                            item.error ||
                            t("settings.channels.noRecovery")}
                        </span>
                        {name === "weixin" && item.enabled && (
                          <button
                            type="button"
                            disabled={weixinPolling}
                            onClick={startWeixinQrLogin}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {weixinPolling ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <QrCode className="h-3 w-3" />
                            )}
                            {i18n.t("settings.weixin.scanLogin")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ponytail: 仅微信开放,channel 固定 weixin,不再展示渠道选择器 */}
          <form
            onSubmit={submitPairingCommand}
            className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
          >
            <label className="grid gap-2">
              <span className={labelClass}>
                {i18n.t("settings.pairingCommand")}
              </span>
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
              className="tw-btn-primary self-end"
            >
              {pairingBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MessageSquareMore className="h-4 w-4" />
              )}
              {i18n.t("settings.runPairing")}
            </button>
          </form>
        </div>
      </section>

      <RuntimeStatus />

      {/* WeChat QR login modal */}
      {weixinQr && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setWeixinQr(null)}
        >
          <div
            className="rounded-lg border bg-card p-6 max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-4">
              {i18n.t("settings.weixin.scanTitle")}
            </h3>
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground text-center">
                {i18n.t("settings.weixin.scanHint")}
                <br />
                {i18n.t("settings.weixin.autoDetect")}
              </p>
              {weixinQr.image?.startsWith("http") && (
                <button
                  onClick={() =>
                    window.open(weixinQr.image, "_blank", "noopener,noreferrer")
                  }
                  className="text-xs text-primary hover:underline"
                >
                  {i18n.t("settings.weixin.reopenLink")}
                </button>
              )}
            </div>
            <button
              onClick={() => setWeixinQr(null)}
              className="tw-btn-ghost mt-4 w-full"
            >
              {i18n.t("settings.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
