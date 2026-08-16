import { useTranslation } from "react-i18next";
import { Moon, Settings, Sun, Telescope, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/telemetry";
import { returnToConsoleWithTransition, type ShellConsolePage } from "@/lib/desktopShell";

/**
 * 桌面壳层级导航栏:主窗口最左侧固定竖排(图标在上、文字在下)。
 *
 * 账户/设置是壳内控制台页面(hash 路由定向返回);「研究」即当前
 * WebUI(高亮态,不可点击)。控制台侧(console-app)渲染同一条 rail,
 * 两侧共同构成跨层级的常驻导航,替代"启动器 ↔ 浏览器"的割裂跳转。
 * 仅在 `?desktop=1` 内嵌模式下渲染;浏览器直接访问不显示。
 */

function RailButton({
  label,
  icon: Icon,
  active,
  onClick,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={active || disabled}
      aria-current={active ? "page" : undefined}
      className={cn(
        "desktop-shell-rail__item",
        active && "desktop-shell-rail__item--active",
      )}
    >
      <Icon className="desktop-shell-rail__icon" aria-hidden="true" />
      <span className="desktop-shell-rail__label">{label}</span>
    </button>
  );
}

export function DesktopShellRail({
  dark,
  themeSaving,
  onToggleTheme,
}: {
  dark: boolean;
  themeSaving?: boolean;
  onToggleTheme: () => void;
}) {
  const { t } = useTranslation();

  const go = (page: ShellConsolePage, target: string) => {
    try {
      track("feature_use", { nav_target: target }, { name: "desktop_rail" });
    } catch {}
    returnToConsoleWithTransition(page);
  };

  return (
    <aside
      aria-label={t("layout.rail.section")}
      className="desktop-shell-rail"
    >
      <RailButton
        label={t("layout.rail.account")}
        icon={UserRound}
        onClick={() => go("profile", "desktop-account")}
      />
      {/* 研究 = 当前 WebUI,常亮不可点 */}
      <RailButton label={t("layout.rail.research")} icon={Telescope} active />
      <div className="desktop-shell-rail__bottom">
        <RailButton
          label={t(dark ? "layout.dark" : "layout.light")}
          icon={dark ? Moon : Sun}
          disabled={themeSaving}
          onClick={onToggleTheme}
        />
        <RailButton
          label={t("layout.settings")}
          icon={Settings}
          onClick={() => go("settings", "desktop-settings")}
        />
      </div>
    </aside>
  );
}
