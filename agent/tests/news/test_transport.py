"""TDD：通用化传输层（规格 §6.5 七条验收 + 重试/熔断/SSRF 回归）。"""

from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any, Callable

import httpx
import pytest

from src.news.transport import TransportClient, TransportError, TransportRequest


class FakeResolver:
    def __init__(self, addresses: dict[str, list[str]]) -> None:
        self.addresses = addresses
        self.calls: list[str] = []

    async def resolve(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.addresses.get(host, ["93.184.216.34"])


class FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict[str, httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses[str(request.url)]


class QueuedTransport(httpx.AsyncBaseTransport):
    """按调用次序弹出响应，用于重试/熔断序列。"""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses.pop(0)


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


async def _no_sleep(_seconds: float) -> None:
    return None


def _client(
    responses: dict[str, httpx.Response], resolver: FakeResolver | None = None
) -> tuple[TransportClient, FakeTransport]:
    fake = FakeTransport(responses)
    client = TransportClient(resolver=resolver or FakeResolver({}), transport=fake, sleep=_no_sleep)
    return client, fake


BASE = "https://feeds.example.test"


@_async_test
async def test_get_json_roundtrip():
    client, fake = _client(
        {
            "https://93.184.216.34/json": httpx.Response(
                200, headers={"content-type": "application/json"}, json={"ok": True}
            ),
        }
    )
    response = await client.fetch(TransportRequest(url=f"{BASE}/json"))
    assert response.status_code == 200
    assert response.content_type == "application/json"
    assert response.body == b'{"ok":true}'
    assert response.final_url == f"{BASE}/json"
    assert response.elapsed_ms >= 0.0
    sent = fake.requests[0]
    assert sent.method == "GET"
    assert sent.extensions["sni_hostname"] == "feeds.example.test"


@_async_test
async def test_post_body_and_content_type_sent():
    client, fake = _client(
        {
            "https://93.184.216.34/post": httpx.Response(200, headers={"content-type": "application/json"}, json={}),
        }
    )
    await client.fetch(
        TransportRequest(
            url=f"{BASE}/post",
            method="POST",
            body=b"pageHelp.pageSize=25",
            content_type="application/x-www-form-urlencoded",
        )
    )
    sent = fake.requests[0]
    assert sent.method == "POST"
    assert sent.headers["content-type"] == "application/x-www-form-urlencoded"
    assert sent.read() == b"pageHelp.pageSize=25"


@_async_test
async def test_jsonp_received_as_text_plain():
    payload = b'jsonpCallback({"data": []})'
    client, _ = _client(
        {
            "https://93.184.216.34/jsonp": httpx.Response(200, headers={"content-type": "text/plain"}, content=payload),
        }
    )
    response = await client.fetch(TransportRequest(url=f"{BASE}/jsonp"))
    assert response.content_type == "text/plain"
    assert response.body == payload


@_async_test
async def test_html_within_whitelist():
    client, _ = _client(
        {
            "https://93.184.216.34/page": httpx.Response(
                200, headers={"content-type": "text/html; charset=utf-8"}, content=b"<html></html>"
            ),
        }
    )
    response = await client.fetch(TransportRequest(url=f"{BASE}/page"))
    assert response.content_type == "text/html"
    assert response.body == b"<html></html>"


@_async_test
async def test_redirect_hop_revalidates_ssrf():
    resolver = FakeResolver({"feeds.example.test": ["93.184.216.34"], "evil.example.test": ["127.0.0.1"]})
    client, fake = _client(
        {
            "https://93.184.216.34/redir": httpx.Response(302, headers={"location": "http://evil.example.test/x"}),
        },
        resolver=resolver,
    )
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/redir"))
    assert excinfo.value.code == "unsafe_target"
    assert len(fake.requests) == 1  # 第二跳在 SSRF 校验处被拒，未发出请求


@_async_test
async def test_oversized_body_rejected():
    client, _ = _client(
        {
            "https://93.184.216.34/big": httpx.Response(
                200, headers={"content-type": "application/json"}, content=b"x" * 100
            ),
        }
    )
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/big", max_response_bytes=8))
    assert excinfo.value.code == "response_too_large"


@_async_test
async def test_non_whitelisted_content_type_rejected():
    client, _ = _client(
        {
            "https://93.184.216.34/rss": httpx.Response(
                200, headers={"content-type": "application/xml"}, content=b"<rss/>"
            ),
        }
    )
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/rss"))
    assert excinfo.value.code == "unsupported_content_type"


@_async_test
async def test_retry_on_429_then_success():
    transport = QueuedTransport(
        [
            httpx.Response(429, headers={"retry-after": "0", "content-type": "text/plain"}),
            httpx.Response(200, headers={"content-type": "application/json"}, json={}),
        ]
    )
    client = TransportClient(transport=transport, sleep=_no_sleep)
    response = await client.fetch(TransportRequest(url=f"{BASE}/retry"))
    assert response.status_code == 200
    assert len(transport.requests) == 2


@_async_test
async def test_forbidden_maps_to_stable_code():
    client, _ = _client(
        {
            "https://93.184.216.34/deny": httpx.Response(403, headers={"content-type": "text/plain"}),
        }
    )
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/deny"))
    assert excinfo.value.code == "forbidden"


@_async_test
async def test_circuit_opens_after_repeated_failures():
    transport = QueuedTransport([httpx.Response(500, headers={"content-type": "text/plain"}) for _ in range(9)])
    client = TransportClient(transport=transport, sleep=_no_sleep)
    for _ in range(3):  # 每次请求内部重试 3 次 → 9 次真实请求后熔断
        with pytest.raises(TransportError) as excinfo:
            await client.fetch(TransportRequest(url=f"{BASE}/flaky"))
        assert excinfo.value.code == "http_status"
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url=f"{BASE}/flaky"))
    assert excinfo.value.code == "circuit_open"
    assert len(transport.requests) == 9


@_async_test
async def test_unsafe_direct_target_rejected():
    resolver = FakeResolver({"loopback.example.test": ["127.0.0.1"]})
    client, _ = _client({}, resolver=resolver)
    with pytest.raises(TransportError) as excinfo:
        await client.fetch(TransportRequest(url="http://loopback.example.test/x"))
    assert excinfo.value.code == "unsafe_target"
