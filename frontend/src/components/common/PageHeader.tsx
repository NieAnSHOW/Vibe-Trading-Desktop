import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Trading Worker 页头:金色等宽 kicker + 衬线标题 + 副标题。
 * 每页只出现一次, kicker 用固定英文单词 (如 "Market" / "Research"),
 * 不做逐节 eyebrow。actions 槽放页面级操作按钮(刷新/新建等)。
 */
export function PageHeader({
  kicker,
  title,
  sub,
  actions,
  className,
}: {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-4 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="tw-kicker">{kicker}</p>
        <h1 className="tw-page-title">{title}</h1>
        {sub != null && <p className="tw-page-sub">{sub}</p>}
      </div>
      {actions != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-0.5">
          {actions}
        </div>
      )}
    </header>
  );
}
