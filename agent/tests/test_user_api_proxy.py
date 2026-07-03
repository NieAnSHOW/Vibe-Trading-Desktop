"""Tests for the ``/user-api`` reverse proxy.

Production/desktop builds have no Vite proxy layer, so FastAPI reverse-proxies
``/user-api/*`` to the cool-admin user backend. These tests pin the contract:
``/user-api`` prefix stripped, method/body/query/Authorization forwarded, the
upstream status code passed through, and a 502 when the upstream is unreachable.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import api_server


@pytest.fixture()
def proxy_client(monkeypatch):
    """Install an httpx ``MockTransport`` handler, then yield a TestClient.

    Usage: ``client = proxy_client(handler)`` where ``handler`` receives the
    upstream ``httpx.Request`` and returns the canned ``httpx.Response``.
    """
    def install(handler):
        transport = httpx.MockTransport(handler)

        class _MockedAsyncClient(httpx.AsyncClient):
            def __init__(self, *args, **kwargs):
                kwargs["transport"] = transport
                super().__init__(*args, **kwargs)

        monkeypatch.setattr(api_server.httpx, "AsyncClient", _MockedAsyncClient)
        return TestClient(api_server.app)

    return install


class TestUserApiProxy:
    def test_get_strips_prefix_and_forwards_query(self, proxy_client):
        captured = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured["method"] = req.method
            captured["path"] = req.url.path
            captured["url"] = str(req.url)
            return httpx.Response(200, content=b'{"code":1000,"data":{"ok":true}}')

        client = proxy_client(handler)
        r = client.get("/user-api/app/user/login/captcha?width=120&height=40")

        assert r.status_code == 200
        assert r.json() == {"code": 1000, "data": {"ok": True}}
        # The /user-api prefix must be stripped before forwarding upstream.
        assert captured["method"] == "GET"
        assert captured["path"] == "/app/user/login/captcha"
        # Query string survives (url is str and carries it verbatim).
        assert "width=120" in captured["url"] and "height=40" in captured["url"]
        assert captured["url"].startswith("https://trading-server.nieanshow.cn/")

    def test_post_forwards_body_and_bare_authorization(self, proxy_client):
        captured = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured["method"] = req.method
            captured["path"] = req.url.path
            captured["headers"] = dict(req.headers)
            captured["content"] = req.content
            return httpx.Response(200, content=b'{"code":1000}')

        client = proxy_client(handler)
        r = client.post(
            "/user-api/app/user/login/phone",
            json={"phone": "13800000000", "smsCode": "1234"},
            headers={"Authorization": "raw-token"},
        )

        assert r.status_code == 200
        assert captured["method"] == "POST"
        assert captured["path"] == "/app/user/login/phone"
        # cool-admin expects a bare token (no "Bearer " prefix) — must survive.
        assert captured["headers"]["authorization"] == "raw-token"
        assert b"13800000000" in captured["content"]

    def test_upstream_status_passed_through(self, proxy_client):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(404, content=b'{"code":1003,"message":"no such"}')

        client = proxy_client(handler)
        r = client.get("/user-api/anything")

        assert r.status_code == 404

    def test_upstream_error_returns_502(self, proxy_client):
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("upstream unreachable")

        client = proxy_client(handler)
        r = client.get("/user-api/anything")

        assert r.status_code == 502
        assert "proxy error" in r.json()["detail"]
