// frontend/src/lib/telemetry/uploader.ts
import { getBucketsBefore, deleteBucket, purgeOld, localToday } from "./db";
import { getDeviceId } from "./device-id";
import { fetchSidecarMetrics } from "./metrics";
import type { SidecarMetrics, TelemetryBatch, UploadResponse } from "./types";

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string) || "0.0.0";

let _backoff = [2_000, 8_000, 30_000];
let _endpoint = `${import.meta.env.VITE_USER_API_BASE ?? ""}/telemetry/open/events/events`;
let _tokenGetter: () => string | null = () => {
  try {
    const raw = localStorage.getItem("vibe_trading_auth");
    return raw ? (JSON.parse(raw).state?.token ?? null) : null;
  } catch {
    return null;
  }
};

export function setUploadEndpoint(url: string): void {
  _endpoint = url;
}

export function __setTokenGetterForTest(fn: () => string | null): void {
  _tokenGetter = fn;
}

export function __setBackoffMsForTest(ms: number[]): void {
  _backoff = ms;
}

async function uploadOnce(batch: TelemetryBatch, token: string | null): Promise<number> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(_endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(batch),
  });
  if (res.ok) {
    try { await res.json() as UploadResponse; } catch { /* ignore parse errors */ }
    return 200;
  }
  return res.status;
}

async function uploadBatchWithRetry(batch: TelemetryBatch, token: string | null): Promise<boolean> {
  for (let attempt = 0; attempt <= _backoff.length; attempt++) {
    const status = await uploadOnce(batch, token);
    if (status === 200) return true;
    // 4xx (non-429): poison pill, discard
    if (status >= 400 && status < 500 && status !== 429) return true; // treated as handled
    // 5xx / 429 / network error: backoff retry, max 3 retries
    if (attempt < _backoff.length) {
      await new Promise((r) => setTimeout(r, _backoff[attempt]));
    } else {
      return false; // retain for next startup
    }
  }
  return false;
}

export async function flushNow(): Promise<void> {
  // Purge expired buckets first (>14 days) so they are never uploaded
  await purgeOld(14).catch(() => 0);

  const today = localToday();
  const buckets = await getBucketsBefore(today);
  const token = _tokenGetter();
  const dates = Object.keys(buckets).sort(); // ascending by date
  for (const date of dates) {
    const events = buckets[date];
    if (!events?.length) continue;
    if (date === today) continue; // today's data not uploaded (defense; getBucketsBefore already excluded)
    let sidecarMetrics: SidecarMetrics | null = null;
    try { sidecarMetrics = await fetchSidecarMetrics(); } catch { sidecarMetrics = null; }
    const batch: TelemetryBatch = {
      device_id: getDeviceId(),
      app_version: APP_VERSION,
      batch_date: date,
      events,
      sidecar_metrics: sidecarMetrics ?? {
        since: 0,
        skill_calls: {},
        backtests: { count: 0, total_ms: 0, by_engine: {} },
        errors: { count: 0, by_type: {} },
      },
    };
    const ok = await uploadBatchWithRetry(batch, token).catch(() => false);
    if (ok) await deleteBucket(date);
  }
}
