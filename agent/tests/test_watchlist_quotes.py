"""TDD：测试 QuoteProvider Protocol 和 TencentQuoteProvider。"""
from __future__ import annotations

import pytest
from unittest.mock import patch


def test_quote_provider_protocol():
    """QuoteProvider 是 Protocol，TencentQuoteProvider 满足其接口。"""
    from src.api.watchlist_routes import TencentQuoteProvider
    provider = TencentQuoteProvider()
    assert hasattr(provider, "market")
    assert hasattr(provider, "fetch")
    assert provider.market == "a_stock"


def test_tencent_provider_fetch_returns_unified_structure():
    """fetch() 返回统一行情结构：code/name/price/change_pct/change_amt/high/low/volume。"""
    from src.api.watchlist_routes import TencentQuoteProvider

    mock_data = {
        "000001": {
            "name": "平安银行",
            "price": 10.5,
            "change_pct": 1.2,
            "change_amt": 0.12,
            "high": 10.8,
            "low": 10.3,
            "amount_wan": 5000.0,
        }
    }
    with patch("src.api.watchlist_routes.tencent_quote", return_value=mock_data):
        provider = TencentQuoteProvider()
        result = provider.fetch(["000001"])

    assert "000001" in result
    q = result["000001"]
    assert q["name"] == "平安银行"
    assert q["price"] == 10.5
    assert q["change_pct"] == 1.2
    assert q["change_amt"] == 0.12


def test_tencent_provider_partial_failure():
    """某只票查询失败时，返回 error 字段，不抛异常。"""
    from src.api.watchlist_routes import TencentQuoteProvider

    # 只返回一只，另一只缺失
    mock_data = {"000001": {"name": "平安银行", "price": 10.5, "change_pct": 0.0, "change_amt": 0.0, "high": None, "low": None, "amount_wan": None}}
    with patch("src.api.watchlist_routes.tencent_quote", return_value=mock_data):
        provider = TencentQuoteProvider()
        result = provider.fetch(["000001", "999999"])

    assert "000001" in result
    assert "999999" in result
    assert "error" in result["999999"]


def test_tencent_provider_network_error():
    """网络错误时抛异常（由调用层捕获，非 provider 职责）。"""
    from src.api.watchlist_routes import TencentQuoteProvider

    with patch("src.api.watchlist_routes.tencent_quote", side_effect=Exception("timeout")):
        provider = TencentQuoteProvider()
        with pytest.raises(Exception):
            provider.fetch(["000001"])


# ─── Task 6: GET /watchlist/quotes endpoint ───────────────────────────────

@pytest.fixture()
def quotes_client(tmp_path, monkeypatch):
    """创建隔离 TestClient，mock tencent_quote。"""
    import src.api.watchlist_routes as wm
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(wm.router)
    return TestClient(app)


def test_quotes_endpoint_basic(quotes_client, monkeypatch):
    """GET /watchlist/quotes?codes=000001 返回行情数据。"""
    import src.api.watchlist_routes as wm
    mock_data = {"000001": {"name": "平安银行", "price": 10.5, "change_pct": 1.2, "change_amt": 0.12, "high": 10.8, "low": 10.3, "amount_wan": 5000.0}}
    monkeypatch.setattr(wm, "tencent_quote", lambda codes: mock_data)
    resp = quotes_client.get("/watchlist/quotes?codes=000001")
    assert resp.status_code == 200
    data = resp.json()
    assert "000001" in data
    assert data["000001"]["price"] == 10.5


def test_quotes_endpoint_empty_codes(quotes_client):
    """GET /watchlist/quotes 无 codes 参数返回 400。"""
    resp = quotes_client.get("/watchlist/quotes")
    assert resp.status_code == 400


def test_quotes_partial_failure(quotes_client, monkeypatch):
    """部分失败时，失败的 code 带 error 字段，不抛 500。"""
    import src.api.watchlist_routes as wm
    mock_data = {"000001": {"name": "平安银行", "price": 10.5, "change_pct": 0.0, "change_amt": 0.0, "high": None, "low": None, "amount_wan": None}}
    monkeypatch.setattr(wm, "tencent_quote", lambda codes: mock_data)
    resp = quotes_client.get("/watchlist/quotes?codes=000001,999999")
    assert resp.status_code == 200
    data = resp.json()
    assert "error" in data["999999"]


def test_quotes_unknown_market(quotes_client):
    """未知 market 参数返回 400。"""
    resp = quotes_client.get("/watchlist/quotes?codes=000001&market=unknown")
    assert resp.status_code == 400
