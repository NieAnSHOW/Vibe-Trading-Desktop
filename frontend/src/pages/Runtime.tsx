import { getConsent, setConsent } from "@/lib/telemetry";
import { useState, type FormEvent } from "react";
import { KeyRound, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getApiAuthKey, setApiAuthKey } from "@/lib/apiAuth";
import { RuntimeStatus } from "@/components/settings/RuntimeStatus";
import { PageHeader } from "@/components/common/PageHeader";

const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelClass = "text-sm font-medium";

/**
 * 运行时页:webui 的设置职能(LLM/数据源/IM 通道/API 密钥管理)已迁至
 * 桌面控制台,此处只保留实盘/模拟运行时监控;本地 API 密钥与匿名遥测
 * 开关是浏览器直连部署的唯一入口,随本页保留。
 */
export function Runtime() {
  const { t } = useTranslation();
  const [localApiKey, setLocalApiKeyState] = useState(() => getApiAuthKey());
  const [usageDataOn, setUsageDataOn] = useState(getConsent());

  const toggleUsageData = async (on: boolean) => {
    setUsageDataOn(on);
    await setConsent(on);
    toast.success(
      on ? t("settings.usageData.on") : t("settings.usageData.off"),
    );
  };

  const submitLocalApiKey = (event: FormEvent) => {
    event.preventDefault();
    setApiAuthKey(localApiKey);
    toast.success(t("settings.localApiKeySaved"));
    window.location.reload();
  };

  return (
    <div
      data-testid="runtime-workspace"
      className="tw-page flex h-full w-full flex-col gap-3 p-3 lg:gap-3 lg:p-5"
    >
      <PageHeader kicker="Runtime" title={t("layout.runtime")} />

      <RuntimeStatus />

      <form onSubmit={submitLocalApiKey} className="tw-panel">
        <header className="tw-panel-head">
          <div className="flex min-w-0 items-center gap-2">
            <KeyRound className="h-4 w-4 shrink-0 text-primary" />
            <h2 className="tw-panel-label">{t("settings.localApiAccess")}</h2>
          </div>
        </header>
        <div className="tw-panel-body">
          <p className="mb-4 text-sm text-muted-foreground">
            {t("settings.localApiAccessDesc")}
          </p>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-2">
              <span className={labelClass}>{t("settings.serverApiKey")}</span>
              <input
                type="password"
                value={localApiKey}
                onChange={(event) => setLocalApiKeyState(event.target.value)}
                className={fieldClass}
                placeholder={t("settings.storedInBrowser")}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="tw-btn-primary self-end">
              <Save className="h-4 w-4" />
              {t("settings.save")}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings.storedInBrowser")}
          </p>
        </div>
      </form>

      <section className="tw-panel">
        <header className="tw-panel-head">
          <h2 className="tw-panel-label">{t("settings.usageData.title")}</h2>
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
            {t("settings.usageData.description")}
          </p>
        </div>
      </section>
    </div>
  );
}
