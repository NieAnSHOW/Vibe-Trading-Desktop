import { isDesktopEmbedded, isDesktopShellFrame } from "@/lib/desktopShell";

/**
 * 桌面壳内打开外部链接。
 *
 * Tauri v2 只向主框架注入 IPC(__TAURI_INTERNALS__),嵌入 iframe 的 WebUI
 * 无法直接 invoke;因此 iframe 模式经 postMessage 委托控制台主框架调用
 * open_external_url(消息桥与 vibe-shell:theme 同通道,控制台侧校验
 * event.source 后才放行)。非嵌入的浏览器访问保持 window.open。
 */
export function openExternalUrl(url: string): void {
  if (isDesktopShellFrame()) {
    window.parent.postMessage({ type: "vibe-shell:open-external", url }, "*");
    return;
  }
  if (isDesktopEmbedded()) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("open_external_url", { url }))
      .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * 嵌入态全局拦截外源链接点击。桌面 webview 不处理 target=_blank/新窗口,
 * 新闻、自选股等页面里的裸 <a> 需要统一改道到 openExternalUrl。
 * 返回卸载函数(仅拦截与当前 origin 不同的 http/https 左键点击)。
 */
export function installExternalLinkInterceptor(): () => void {
  const onClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.origin === window.location.origin) return;
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    openExternalUrl(url.toString());
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
