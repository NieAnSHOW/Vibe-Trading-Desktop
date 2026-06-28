// frontend/src/lib/telemetry/metrics.ts
import type { SidecarMetrics } from "./types";

export async function fetchSidecarMetrics(): Promise<SidecarMetrics | null> {
  try {
    const res = await fetch("/telemetry/sidecar-metrics", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<SidecarMetrics>;
    if (
      typeof body.since !== "number" ||
      typeof body.skill_calls !== "object" ||
      typeof body.backtests !== "object" ||
      typeof body.errors !== "object"
    ) {
      return null;
    }
    return body as SidecarMetrics;
  } catch {
    return null; // sidecar 不可达：best-effort 跳过（§9）
  }
}
