import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { openExternalUrl } from "@/lib/externalLinks";
import {
  adLink,
  adText,
  fetchAnnouncements,
  type AnnouncementAd,
} from "@/lib/announcements";

/**
 * 市场看板公告栏:一次只露一条,上下循环滚动(末尾克隆首条衔接成环,
 * 滚到克隆行后瞬时回零),悬停/聚焦暂停,仅一条时静态。数据每 5 分钟
 * 轮询刷新,失败保留旧公告。带链接的条目整行可点,经 openExternalUrl
 * 拉起系统浏览器(桌面壳内)或新标签(浏览器)。
 */

const ROTATE_INTERVAL_MS = 4000;
/** 单行高度(h-8 = 2rem);与 translateY 的步进必须同步改 */
const ROW_REM = 2;

/** 刷新间隔:公告是低频营销内容,5 分钟足够;页面隐藏期跳过 */
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function AnnouncementBar() {
  const { t } = useTranslation();
  const [ads, setAds] = useState<AnnouncementAd[]>([]);
  // 0..ads.length;停在 ads.length 时视觉上是首条克隆,过渡结束瞬时回 0
  const [pos, setPos] = useState(0);
  const [animating, setAnimating] = useState(true);
  const pausedRef = useRef(false);

  // 挂载即取 + 每 5 分钟轮询(页面隐藏时跳过);回到前台且距上次超过
  // 间隔则补取。失败(null)保留旧公告;空列表则隐藏公告栏。
  useEffect(() => {
    let alive = true;
    let lastFetch = 0;
    const load = () => {
      lastFetch = Date.now();
      void fetchAnnouncements("dashboard").then((items) => {
        if (!alive || items === null) return;
        setAds(items);
        // 轮换位置越界(列表变短/变单条)时归零;pos 有效上限:
        // 多条=克隆行(ads.length),单条=0(不轮换)
        setPos((p) => (p > (items.length > 1 ? items.length : 0) ? 0 : p));
      });
    };
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden && Date.now() - lastFetch >= REFRESH_INTERVAL_MS) {
        load();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const rotating = ads.length > 1;

  useEffect(() => {
    if (!rotating) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (pausedRef.current || document.hidden) return;
      setPos((p) => p + 1);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [rotating]);

  function handleTransitionEnd() {
    if (pos !== ads.length) return;
    // 回零必须跳过过渡;双 rAF 确保浏览器先提交"归零帧"再恢复过渡
    setAnimating(false);
    setPos(0);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setAnimating(true)),
    );
  }

  if (ads.length === 0) return null;

  const rows = rotating ? [...ads, ads[0]] : ads;

  return (
    <div
      data-testid="dashboard-announcements"
      className="flex items-center gap-2 rounded-lg border bg-card px-2.5"
      aria-label={t("dashboard.announcements")}
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
      onFocus={() => {
        pausedRef.current = true;
      }}
      onBlur={() => {
        pausedRef.current = false;
      }}
    >
      <Megaphone className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
      <div className="relative h-8 flex-1 overflow-hidden">
        <div
          className="flex flex-col will-change-transform"
          style={{
            transform: `translateY(-${pos * ROW_REM}rem)`,
            transition: animating ? "transform 500ms ease" : "none",
          }}
          onTransitionEnd={handleTransitionEnd}
        >
          {rows.map((ad, i) => {
            const link = adLink(ad);
            const isClone = rotating && i === ads.length;
            return (
              <div
                key={`${ad.id}-${i}`}
                aria-hidden={isClone || undefined}
                role={link && !isClone ? "button" : undefined}
                tabIndex={link && !isClone ? 0 : undefined}
                title={adText(ad)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 text-xs text-foreground/90",
                  link && !isClone && "cursor-pointer hover:text-foreground",
                )}
                onClick={() => {
                  if (link && !isClone) openExternalUrl(link);
                }}
                onKeyDown={(e) => {
                  if (!link || isClone) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openExternalUrl(link);
                  }
                }}
              >
                <span className="truncate">{adText(ad)}</span>
                {link && !isClone && (
                  <ArrowUpRight
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
