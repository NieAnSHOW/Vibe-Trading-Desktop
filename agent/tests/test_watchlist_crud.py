"""TDD：测试 watchlist CRUD 端点（GET/POST/DELETE /watchlist/stocks）。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """创建隔离 TestClient，使用临时 DB 文件。"""
    import src.api.watchlist_routes as wm
    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    wm._init_db()

    app = FastAPI()
    app.include_router(wm.router)
    return TestClient(app)


def test_list_stocks_empty(client):
    """初始化后 GET /watchlist/stocks 返回空列表。"""
    resp = client.get("/watchlist/stocks")
    assert resp.status_code == 200
    assert resp.json() == {"stocks": []}


def test_add_stock(client):
    """POST 后 GET 返回该股票。"""
    resp = client.post("/watchlist/stocks", json={"code": "000001"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["added"] is True

    resp2 = client.get("/watchlist/stocks")
    stocks = resp2.json()["stocks"]
    assert len(stocks) == 1
    assert stocks[0]["code"] == "000001"


def test_add_duplicate(client):
    """重复 POST 返回 exists=true，不报错。"""
    client.post("/watchlist/stocks", json={"code": "000001"})
    resp = client.post("/watchlist/stocks", json={"code": "000001"})
    assert resp.status_code == 200
    assert resp.json()["exists"] is True


def test_delete_stock(client):
    """POST 后 DELETE，GET 返回空列表。"""
    client.post("/watchlist/stocks", json={"code": "600519"})
    resp = client.delete("/watchlist/stocks/600519")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True

    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks == []


def test_delete_nonexistent(client):
    """DELETE 不存在的股票返回 404。"""
    resp = client.delete("/watchlist/stocks/999999")
    assert resp.status_code == 404
