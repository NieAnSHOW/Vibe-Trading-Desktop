"""Bounded-window SQLite entry store shared by flash and announcement collectors (spec §3.1/§3.3/§5.5)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Literal, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

FLASH_WINDOW = timedelta(hours=24)
ANNOUNCEMENT_WINDOW = timedelta(days=7)
TITLE_DUP_THRESHOLD = 0.7  # simhash 相似度阈值（规格 §5.5）
_NEARDUP_SCAN_LIMIT = 400

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('flash','announcement')),
    published_at TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    structured_codes TEXT NOT NULL DEFAULT '[]',
    extra_urls TEXT NOT NULL DEFAULT '[]',
    matched_codes TEXT NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_type_published ON entries(type, published_at DESC);
"""


def news_db_path() -> Path:
    return Path.home() / ".vibe-trading" / "news.db"


def normalize_url(raw: str) -> str:
    """剥离 utm_* / source=* 跟踪参数；仅接受 http/https，非法输入返回空串（规格 §5.5/§5.8）。"""
    try:
        parsed = urlsplit(raw.strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    kept = [
        (name, value)
        for name, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not (name.lower().startswith("utm_") or name.lower() == "source")
    ]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", urlencode(kept), parsed.fragment))


@dataclass(frozen=True)
class StoredEntry:
    """条目库统一行结构；matched_codes/confidence 为读取时匹配的预留字段（入库恒空）。"""

    source: str
    item_id: str
    type: str
    published_at: str
    title: str
    summary: str
    url: str
    structured_codes: tuple[str, ...]
    extra_urls: tuple[str, ...] = ()


def _simhash64(text: str) -> int:
    tokens = [text[index : index + 2] for index in range(max(len(text) - 1, 0))] or [text]
    weights = [0] * 64
    for token in tokens:
        digest = int.from_bytes(hashlib.md5(token.encode("utf-8")).digest()[:8], "big")
        for bit in range(64):
            weights[bit] += 1 if (digest >> bit) & 1 else -1
    value = 0
    for bit in range(64):
        if weights[bit] > 0:
            value |= 1 << bit
    return value


def title_similarity(left: str, right: str) -> float:
    """simhash 相似度 [0,1]：1 - hamming/64。"""
    return 1.0 - bin(_simhash64(left) ^ _simhash64(right)).count("1") / 64.0


class EntryStore:
    """~/.vibe-trading/news.db：快讯 24h / 公告 7d 有界窗口，超窗物理删除。"""

    def __init__(self, db_path: Path | None = None) -> None:
        self._path = db_path or news_db_path()
        self._lock = threading.Lock()
        self._generation = 0  # 单调递增条目库写入代数：入库/清理各 +1，派生缓存键据此失效
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def generation(self) -> int:
        """当前写入代数；任何写入（入库/清理）都会推进。"""
        return self._generation

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path)
        conn.row_factory = sqlite3.Row
        return conn

    def upsert_entries(self, entries: Iterable[StoredEntry], now: datetime | None = None) -> int:
        """入库：同源 (source,item_id) 去重；跨源标题 simhash ≥0.7 合并（保留多源链接、取最早时间）。"""
        now_iso = (now or datetime.now(timezone.utc)).isoformat()
        inserted = 0
        with self._lock, self._connect() as conn:
            for entry in entries:
                cutoff = (datetime.fromisoformat(now_iso) - max(FLASH_WINDOW, ANNOUNCEMENT_WINDOW)).isoformat()
                recent = conn.execute(
                    "SELECT source, item_id, published_at, title, url, extra_urls FROM entries "
                    "WHERE type = ? AND published_at >= ? ORDER BY published_at DESC LIMIT ?",
                    (entry.type, cutoff, _NEARDUP_SCAN_LIMIT),
                ).fetchall()
                merged = False
                for candidate in recent:
                    if title_similarity(entry.title, candidate["title"]) < TITLE_DUP_THRESHOLD:
                        continue
                    extra = list(json.loads(candidate["extra_urls"]))
                    if entry.url and entry.url != candidate["url"] and entry.url not in extra:
                        extra.append(entry.url)
                    earliest = min(candidate["published_at"], entry.published_at)
                    conn.execute(
                        "UPDATE entries SET extra_urls = ?, published_at = ? WHERE source = ? AND item_id = ?",
                        (json.dumps(extra, ensure_ascii=False), earliest, candidate["source"], candidate["item_id"]),
                    )
                    merged = True
                    break
                if merged:
                    continue
                # ponytail: 跨源近似扫描为窗口内 O(n) 顺序比对；条目量超万级再换倒排索引。
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO entries(source, item_id, type, published_at, title, summary, url,"
                    " structured_codes, extra_urls, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        entry.source,
                        entry.item_id,
                        entry.type,
                        entry.published_at,
                        entry.title,
                        entry.summary,
                        entry.url,
                        json.dumps(list(entry.structured_codes), ensure_ascii=False),
                        json.dumps(list(entry.extra_urls), ensure_ascii=False),
                        now_iso,
                    ),
                )
                inserted += cursor.rowcount
            conn.commit()
            if inserted:
                self._generation += 1
        return inserted

    def window_merged(
        self,
        limit: int = 50,
        now: datetime | None = None,
        after_published_at: str | None = None,
        after_item_id: str | None = None,
        before_published_at: str | None = None,
        before_item_id: str | None = None,
        order: Literal["desc", "asc"] = "desc",
    ) -> list[StoredEntry]:
        """窗口内条目（快讯 24h / 公告 7d），默认新→旧。

        after_*：只返回严格更新的条目（> 比较严格不等，配合 order="asc" 交付最旧未交付页）；
        before_*：只返回更早条目（< 严格不等，翻页位）。
        """
        at = now or datetime.now(timezone.utc)
        flash_cutoff = (at - FLASH_WINDOW).isoformat()
        announcement_cutoff = (at - ANNOUNCEMENT_WINDOW).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM entries "
                "WHERE ((type = 'flash' AND published_at >= :flash_cutoff) "
                "    OR (type = 'announcement' AND published_at >= :announcement_cutoff)) "
                "AND (:after_ts IS NULL OR published_at > :after_ts "
                "     OR (published_at = :after_ts AND item_id > :after_id)) "
                "AND (:before_ts IS NULL OR published_at < :before_ts "
                "     OR (published_at = :before_ts AND item_id < :before_id)) "
                f"ORDER BY published_at {order.upper()}, item_id {order.upper()} LIMIT :limit",
                {
                    "flash_cutoff": flash_cutoff,
                    "announcement_cutoff": announcement_cutoff,
                    "after_ts": after_published_at,
                    "after_id": after_item_id,
                    "before_ts": before_published_at,
                    "before_id": before_item_id,
                    "limit": limit,
                },
            ).fetchall()
        return [self._to_entry(row) for row in rows]

    def purge_expired(self, now: datetime | None = None) -> None:
        at = now or datetime.now(timezone.utc)
        with self._lock, self._connect() as conn:
            conn.execute(
                "DELETE FROM entries WHERE type = 'flash' AND published_at < ?", ((at - FLASH_WINDOW).isoformat(),)
            )
            conn.execute(
                "DELETE FROM entries WHERE type = 'announcement' AND published_at < ?",
                ((at - ANNOUNCEMENT_WINDOW).isoformat(),),
            )
            conn.commit()
            self._generation += 1

    def last_updated_at(self) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT MAX(first_seen_at) FROM entries").fetchone()
        return str(row[0]) if row and row[0] else None

    def fetch_by_keys(self, keys: Sequence[tuple[str, str]]) -> list[StoredEntry]:
        """按键集合取回现存行，保持输入顺序；已清理的键自然跳过（缓存 replay 防护）。"""
        if not keys:
            return []
        placeholders = ",".join("?" * len(keys))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM entries WHERE source || ':' || item_id IN ({placeholders})",
                [f"{source}:{item_id}" for source, item_id in keys],
            ).fetchall()
        by_key = {(row["source"], row["item_id"]): self._to_entry(row) for row in rows}
        return [by_key[key] for key in keys if key in by_key]

    @staticmethod
    def _to_entry(row: sqlite3.Row) -> StoredEntry:
        return StoredEntry(
            source=row["source"],
            item_id=row["item_id"],
            type=row["type"],
            published_at=row["published_at"],
            title=row["title"],
            summary=row["summary"],
            url=row["url"],
            structured_codes=tuple(json.loads(row["structured_codes"])),
            extra_urls=tuple(json.loads(row["extra_urls"])),
        )
