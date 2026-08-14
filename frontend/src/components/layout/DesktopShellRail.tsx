import { useTranslation } from "react-i18next";
import { MonitorCog, Settings, Telescope, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/telemetry";
import { returnToConsole, type ShellConsolePage } from "@/lib/desktopShell";

/**
 * 桌面壳层级导航栏:主窗口最左侧固定竖排(图标在上、文字在下)。
 *
 * 账户/环境/设置是壳内控制台页面(hash 路由定向返回);「研究」即当前
 * WebUI(高亮态,不可点击)。控制台侧(console-app)渲染同一条 rail,
 * 两侧共同构成跨层级的常驻导航,替代"启动器 ↔ 浏览器"的割裂跳转。
 * 仅在 `?desktop=1` 内嵌模式下渲染;浏览器直接访问不显示。
 */

function RailButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={active}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="w-full truncate text-[10px] leading-tight">{label}</span>
    </button>
  );
}

export function DesktopShellRail() {
  const { t } = useTranslation();

  const go = (page: ShellConsolePage, target: string) => {
    try {
      track("feature_use", { nav_target: target }, { name: "desktop_rail" });
    } catch {}
    returnToConsole(page);
  };

  return (
    <aside
      aria-label={t("layout.rail.section")}
      className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r bg-card py-3"
    >
      <RailButton
        label={t("layout.rail.account")}
        icon={UserRound}
        onClick={() => go("login", "desktop-account")}
      />
      <RailButton
        label={t("layout.rail.environment")}
        icon={MonitorCog}
        onClick={() => go("console", "desktop-environment")}
      />
      {/* 研究 = 当前 WebUI,常亮不可点 */}
      <RailButton label={t("layout.rail.research")} icon={Telescope} active />
      <div className="mt-auto">
        <RailButton
          label={t("layout.settings")}
          icon={Settings}
          onClick={() => go("settings", "desktop-settings")}
        />
      </div>
    </aside>
  );
}
