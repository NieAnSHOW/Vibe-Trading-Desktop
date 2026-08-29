"""Read-time watchlist matching with content-version keys and a derived cache (spec §3.1/§4.1)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import sqlite3
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

from src.news.health import HealthTracker, SourceHealth
from src.news.store import EntryStore, StoredEntry

WATCHLIST_DB_PATH = Path.home() / ".vibe-trading" / "watchlist.db"

_HU_PREFIXES = {"600", "601", "603", "605", "688"}
_SZ_PREFIXES = {"000", "001", "002", "003", "300", "301"}
_STOCKLIST_CODE_PATTERN = re.compile(r"([01])\.(\d{6})")
# 上下文护栏：全/半角括号包裹，或“股票代码/证券代码/代码：”引导（§4.1 防金额误伤）
_CODE_CONTEXT_PATTERN = re.compile(r"[（(](\d{6})[）)]|[股证][票券]?代码[:：]?\s*(\d{6})")
MATCH_RULE_STRUCTURED = "structured_field"
MATCH_RULE_CODE_PATTERN = "code_pattern"
MATCH_RULE_NAME_EXACT = "name_exact"


@dataclass(frozen=True)
class WatchlistEntry:
    code: str
    name: str
    market: str


def load_watchlist(db_path: Path | None = None) -> list[WatchlistEntry]:
    """直读本机 watchlist.db（规格 §3.1：不走 HTTP）。库不存在视为空自选。"""
    path = db_path or WATCHLIST_DB_PATH
    if not path.exists():
        return []
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT code, name, market FROM watchlist").fetchall()
    finally:
        conn.close()
    return [
        WatchlistEntry(code=str(row[0]), name=str(row[1] or "").strip(), market=str(row[2] or "a_stock"))
        for row in rows
    ]


def compute_watchlist_version(entries: Sequence[WatchlistEntry]) -> str:
    """watchlist_version = sha256(sorted((code, name, market) triples))；空列表有确定值（规格 §3.1/§6.1）。

    名称参与中置信度匹配：T0 回填/改名必须使版本键变化 → 派生缓存失效，否则缓存复用旧匹配结果。
    """
    payload = "\n".join(
        f"{entry.code}|{entry.name}|{entry.market}"
        for entry in sorted(entries, key=lambda item: (item.code, item.market))
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_stocklist_code(raw: str) -> str | None:
    """东财 stockList `1.600519`/`0.000001` → 6 位代码；北交所前缀未确认，首版跳过（§4.1.1）。"""
    text = raw.strip()
    if text.isdigit() and len(text) == 6:
        return text
    match = _STOCKLIST_CODE_PATTERN.fullmatch(text)
    if not match:
        return None
    flag, code = match.group(1), match.group(2)
    if flag == "1" and code[:3] in _HU_PREFIXES:
        return code
    if flag == "0" and code[:3] in _SZ_PREFIXES:
        return code
    return None


@dataclass(frozen=True)
class MatchedStock:
    code: str
    name: str
    match_rule: str


def match_entry(
    entry: StoredEntry,
    by_code: dict[str, WatchlistEntry],
    names_lc: dict[str, WatchlistEntry],
) -> tuple[list[MatchedStock], str | None]:
    """三级匹配：structured_field(high) > code_pattern(high) > name_exact(medium)。无命中返回 ([], None)。"""
    matches: list[MatchedStock] = []
    seen: set[str] = set()
    for raw in entry.structured_codes:
        code = normalize_stocklist_code(raw)
        if code and code in by_code and code not in seen:
            seen.add(code)
            matches.append(MatchedStock(code=code, name=by_code[code].name, match_rule=MATCH_RULE_STRUCTURED))
    haystack = f"{entry.title} {entry.summary}"
    for match in _CODE_CONTEXT_PATTERN.finditer(haystack):
        code = match.group(1) or match.group(2)
        if code in by_code and code not in seen:
            seen.add(code)
            matches.append(MatchedStock(code=code, name=by_code[code].name, match_rule=MATCH_RULE_CODE_PATTERN))
    lowered = haystack.lower()
    for name, watch_entry in names_lc.items():
        if name in lowered and watch_entry.code not in seen:
            seen.add(watch_entry.code)
            matches.append(MatchedStock(code=watch_entry.code, name=watch_entry.name, match_rule=MATCH_RULE_NAME_EXACT))
    if not matches:
        return [], None
    confidence = "high" if any(item.match_rule != MATCH_RULE_NAME_EXACT for item in matches) else "medium"
    return matches, confidence


def encode_cursor(version: str, published_at: str, item_id: str) -> str:
    """不透明游标 = base64(json{v,t,i})；客户端不得解析内部结构（§6.1）。"""
    payload = json.dumps({"v": version, "t": published_at, "i": item_id}, ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def decode_cursor(cursor: str) -> dict | None:
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, UnicodeError, binascii.Error):
        return None
    if not isinstance(payload, dict) or not {"v", "t", "i"} <= set(payload):
        return None
    return payload


@dataclass(frozen=True)
class CacheKey:
    """派生缓存键（§3.1 + 缺陷4/5 修正）：全维度包含，缺一即可能脏读/replay。"""

    watchlist_version: str
    store_generation: int  # 条目库写入代数：入库/清理后旧页缓存立即失效（实时性 + replay 防护）
    after_cursor: str | None
    before_cursor: str | None
    limit: int


class DerivedFeedCache:
    """键 = (watchlist_version, store_generation, after_cursor, before_cursor, limit)。

    值只存"条目 id 有序列表 + 双游标"而非完整条目快照——hydrate 时从 EntryStore join，
    窗口清理删除条目后，缓存 id 指向的行自然消失，不会把已删数据 replay 给用户。
    """

    MAX_ENTRIES = 16

    def __init__(self) -> None:
        self._entries: OrderedDict[CacheKey, tuple[list[tuple[str, str]], str | None, str | None]] = OrderedDict()

    def get(self, key: CacheKey) -> tuple[list[tuple[str, str]], str | None, str | None] | None:
        if key not in self._entries:
            return None
        self._entries.move_to_end(key)
        return self._entries[key]

    def put(self, key: CacheKey, value: tuple[list[tuple[str, str]], str | None, str | None]) -> None:
        self._entries[key] = value
        self._entries.move_to_end(key)
        while len(self._entries) > self.MAX_ENTRIES:
            self._entries.popitem(last=False)


class WatchlistFeedService:
    """GET /news-api/watchlist-feed 读取路径：加载自选 → 版本键 → 匹配 → 缓存 → 边界语义（§6.1）。

    游标两参数正交：
    - after_cursor（轮询水位）：只返回比它更新的条目；响应 new_cursor 是推进后的水位
      （取本页扫描到的最新一行位置，未命中行也推进水位，避免每轮重扫）。
    - before_cursor（翻页游标）：只返回比它更早的条目；响应 next_cursor 指向更早一页。
    - 首屏（两者皆 null）：从窗口头部取最新一页，同时给出 new_cursor 与 next_cursor。
    """

    def __init__(
        self,
        store: EntryStore,
        health: HealthTracker,
        cache: DerivedFeedCache | None = None,
        watchlist_db: Path | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._health = health
        self._cache = cache or DerivedFeedCache()
        self._watchlist_db = watchlist_db
        self._now = now or (lambda: datetime.now().astimezone())  # 窗口查询时间源；测试注入确定性锚

    async def feed(self, after_cursor: str | None, before_cursor: str | None, limit: int = 50) -> dict:
        if after_cursor and before_cursor:
            raise ValueError("after_cursor and before_cursor are mutually exclusive")
        if after_cursor and decode_cursor(after_cursor) is None:
            raise ValueError("after_cursor is invalid")  # 路由层映射为 400，不静默当 null
        if before_cursor and decode_cursor(before_cursor) is None:
            raise ValueError("before_cursor is invalid")
        limit = max(1, min(limit, 50))
        return await asyncio.get_running_loop().run_in_executor(
            None, self._feed_sync, after_cursor, before_cursor, limit
        )

    def _feed_sync(self, after_cursor: str | None, before_cursor: str | None, limit: int) -> dict:
        watchlist = load_watchlist(self._watchlist_db)
        version = compute_watchlist_version(watchlist)
        by_code = {entry.code: entry for entry in watchlist}
        names_lc = {entry.name.lower(): entry for entry in watchlist if entry.name}

        reset_required = False
        effective_after = after_cursor
        if after_cursor and decode_cursor(after_cursor)["v"] != version:
            reset_required = True  # 自选已变化 → 旧游标失效（§6.1），视为空并从窗口头部重匹配
            effective_after = None
        effective_before = before_cursor
        if before_cursor and decode_cursor(before_cursor)["v"] != version:
            reset_required = True
            effective_before = None
        # 缓存键全维度：版本 + 条目库写入代数 + 双游标 + limit；代数推进即失效（实时性 + replay 防护）
        key = CacheKey(
            watchlist_version=version,
            store_generation=self._store.generation(),
            after_cursor=effective_after,
            before_cursor=effective_before,
            limit=limit,
        )
        cached = None if reset_required else self._cache.get(key)
        if cached is not None:
            cached_keys, new_cursor, next_cursor = cached
            # hydrate：从条目库 join 现存行（已被窗口清理的键自然消失 → 不 replay 已删数据）
            items = self._match_rows(by_code, names_lc, self._store.fetch_by_keys(cached_keys))
        else:
            if effective_after is not None:
                items, new_cursor, next_cursor, delivered_rows = self._page_after(
                    by_code, names_lc, version, effective_after, limit
                )
            elif effective_before is not None:
                items, new_cursor, next_cursor, delivered_rows = self._page_before(
                    by_code, names_lc, version, effective_before, limit
                )
            else:
                items, new_cursor, next_cursor, delivered_rows = self._page_head(by_code, names_lc, version, limit)
            self._cache.put(key, ([(row.source, row.item_id) for row in delivered_rows], new_cursor, next_cursor))
        return {
            "items": items,
            "new_cursor": new_cursor,
            "next_cursor": next_cursor,
            "source_health": self._health_payload(),
            "last_updated_at": self._store.last_updated_at(),
            "watchlist_version": version,
            "reset_required": reset_required,
        }

    def _match_rows(
        self,
        by_code: dict[str, WatchlistEntry],
        names_lc: dict[str, WatchlistEntry],
        rows: list[StoredEntry],
    ) -> list[dict]:
        items: list[dict] = []
        for entry in rows:
            matches, confidence = match_entry(entry, by_code, names_lc)
            if not matches or confidence is None:
                continue  # 低置信度/未命中不展示（§4.1）
            items.append(
                {
                    "id": f"{entry.source}:{entry.item_id}",
                    "source": entry.source,
                    "type": entry.type,
                    "published_at": entry.published_at,
                    "title": entry.title,
                    "summary": entry.summary,
                    "url": entry.url or None,
                    "matched_stocks": [{"code": m.code, "name": m.name, "match_rule": m.match_rule} for m in matches],
                    "confidence": confidence,
                }
            )
        return items

    def _page_head(
        self,
        by_code: dict[str, WatchlistEntry],
        names_lc: dict[str, WatchlistEntry],
        version: str,
        limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        rows = self._store.window_merged(limit=limit + 1, now=self._now())
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)
        new_cursor = encode_cursor(version, rows[0].published_at, rows[0].item_id) if rows else None
        next_cursor = (
            encode_cursor(version, rows[limit - 1].published_at, rows[limit - 1].item_id) if len(rows) > limit else None
        )
        return items, new_cursor, next_cursor, delivered

    def _page_after(
        self,
        by_code: dict[str, WatchlistEntry],
        names_lc: dict[str, WatchlistEntry],
        version: str,
        after_cursor: str,
        limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        """升序交付"最旧的未交付 N 条"（缺陷 3）：一轮涌入超过 limit 条也不丢不重——
        ORDER BY published_at ASC 取最旧未交付页，水位 = 本页最后一条（最新已交付）位置。"""
        data = decode_cursor(after_cursor)
        assert data is not None
        rows = self._store.window_merged(
            limit=limit + 1,
            now=self._now(),
            after_published_at=data["t"],
            after_item_id=data["i"],
            order="asc",
        )
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)  # 升序返回，前端 reverse 展示
        if delivered:
            new_cursor = encode_cursor(version, delivered[-1].published_at, delivered[-1].item_id)
        else:
            new_cursor = after_cursor  # 无新条目 → 水位不变
        return items, new_cursor, None, delivered

    def _page_before(
        self,
        by_code: dict[str, WatchlistEntry],
        names_lc: dict[str, WatchlistEntry],
        version: str,
        before_cursor: str,
        limit: int,
    ) -> tuple[list[dict], str | None, str | None, list[StoredEntry]]:
        data = decode_cursor(before_cursor)
        assert data is not None
        rows = self._store.window_merged(
            limit=limit + 1,
            now=self._now(),
            before_published_at=data["t"],
            before_item_id=data["i"],
        )
        delivered = rows[:limit]
        items = self._match_rows(by_code, names_lc, delivered)
        next_cursor = (
            encode_cursor(version, rows[limit - 1].published_at, rows[limit - 1].item_id) if len(rows) > limit else None
        )
        return items, None, next_cursor, delivered

    def _health_payload(self) -> list[dict]:
        snapshot: list[SourceHealth] = self._health.snapshot()
        return [
            {
                "source_id": health.source_id,
                "state": health.state,
                "last_success_at": health.last_success_at,
                "last_error": health.last_error,
            }
            for health in snapshot
        ]
