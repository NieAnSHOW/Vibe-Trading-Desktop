"""Tests for dashboard AI summary route with caching and validation."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_cache():
    """Clear the module-level cache between tests so cache state does not leak."""
    from src.api import dashboard_routes as routes
    routes._cache.clear()


def _build_test_app():
    """Create an isolated FastAPI app with dashboard routes and no-op auth."""
    app = FastAPI()

    async def _noop_auth():
        return None

    from src.api.dashboard_routes import register_dashboard_routes
    register_dashboard_routes(app, require_auth=_noop_auth)
    return app


@pytest.fixture
def client():
    """Return a TestClient against an isolated app."""
    return TestClient(_build_test_app())


def snapshot(force_refresh: bool = False) -> dict:
    return {
        "market": "a_share",
        "market_as_of": "2026-07-13T10:00:00Z",
        "force_refresh": force_refresh,
        "indices": [
            {"code": "000001", "name": "上证指数", "price": 3428.0, "change_pct": 0.84},
            {"code": "399001", "name": "深证成指", "price": 10761.0, "change_pct": 1.13},
            {"code": "399006", "name": "创业板指", "price": 2214.0, "change_pct": -0.22},
        ],
        "sectors": [{"name": "半导体", "change_pct": 2.1}],
        "watchlist": [{"code": "600519", "name": "贵州茅台", "change_pct": 1.2}],
    }


VALID_JSON = (
    '{"headline":"风险偏好回升","drivers":["半导体走强"],'
    '"risks":["高位分化"],"focus":["观察成交量"]}'
)


# ---------------------------------------------------------------------------
# Valid snapshot → validated summary
# ---------------------------------------------------------------------------

def test_valid_snapshot_returns_validated_summary(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_invoke(_snapshot):
        counter["calls"] += 1
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_invoke)

    resp = client.post("/dashboard/market-summary", json=snapshot())
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["summary"]["headline"] == "风险偏好回升"
    assert body["summary"]["drivers"] == ["半导体走强"]
    assert body["summary"]["risks"] == ["高位分化"]
    assert body["summary"]["focus"] == ["观察成交量"]
    assert counter["calls"] == 1


# ---------------------------------------------------------------------------
# Cache hit skips second LLM call
# ---------------------------------------------------------------------------

def test_cache_hit_skips_second_llm_call(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_invoke(_snapshot):
        counter["calls"] += 1
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_invoke)

    # First call — should invoke LLM
    r1 = client.post("/dashboard/market-summary", json=snapshot())
    assert r1.status_code == 200
    assert r1.json()["available"] is True
    assert counter["calls"] == 1

    # Second call with same 5-minute bucket — should hit cache
    r2 = client.post("/dashboard/market-summary", json=snapshot())
    assert r2.status_code == 200
    assert r2.json()["available"] is True
    assert counter["calls"] == 1  # no additional call


# ---------------------------------------------------------------------------
# force_refresh invokes LLM again
# ---------------------------------------------------------------------------

def test_force_refresh_invokes_llm_again(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_invoke(_snapshot):
        counter["calls"] += 1
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_invoke)

    # Seed cache
    r1 = client.post("/dashboard/market-summary", json=snapshot())
    assert r1.status_code == 200
    assert counter["calls"] == 1

    # force_refresh should bypass cache
    r2 = client.post("/dashboard/market-summary", json=snapshot(force_refresh=True))
    assert r2.status_code == 200
    assert counter["calls"] == 2


# ---------------------------------------------------------------------------
# Too many sectors → 422 without LLM call
# ---------------------------------------------------------------------------

def test_too_many_sectors_returns_422_without_llm_call(client, monkeypatch):
    from src.api import dashboard_routes as routes

    called = {"invoked": False}

    def mock_invoke(_snapshot):
        called["invoked"] = True
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_invoke)

    bad = snapshot()
    bad["sectors"] = [{"name": f"S{n}", "change_pct": 1.0} for n in range(13)]

    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422
    assert called["invoked"] is False


# ---------------------------------------------------------------------------
# Invalid model JSON → unavailable, not cached
# ---------------------------------------------------------------------------

def test_invalid_model_json_is_unavailable_and_not_cached(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_bad_then_good(_snapshot):
        counter["calls"] += 1
        if counter["calls"] == 1:
            return "not valid json {{{"  # unparseable
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_bad_then_good)

    # First call — invalid JSON
    r1 = client.post("/dashboard/market-summary", json=snapshot())
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["available"] is False
    assert body1["error_code"] is not None
    assert body1["summary"] is None
    assert counter["calls"] == 1

    # Second call — should NOT hit cache (bad result not cached), invokes LLM again
    r2 = client.post("/dashboard/market-summary", json=snapshot())
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["available"] is True
    assert counter["calls"] == 2


# ---------------------------------------------------------------------------
# LLM failure → safe 503 without provider text
# ---------------------------------------------------------------------------

def test_llm_failure_returns_safe_503_without_provider_text(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_failure(_snapshot):
        counter["calls"] += 1
        if counter["calls"] == 1:
            raise RuntimeError("provider returned 500: upstream service error")
        return VALID_JSON

    monkeypatch.setattr(routes, "_invoke_summary", mock_failure)

    r1 = client.post("/dashboard/market-summary", json=snapshot())
    assert r1.status_code == 503
    body1 = r1.json()
    assert body1["available"] is False
    assert body1["error_code"] is not None
    # Must NOT leak provider text
    assert "500" not in body1.get("detail", "")
    assert "upstream" not in body1.get("detail", "")

    # Second call should succeed (failure not cached)
    r2 = client.post("/dashboard/market-summary", json=snapshot())
    assert r2.status_code == 200
    assert r2.json()["available"] is True
    assert counter["calls"] == 2


# ---------------------------------------------------------------------------
# Stale cache returned on failure when prior success exists
# ---------------------------------------------------------------------------

def test_stale_cache_returned_on_repeated_failure(client, monkeypatch):
    from src.api import dashboard_routes as routes

    counter = {"calls": 0}

    def mock_first_ok_then_fail(_snapshot):
        counter["calls"] += 1
        if counter["calls"] == 1:
            return VALID_JSON
        raise RuntimeError("fail")

    monkeypatch.setattr(routes, "_invoke_summary", mock_first_ok_then_fail)

    # Seed cache
    r1 = client.post("/dashboard/market-summary", json=snapshot())
    assert r1.status_code == 200
    assert r1.json()["available"] is True
    assert counter["calls"] == 1

    # Force refresh to trigger failure — should get stale cache
    r2 = client.post("/dashboard/market-summary", json=snapshot(force_refresh=True))
    assert r2.status_code == 200  # degraded success with stale entry
    body2 = r2.json()
    assert body2["available"] is True
    assert body2["stale"] is True
    assert body2["summary"]["headline"] == "风险偏好回升"
    assert counter["calls"] == 2


# ---------------------------------------------------------------------------
# Validation edge cases
# ---------------------------------------------------------------------------

def test_invalid_market_rejected(client):
    bad = snapshot()
    bad["market"] = "us"
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


def test_invalid_index_code_rejected(client):
    bad = snapshot()
    bad["indices"] = [
        {"code": "000001", "name": "上证指数", "price": 3428.0, "change_pct": 0.84},
        {"code": "399001", "name": "深证成指", "price": 10761.0, "change_pct": 1.13},
        {"code": "999999", "name": "bad", "price": 1000.0, "change_pct": 0.0},
    ]
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


def test_wrong_number_of_indices_rejected(client):
    bad = snapshot()
    bad["indices"] = bad["indices"][:2]
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


def test_negative_price_rejected(client):
    bad = snapshot()
    bad["indices"][0]["price"] = -1.0
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


def test_change_pct_out_of_range_rejected(client):
    bad = snapshot()
    bad["indices"][0]["change_pct"] = 200.0
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


def test_too_many_watchlist_rejected(client):
    bad = snapshot()
    bad["watchlist"] = [{"code": f"00000{i}", "name": f"Stock{i}", "change_pct": 1.0} for i in range(31)]
    resp = client.post("/dashboard/market-summary", json=bad)
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Read-only dashboard market data
# ---------------------------------------------------------------------------


def test_board_heat_returns_normalized_provider_rows(client, monkeypatch):
    from src.api import dashboard_routes as routes

    monkeypatch.setattr(
        routes,
        "_fetch_board_heat",
        lambda kind: [
            {
                "code": "885959",
                "name": "PCB概念",
                "change_pct": 4.1278,
                "rise_count": None,
                "fall_count": None,
                "leading_stock": None,
                "leading_stock_change_pct": None,
            }
        ],
    )

    resp = client.get("/dashboard/board-heat?kind=concept")

    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "10jqka-hot-list"
    assert body["stale"] is False
    assert body["data"][0] == {
        "code": "885959",
        "name": "PCB概念",
        "change_pct": 4.1278,
        "rise_count": None,
        "fall_count": None,
        "leading_stock": None,
        "leading_stock_change_pct": None,
    }


def test_fetch_board_heat_loads_provider_dependencies_on_demand(monkeypatch):
    from backtest.loaders import _http, registry
    from src.api import dashboard_routes as routes

    applied = []
    monkeypatch.setattr(registry, "_apply_china_direct_no_proxy", lambda: applied.append(True))
    monkeypatch.setattr(
        _http,
        "throttled_get_json",
        lambda *_args, **_kwargs: {
            "data": {"plate_list": [{"code": "885959", "name": "PCB概念", "rise_and_fall": "4.1278"}]}
        },
    )

    assert routes._fetch_board_heat("concept") == [
        {
            "code": "885959",
            "name": "PCB概念",
            "change_pct": 4.1278,
            "rise_count": None,
            "fall_count": None,
            "leading_stock": None,
            "leading_stock_change_pct": None,
        }
    ]
    assert applied == [True]


def test_board_heat_rejects_unknown_kind(client):
    resp = client.get("/dashboard/board-heat?kind=region")
    assert resp.status_code == 422


def test_daily_bars_returns_tencent_history(client, monkeypatch):
    from src.api import dashboard_routes as routes

    seen = []

    def fake_fetch(symbol):
        seen.append(symbol)
        return [
            {
                "time": "2026-07-14",
                "open": 3909.27,
                "high": 3967.13,
                "low": 3869.3,
                "close": 3967.13,
                "volume": 579982052.0,
            }
        ]

    monkeypatch.setattr(routes, "_fetch_daily_bars", fake_fetch)

    resp = client.get("/dashboard/daily-bars?symbol=sh000001")

    assert resp.status_code == 200
    assert seen == ["sh000001"]
    body = resp.json()
    assert body["source"] == "tencent"
    assert body["data"][0]["close"] == 3967.13


def test_intraday_bars_returns_normalized_history(client, monkeypatch):
    from src.api import dashboard_routes as routes

    seen = []

    def fake_fetch(symbol):
        seen.append(symbol)
        return [
            {
                "time": "2026-07-23T09:31:00",
                "open": 10.0,
                "high": 10.2,
                "low": 9.9,
                "close": 10.1,
                "volume": 1200.0,
            }
        ]

    monkeypatch.setattr(routes, "_fetch_intraday_bars", fake_fetch, raising=False)

    response = client.get("/dashboard/intraday-bars?symbol=600519")

    assert response.status_code == 200
    assert seen == ["600519"]
    assert response.json()["source"] == "akshare"
    assert response.json()["data"][0]["close"] == 10.1


def test_intraday_bars_rejects_invalid_symbol(client):
    response = client.get("/dashboard/intraday-bars?symbol=invalid")

    assert response.status_code == 400
    assert "6-digit A-share code" in response.json()["detail"]


def test_intraday_bars_reports_provider_failure(client, monkeypatch):
    from src.api import dashboard_routes as routes

    def fake_fetch(_symbol):
        raise RuntimeError("offline")

    monkeypatch.setattr(routes, "_fetch_intraday_bars", fake_fetch, raising=False)

    response = client.get("/dashboard/intraday-bars?symbol=600519")

    assert response.status_code == 503
    assert response.json()["detail"] == "intraday bars unavailable"


def test_intraday_bars_falls_back_to_sina_when_eastmoney_fails(monkeypatch):
    import sys
    from types import SimpleNamespace

    import pandas as pd

    from src.api import dashboard_routes as routes

    today = datetime.now(routes._CHINA_TZ).strftime("%Y-%m-%d")
    seen = []

    def failing_eastmoney(**_kwargs):
        raise ConnectionError("eastmoney disconnected")

    def sina_minute(**kwargs):
        seen.append(kwargs)
        return pd.DataFrame(
            [
                {
                    "day": f"{today} 09:31:00",
                    "open": "78.1",
                    "high": "78.4",
                    "low": "78.0",
                    "close": "78.2",
                    "volume": "1200",
                }
            ]
        )

    monkeypatch.setitem(
        sys.modules,
        "akshare",
        SimpleNamespace(
            stock_zh_a_hist_min_em=failing_eastmoney,
            stock_zh_a_minute=sina_minute,
        ),
    )

    rows = routes._fetch_intraday_bars("688059")

    assert rows == [
        {
            "time": f"{today}T09:31:00",
            "open": 78.1,
            "high": 78.4,
            "low": 78.0,
            "close": 78.2,
            "volume": 1200.0,
        }
    ]
    assert seen == [{"symbol": "sh688059", "period": "1", "adjust": ""}]
