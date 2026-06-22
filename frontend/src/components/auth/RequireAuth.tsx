// src/components/auth/RequireAuth.tsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/auth";

export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }
  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
