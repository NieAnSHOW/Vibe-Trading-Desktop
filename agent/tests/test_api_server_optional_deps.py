"""Smoke test: the optional-deps router is mounted on the main app."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_optional_deps_list_mounted():
    # Import lazily so the app is constructed with the router wired in.
    import api_server

    client = TestClient(api_server.app)
    resp = client.get("/optional-deps/list")
    assert resp.status_code == 200
    body = resp.json()
    assert "brokers" in body
    assert isinstance(body["brokers"], list)
