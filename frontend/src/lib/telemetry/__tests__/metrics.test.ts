// frontend/src/lib/telemetry/__tests__/metrics.test.ts
import { fetchSidecarMetrics } from "../metrics";

afterEach(() => vi.restoreAllMocks());

it("成功返回聚合对象", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ since: 1, skill_calls: { a: 1 }, backtests: { count: 0, total_ms: 0, by_engine: {} }, errors: { count: 0, by_type: {} } }),
  })));
  const m = await fetchSidecarMetrics();
  expect(m).not.toBeNull();
  expect(m?.skill_calls).toEqual({ a: 1 });
});

it("sidecar 不可达 → 返回 null 不抛", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
  await expect(fetchSidecarMetrics()).resolves.toBeNull();
});

it("非 2xx → 返回 null", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
  await expect(fetchSidecarMetrics()).resolves.toBeNull();
});
