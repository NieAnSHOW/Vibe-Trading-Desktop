"""TDD：添加自选解析证券名称 + 存量空名称回填（规格 §4.2）。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.watchlist_routes as wm


class FakeProvider:
    market = "a_stock"

    def __init__(self, names: dict[str, str]) -> None:
        self.names = names
        self.calls: list[list[str]] = []

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        self.calls.append(list(codes))
        return {code: {"code": code, "name": self.names.get(code, "")} for code in codes}


class BrokenProvider:
    market = "a_stock"

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        raise RuntimeError("quote source down")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "watchlist.db"
    monkeypatch.setattr(wm, "DB_PATH", db_file)
    monkeypatch.setattr(wm, "name_provider", None)
    wm._init_db()
    app = FastAPI()
    app.include_router(wm.router)
    return TestClient(app)


def test_add_stock_resolves_name(client, monkeypatch):
    monkeypatch.setattr(wm, "name_provider", FakeProvider({"600519": "贵州茅台"}))
    assert client.post("/watchlist/stocks", json={"code": "600519"}).json() == {"added": True, "exists": False}
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == "贵州茅台"


def test_add_stock_without_provider_keeps_empty_name(client):
    resp = client.post("/watchlist/stocks", json={"code": "600519"})
    assert resp.json()["added"] is True
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == ""


def test_add_stock_keeps_empty_name_when_provider_fails(client, monkeypatch):
    monkeypatch.setattr(wm, "name_provider", BrokenProvider())
    assert client.post("/watchlist/stocks", json={"code": "600519"}).json()["added"] is True
    stocks = client.get("/watchlist/stocks").json()["stocks"]
    assert stocks[0]["name"] == ""


def test_backfill_updates_only_resolved_rows(client, monkeypatch):
    provider = FakeProvider({"000001": "平安银行"})
    monkeypatch.setattr(wm, "name_provider", provider)
    with wm._get_connection() as conn:
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('000001', '', 'a_stock')")
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('600519', '', 'a_stock')")
        conn.commit()

    updated = wm.backfill_missing_names()

    assert updated == 1  # 600519 解析结果为空名 → 保持空名称
    with wm._get_connection() as conn:
        rows = dict(conn.execute("SELECT code, name FROM watchlist").fetchall())
    assert rows == {"000001": "平安银行", "600519": ""}


def test_backfill_no_provider_noop(client, tmp_path):
    with wm._get_connection() as conn:
        conn.execute("INSERT INTO watchlist(code, name, market) VALUES ('000001', '', 'a_stock')")
        conn.commit()
    assert wm.backfill_missing_names() == 0  # 未注入 provider → 不触网、不改数据


def test_register_injects_default_provider(monkeypatch):
    monkeypatch.setattr(wm, "name_provider", None)
    app = FastAPI()
    wm.register_watchlist_routes(app)
    assert wm.name_provider is wm._DEFAULT_PROVIDER
