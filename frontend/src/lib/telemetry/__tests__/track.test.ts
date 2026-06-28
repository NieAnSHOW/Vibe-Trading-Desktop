// frontend/src/lib/telemetry/__tests__/track.test.ts
import { track } from "../track";
import { setConsent, resetConsentForTest } from "../consent";
import { getBucketsBefore } from "../db";

beforeEach(async () => {
  localStorage.clear();
  resetConsentForTest();
  const req = indexedDB.deleteDatabase("vibe_telemetry");
  await new Promise<void>((r) => { req.onsuccess = () => r(); req.onerror = () => r(); });
});

it("consent 开 → 写入当天桶", async () => {
  track("page_view", { route: "/agent" });
  // 写入是异步的，等一个微任务+setTimeout
  await new Promise((r) => setTimeout(r, 10));
  const today = new Date().toLocaleDateString("en-CA");
  const buckets = await getBucketsBefore(shiftTomorrow(today));
  const evs = buckets[today] ?? [];
  expect(evs.some((e) => e.type === "page_view" && (e.props as any).route === "/agent")).toBe(true);
});

it("consent 关 → 不写入", async () => {
  await setConsent(false);
  track("page_view", { route: "/agent" });
  await new Promise((r) => setTimeout(r, 10));
  const today = new Date().toLocaleDateString("en-CA");
  const buckets = await getBucketsBefore(shiftTomorrow(today));
  expect(buckets[today] ?? []).toHaveLength(0);
});

it("白名单外 type 不写入不抛错", async () => {
  expect(() => track("bogus", { anything: 1 })).not.toThrow();
  await new Promise((r) => setTimeout(r, 10));
  const today = new Date().toLocaleDateString("en-CA");
  const buckets = await getBucketsBefore(shiftTomorrow(today));
  expect(buckets[today] ?? []).toHaveLength(0);
});

function shiftTomorrow(d: string): string {
  const [y, m, dd] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, dd); dt.setDate(dt.getDate() + 1);
  return dt.toLocaleDateString("en-CA");
}
