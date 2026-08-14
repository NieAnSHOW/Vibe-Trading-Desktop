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

/** 控制台地址只允许这些 scheme,防御异常参数导致的任意导航。 */
const ALLOWED_SCHEMES = ["http:", "https:", "tauri:"];

/** 应用启动时调用一次:从当前 URL 捕获内嵌状态与控制台地址。 */
export function initDesktopShell(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") !== "1") return;

    window.sessionStorage.setItem(EMBEDDED_KEY, "1");
    const consoleUrl = params.get("console")?.trim();
    if (consoleUrl) {
      window.sessionStorage.setItem(CONSOLE_URL_KEY, consoleUrl);
    }
  } catch {
    // sessionStorage 不可用(隐私模式极端情况)时静默降级:入口按 URL 探测。
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

/** 校验控制台地址;非白名单 scheme 返回 false。 */
export function isShellConsoleUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** 桌面壳 rail 的目标页面,对应控制台 hash 路由。 */
export type ShellConsolePage = "login" | "console" | "settings";

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
  parsed.hash = page === "console" ? "" : `#/${page}`;
  return parsed.toString();
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
