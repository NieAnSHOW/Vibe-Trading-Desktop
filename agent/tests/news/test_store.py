"""TDD：news.db 条目库——窗口/去重/跨源合并/URL 规范化（规格 §3.1/§3.3/§5.5）。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.news.store import FLASH_WINDOW, ANNOUNCEMENT_WINDOW, EntryStore, StoredEntry, normalize_url

NOW = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)


_FLASH_TOPICS = {
    "0": "央行开展逆回购操作",
    "1": "新能源汽车销量创新高",
    "2": "半导体设备出口管制升级",
    "3": "光伏组件价格持续回落",
    "4": "白酒板块资金流向跟踪",
    "old-flash": "隔夜海外市场收盘报道",
    "fresh-flash": "沪深两市早盘高开走势",
}


def _flash(
    item_id: str, title: str | None = None, published: datetime | None = None, source: str = "eastmoney"
) -> StoredEntry:
    return StoredEntry(
        source=source,
        item_id=item_id,
        type="flash",
        published_at=(published or NOW).isoformat(),
        title=title or _FLASH_TOPICS.get(item_id, f"快讯主题{item_id}"),
        summary="摘要",
        url="",
        structured_codes=(),
    )


def test_normalize_url_strips_tracking_params():
    assert (
        normalize_url("https://finance.sina.com.cn/a.html?utm_source=x&id=1&source=y")
        == "https://finance.sina.com.cn/a.html?id=1"
    )
    assert normalize_url("javascript:alert(1)") == ""
    assert normalize_url("https://example.com/ok") == "https://example.com/ok"


def test_upsert_and_window_ordering(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash("1", published=NOW - timedelta(minutes=1)), _flash("0", published=NOW)])
    rows = store.window_merged(limit=10, now=NOW)
    assert [row.item_id for row in rows] == ["0", "1"]  # published_at 新→旧


def test_same_source_dedup_by_item_id(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    assert store.upsert_entries([_flash("a")]) == 1
    assert store.upsert_entries([_flash("a")]) == 0  # (source, item_id) 唯一


def test_cross_source_near_duplicate_merge(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries(
        [
            _flash(
                "sina-1", title="央行宣布降低存款准备金率0.5个百分点", source="sina", published=NOW - timedelta(hours=1)
            )
        ]
    )
    twin = StoredEntry(
        source="eastmoney",
        item_id="em-1",
        type="flash",
        published_at=NOW.isoformat(),
        title="央行宣布降低存款准备金率0.5个百分点",
        summary="摘要",
        url="https://eastmoney.example/x",
        structured_codes=(),
    )
    assert store.upsert_entries([twin], now=NOW) == 0  # simhash ≥0.7 合并，不新增
    rows = store.window_merged(limit=10, now=NOW)
    assert len(rows) == 1
    assert rows[0].source == "sina"  # 保留最早 published_at 的条目
    assert "https://eastmoney.example/x" in rows[0].extra_urls  # 多源链接保留


def test_before_cursor_pagination_returns_older(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash(str(i), published=NOW - timedelta(minutes=i)) for i in range(5)])
    page1 = store.window_merged(limit=2, now=NOW)
    assert len(page1) == 2
    page2 = store.window_merged(
        limit=2, now=NOW, before_published_at=page1[-1].published_at, before_item_id=page1[-1].item_id
    )
    assert [row.item_id for row in page2] == ["2", "3"]  # 更早一页（新→旧）


def test_after_cursor_pagination_returns_newer(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    store.upsert_entries([_flash(str(i), published=NOW - timedelta(minutes=i)) for i in range(5)])
    watermark = store.window_merged(limit=10, now=NOW)[-1]  # 最旧条目 "4" 作为水位
    newer = store.window_merged(
        limit=10, now=NOW, after_published_at=watermark.published_at, after_item_id=watermark.item_id
    )
    assert [row.item_id for row in newer] == ["0", "1", "2", "3"]  # 严格更新的条目，仍按新→旧排序


def test_purge_expired_windows(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    old_flash = _flash("old-flash", published=NOW - FLASH_WINDOW - timedelta(minutes=5))
    fresh_flash = _flash("fresh-flash", published=NOW - FLASH_WINDOW + timedelta(minutes=5))
    old_ann = StoredEntry(
        source="sse",
        item_id="old-ann",
        type="announcement",
        published_at=(NOW - ANNOUNCEMENT_WINDOW - timedelta(minutes=5)).isoformat(),
        title="公告",
        summary="",
        url="",
        structured_codes=(),
    )
    fresh_ann = StoredEntry(
        source="sse",
        item_id="fresh-ann",
        type="announcement",
        published_at=(NOW - ANNOUNCEMENT_WINDOW + timedelta(days=1)).isoformat(),
        title="季度业绩预告公告",
        summary="",
        url="",
        structured_codes=(),
    )
    store.upsert_entries([old_flash, fresh_flash, old_ann, fresh_ann], now=NOW)
    store.purge_expired(now=NOW)
    remaining = {row.item_id for row in store.window_merged(limit=100, now=NOW)}
    assert remaining == {"fresh-flash", "fresh-ann"}


def test_last_updated_at_tracks_ingestion(tmp_path):
    store = EntryStore(tmp_path / "news.db")
    assert store.last_updated_at() is None
    store.upsert_entries([_flash("a")], now=NOW)
    assert store.last_updated_at() is not None
