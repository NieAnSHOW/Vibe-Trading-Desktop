import { getConsent, setConsent } from "@/lib/telemetry";
import i18n from "@/i18n";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  api,
  isAuthRequiredError,
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
  const [form, setForm] = useState<LLMFormState | null>(null);
  const [localApiKey, setLocalApiKeyState] = useState(() => getApiAuthKey());
  const [loading, setLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(
    null,
  );
  const [usageDataOn, setUsageDataOn] = useState(getConsent());

  const toggleUsageData = async (on: boolean) => {
    setUsageDataOn(on);
    await setConsent(on);
    toast.success(
      on ? i18n.t("settings.usageData.on") : i18n.t("settings.usageData.off"),
    );
  };

  useEffect(() => {
    let alive = true;
    Promise.allSettled([api.getLLMSettings(), api.getDataSourceSettings()])
      .then(([llmResult, dataSourceResult]) => {
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
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

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

      {/* ponytail: IM 通道/审批/微信扫码登录已迁至桌面端控制台(设置 → 消息渠道)。 */}

      <RuntimeStatus />
    </div>
  );
}
