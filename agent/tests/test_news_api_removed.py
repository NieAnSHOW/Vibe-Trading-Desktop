"""Removal contract (spec 2026-08-30 §6.3): no news feed routes or singletons."""

from __future__ import annotations

import api_server


def test_no_news_api_routes_in_route_table() -> None:
    paths = {getattr(route, "path", "") for route in api_server.app.routes}
    offenders = {path for path in paths if path == "/news-api" or path.startswith("/news-api/")}
    assert offenders == set(), f"stale news routes: {sorted(offenders)}"


def test_no_feed_singletons_remain_on_the_serve_app() -> None:
    for name in (
        "_feed_store",
        "_feed_health",
        "_feed_transport",
        "_flash_aggregator",
        "_announcement_collector",
        "_feed_refresher",
        "_feed_service",
        "_feed_stop",
    ):
        assert not hasattr(api_server, name), name
