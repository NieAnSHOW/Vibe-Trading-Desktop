import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, type WatchlistFeed } from "@/lib/api";

const POLL_INTERVAL_MS = 12_000; // 规格 §6.3：10-15s 短轮询
const PAGE_LIMIT = 50;           // 规格 §6.1 items 上限

export interface WatchlistFeedState {
  feed: WatchlistFeed | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
}

export interface WatchlistFeedController extends WatchlistFeedState {
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

type FeedAction =
  | { type: "loaded"; feed: WatchlistFeed }   // 首屏/整页替换
  | { type: "polled"; feed: WatchlistFeed }   // 轮询：增量合并新条目
  | { type: "appended"; feed: WatchlistFeed } // 上滑：追加更早条目
  | { type: "refreshing"; value: boolean }
  | { type: "failed"; error: string };

function mergeNewer(current: WatchlistFeed, incoming: WatchlistFeed): WatchlistFeed {
  const seen = new Set(current.items.map((item) => item.id));
  // after 模式服务端升序交付（防 poll 丢条目），前端 reverse 后前置，维持新→旧展示序
  const fresh = incoming.items.filter((item) => !seen.has(item.id)).reverse();
  return {
    ...current,
    items: [...fresh, ...current.items],
    new_cursor: incoming.new_cursor ?? current.new_cursor, // 水位推进；无新条目时回传原水位
    source_health: incoming.source_health,
    last_updated_at: incoming.last_updated_at,
    reset_required: false,
  };
}

function mergeOlder(current: WatchlistFeed, incoming: WatchlistFeed): WatchlistFeed {
  const seen = new Set(current.items.map((item) => item.id));
  const older = incoming.items.filter((item) => !seen.has(item.id));
  return {
    ...current,
    items: [...current.items, ...older],
    next_cursor: incoming.next_cursor,
    source_health: incoming.source_health,
    last_updated_at: incoming.last_updated_at,
    reset_required: false,
  };
}

function reduce(state: WatchlistFeedState, action: FeedAction): WatchlistFeedState {
  switch (action.type) {
    case "loaded":
      return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
    case "polled":
      if (!state.feed || action.feed.reset_required) {
        // reset_required：服务端已按窗口头部重匹配 → 整页替换
        return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
      }
      return { feed: mergeNewer(state.feed, action.feed), isLoading: false, isRefreshing: false, error: null };
    case "appended":
      if (!state.feed || action.feed.reset_required) {
        return { feed: action.feed, isLoading: false, isRefreshing: false, error: null };
      }
      return { feed: mergeOlder(state.feed, action.feed), isLoading: false, isRefreshing: false, error: null };
    case "refreshing":
      return { ...state, isRefreshing: action.value };
    case "failed":
      return { ...state, isLoading: false, isRefreshing: false, error: action.error };
  }
}

function wasAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWatchlistFeed(): WatchlistFeedController {
  const [state, dispatch] = useReducer(reduce, { feed: null, isLoading: true, isRefreshing: false, error: null });
  const feedRef = useRef(state.feed);
  feedRef.current = state.feed;

  const loadHead = useCallback(async () => {
    try {
      const response = await api.getWatchlistFeed(null, null, PAGE_LIMIT);
      dispatch({ type: "loaded", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  const poll = useCallback(async () => {
    const watermark = feedRef.current?.new_cursor ?? null;
    try {
      const response = await api.getWatchlistFeed(watermark, null, PAGE_LIMIT);
      dispatch({ type: "polled", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  const refresh = useCallback(async () => {
    dispatch({ type: "refreshing", value: true });
    try {
      await api.refreshWatchlistFeed();
    } catch {
      // 429/网络失败不阻断：随后仍立即 GET 拉新（§6.1.1 前端约定）
    }
    await loadHead();
    dispatch({ type: "refreshing", value: false });
  }, [loadHead]);

  const loadMore = useCallback(async () => {
    const cursor = feedRef.current?.next_cursor ?? null;
    if (!cursor) return;
    try {
      const response = await api.getWatchlistFeed(null, cursor, PAGE_LIMIT);
      dispatch({ type: "appended", feed: response });
    } catch (error) {
      if (wasAborted(error)) return;
      dispatch({ type: "failed", error: failureMessage(error) });
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) return; // hidden 暂停（§6.3）
      if (feedRef.current === null) await loadHead();
      else await poll();
    };
    const schedule = () => {
      timer = setTimeout(() => {
        timer = undefined;
        void tick().then(() => {
          if (active) schedule();
        });
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) void poll(); // 回前台补拉（§6.3）
    };
    void tick();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadHead, poll]);

  return { ...state, refresh, loadMore };
}
