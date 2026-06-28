// frontend/src/lib/telemetry/__tests__/uploader.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushNow, setUploadEndpoint, __setTokenGetterForTest, __setBackoffMsForTest } from "../uploader";
import { putEvent } from "../db";
import { setConsent, resetConsentForTest } from "../consent";

let posted: { url: string; body: any; auth: string | null }[] = [];

beforeEach(async () => {
  localStorage.clear();
  resetConsentForTest();
  posted = [];
  __setTokenGetterForTest(() => null);
  __setBackoffMsForTest([2_000, 8_000, 30_000]); // reset to defaults
  setUploadEndpoint("https://test.invalid/events");
  const req = indexedDB.deleteDatabase("vibe_telemetry");
  await new Promise<void>((r) => { req.onsuccess = () => r(); req.onerror = () => r(); });
});

function mockFetch(status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    posted.push({ url, body: JSON.parse(init.body), auth: init.headers?.Authorization ?? null });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ accepted: true, accepted_count: posted.at(-1)!.body.events.length }) };
  }));
}

describe("uploader", () => {
  it("scans date<today batches, uploads, deletes on 2xx", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    await putEvent({ ts: 1, type: "page_view", props: { route: "/a" }, date: "2026-06-27" });
    mockFetch(200);
    await flushNow();
    expect(posted).toHaveLength(1);
    expect(posted[0].body.batch_date).toBe("2026-06-27");
    expect(posted[0].body.device_id).toBeTruthy();
    expect(posted[0].body.events).toHaveLength(1);
    // body must not contain user_id
    expect(posted[0].body).not.toHaveProperty("user_id");
    vi.useRealTimers();
  });

  it("does not upload today's data (same-day restarts)", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-28" }); // today
    mockFetch(200);
    await flushNow();
    expect(posted).toHaveLength(0);
    vi.useRealTimers();
  });

  it("no Authorization when not logged in", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    __setTokenGetterForTest(() => null);
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-27" });
    mockFetch(200);
    await flushNow();
    expect(posted[0].auth).toBeNull();
    vi.useRealTimers();
  });

  it("attaches Bearer token when logged in", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    __setTokenGetterForTest(() => "VIP-TOKEN");
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-27" });
    mockFetch(200);
    await flushNow();
    expect(posted[0].auth).toBe("Bearer VIP-TOKEN");
    vi.useRealTimers();
  });

  it("backoff <= 3 retries on failure, retains data", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    __setBackoffMsForTest([0, 0, 0]); // instant retries for test
    let uploadCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      // only count POST calls to our endpoint (not sidecar GET)
      if (init?.method === "POST") uploadCalls++;
      return { ok: false, status: 500, json: async () => ({}) };
    }));
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-27" });
    await flushNow();
    // 4 total upload calls: 1 initial + 3 retries
    expect(uploadCalls).toBe(4);
    vi.useRealTimers();
  });

  it("4xx (non-429) is a poison pill — discard, no retry", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    let uploadCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      if (init?.method === "POST") uploadCalls++;
      return { ok: false, status: 400, json: async () => ({}) };
    }));
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-27" });
    await flushNow();
    // 1 upload call: returns 400, treated as poison pill, no retry
    expect(uploadCalls).toBe(1);
    vi.useRealTimers();
  });

  it("consent off still uploads historical batches once", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-27" });
    await setConsent(false);
    mockFetch(200);
    await flushNow();
    expect(posted).toHaveLength(1); // historical batch still uploaded
    vi.useRealTimers();
  });

  it(">14 day batches are purged by purgeOld", async () => {
    vi.setSystemTime(new Date(2026, 5, 28));
    await putEvent({ ts: 1, type: "page_view", props: {}, date: "2026-06-10" }); // >14d
    mockFetch(200);
    await flushNow();
    expect(posted.find((p) => p.body.batch_date === "2026-06-10")).toBeUndefined();
    vi.useRealTimers();
  });
});
