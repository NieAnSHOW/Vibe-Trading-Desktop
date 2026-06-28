// frontend/src/lib/telemetry/track.ts
import { isTelemetryEnabled } from "./consent";
import { sanitize } from "./sanitize";
import { putEvent, localToday } from "./db";

export function track(
  type: string,
  props?: Record<string, unknown>,
  opts?: { name?: string },
): void {
  if (!isTelemetryEnabled()) return; // consent gate（§8）
  const r = sanitize({ type, name: opts?.name, props });
  if (!r.ok) return; // 白名单外静默丢弃（§5）
  // 异步写入，调用方不 await；失败吞掉，绝不影响 UI
  putEvent({ ...r.event, date: localToday() }).catch((e) => {
    // ponytail: 仅 console.warn，IDB 不可用不阻塞功能
    console.warn("[telemetry] putEvent failed", e);
  });
}
