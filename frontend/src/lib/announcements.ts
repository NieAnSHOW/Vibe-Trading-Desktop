import { invoke } from "@tauri-apps/api/core";
import { isDesktopEmbedded, isDesktopShellFrame } from "@/lib/desktopShell";

/** 公告/广告条目(镜像 cool-admin MarketingAdEntity 与 Rust 侧 AdItem)。 */
export type AnnouncementAd = {
  id: number;
  title: string;
  /** 1=纯图片 2=纯文本 */
  type: number;
  position: string;
  images?: { url: string; link?: string }[] | null;
  content?: string | null;
  link?: string | null;
  sort: number;
};

/** 展示文本:优先 content,缺省回退 title(与控制台 AdSlot 一致)。 */
export function adText(ad: AnnouncementAd): string {
  return ad.content || ad.title || "";
}

/** 跳转链接:优先条目 link,回退首图 link(与控制台 AdSlot 一致)。 */
export function adLink(ad: AnnouncementAd): string | null {
  return ad.link ?? ad.images?.[0]?.link ?? null;
}

/** 控制台桥回复超时:Rust 侧 fetch 超时 10s,留余量。 */
const BRIDGE_TIMEOUT_MS = 12_000;

/**
 * 拉取公告列表。
 *
 * 公告数据在会员服务器(cool-admin)上,服务端不带 CORS 头,WebUI 文档无法
 * 直连,只能走桌面壳:iframe 模式经 postMessage 消息桥委托控制台调用
 * console_fetch_ads(与 vibe-shell:open-external 同通道);非 frame 的内嵌
 * 文档直接 invoke。普通浏览器访问拿不到公告。
 *
 * 返回 null 表示拉取失败或当前环境不可用(调用方应保留旧数据);空数组表示
 * 接口正常但服务端没有公告(公告栏应隐藏)。
 */
export async function fetchAnnouncements(
  position: string,
): Promise<AnnouncementAd[] | null> {
  try {
    if (isDesktopShellFrame()) {
      return await requestAdsViaBridge(position);
    }
    if (isDesktopEmbedded()) {
      return await invoke<AnnouncementAd[]>("console_fetch_ads", { position });
    }
  } catch {
    // 拉取失败返回 null:调用方保留旧公告,不影响看板
  }
  return null;
}

function requestAdsViaBridge(
  position: string,
): Promise<AnnouncementAd[] | null> {
  // tsconfig lib=ES2020,没有 Promise.withResolvers,保留 executor 形式
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, BRIDGE_TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data as
        | { type?: string; position?: string; ads?: unknown }
        | null;
      if (data?.type !== "vibe-shell:ads" || data.position !== position) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(Array.isArray(data.ads) ? (data.ads as AnnouncementAd[]) : null);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "vibe-shell:ads-request", position }, "*");
  });
}
