// src/components/layout/UserMenu.tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, LogOut, User } from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { useTranslation } from "react-i18next";

export function UserMenu() {
  const { t } = useTranslation();
  const status = useAuthStore((s) => s.status);
  const userInfo = useAuthStore((s) => s.userInfo);
  const logout = useAuthStore((s) => s.logout);
  const [open, setOpen] = useState(false);

  if (status === "loading") {
    return <div className="h-7 w-7 animate-pulse rounded-full bg-muted" />;
  }
  if (status !== "authenticated") {
    return (
      <Link
        to="/login"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted"
      >
        <User className="h-3.5 w-3.5" />
        {t("userMenu.login")}
      </Link>
    );
  }

  const name = userInfo?.nickName || t("userMenu.guest");
  const initial = name.slice(0, 1).toUpperCase();

  return (
    <div className="relative" data-testid="user-menu">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] text-primary">
          {initial}
        </span>
        <span className="max-w-[8rem] truncate">{name}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border bg-card p-1 text-xs shadow-md">
            <Link
              to="/profile"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-foreground hover:bg-muted"
            >
              <User className="h-3.5 w-3.5" />
              {t("userMenu.profile")}
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                logout();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-danger hover:bg-danger/10"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t("userMenu.logout")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
