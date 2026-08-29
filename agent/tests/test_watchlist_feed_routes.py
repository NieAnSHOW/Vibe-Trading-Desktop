"""TDD：/news-api/watchlist-feed 路由契约（规格 §6.1/§6.1.1）。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.watchlist_feed_routes import register_watchlist_feed_routes
from src.news.refresh import RefreshDecision


class StubService:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls: list[tuple[str | None, str | None, int]] = []

    async def feed(self, after_cursor: str | None, before_cursor: str | None, limit: int = 50) -> dict:
        if after_cursor and before_cursor:
            raise ValueError("after_cursor and before_cursor are mutually exclusive")
        self.calls.append((after_cursor, before_cursor, limit))
        return self.payload


class StubRefresher:
    def __init__(self, decision: RefreshDecision) -> None:
        self.decision = decision

    async def trigger(self) -> RefreshDecision:
        return self.decision


VALID_PAYLOAD = {
    "items": [
        {
            "id": "eastmoney:202608291200",
            "source": "eastmoney",
            "type": "flash",
            "published_at": "2026-08-29T12:00:00+00:00",
            "title": "央行开展逆回购",
            "summary": "500亿元",
            "url": None,
            "matched_stocks": [{"code": "600519", "name": "贵州茅台", "match_rule": "structured_field"}],
            "confidence": "high",
        }
    ],
    "new_cursor": "watermark-cursor",
    "next_cursor": None,
    "source_health": [
        {"source_id": "eastmoney", "state": "ok", "last_success_at": "2026-08-29T12:00:00+00:00", "last_error": None},
        {"source_id": "sina", "state": "failed", "last_success_at": None, "last_error": "timeout"},
    ],
    "last_updated_at": None,
    "watchlist_version": "a" * 64,
    "reset_required": False,
}


def _app(service: StubService, refresher: StubRefresher) -> FastAPI:
    app = FastAPI()
    register_watchlist_feed_routes(app, require_auth=lambda: None, service=service, refresher=refresher)
    return app


def test_get_watchlist_feed_returns_payload():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed")
    assert resp.status_code == 200
    assert set(resp.json().keys()) == set(VALID_PAYLOAD.keys())
    assert resp.json()["new_cursor"] == "watermark-cursor"
    assert service.calls == [(None, None, 50)]


def test_get_watchlist_feed_passthrough_cursors_and_limit():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    client.get("/news-api/watchlist-feed", params={"after_cursor": "wm", "limit": 10})
    client.get("/news-api/watchlist-feed", params={"before_cursor": "pg", "limit": 10})
    assert service.calls == [("wm", None, 10), (None, "pg", 10)]


def test_get_watchlist_feed_rejects_both_cursors_400():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed", params={"after_cursor": "a", "before_cursor": "b"})
    assert resp.status_code == 400


def test_get_watchlist_feed_rejects_overlong_cursor():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, None, False))))
    resp = client.get("/news-api/watchlist-feed", params={"after_cursor": "x" * 513})
    assert resp.status_code == 422


def test_post_refresh_accepted_202():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(True, "task-1", False))))
    resp = client.post("/news-api/watchlist-feed/refresh")
    assert resp.status_code == 202
    assert resp.json() == {"accepted": True, "task_id": "task-1", "reused": False}


def test_post_refresh_rate_limited_429():
    service = StubService(dict(VALID_PAYLOAD))
    client = TestClient(_app(service, StubRefresher(RefreshDecision(False, None, False, rate_limited=True))))
    resp = client.post("/news-api/watchlist-feed/refresh")
    assert resp.status_code == 429
