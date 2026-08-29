"""东方财富 7x24 + 新浪滚动并行快讯聚合（规格 §3.1/§5.4；端点证据见规格 §10）。"""

from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from src.news.health import HealthTracker
from src.news.store import EntryStore, StoredEntry, normalize_url
from src.news.transport import TransportClient, TransportError, TransportRequest

EASTMONEY_URL = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
SINA_URL = "https://feed.mix.sina.com.cn/api/roll/get"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


@dataclass(frozen=True)
class FlashBatch:
    source: str
    entries: tuple[StoredEntry, ...]
    cursor: str | None = None
    error: str | None = None


def parse_eastmoney(payload: bytes) -> tuple[list[StoredEntry], str | None]:
    """data.fastNewsList[] → 条目；游标 = max(realSort)；stockList 原样保存（标准化在匹配层 §4.1.1）。"""
    document = json.loads(payload)
    items = (document.get("data") or {}).get("fastNewsList") or []
    entries: list[StoredEntry] = []
    cursor: int | None = None
    for item in items:
        try:
            published_at = datetime.fromtimestamp(int(item["showTime"]), tz=timezone.utc).isoformat()
        except (KeyError, TypeError, ValueError, OSError, OverflowError):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        entries.append(
            StoredEntry(
                source="eastmoney",
                item_id=str(item.get("code") or item.get("realSort") or ""),
                type="flash",
                published_at=published_at,
                title=title,
                summary=str(item.get("summary") or "").strip()[:500],
                url=normalize_url(str(item.get("url") or "")),
                structured_codes=tuple(str(raw) for raw in (item.get("stockList") or [])),
            )
        )
        try:
            real_sort = int(item["realSort"])
        except (KeyError, TypeError, ValueError):
            continue
        cursor = real_sort if cursor is None else max(cursor, real_sort)
    return entries, (str(cursor) if cursor is not None else None)


def parse_sina(payload: bytes) -> list[StoredEntry]:
    """result.data[] → 条目；item_id = url（新浪无原生 id）；ctime 为秒级时间戳。"""
    document = json.loads(payload)
    items = ((document.get("result") or {}).get("data")) or []
    entries: list[StoredEntry] = []
    for item in items:
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        if not title or not url:
            continue
        try:
            published_at = datetime.fromtimestamp(int(item["ctime"]), tz=timezone.utc).isoformat()
        except (KeyError, TypeError, ValueError, OSError, OverflowError):
            continue
        entries.append(
            StoredEntry(
                source="sina",
                item_id=url,
                type="flash",
                published_at=published_at,
                title=title,
                summary=str(item.get("intro") or "").strip()[:500],
                url=normalize_url(url),
                structured_codes=(),
            )
        )
    return entries


class FlashAggregator:
    """东财+新浪并行：各自节奏增量轮询；限流退避 30→60→120s+抖动、3 次挂起；degraded 后 60s 探活。"""

    EASTMONEY_INTERVAL_S = 20.0  # 15-30s 窗口内
    SINA_INTERVAL_S = 25.0
    MIN_SOURCE_SPACING_S = 1.5  # §5.4 单源请求间隔 ≥1.5s
    PROBE_INTERVAL_S = 60.0  # degraded/failed 探活节奏
    RATE_LIMIT_BACKOFF_S = (30.0, 60.0, 120.0)
    RATE_LIMIT_JITTER_S = 5.0
    MAX_RATE_LIMIT_STRIKES = 3
    PURGE_INTERVAL_S = 600.0

    def __init__(
        self,
        transport: TransportClient,
        store: EntryStore,
        health: HealthTracker,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport
        self._store = store
        self._health = health
        self._sleep = sleep
        self._now = now
        self._east_since: str | None = None
        self._due = {"eastmoney": 0.0, "sina": 0.0}
        self._last_request = {"eastmoney": float("-inf"), "sina": float("-inf")}
        self._strikes = {"eastmoney": 0, "sina": 0}
        self._last_purge = 0.0

    async def poll_once(self) -> bool:
        """一轮增量：跳过未到期/退避中的源；返回本轮是否有新条目入库。"""
        progressed = False
        for source in ("eastmoney", "sina"):
            now = self._now()
            if now < self._due[source] or now - self._last_request[source] < self.MIN_SOURCE_SPACING_S:
                continue
            progressed = await self._poll_source(source) or progressed
        if self._now() - self._last_purge >= self.PURGE_INTERVAL_S:
            self._last_purge = self._now()
            self._store.purge_expired()
        return progressed

    async def poll_source_now(self, source: str) -> None:
        """手动强制补拉路径：绕过节奏门，但保留 ≥1.5s 请求间隔。"""
        await self._poll_source(source)

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.poll_once()
            try:
                await asyncio.wait_for(stop.wait(), timeout=1.0)
            except TimeoutError:
                pass

    async def _poll_source(self, source: str) -> bool:
        self._last_request[source] = self._now()
        batch = await (self._fetch_eastmoney() if source == "eastmoney" else self._fetch_sina())
        if batch.error is not None:
            self._health.record_failure(source, batch.error)
            if batch.error in {"rate_limited", "forbidden"}:
                self._suspend_with_backoff(source)
            return False
        inserted = self._store.upsert_entries(batch.entries)
        self._health.record_success(source, advanced=inserted > 0)
        self._strikes[source] = 0
        interval = self.EASTMONEY_INTERVAL_S if source == "eastmoney" else self.SINA_INTERVAL_S
        if self._health.state_of(source) in {"degraded", "failed"}:
            interval = self.PROBE_INTERVAL_S
        self._due[source] = self._now() + interval
        if batch.cursor is not None and source == "eastmoney":
            self._east_since = batch.cursor
        return inserted > 0

    def _suspend_with_backoff(self, source: str) -> None:
        self._strikes[source] += 1
        index = min(self._strikes[source], len(self.RATE_LIMIT_BACKOFF_S)) - 1
        delay = self.RATE_LIMIT_BACKOFF_S[index] + random.uniform(0.0, self.RATE_LIMIT_JITTER_S)
        self._due[source] = self._now() + delay

    async def _fetch_eastmoney(self) -> FlashBatch:
        request = TransportRequest(
            url=EASTMONEY_URL,
            query={
                "client": "web",
                "biz": "web_724",
                "fastColumn": "102",
                "sortEnd": self._east_since or "",
                "pageSize": "20",
                "req_trace": str(uuid.uuid4()),
            },
            headers={
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
                "Referer": "https://kuaixun.eastmoney.com/",
            },
        )
        try:
            response = await self._transport.fetch(request)
        except TransportError as error:
            return FlashBatch(source="eastmoney", entries=(), error=error.code)
        entries, cursor = parse_eastmoney(response.body)
        return FlashBatch(source="eastmoney", entries=tuple(entries), cursor=cursor)

    async def _fetch_sina(self) -> FlashBatch:
        request = TransportRequest(
            url=SINA_URL,
            query={"pageid": "153", "lid": "2516", "k": "", "num": "50", "page": "1"},
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            response = await self._transport.fetch(request)
        except TransportError as error:
            return FlashBatch(source="sina", entries=(), error=error.code)
        return FlashBatch(source="sina", entries=tuple(parse_sina(response.body)))
