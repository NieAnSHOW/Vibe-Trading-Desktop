"""TDD：公告采集——上交所 jsonp 解析 / 深交所 HTML 解析 / 降级链 / 2min 门控（规格 §3.1/§5.3）。"""

from __future__ import annotations

import asyncio
import hashlib
import json
from functools import wraps
from typing import Any, Callable

import httpx

from src.news.announcements.collector import AnnouncementCollector, parse_sse, parse_szse_html, strip_jsonp
from src.news.calendar import ConservativeCalendar
from src.news.health import HealthTracker
from src.news.store import EntryStore
from src.news.transport import TransportClient

SSE_RAW = (
    'jsonp123({"pageHelp": {"data": [{"SECURITY_CODE": "600519", "SECURITY_NAME": "贵州茅台", '
    '"TITLE": "关于召开2026年第一次临时股东大会的通知", "SSEDATE": "2026-08-28", "SSETIME": "18:30", '
    '"URL": "/disclosure/listedinfo/announcement/c/new/2026-08-28/600519_20260828.pdf"}]}});'
).encode("utf-8")
SZSE_HTML = """
<html><body><table>
<tr><td class="date">2026-08-28</td><td><a href="/disclosure/notice/notice.pdf">关于变更持续督导保荐代表人的公告</a></td></tr>
<tr><td class="date">2026-08-27</td><td><a href="/disclosure/notice/other.pdf">2026年半年度报告</a></td></tr>
</table></body></html>
""".encode("utf-8")


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


async def _no_sleep(_seconds: float) -> None:
    return None


class FakeResolver:
    async def resolve(self, host: str) -> list[str]:
        return ["93.184.216.34"]


class RoutingTransport(httpx.AsyncBaseTransport):
    """按 path 路由（忽略 query 与 host——传输层会把 host 重写为解析出的 IP）。"""

    def __init__(self, routes: dict[str, httpx.Response]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.routes[str(request.url.path)]


def _tracker() -> HealthTracker:
    return HealthTracker(ConservativeCalendar())


def test_strip_jsonp_unwraps_shell():
    assert json.loads(strip_jsonp('cb({"a": 1});')) == {"a": 1}


def test_parse_sse_builds_entries_with_dedup_key():
    entries = parse_sse(SSE_RAW)
    assert len(entries) == 1
    entry = entries[0]
    expected_id = hashlib.sha1("600519|2026-08-28|关于召开2026年第一次临时股东大会的通知".encode()).hexdigest()
    assert entry.item_id == expected_id  # 去重键 (code, ann_date, title)
    assert entry.source == "sse"
    assert entry.type == "announcement"
    assert entry.structured_codes == ("600519",)
    assert (
        entry.url == "https://static.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-08-28/600519_20260828.pdf"
    )
    assert entry.published_at.startswith("2026-08-28T10:30")  # 18:30 +08:00 → UTC


def test_parse_szse_html_extracts_rows():
    entries = parse_szse_html(SZSE_HTML)
    assert [entry.title for entry in entries] == [
        "关于变更持续督导保荐代表人的公告",
        "2026年半年度报告",
    ]
    assert entries[0].source == "szse"
    assert entries[0].structured_codes == ()  # 深交所 HTML 无证券代码字段，仅标题匹配
    assert entries[0].item_id  # title+date 派生 id


@_async_test
async def test_poll_once_prefers_sse_and_falls_back_on_failure(tmp_path):
    transport = RoutingTransport(
        {
            "/security/stock/queryCompanyBulletin.do": httpx.Response(500, headers={"content-type": "text/plain"}),
            "/disclosure/notice/index.html": httpx.Response(
                200, headers={"content-type": "text/html"}, content=SZSE_HTML
            ),
        }
    )
    store = EntryStore(tmp_path / "news.db")
    health = _tracker()
    collector = AnnouncementCollector(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store,
        health=health,
        sleep=_no_sleep,
    )
    assert await collector.poll_once() is True
    titles = [entry.title for entry in store.window_merged(limit=10)]
    assert "2026年半年度报告" in titles  # sse 失败 → szse 备源接住
    assert health.state_of("sse") != "ok"  # 单次失败仅累计；连续 3 次才 degraded（§5.1）
    assert health.state_of("szse") == "ok"


@_async_test
async def test_maybe_refresh_respects_two_minute_gate(tmp_path):
    transport = RoutingTransport(
        {
            "/security/stock/queryCompanyBulletin.do": httpx.Response(
                200, headers={"content-type": "text/plain"}, content=SSE_RAW
            ),
        }
    )
    store = EntryStore(tmp_path / "news.db")
    collector = AnnouncementCollector(
        transport=TransportClient(resolver=FakeResolver(), transport=transport),
        store=store,
        health=_tracker(),
        sleep=_no_sleep,
    )
    await collector.maybe_refresh(force=False)  # 首次（距上次拉取无穷远）→ 允许
    first_requests = len(transport.requests)
    assert first_requests == 1
    await collector.maybe_refresh(force=False)  # 刚拉取过 → 2min 门控拦截
    assert len(transport.requests) == first_requests
    await collector.maybe_refresh(force=True)  # 强制绕过
    assert len(transport.requests) == first_requests + 1
