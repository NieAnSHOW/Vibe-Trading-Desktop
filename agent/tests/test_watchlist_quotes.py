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


# ─── Task 7: TTL cache + stale fallback ──────────────────────────────────────

def test_cache_returns_stale_on_error(monkeypatch):
    """数据源超时/失败时，返回最后缓存值，不抛 HTTP 500。"""
    import src.api.watchlist_routes as wm
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    call_count = 0

    def mock_tencent_first(codes):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return {"000001": {"name": "平安银行", "price": 10.5, "change_pct": 1.0, "change_amt": 0.1, "high": 11.0, "low": 10.0, "amount_wan": 100.0}}
        raise Exception("network timeout")

    monkeypatch.setattr(wm, "tencent_quote", mock_tencent_first)
    # Clear cache before test
    wm._QUOTE_CACHE.clear()

    app = FastAPI()
    app.include_router(wm.router)
    client = TestClient(app)

    # First call — populates cache
    resp1 = client.get("/watchlist/quotes?codes=000001")
    assert resp1.status_code == 200
    assert resp1.json()["000001"]["price"] == 10.5

    # Manually expire cache so next call triggers the network (which will fail)
    wm._QUOTE_CACHE["000001"] = (0.0, wm._QUOTE_CACHE["000001"][1])  # ts=0 → expired

    # Second call — network fails, but returns stale cache
    resp2 = client.get("/watchlist/quotes?codes=000001")
    assert resp2.status_code == 200
    data = resp2.json()
    assert data["000001"]["price"] == 10.5  # stale value returned
    assert data["000001"].get("stale") is True  # stale flag


def test_cache_no_stale_returns_error_entry(monkeypatch):
    """无缓存时数据源失败，返回 error 字段条目，不抛 HTTP 500。"""
    import src.api.watchlist_routes as wm
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(wm, "tencent_quote", lambda codes: (_ for _ in ()).throw(Exception("timeout")))
    wm._QUOTE_CACHE.clear()

    app = FastAPI()
    app.include_router(wm.router)
    client = TestClient(app)

    resp = client.get("/watchlist/quotes?codes=999888")
    assert resp.status_code == 200
    data = resp.json()
    assert "error" in data["999888"]
