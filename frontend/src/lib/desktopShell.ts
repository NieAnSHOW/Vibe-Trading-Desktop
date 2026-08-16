/**
 * 桌面壳(Tauri)内嵌探测与返回控制台。
 *
 * 桌面壳把主窗口 webview 导航到本站时携带 `?desktop=1&console=<url>`
 * (见 src-tauri/src/webui_embed.rs)。SPA 路由切换会丢掉查询串,因此首次
 * 加载时把状态落到 sessionStorage;侧边栏据此显示「控制台」入口,点击后
 * 导航回壳内控制台页。浏览器直接访问(无参数)时一切如常,不显示该入口。
 */

const EMBEDDED_KEY = "vibe.desktop.embedded";
const CONSOLE_URL_KEY = "vibe.desktop.consoleUrl";
const THEME_MODE_KEY = "vibe.desktop.themeMode";
const THEME_COLOR_KEY = "vibe.desktop.themeColor";
const FRAME_KEY = "vibe.desktop.frame";
export const SHELL_PAGE_TRANSITION_MS = 220;

/** Remove the HTML-first rail once the React rail has committed. */
export function dismissDesktopRailBootstrap(): void {
  document.getElementById("desktop-shell-rail-bootstrap")?.remove();
}

export type DesktopThemeMode = "system" | "light" | "dark";

const THEME_COLORS = new Set(["teal", "blue", "purple", "pink", "orange", "green"]);

function isDesktopThemeMode(value: string | null): value is DesktopThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/** 控制台地址只允许这些 scheme,防御异常参数导致的任意导航。 */
const ALLOWED_SCHEMES = ["http:", "https:", "tauri:"];

/** 应用启动时调用一次:从当前 URL 捕获内嵌状态与控制台地址。 */
export function initDesktopShell(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") !== "1") return;

    window.sessionStorage.setItem(EMBEDDED_KEY, "1");
    if (params.get("shell") === "frame") window.sessionStorage.setItem(FRAME_KEY, "1");
    else window.sessionStorage.removeItem(FRAME_KEY);
    const consoleUrl = params.get("console")?.trim();
    if (consoleUrl) {
      window.sessionStorage.setItem(CONSOLE_URL_KEY, consoleUrl);
    }
    const themeMode = params.get("theme");
    window.sessionStorage.setItem(
      THEME_MODE_KEY,
      isDesktopThemeMode(themeMode) ? themeMode : "system",
    );
    const themeColor = params.get("theme_color");
    if (THEME_COLORS.has(themeColor ?? "")) {
      window.sessionStorage.setItem(THEME_COLOR_KEY, themeColor!);
    } else {
      window.sessionStorage.removeItem(THEME_COLOR_KEY);
    }
  } catch {
    // sessionStorage 不可用(隐私模式极端情况)时静默降级:入口按 URL 探测。
  }
}

/** 读取桌面壳传入的主题模式;普通浏览器始终返回系统模式。 */
export function getDesktopThemeMode(): DesktopThemeMode {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") === "1") {
      const theme = params.get("theme");
      if (isDesktopThemeMode(theme)) return theme;
    }
    if (window.sessionStorage.getItem(EMBEDDED_KEY) !== "1") return "system";
    const saved = window.sessionStorage.getItem(THEME_MODE_KEY);
    return isDesktopThemeMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** 更新嵌入 WebUI 的当前主题模式，保证 SPA 路由或刷新后继续使用新选择。 */
export function setDesktopThemeMode(mode: DesktopThemeMode): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("desktop") === "1") {
      url.searchParams.set("theme", mode);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (window.sessionStorage.getItem(EMBEDDED_KEY) === "1") {
      window.sessionStorage.setItem(THEME_MODE_KEY, mode);
    }
  } catch {
    // sessionStorage/history 不可用时仍由当前 React 状态维持本次显示主题。
  }
}

/** 读取桌面壳传入的主题色;普通浏览器不强制主题色。 */
export function getDesktopThemeColor(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") === "1") {
      const color = params.get("theme_color");
      if (THEME_COLORS.has(color ?? "")) return color;
    }
    if (window.sessionStorage.getItem(EMBEDDED_KEY) !== "1") return null;
    const saved = window.sessionStorage.getItem(THEME_COLOR_KEY);
    return THEME_COLORS.has(saved ?? "") ? saved : null;
  } catch {
    return null;
  }
}

