"""TDD：测试 api_server startup 事件幂等建表（Task 2.6 回归修复）。

锁回归：startup 必须调用 watchlist init_db，否则空库下
GET/POST/DELETE /watchlist/stocks 触发 sqlite3.OperationalError → FastAPI 500。
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_with_tmp_db(tmp_path, monkeypatch):
    """隔离 DB_PATH 并屏蔽无关 startup 副作用，返回 (app, db_file)。"""
    import api_server
    import src.api.watchlist_routes as wm
    import src.preflight as preflight_mod

    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    # 屏蔽与 watchlist 无关的 startup 副作用（preflight 网络/日志、后台 executor）
    monkeypatch.setattr(preflight_mod, "run_preflight", lambda *a, **kw: None)
    monkeypatch.setattr(api_server, "_start_scheduled_research_executor", lambda *a, **kw: None)
    return api_server.app, db_file


def test_startup_creates_watchlist_table(app_with_tmp_db):
    """startup 完成后 watchlist 表必须存在于 DB 文件中。"""
    app, db_file = app_with_tmp_db
    with TestClient(app):
        pass  # startup 在进入 context 时执行
    assert db_file.exists(), "startup 未创建 db 文件"
    conn = sqlite3.connect(db_file)
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='watchlist'"
    ).fetchall()
    conn.close()
    assert len(rows) == 1, "startup 后 watchlist 表不存在（漏调 init_db）"


def test_startup_makes_stocks_endpoint_return_200(app_with_tmp_db):
    """startup 后 GET /watchlist/stocks 返回 200（而非 500 no such table）。"""
    app, _ = app_with_tmp_db
    with TestClient(app) as client:
        resp = client.get("/watchlist/stocks")
    assert resp.status_code == 200, f"期望 200，实际 {resp.status_code}: {resp.text}"
    assert resp.json() == {"stocks": []}
