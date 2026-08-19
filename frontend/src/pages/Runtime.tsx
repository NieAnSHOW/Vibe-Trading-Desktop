import { useTranslation } from "react-i18next";
import { RuntimeStatus } from "@/components/settings/RuntimeStatus";
import { PageHeader } from "@/components/common/PageHeader";

/**
 * 运行时页:webui 的设置职能(LLM/数据源/IM 通道/API 密钥/遥测开关)已全部
 * 迁至桌面控制台,此处仅保留实盘/模拟运行时监控。
 */
export function Runtime() {
  const { t } = useTranslation();

  return (
    <div
      data-testid="runtime-workspace"
      className="tw-page max-w-none flex h-full min-h-0 w-full min-w-0 flex-col gap-3"
    >
      <PageHeader kicker="Runtime" title={t("layout.runtime")} />
      <RuntimeStatus />
    </div>
  );
}
