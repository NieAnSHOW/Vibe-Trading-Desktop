"""TDD：版本键 / stockList 标准化 / 三级匹配 / 游标 / 派生缓存 / 读取服务（规格 §3.1/§4.1/§6.1）。"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Callable

import pytest

from src.news.calendar import ConservativeCalendar
from src.news.health import HealthTracker
from src.news.matcher import (
    CacheKey,
    DerivedFeedCache,
    WatchlistFeedService,
    compute_watchlist_version,
    decode_cursor,
    encode_cursor,
    match_entry,
    normalize_stocklist_code,
)
from src.news.store import FLASH_WINDOW, EntryStore, StoredEntry

NOW = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)
WATCHLIST_DB_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS watchlist ("
    " code TEXT PRIMARY KEY, name TEXT DEFAULT '', market TEXT DEFAULT 'a_stock', added_at TEXT)"
)


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


@pytest.fixture()
def watchlist_db(tmp_path: Path) -> Path:
    db = tmp_path / "watchlist.db"
    with sqlite3.connect(db) as conn:
        conn.execute(WATCHLIST_DB_SCHEMA)
        conn.execute(
            "INSERT INTO watchlist(code, name, market, added_at) VALUES ('600519', '贵州茅台', 'a_stock', '2026-08-01')"
        )
        conn.execute(
            "INSERT INTO watchlist(code, name, market, added_at) VALUES ('000001', '平安银行', 'a_stock', '2026-08-02')"
        )
        conn.commit()
    return db


def _entry(
    source: str = "eastmoney",
    item_id: str = "e1",
    title: str = "标题",
    summary: str = "",
    structured: tuple[str, ...] = (),
) -> StoredEntry:
    return StoredEntry(
        source=source,
        item_id=item_id,
        type="flash",
        published_at=NOW.isoformat(),
        title=title,
        summary=summary,
        url="",
        structured_codes=structured,
    )


def _match_indexes():
    from src.news.matcher import WatchlistEntry

    entries = [WatchlistEntry("600519", "贵州茅台", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    by_code = {entry.code: entry for entry in entries}
    names_lc = {entry.name.lower(): entry for entry in entries if entry.name}
    return by_code, names_lc


def test_normalize_stocklist_code_prefix_rules():
    assert normalize_stocklist_code("1.600519") == "600519"  # 沪
    assert normalize_stocklist_code("0.000001") == "000001"  # 深
    assert normalize_stocklist_code("1.688001") == "688001"
    assert normalize_stocklist_code("0.300750") == "300750"
    assert normalize_stocklist_code("600519") == "600519"  # 6 位直通（公告 SECURITY_CODE）
    assert normalize_stocklist_code("1.400001") is None  # 非沪前缀（北交所未确认 → 跳过）
    assert normalize_stocklist_code("0.830001") is None
    assert normalize_stocklist_code("garbage") is None


def test_compute_watchlist_version_order_insensitive_and_content_bound():
    from src.news.matcher import WatchlistEntry

    a = [WatchlistEntry("600519", "贵州茅台", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    b = list(reversed(a))
    assert compute_watchlist_version(a) == compute_watchlist_version(b)
    assert compute_watchlist_version(a) != compute_watchlist_version(a[:-1])
    renamed = [WatchlistEntry("600519", "贵州茅台改", "a_stock"), WatchlistEntry("000001", "平安银行", "a_stock")]
    assert compute_watchlist_version(a) != compute_watchlist_version(renamed)  # 名称参与版本键（T0 回填必须失效缓存）
    assert len(compute_watchlist_version([])) == 64  # 空自选也有确定哈希


def test_match_entry_structured_field_high():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(structured=("1.600519",)), by_code, names_lc)
    assert [(m.code, m.match_rule) for m in matches] == [("600519", "structured_field")]
    assert confidence == "high"


def test_match_entry_code_pattern_requires_context_guard():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(title="股价报（600519）元"), by_code, names_lc)
    assert matches[0].match_rule == "code_pattern"
    assert confidence == "high"
    # 金额数字无护栏 → 不命中
    matches_bare, confidence_bare = match_entry(_entry(title="成交额达 1423000 元"), by_code, names_lc)
    assert matches_bare == [] and confidence_bare is None


def test_match_entry_name_exact_medium():
    by_code, names_lc = _match_indexes()
    matches, confidence = match_entry(_entry(title="贵州茅台发布半年报"), by_code, names_lc)
    assert [(m.code, m.match_rule) for m in matches] == [("600519", "name_exact")]
    assert confidence == "medium"


def test_match_entry_no_match_returns_none():
    by_code, names_lc = _match_indexes()
    assert match_entry(_entry(title="国际油价上涨"), by_code, names_lc) == ([], None)


def test_cursor_roundtrip_and_tamper():
    encoded = encode_cursor("v" * 64, "2026-08-29T00:00:00+00:00", "abc")
    assert decode_cursor(encoded) == {"v": "v" * 64, "t": "2026-08-29T00:00:00+00:00", "i": "abc"}
    assert decode_cursor("not-a-cursor") is None


def test_derived_cache_hit_and_lru_eviction():
    cache = DerivedFeedCache()
    value = ([("eastmoney", "a")], "wm", None)
    cache.put(CacheKey("v1", 0, None, None, 50), value)
    assert cache.get(CacheKey("v1", 0, None, None, 50)) == value
    assert cache.get(CacheKey("v2", 0, None, None, 50)) is None
    assert cache.get(CacheKey("v1", 0, None, None, 25)) is None  # limit 维度
    assert cache.get(CacheKey("v1", 1, None, None, 50)) is None  # generation 变化 → 失效（缺陷 5）
    for i in range(16):
        cache.put(CacheKey(f"k{i}", 0, None, None, 50), ([], None, None))
    assert cache.get(CacheKey("v1", 0, None, None, 50)) is None  # LRU 淘汰


def _feed_service(tmp_path: Path, watchlist_db: Path) -> tuple[WatchlistFeedService, EntryStore]:
    store = EntryStore(tmp_path / "news.db")
    health = HealthTracker(ConservativeCalendar())
    # 时间锚注入：窗口查询锚定 NOW，测试对墙钟零敏感（store 约定同 test_store.py 的 now=NOW）
    service = WatchlistFeedService(store=store, health=health, watchlist_db=watchlist_db, now=lambda: NOW)
    return service, store


@_async_test
async def test_feed_empty_watchlist_boundary(tmp_path, watchlist_db):
    empty_db = tmp_path / "empty.db"
    with sqlite3.connect(empty_db) as conn:
        conn.execute(WATCHLIST_DB_SCHEMA)
        conn.commit()
    service, _ = _feed_service(tmp_path, empty_db)
    payload = await service.feed(None, None, 50)
    assert payload["items"] == []
    assert payload["new_cursor"] is None
    assert payload["next_cursor"] is None
    assert payload["reset_required"] is False
    assert len(payload["watchlist_version"]) == 64


@_async_test
async def test_feed_head_page_sets_both_cursors(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="a",
                type="flash",
                published_at=(NOW - timedelta(minutes=1)).isoformat(),
                title="贵州茅台发布半年报",
                summary="",
                url="",
                structured_codes=(),
            ),
            StoredEntry(
                source="eastmoney",
                item_id="b",
                type="flash",
                published_at=NOW.isoformat(),
                title="A股三大指数收盘涨跌不一成交额放大",
                summary="",
                url="",
                structured_codes=("1.600519",),
            ),
            StoredEntry(
                source="eastmoney",
                item_id="c",
                type="flash",
                published_at=(NOW - timedelta(minutes=2)).isoformat(),
                title="国际油价周四大涨百分之三创近期新高",
                summary="",
                url="",
                structured_codes=(),
            ),
            StoredEntry(
                source="eastmoney",
                item_id="d",
                type="flash",
                published_at=(NOW - timedelta(minutes=3)).isoformat(),
                title="平安银行获北向资金连续五日净买入",
                summary="",
                url="",
                structured_codes=("0.000001",),
            ),
        ],
        now=NOW,
    )
    payload = await service.feed(None, None, 2)
    assert [item["id"] for item in payload["items"]] == ["eastmoney:b", "eastmoney:a"]  # 新→旧 + 过滤未命中
    assert payload["items"][0]["confidence"] == "high"
    assert payload["items"][0]["matched_stocks"] == [
        {"code": "600519", "name": "贵州茅台", "match_rule": "structured_field"}
    ]
    # new_cursor = 窗口头部水位（含未命中行 b）；next_cursor = 本页末行之后的更早页
    assert payload["new_cursor"] is not None
    assert payload["next_cursor"] is not None
    assert payload["new_cursor"] != payload["next_cursor"]

    older = await service.feed(None, payload["next_cursor"], 50)
    assert [item["id"] for item in older["items"]] == ["eastmoney:d"]  # 翻页只出更早条目
    assert older["next_cursor"] is None
    assert older["new_cursor"] is None  # before 模式不推进水位


@_async_test
async def test_feed_poll_returns_only_new_items_and_advances_watermark(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="a",
                type="flash",
                published_at=(NOW - timedelta(minutes=1)).isoformat(),
                title="贵州茅台发布半年报",
                summary="",
                url="",
                structured_codes=(),
            ),
        ],
        now=NOW,
    )
    head = await service.feed(None, None, 50)
    watermark = head["new_cursor"]
    assert watermark is not None

    # 无新条目的一轮：items 空、水位原样回传
    idle = await service.feed(watermark, None, 50)
    assert idle["items"] == []
    assert idle["new_cursor"] == watermark

    # 新条目到达：只返回更新的条目，水位推进到最新行
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="m",
                type="flash",
                published_at=NOW.isoformat(),
                title="白酒龙头午后直线拉升带动指数走强",
                summary="",
                url="",
                structured_codes=("1.600519",),
            ),
            StoredEntry(
                source="eastmoney",
                item_id="n",
                type="flash",
                published_at=(NOW - timedelta(minutes=5)).isoformat(),
                title="国际黄金价格创历史新高避险情绪升温",
                summary="",
                url="",
                structured_codes=(),
            ),
        ],
        now=NOW,
    )
    polled = await service.feed(watermark, None, 50)
    assert [item["id"] for item in polled["items"]] == ["eastmoney:m"]
    assert polled["new_cursor"] != watermark

    # 再轮询：不再重复返回 m
    again = await service.feed(polled["new_cursor"], None, 50)
    assert again["items"] == []


@_async_test
async def test_feed_mutually_exclusive_cursors(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    with pytest.raises(ValueError):
        await service.feed("a", "b", 50)


@_async_test
async def test_feed_garbage_cursor_is_error_not_reset(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    with pytest.raises(ValueError):
        await service.feed("not-a-cursor", None, 50)  # 路由层映射 400，不静默当 null
    with pytest.raises(ValueError):
        await service.feed(None, "garbage", 50)


@_async_test
async def test_feed_cache_invalidated_on_ingestion(tmp_path, watchlist_db):
    """缺陷 5：同 (version, cursor) 查询 → 入库新条目 → 再查必须返回新条目。"""
    service, store = _feed_service(tmp_path, watchlist_db)
    first = await service.feed(None, None, 50)
    assert first["items"] == []
    gen0 = store.generation()
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="m",
                type="flash",
                published_at=NOW.isoformat(),
                title="白酒龙头午后直线拉升带动指数走强",
                summary="",
                url="",
                structured_codes=("1.600519",),
            ),
        ],
        now=NOW,
    )
    assert store.generation() == gen0 + 1
    second = await service.feed(None, None, 50)
    assert [item["id"] for item in second["items"]] == ["eastmoney:m"]  # generation 推进 → 缓存失效


@_async_test
async def test_feed_after_burst_delivery_no_loss_no_dup(tmp_path, watchlist_db):
    """缺陷 3：一轮涌入超过 limit 条（8 条 / limit=3，三轮拉取），全部送达、无重复。

    标题取自人工核对过的 simhash 两两相似度 <0.7 的真实风格语料——
    结构雷同的合成标题本就应被 §5.5 近似合并，不用于本测试。
    """
    titles = [
        "A股三大指数收盘涨跌不一成交额放大",
        "国际油价周四大涨百分之三创近期新高",
        "平安银行获北向资金连续五日净买入",
        "白酒龙头午后直线拉升带动指数走强",
        "国际黄金价格创历史新高避险情绪升温",
        "央行开展6000亿元中期借贷便利操作",
        "证监会发布程序化交易新规征求意见",
        "工信部发布人工智能产业支持政策",
    ]
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="seed",
                type="flash",
                published_at=(NOW - timedelta(hours=2)).isoformat(),
                title="贵州茅台发布半年报业绩说明",
                summary="",
                url="",
                structured_codes=(),
            )
        ],
        now=NOW,
    )
    head = await service.feed(None, None, 3)
    watermark = head["new_cursor"]

    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id=f"n{i}",
                type="flash",
                published_at=(NOW - timedelta(minutes=60 - i)).isoformat(),
                title=titles[i],
                summary="",
                url="",
                structured_codes=("1.600519",),
            )
            for i in range(8)
        ],
        now=NOW,
    )

    delivered: list[str] = []
    cursor: str | None = watermark
    for _ in range(3):
        page = await service.feed(cursor, None, 3)
        assert [item["id"] for item in page["items"]] == sorted(  # 升序交付（最旧未交付优先）
            (item["id"] for item in page["items"])
        )
        delivered.extend(item["id"] for item in page["items"])
        cursor = page["new_cursor"]
    assert len(delivered) == 8  # 全部送达（3+3+2）
    assert len(set(delivered)) == 8  # 无重复
    assert all(item_id.startswith("eastmoney:n") for item_id in delivered)
    tail = await service.feed(cursor, None, 3)
    assert tail["items"] == []  # 水位之后无新条目


@_async_test
async def test_feed_purged_entries_not_replayed(tmp_path, watchlist_db):
    """缺陷 4：条目被清理后，同 cursor 再查不返回已删条目；连续两次查询一致。"""
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries(
        [
            StoredEntry(
                source="eastmoney",
                item_id="old",
                type="flash",
                # 时间锚确定性修正：条目须在 NOW 查询窗口内（距超窗 30 分钟），purge(now=NOW+1h) 必然清理
                published_at=(NOW - FLASH_WINDOW + timedelta(minutes=30)).isoformat(),
                title="即将超窗的旧快讯",
                summary="",
                url="",
                structured_codes=("1.600519",),
            ),
        ],
        now=NOW,
    )
    first = await service.feed(None, None, 50)
    assert [item["id"] for item in first["items"]] == ["eastmoney:old"]

    store.purge_expired(now=NOW + timedelta(hours=1))  # 清理超窗条目

    second = await service.feed(None, None, 50)
    assert second["items"] == []  # 已删条目不被 replay
    third = await service.feed(None, None, 50)
    assert [item["id"] for item in third["items"]] == [item["id"] for item in second["items"]]


@_async_test
async def test_feed_reset_required_on_either_stale_cursor(tmp_path, watchlist_db):
    service, store = _feed_service(tmp_path, watchlist_db)
    store.upsert_entries([_entry(item_id="a", title="贵州茅台公告")], now=NOW)
    stale = encode_cursor("0" * 64, NOW.isoformat(), "a")

    stale_after = await service.feed(stale, None, 50)
    assert stale_after["reset_required"] is True
    assert stale_after["items"][0]["id"] == "eastmoney:a"  # after 失效 → 从窗口头部重新匹配

    stale_before = await service.feed(None, stale, 50)
    assert stale_before["reset_required"] is True  # before 失效同样触发 reset


@_async_test
async def test_feed_source_health_shape(tmp_path, watchlist_db):
    service, _ = _feed_service(tmp_path, watchlist_db)
    payload = await service.feed(None, None, 50)
    assert [h["source_id"] for h in payload["source_health"]] == ["eastmoney", "sina", "sse", "szse"]
    assert set(payload["source_health"][0].keys()) == {"source_id", "state", "last_success_at", "last_error"}
