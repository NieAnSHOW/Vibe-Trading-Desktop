"""公告采集：上交所 jsonp 主源 → 深交所 HTML 备源降级链（规格 §3.1/§5.3；端点证据见规格 §10）。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

from src.news.health import HealthTracker
from src.news.store import EntryStore, StoredEntry, normalize_url
from src.news.transport import TransportClient, TransportError, TransportRequest

from src.news.flash.service import USER_AGENT  # 共享 UA 常量

SSE_URL = "https://query.sse.com.cn/security/stock/queryCompanyBulletin.do"
SZSE_URL = "https://www.szse.cn/disclosure/notice/index.html"
STATIC_SSE_PREFIX = "https://static.sse.com.cn"
_TZ_SHANGHAI = timezone(timedelta(hours=8))

POLL_INTERVAL_S = 480.0  # 5-10min 区间
FORCE_REFRESH_GAP_S = 120.0  # 手动补拉仅当距上次拉取 >2min（§6.1.1）


def strip_jsonp(payload: str) -> str:
    """剥 jsonp 壳：取首个 '(' 到末尾 ')' 之间的 JSON 文本。"""
    match = re.search(r"\((.*)\)\s*;?\s*$", payload.strip(), re.DOTALL)
    if not match:
        raise ValueError("jsonp shell not found")
    return match.group(1)


def parse_sse(payload: bytes) -> list[StoredEntry]:
    """上交所 jsonp → 条目；去重键 (code, ann_date, title) → item_id；URL 为 PDF 相对路径拼接。"""
    document = json.loads(strip_jsonp(payload.decode("utf-8", errors="replace")))
    rows = ((document.get("pageHelp") or {}).get("data")) or []
    entries: list[StoredEntry] = []
    for row in rows:
        code = str(row.get("SECURITY_CODE") or "").strip()
        title = str(row.get("TITLE") or "").strip()
        date_text = str(row.get("SSEDATE") or "").strip()
        if not code or not title or not date_text:
            continue
        time_text = str(row.get("SSETIME") or "00:00").strip() or "00:00"
        try:
            published_at = (
                datetime.fromisoformat(f"{date_text}T{time_text}:00")
                .replace(tzinfo=_TZ_SHANGHAI)
                .astimezone(timezone.utc)
                .isoformat()
            )
        except ValueError:
            continue
        relative = str(row.get("URL") or "").strip()
        entries.append(
            StoredEntry(
                source="sse",
                item_id=hashlib.sha1(f"{code}|{date_text}|{title}".encode("utf-8")).hexdigest(),
                type="announcement",
                published_at=published_at,
                title=title,
                summary="",
                url=normalize_url(f"{STATIC_SSE_PREFIX}{relative}") if relative else "",
                structured_codes=(code,),
            )
        )
    return entries


class _NoticeLinkParser(HTMLParser):
    """深交所服务端渲染频道：收集公告 <a> 行与其前的最近日期文本。"""

    _DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[tuple[str, str, str]] = []  # (title, href, date)
        self._in_link = False
        self._href = ""
        self._chunks: list[str] = []
        self._last_date = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if "/disclosure/" in href or href.endswith(".pdf"):
                self._in_link = True
                self._href = href
                self._chunks = []

    def handle_data(self, data: str) -> None:
        date_match = self._DATE_PATTERN.search(data)
        if date_match:
            self._last_date = date_match.group(0)
        if self._in_link:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_link:
            self._in_link = False
            title = "".join(self._chunks).strip()
            if title:
                self.rows.append((title, self._href, self._last_date))


def parse_szse_html(payload: bytes) -> list[StoredEntry]:
    """深交所 HTML 频道 → 条目；无证券代码字段，仅标题匹配（中置信度）。"""
    parser = _NoticeLinkParser()
    parser.feed(payload.decode("utf-8", errors="replace"))
    entries: list[StoredEntry] = []
    for title, href, date_text in parser.rows:
        entries.append(
            StoredEntry(
                source="szse",
                item_id=hashlib.sha1(f"szse|{date_text}|{title}".encode("utf-8")).hexdigest(),
                type="announcement",
                published_at=(f"{date_text}T00:00:00+00:00" if date_text else ""),
                title=title,
                summary="",
                url=normalize_url(f"https://www.szse.cn{href}" if href.startswith("/") else href),
                structured_codes=(),
            )
        )
    return [entry for entry in entries if entry.published_at]  # 无日期的行不可排序，丢弃


class AnnouncementCollector:
    """上交所→深交所降级链；POLL_INTERVAL_S 节奏；maybe_refresh 带 2min 门控（§6.1.1）。"""

    def __init__(
        self,
        transport: TransportClient,
        store: EntryStore,
        health: HealthTracker,
        sleep: object = asyncio.sleep,
        now: object = time.monotonic,
    ) -> None:
        self._transport = transport
        self._store = store
        self._health = health
        self._sleep = sleep
        self._now = now
        self._last_poll = float("-inf")

    async def poll_once(self) -> bool:
        """主源 sse → 仅当 sse 采集失败（传输/解析错误）才切备源 szse；各自独立上报健康。"""
        sse_ok, sse_progressed = await self._poll_sse()
        progressed = sse_progressed
        if not sse_ok:
            progressed = (await self._poll_szse())[1] or progressed
        self._last_poll = self._now()
        return progressed

    async def maybe_refresh(self, *, force: bool = False) -> None:
        """手动强制补拉入口：force=False 时仅当距上次拉取 >2min 才触发（§6.1.1）。"""
        if not force and self._now() - self._last_poll < FORCE_REFRESH_GAP_S:
            return
        await self.poll_once()

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.poll_once()
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_S)
            except TimeoutError:
                pass

    async def _poll_sse(self) -> tuple[bool, bool]:
        """返回 (采集是否成功, 是否有新条目入库)。"""
        now = datetime.now(_TZ_SHANGHAI)
        request = TransportRequest(
            url=SSE_URL,
            query={
                "isPagination": "true",
                "pageHelp.pageSize": "25",
                "pageHelp.pageNo": "1",
                "pageHelp.beginPage": "1",
                "pageHelp.cacheSize": "1",
                "pageHelp.endPage": "1",
                "securityType": "0101",
                "reportType2": "DQBG",
                "reportType": "ALL",
                # 探测证据（规格 §10）：仅需 Referer http://www.sse.com.cn/；参数为公开页面默认值
                "beginTime": (now - timedelta(days=14)).strftime("%Y-%m-%d"),
                "endTime": now.strftime("%Y-%m-%d"),
            },
            headers={"Referer": "http://www.sse.com.cn/", "User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        try:
            response = await self._transport.fetch(request)
            entries = parse_sse(response.body)
        except TransportError as error:
            self._health.record_failure("sse", error.code)
            return False, False
        except (ValueError, KeyError):
            self._health.record_failure("sse", "parse_error")
            return False, False
        inserted = self._store.upsert_entries(entries)
        self._health.record_success("sse", advanced=inserted > 0)
        return True, inserted > 0

    async def _poll_szse(self) -> tuple[bool, bool]:
        """返回 (采集是否成功, 是否有新条目入库)。"""
        request = TransportRequest(
            url=SZSE_URL,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
        try:
            response = await self._transport.fetch(request)
            entries = parse_szse_html(response.body)
        except TransportError as error:
            self._health.record_failure("szse", error.code)
            return False, False
        except ValueError:
            self._health.record_failure("szse", "parse_error")
            return False, False
        inserted = self._store.upsert_entries(entries)
        self._health.record_success("szse", advanced=inserted > 0)
        return True, inserted > 0
