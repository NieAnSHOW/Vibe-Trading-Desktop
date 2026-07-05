import './i18n';
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { router } from "./router";
import { init as initTelemetry } from "@/lib/telemetry";
import { track } from "@/lib/telemetry";
import { hashStack } from "@/lib/telemetry/sanitize";
import "highlight.js/styles/github-dark-dimmed.min.css";
import "./index.css";


// 触发隔天遥测数据 flush（非阻塞）
initTelemetry();

// 全局未捕获错误 → telemetry error 事件
window.addEventListener("error", (e) => {
  try { track("error", { type: e.error?.name ?? "Error", stack_hash: hashStack(e.error?.stack ?? "") }); } catch {}
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton duration={3500} />
    </ErrorBoundary>
  </StrictMode>
);
