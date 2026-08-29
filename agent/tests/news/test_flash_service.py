"""TDD：东财+新浪快讯聚合器——解析/游标/限流退避/健康上报（规格 §3.1/§5.4）。"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

import httpx

from src.news.calendar import ConservativeCalendar
from src.news.flash.service import FlashAggregator, parse_eastmoney, parse_sina
from src.news.health import HealthTracker
from src.news.store import EntryStore
from src.news.transport import TransportClient


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


class FakeResolver:
    async def resolve(self, host: str) -> list[str]:
        return ["93.184.216.34"]


class RoutingTransport(httpx.AsyncBaseTransport):
    """按 path 路由（忽略 query 与 host——传输层会把 host 重写为解析出的 IP），返回预设响应。"""

    def __init__(self, routes: dict[str, list[httpx.Response]]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = str(request.url.path)
        responses = self.routes[key]
        return responses.pop(0) if len(responses) > 1 else responses[0]


@dataclass
class Clock:
    value: float = 1000.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


async def _no_sleep(_seconds: float) -> None:
    return None


def _tracker() -> HealthTracker:
    return HealthTracker(ConservativeCalendar(), now=lambda: datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc))


def _eastmoney_payload() -> bytes:
    return json.dumps(
        {
            "data": {
                "fastNewsList": [
                    {
                        "code": "202608291200",
                        "title": "央行开展逆回购",
                        "summary": "500亿元",
                        "showTime": 1787985600,
                        "realSort": 1787985600,
                        "stockList": ["1.600519", "0.000001"],
                    },
                    {
                        "code": "202608291199",
                        "title": "某公司发布公告",
                        "summary": "",
                        "showTime": 1787985500,
                        "realSort": 1787985500,
                        "stockList": [],
                    },
                ]
            }
        }
    ).encode()


def test_parse_eastmoney_builds_entries_and_cursor():
    entries, cursor = parse_eastmoney(_eastmoney_payload())
    assert cursor == "1787985600"
    assert [entry.item_id for entry in entries] == ["202608291200", "202608291199"]
    assert entries[0].structured_codes == ("1.600519", "0.000001")  # 原样保存，标准化在匹配层
    assert entries[0].type == "flash"


def test_parse_sina_builds_entries():
    payload = json.dumps(
        {
            "result": {
                "data": [
                    {
                        "title": "新浪快讯",
                        "intro": "内容",
                        "ctime": 1787985600,
                        "url": "https://finance.sina.com.cn/a.html?utm_source=rss",
                    },
                ]
            }
        }
    ).encode()
    entries = parse_sina(payload)
    assert len(entries) == 1
    assert entries[0].source == "sina"
    assert entries[0].url == "https://finance.sina.com.cn/a.html"  # utm 剥离


@_async_test
async def test_poll_once_ingests_both_sources_and_reports_health(tmp_path):
    transport = RoutingTransport(
        {
            "/comm/web/getFastNewsList": [
                httpx.Response(200, headers={"content-type": "application/json"}, content=_eastmoney_payload())
            ],
            "/api/roll/get": [
                httpx.Response(
                    200,
                    headers={"content-type": "application/json"},
                    content=json.dumps(
                        {
                            "result": {
                                "data": [
                                    {
                                        "title": "新浪快讯",
                                        "intro": "",
                                        "ctime": 1787985600,
                                        "url": "https://finance.sina.com.cn/b.html",
                                    }
                                ]
                            }
                        }
                    ).encode(),
                )
            ],
        }
    )
    clock = Clock()
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    aggregator = FlashAggregator(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store,
        health=health,
        sleep=_no_sleep,
        now=clock.now,
    )

    assert await aggregator.poll_once() is True
    assert len(store.window_merged(limit=10)) == 3
    assert health.state_of("eastmoney") == "ok"
    assert health.state_of("sina") == "ok"
    east_request = next(r for r in transport.requests if "getFastNewsList" in str(r.url))
    assert "req_trace" in str(east_request)


@_async_test
async def test_rate_limit_backoff_suspends_source(tmp_path):
    transport = RoutingTransport(
        {
            "/comm/web/getFastNewsList": [
                httpx.Response(429, headers={"content-type": "text/plain", "retry-after": "0"}),
            ],
            "/api/roll/get": [
                httpx.Response(
                    200,
                    headers={"content-type": "application/json"},
                    content=json.dumps({"result": {"data": []}}).encode(),
                ),
            ],
        }
    )
    clock = Clock()
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    aggregator = FlashAggregator(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store,
        health=health,
        sleep=_no_sleep,
        now=clock.now,
    )

    await aggregator.poll_once()  # eastmoney 429 → 重试 3 次耗尽 → 退避挂起；sina 空页成功
    assert health.state_of("eastmoney") in {"degraded", "failed"}
    east_calls = [r for r in transport.requests if "getFastNewsList" in str(r.url)]
    assert len(east_calls) == 3  # MAX_ATTEMPTS

    transport.requests.clear()
    await aggregator.poll_once()  # eastmoney 处于退避窗口内 → 跳过；不再发请求
    assert not [r for r in transport.requests if "getFastNewsList" in str(r.url)]


# --- FeedRefreshCoordinator（§6.1.1 single-flight + 5s 限流）---
from src.news.refresh import FeedRefreshCoordinator  # noqa: E402


class StubAnnouncements:
    def __init__(self) -> None:
        self.calls: list[bool] = []

    async def maybe_refresh(self, *, force: bool = False) -> None:
        self.calls.append(force)


@_async_test
async def test_refresh_single_flight_and_rate_limit(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    aggregator = FlashAggregator(
        transport=TransportClient(resolver=FakeResolver(), transport=RoutingTransport({
            "/comm/web/getFastNewsList": [
                httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps({"data": {"fastNewsList": []}}).encode()),
            ],
            "/api/roll/get": [
                httpx.Response(200, headers={"content-type": "application/json"}, content=json.dumps({"result": {"data": []}}).encode()),
            ],
        })),
        store=store, health=_tracker(), sleep=_no_sleep, now=Clock().now,
    )
    announcements = StubAnnouncements()
    coordinator = FeedRefreshCoordinator(flash=aggregator, announcements=announcements,
                                         now=lambda: 1000.0)
    first = await coordinator.trigger()
    assert (first.accepted, first.reused, first.rate_limited) == (True, False, False)
    assert first.task_id
    second = await coordinator.trigger()  # 任务运行中 → reuse
    assert (second.accepted, second.reused, second.task_id == first.task_id) == (True, True, True)

    await coordinator._task  # 等待任务结束后测试 5s 限流窗口
    await asyncio.sleep(0)
    limited = await coordinator.trigger()
    assert limited.rate_limited is True  # now 固定 1000.0 < 5s 窗口
    assert announcements.calls == [False]  # 公告走 2min 门控，不走 force
