import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import type { WatchlistFeed } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn().mockResolvedValue(undefined),
  state: { feed: null as WatchlistFeed | null, isLoading: false, isRefreshing: false, error: null as string | null },
}));

vi.mock("@/hooks/useWatchlistFeed", () => ({
  useWatchlistFeed: () => ({
    ...mocks.state,
    refresh: mocks.refresh,
    loadMore: mocks.loadMore,
  }),
}));

import { News } from "../News";

const feed = (overrides: Partial<WatchlistFeed> = {}): WatchlistFeed => ({
  items: [
    {
      id: "sse:abc", source: "sse", type: "announcement",
      published_at: "2026-08-28T10:30:00+00:00",
      title: "关于召开临时股东大会的通知", summary: "摘要内容",
      url: "https://static.sse.com.cn/x.pdf",
      matched_stocks: [{ code: "600519", name: "贵州茅台", match_rule: "structured_field" }],
      confidence: "high",
    },
    {
      id: "eastmoney:1", source: "eastmoney", type: "flash",
      published_at: "2026-08-29T12:00:00+00:00", title: "央行开展逆回购", summary: "",
      url: null, matched_stocks: [], confidence: "high",
    },
  ],
  next_cursor: null,
  source_health: [
    { source_id: "eastmoney", state: "ok", last_success_at: null, last_error: null },
    { source_id: "sina", state: "ok", last_success_at: null, last_error: null },
    { source_id: "sse", state: "degraded", last_success_at: null, last_error: "timeout" },
    { source_id: "szse", state: "ok", last_success_at: null, last_error: null },
  ],
  last_updated_at: "2026-08-29T12:00:01+00:00",
  watchlist_version: "a".repeat(64),
  reset_required: false,
  ...overrides,
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

test("renders unified stream with announcement badge and stock badge link", () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  expect(screen.getByText("关于召开临时股东大会的通知")).toBeInTheDocument();
  expect(screen.getByText("公告")).toBeInTheDocument(); // 公告置顶标识（§6.3）
  const badge = screen.getByText("600519 贵州茅台");
  expect(badge).toHaveAttribute("href", "/watchlist"); // 股票徽标跳自选管理（§6.3）
});

test("shows degraded hint but not banner when any source is ok", () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  expect(screen.getByText("上交所源暂时不可用，数据可能不完整")).toBeInTheDocument(); // 单源降级小字提示（§6.3）
  expect(screen.queryByText("数据可能延迟")).not.toBeInTheDocument();
});

test("shows delayed banner when all sources failed", () => {
  const all = feed().source_health.map((health) => ({ ...health, state: "failed" as const }));
  mocks.state = { feed: feed({ source_health: all }), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  expect(screen.getByText("数据可能延迟")).toBeInTheDocument(); // 全源失败横幅（§5.7）
});

test("shows empty-watchlist guidance when no items and no failures", () => {
  mocks.state = { feed: feed({ items: [] }), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  expect(screen.getByText("还没有自选股")).toBeInTheDocument();
  expect(screen.getByText("去添加自选").closest("a")).toHaveAttribute("href", "/watchlist");
});

test("manual refresh calls hook refresh", async () => {
  mocks.state = { feed: feed(), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

test("load more button appears when next_cursor exists", async () => {
  mocks.state = { feed: feed({ next_cursor: "cursor" }), isLoading: false, isRefreshing: false, error: null };
  render(<MemoryRouter><News /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "加载更早" }));
  expect(mocks.loadMore).toHaveBeenCalledTimes(1);
});
