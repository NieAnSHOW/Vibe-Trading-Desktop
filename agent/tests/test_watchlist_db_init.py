"""TDD：测试 watchlist SQLite 初始化与连接管理。

RED 阶段：在 watchlist_routes.py 添加实现前，所有测试均应失败。
"""
from __future__ import annotations

import sqlite3

import pytest


def test_init_creates_db_file(tmp_path, monkeypatch):
    """调用 _init_db() 后，db 文件应存在于指定路径。"""
    import src.api.watchlist_routes as wm

    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)

    wm._init_db()

    assert db_file.exists(), "db 文件未创建"


def test_init_is_idempotent(tmp_path, monkeypatch):
    """连续调用两次 _init_db() 不报错，表结构不变。"""
    import src.api.watchlist_routes as wm

    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)

    wm._init_db()
    wm._init_db()  # 第二次不应抛异常


def test_table_schema(tmp_path, monkeypatch):
    """watchlist 表存在且含所有必需字段。"""
    import src.api.watchlist_routes as wm

    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    wm._init_db()

    conn = sqlite3.connect(db_file)
    cursor = conn.execute("PRAGMA table_info(watchlist)")
    columns = {row[1] for row in cursor.fetchall()}
    conn.close()

    for col in ("code", "market", "name", "added_at", "sort_order"):
        assert col in columns, f"缺少字段: {col}，实际: {columns}"


def test_primary_key(tmp_path, monkeypatch):
    """尝试插入相同 (code, market) 两次应抛 IntegrityError。"""
    import src.api.watchlist_routes as wm

    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    wm._init_db()

    conn = sqlite3.connect(db_file)
    conn.execute(
        "INSERT INTO watchlist(code, market, name) VALUES (?, ?, ?)",
        ("000001", "a_stock", "平安银行"),
    )
    conn.commit()

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO watchlist(code, market, name) VALUES (?, ?, ?)",
            ("000001", "a_stock", "重复"),
        )
        conn.commit()
    conn.close()


def test_custom_db_path(tmp_path, monkeypatch):
    """跨平台：在嵌套子目录下创建 db 文件，父目录自动创建。"""
    import src.api.watchlist_routes as wm

    db_file = tmp_path / "nested" / "dir" / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)

    wm._init_db()

    assert db_file.exists(), "嵌套路径下 db 文件未创建"
