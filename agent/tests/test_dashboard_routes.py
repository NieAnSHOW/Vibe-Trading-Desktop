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