/** 当前是否运行在桌面壳内嵌窗口中。 */
export function isDesktopEmbedded(): boolean {
  try {
    if (window.sessionStorage.getItem(EMBEDDED_KEY) === "1") return true;
  } catch {
    // ignore
  }
  try {
    return new URLSearchParams(window.location.search).get("desktop") === "1";
  } catch {
    return false;
  }
}

/** The WebUI is hosted in the console's retained iframe and must not render a second rail. */
export function isDesktopShellFrame(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("shell") === "frame") return true;
    return window.sessionStorage.getItem(FRAME_KEY) === "1";
  } catch {
    return false;
  }
}

/** Keep the frame marker on deep SPA routes so a hard refresh remains embeddable. */
export function preserveDesktopShellFrameUrl(): void {
  if (!isDesktopShellFrame()) return;
  try {
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.get("desktop") !== "1") {
      url.searchParams.set("desktop", "1");
      changed = true;
    }
    if (url.searchParams.get("shell") !== "frame") {
      url.searchParams.set("shell", "frame");
      changed = true;
    }
    if (changed) {
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  } catch {
    // History may be unavailable in restricted webviews; the session marker still works.
  }
}

/** 校验控制台地址;非白名单 scheme 返回 false。 */
export function isShellConsoleUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** 桌面壳 rail 的目标页面,对应控制台 hash 路由。 */
export type ShellConsolePage = "login" | "profile" | "console" | "settings";

/** 读取已保存的控制台地址(无效或缺失返回 null)。 */
export function getShellConsoleUrl(): string | null {
  let url: string | null = null;
  try {
    url = window.sessionStorage.getItem(CONSOLE_URL_KEY);
  } catch {
    return null;
  }
  if (!url || !isShellConsoleUrl(url)) return null;
  return url;
}

/** 控制台页面完整地址:base + hash 路由(控制台是 createWebHashHistory)。 */
export function shellConsolePageUrl(page: ShellConsolePage): string | null {
  const base = getShellConsoleUrl();
  if (!base) return null;
  // base 已由壳侧规范化为 origin+path;防御性再剥一次 query/hash。
  const parsed = new URL(base);
  parsed.search = "";
  // 把当前 WebUI 主题交接给控制台,让其在异步读取设置前就能首屏使用同一主题。
  const theme = getDesktopThemeModeTransfer();
  if (theme) {
    parsed.searchParams.set("theme", theme);
    const color = getDesktopThemeColor();
    if (color) parsed.searchParams.set("theme_color", color);
  }
  parsed.searchParams.set("transition", "1");
  parsed.hash = page === "console" ? "" : `#/${page}`;
  return parsed.toString();
}

function getDesktopThemeModeTransfer(): DesktopThemeMode | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") === "1") {
      const theme = params.get("theme");
      if (isDesktopThemeMode(theme)) return theme;
    }
    if (window.sessionStorage.getItem(EMBEDDED_KEY) === "1") {
      const saved = window.sessionStorage.getItem(THEME_MODE_KEY);
      return isDesktopThemeMode(saved) ? saved : null;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 导航回桌面壳控制台页;仅在有效地址时动作,否则保持当前页。
 *  navigate 可注入,便于单测(jsdom 无法 spy location.replace)。 */
export function returnToConsole(
  page: ShellConsolePage = "console",
  navigate: (url: string) => void = (url) => window.location.replace(url),
): void {
  const url = shellConsolePageUrl(page);
  if (url) {
    navigate(url);
  }
}

/**
 * 研究页与控制台属于不同文档。先播放与控制台路由一致的离场动画，再执行
 * 整页导航，避免点击导航时画面瞬间跳变。
 */
export function returnToConsoleWithTransition(
  page: ShellConsolePage = "console",
  navigate: (url: string) => void = (url) => window.location.replace(url),
): void {
  const url = shellConsolePageUrl(page);
  if (!url) return;
  if (document.documentElement.classList.contains("desktop-shell-leaving")) return;
  if (prefersReducedMotion()) {
    navigate(url);
    return;
  }
  document.documentElement.classList.add("desktop-shell-leaving");
  window.setTimeout(() => navigate(url), SHELL_PAGE_TRANSITION_MS);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
