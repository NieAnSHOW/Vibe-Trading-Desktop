import { act, render, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWatchlistFeed: vi.fn(),
  refreshWatchlistFeed: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getWatchlistFeed: mocks.getWatchlistFeed,
    refreshWatchlistFeed: mocks.refreshWatchlistFeed,
  },
}));

import { useWatchlistFeed, type WatchlistFeedController } from "../useWatchlistFeed";

// 假计时器测试失败时也要把真实计时器还给后续用例（restoreMocks 不覆盖 fake timers）
beforeEach(() => {
  // restoreMocks 不作用于裸 vi.fn()：调用历史/实现/Once 队列都会跨用例泄漏，逐项重置
  mocks.getWatchlistFeed.mockReset();
  mocks.refreshWatchlistFeed.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const feed = (overrides: Record<string, unknown> = {}) => ({
  items: [] as Array<{ id: string }>,
  new_cursor: null as string | null,
  next_cursor: null as string | null,
  source_health: [{ source_id: "eastmoney", state: "ok", last_success_at: null, last_error: null }],
  last_updated_at: null,
  watchlist_version: "a".repeat(64),
  reset_required: false,
  ...overrides,
});

function Harness({ onState }: { onState: (state: WatchlistFeedController) => void }) {
  onState(useWatchlistFeed());
  return null;
}

test("initial load fetches head page", async () => {
  mocks.getWatchlistFeed.mockResolvedValue(feed({ items: [{ id: "1" }], new_cursor: "wm1", next_cursor: "pg1" }));
  render(<Harness onState={() => {}} />);
  await waitFor(() => expect(mocks.getWatchlistFeed).toHaveBeenCalledWith(null, null, 50));
});

test("poll sends after_cursor and prepends only new items", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1", next_cursor: "pg1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm2" }));
  let latest: WatchlistFeedController | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith("wm1", null, 50);
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2", "1"]); // 新条目前置，旧条目保留
  expect(latest!.feed!.new_cursor).toBe("wm2");   // 水位推进
  expect(latest!.feed!.next_cursor).toBe("pg1");  // 翻页游标不受轮询影响
  vi.useRealTimers();
});

test("poll with no new items keeps stream and watermark", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1" }))
    .mockResolvedValueOnce(feed({ items: [], new_cursor: "wm1" }));
  let latest: WatchlistFeedController | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["1"]);
  expect(latest!.feed!.new_cursor).toBe("wm1");
  vi.useRealTimers();
});

test("skips polling while document is hidden and refetches on visible", async () => {
  vi.useFakeTimers();
  // jsdom 的 hidden 是原型 getter，spyOn 不生效 → 实例属性遮蔽 + 手动还原
  let hidden = true;
  Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
  mocks.getWatchlistFeed.mockResolvedValue(feed());
  render(<Harness onState={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(mocks.getWatchlistFeed).toHaveBeenCalledTimes(0); // hidden 暂停（§6.3）
  hidden = false;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.getWatchlistFeed).toHaveBeenCalled(); // 回前台补拉
  delete (document as unknown as Record<string, unknown>).hidden;
  vi.useRealTimers();
});

test("refresh posts then reloads head page", async () => {
  mocks.getWatchlistFeed.mockResolvedValue(feed({ items: [{ id: "1" }] }));
  mocks.refreshWatchlistFeed.mockResolvedValue({ accepted: true, task_id: "t", reused: false });
  let latest: WatchlistFeedController | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await waitFor(() => expect(latest).not.toBeNull());
  await act(async () => { await latest!.refresh(); });
  expect(mocks.refreshWatchlistFeed).toHaveBeenCalledTimes(1);
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith(null, null, 50);
});

test("loadMore sends before_cursor and appends older items", async () => {
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm1", next_cursor: "pg1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], next_cursor: null }));
  let latest: WatchlistFeedController | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await waitFor(() => expect(latest?.feed?.next_cursor).toBe("pg1"));
  await act(async () => { await latest!.loadMore(); });
  expect(mocks.getWatchlistFeed).toHaveBeenLastCalledWith(null, "pg1", 50);
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2", "1"]); // 更早条目追加在后
  expect(latest!.feed!.next_cursor).toBe(null);
  expect(latest!.feed!.new_cursor).toBe("wm1"); // 翻页不推进水位
});

test("reset_required on poll replaces items", async () => {
  vi.useFakeTimers();
  mocks.getWatchlistFeed
    .mockResolvedValueOnce(feed({ items: [{ id: "1" }], new_cursor: "wm1" }))
    .mockResolvedValueOnce(feed({ items: [{ id: "2" }], new_cursor: "wm2", next_cursor: "pg2", reset_required: true }));
  let latest: WatchlistFeedController | null = null;
  render(<Harness onState={(state) => { latest = state; }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(latest!.feed!.items.map((item) => item.id)).toEqual(["2"]); // 整页替换（服务端已按头部重匹配）
  expect(latest!.feed!.new_cursor).toBe("wm2");
  vi.useRealTimers();
});
