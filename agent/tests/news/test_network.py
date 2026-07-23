from __future__ import annotations

import asyncio
import datetime as dt
import ssl
from collections import defaultdict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from functools import wraps
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from src.news.catalog import FeedEndpoint
from src.news import network
from src.news.network import MAX_RESPONSE_BYTES, PublicFeedClient


class _ByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], *, delay: float = 0.0) -> None:
        self._chunks = chunks
        self._delay = delay

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield chunk

    async def aclose(self) -> None:
        return None


@dataclass
class FakeResolver:
    addresses: dict[str, list[str]]
    calls: list[str] = field(default_factory=list)

    async def resolve(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.addresses[host]


class FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict[str, httpx.Response] | None = None, *, delay: float = 0.0) -> None:
        self.responses = responses or {}
        self.requests: list[httpx.Request] = []
        self.delay = delay
        self.active = 0
        self.peak_active = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            response = self.responses[str(request.url)]
            return httpx.Response(
                response.status_code,
                headers=response.headers,
                stream=response.stream,
                request=request,
            )
        finally:
            self.active -= 1


class TimeoutTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        raise httpx.ReadTimeout("private diagnostic", request=request)


class SequenceTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = responses
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        response = self._responses.pop(0)
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=response.stream,
            request=request,
        )


class HostTrackingTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.active: dict[str, int] = defaultdict(int)
        self.peak_active: dict[str, int] = defaultdict(int)
        self.entered: dict[str, asyncio.Event] = defaultdict(asyncio.Event)
        self.release = asyncio.Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.headers["host"]
        self.active[host] += 1
        self.peak_active[host] = max(self.peak_active[host], self.active[host])
        self.entered[host].set()
        try:
            await self.release.wait()
            return httpx.Response(200, stream=_ByteStream([b"ok"]), request=request)
        finally:
            self.active[host] -= 1


class BlockingRetrySleep:
    def __init__(self, expected_calls: int) -> None:
        self.expected_calls = expected_calls
        self.calls = 0
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, _delay: float) -> None:
        self.calls += 1
        if self.calls == self.expected_calls:
            self.entered.set()
        await self.release.wait()


class BlockingTransport(httpx.AsyncBaseTransport):
    def __init__(self, expected_requests: int) -> None:
        self.expected_requests = expected_requests
        self.requests: list[httpx.Request] = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if len(self.requests) == self.expected_requests:
            self.entered.set()
        await self.release.wait()
        return httpx.Response(200, stream=_ByteStream([b"ok"]), request=request)


class RedirectThenBlockingTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.second_request_started = asyncio.Event()
        self.release = asyncio.Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if len(self.requests) == 1:
            return httpx.Response(302, headers={"location": "/next"}, request=request)
        self.second_request_started.set()
        await self.release.wait()
        return httpx.Response(200, stream=_ByteStream([b"ok"]), request=request)


class BrokenResolver:
    async def resolve(self, host: str) -> list[str]:
        raise RuntimeError("private resolver diagnostic")


class HangingResolver:
    async def resolve(self, host: str) -> list[str]:
        await asyncio.Event().wait()
        return []


def endpoint(url: str = "https://feed.example/rss") -> FeedEndpoint:
    return FeedEndpoint(id="endpoint", url=url, assignments=())


def rss_response() -> httpx.Response:
    return httpx.Response(200, stream=_ByteStream([b"<rss />"]))


async def record(delays: list[float], delay: float) -> None:
    delays.append(delay)


@dataclass
class Clock:
    value: float = 0.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def _async_test(function: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(function)
    def run(*args: Any, **kwargs: Any) -> Any:
        return asyncio.run(function(*args, **kwargs))

    return run


@_async_test
async def test_fetch_pins_request_to_resolved_ip_and_preserves_host_and_sni() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = FakeTransport(
        {"https://93.184.216.34/rss": httpx.Response(200, stream=_ByteStream([b"<rss />"]))}
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body == b"<rss />"
    assert result.error_code is None
    request = transport.requests[0]
    assert request.url.host == "93.184.216.34"
    assert request.headers["host"] == "feed.example"
    assert request.extensions["sni_hostname"] == "feed.example"


@_async_test
async def test_fetch_idna_canonicalizes_unicode_hostname_for_resolution_host_and_sni() -> None:
    resolver = FakeResolver(
        {
            "éxample.test": ["93.184.216.34"],
            "xn--xample-9ua.test": ["93.184.216.34"],
        }
    )
    transport = FakeTransport(
        {"https://93.184.216.34/rss": httpx.Response(200, stream=_ByteStream([b"<rss />"]))}
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint("https://éxample.test/rss"))

    assert result.body == b"<rss />"
    assert result.error_code is None
    assert resolver.calls == ["xn--xample-9ua.test"]
    assert transport.requests[0].headers["host"] == "xn--xample-9ua.test"
    assert transport.requests[0].extensions["sni_hostname"] == "xn--xample-9ua.test"


@pytest.mark.parametrize(
    ("url", "addresses", "expected_code"),
    [
        ("ftp://feed.example/rss", {"feed.example": ["93.184.216.34"]}, "unsupported_scheme"),
        ("https://user:pass@feed.example/rss", {"feed.example": ["93.184.216.34"]}, "invalid_url"),
        ("https://feed.example/rss", {"feed.example": ["127.0.0.1"]}, "unsafe_target"),
        ("https://feed.example/rss", {"feed.example": ["10.0.0.1"]}, "unsafe_target"),
        ("https://feed.example/rss", {"feed.example": ["169.254.0.1"]}, "unsafe_target"),
        ("https://feed.example/rss", {"feed.example": ["224.0.0.1"]}, "unsafe_target"),
        ("https://feed.example/rss", {"feed.example": ["203.0.113.1"]}, "unsafe_target"),
    ],
)
@_async_test
async def test_fetch_rejects_unsafe_or_invalid_targets(
    url: str, addresses: dict[str, list[str]], expected_code: str
) -> None:
    transport = FakeTransport()

    result = await PublicFeedClient(FakeResolver(addresses), transport=transport).fetch(endpoint(url))

    assert result.body is None
    assert result.error_code == expected_code
    assert transport.requests == []


@_async_test
async def test_fetch_rejects_mixed_public_and_private_dns_answers_before_transport() -> None:
    transport = FakeTransport()
    resolver = FakeResolver({"feed.example": ["93.184.216.34", "127.0.0.1"]})

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body is None
    assert result.error_code == "unsafe_target"
    assert transport.requests == []


@_async_test
async def test_fetch_revalidates_each_redirect_before_pinning_next_request() -> None:
    resolver = FakeResolver(
        {"feed.example": ["93.184.216.34"], "redirect.example": ["93.184.216.35"]}
    )
    transport = FakeTransport(
        {
            "https://93.184.216.34/rss": httpx.Response(302, headers={"location": "https://redirect.example/new"}),
            "https://93.184.216.35/new": httpx.Response(200, stream=_ByteStream([b"redirected"])),
        }
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body == b"redirected"
    assert result.error_code is None
    assert resolver.calls == ["feed.example", "redirect.example"]
    assert [request.headers["host"] for request in transport.requests] == ["feed.example", "redirect.example"]
    assert [request.extensions["sni_hostname"] for request in transport.requests] == ["feed.example", "redirect.example"]


@_async_test
async def test_fetch_disables_keepalive_when_redirect_hostnames_share_an_ip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_async_client = httpx.AsyncClient
    client_options: list[dict[str, Any]] = []

    def recording_async_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        client_options.append(kwargs)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(network.httpx, "AsyncClient", recording_async_client)
    resolver = FakeResolver(
        {"feed.example": ["93.184.216.34"], "redirect.example": ["93.184.216.34"]}
    )
    transport = FakeTransport(
        {
            "https://93.184.216.34/rss": httpx.Response(
                302, headers={"location": "https://redirect.example/new"}
            ),
            "https://93.184.216.34/new": httpx.Response(200, stream=_ByteStream([b"redirected"])),
        }
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body == b"redirected"
    assert len(client_options) == 1
    assert client_options[0]["limits"].max_keepalive_connections == 0
    assert [request.headers["host"] for request in transport.requests] == ["feed.example", "redirect.example"]
    assert [request.extensions["sni_hostname"] for request in transport.requests] == ["feed.example", "redirect.example"]


@_async_test
async def test_redirect_to_a_different_hostname_on_the_same_ip_opens_a_new_tls_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "feed.example")])
    now = dt.datetime.now(dt.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=1))
        .not_valid_after(now + dt.timedelta(minutes=5))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("feed.example"), x509.DNSName("redirect.example")]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "server-cert.pem"
    key_path = tmp_path / "server-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )

    connection_count = 0
    sni_hostnames: list[str | None] = []
    request_heads: list[bytes] = []
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    server_context.set_servername_callback(
        lambda _socket, server_name, _context: sni_hostnames.append(server_name)
    )

    async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal connection_count
        connection_count += 1
        try:
            while True:
                try:
                    request_head = await reader.readuntil(b"\r\n\r\n")
                except (asyncio.IncompleteReadError, ConnectionResetError):
                    break
                request_heads.append(request_head)
                close_after_response = b"\r\nconnection: close\r\n" in request_head.lower()
                if request_head.startswith(b"GET /rss "):
                    writer.write(
                        f"HTTP/1.1 302 Found\r\n"
                        f"Location: https://redirect.example:{server_port}/next\r\n"
                        "Content-Length: 0\r\n"
                        "Connection: keep-alive\r\n\r\n".encode("ascii")
                    )
                else:
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                    close_after_response = True
                await writer.drain()
                if close_after_response:
                    break
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_connection, "127.0.0.1", 0, ssl=server_context)
    server_port = server.sockets[0].getsockname()[1]
    client_context = ssl.create_default_context()
    client_context.check_hostname = False
    client_context.verify_mode = ssl.CERT_NONE
    transport = httpx.AsyncHTTPTransport(verify=client_context)

    def route_to_local_tls_server(parsed: Any, _address: Any, _port: int | None) -> str:
        return network.urlunsplit(
            ("https", f"127.0.0.1:{server_port}", parsed.path or "/", parsed.query, "")
        )

    monkeypatch.setattr(network, "_request_url", route_to_local_tls_server)
    resolver = FakeResolver(
        {"feed.example": ["93.184.216.34"], "redirect.example": ["93.184.216.34"]}
    )

    try:
        result = await PublicFeedClient(resolver, transport=transport).fetch(
            endpoint(f"https://feed.example:{server_port}/rss")
        )
    finally:
        server.close()
        await server.wait_closed()

    assert result.body == b"ok"
    assert result.error_code is None
    assert resolver.calls == ["feed.example", "redirect.example"]
    assert connection_count == 2
    assert sni_hostnames == ["feed.example", "redirect.example"]
    assert all(b"\r\nconnection: close\r\n" in request_head.lower() for request_head in request_heads)


@_async_test
async def test_fetch_rejects_an_unsafe_redirect_target() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"], "internal.example": ["127.0.0.1"]})
    transport = FakeTransport(
        {"https://93.184.216.34/rss": httpx.Response(302, headers={"location": "http://internal.example/secret"})}
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.error_code == "unsafe_target"
    assert len(transport.requests) == 1


@_async_test
async def test_fetch_stops_after_three_redirects() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = FakeTransport(
        {
            "https://93.184.216.34/a": httpx.Response(302, headers={"location": "/b"}),
            "https://93.184.216.34/b": httpx.Response(302, headers={"location": "/c"}),
            "https://93.184.216.34/c": httpx.Response(302, headers={"location": "/d"}),
            "https://93.184.216.34/d": httpx.Response(302, headers={"location": "/e"}),
        }
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint("https://feed.example/a"))

    assert result.error_code == "too_many_redirects"
    assert len(transport.requests) == 4


@_async_test
async def test_fetch_limits_streamed_body_to_two_mebibytes() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = FakeTransport(
        {
            "https://93.184.216.34/rss": httpx.Response(
                200, stream=_ByteStream([b"a" * 65536] * ((MAX_RESPONSE_BYTES // 65536) + 1))
            )
        }
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body is None
    assert result.error_code == "response_too_large"


@_async_test
async def test_fetch_maps_timeouts_without_exposing_diagnostic_text() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = TimeoutTransport()

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body is None
    assert result.error_code == "timeout"
    assert transport.requests[0].extensions["timeout"] == {
        "connect": 5.0,
        "read": 15.0,
        "write": 15.0,
        "pool": 5.0,
    }


@_async_test
async def test_retry_after_is_honored_then_successful() -> None:
    delays: list[float] = []
    transport = SequenceTransport([httpx.Response(429, headers={"Retry-After": "3"}), rss_response()])
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})

    result = await PublicFeedClient(
        resolver,
        transport=transport,
        sleep=lambda delay: record(delays, delay),
    ).fetch(endpoint())

    assert result.ok is True
    assert delays == [3.0]
    assert len(transport.requests) == 2


@_async_test
async def test_fetch_does_not_retry_non_retryable_http_status() -> None:
    delays: list[float] = []
    transport = SequenceTransport([httpx.Response(404)])
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})

    result = await PublicFeedClient(
        resolver,
        transport=transport,
        sleep=lambda delay: record(delays, delay),
    ).fetch(endpoint())

    assert result.error_code == "http_status"
    assert delays == []
    assert len(transport.requests) == 1


@_async_test
async def test_exhausted_429_retries_return_rate_limited() -> None:
    delays: list[float] = []
    transport = SequenceTransport([httpx.Response(429), httpx.Response(429), httpx.Response(429)])
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})

    result = await PublicFeedClient(
        resolver,
        transport=transport,
        sleep=lambda delay: record(delays, delay),
    ).fetch(endpoint())

    assert result.error_code == "rate_limited"
    assert delays == [1.0, 2.0]
    assert len(transport.requests) == 3


@_async_test
async def test_deadline_after_huge_retry_after_opens_endpoint_circuit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(network, "TOTAL_FETCH_TIMEOUT_SECONDS", 0.001)
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = SequenceTransport([httpx.Response(429, headers={"Retry-After": "999999999"}) for _ in range(4)])
    client = PublicFeedClient(resolver, transport=transport)

    for _ in range(3):
        assert (await client.fetch(endpoint())).error_code == "timeout"
    assert len(transport.requests) == 3

    assert (await client.fetch(endpoint())).error_code == "circuit_open"
    assert len(transport.requests) == 3


@_async_test
async def test_open_endpoint_circuit_skips_transport_until_cooldown() -> None:
    clock = Clock()
    transport = TimeoutTransport()
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    client = PublicFeedClient(resolver, transport=transport, sleep=lambda _delay: record([], 0), now=clock.now)

    for _ in range(3):
        assert (await client.fetch(endpoint())).error_code == "timeout"
    assert len(transport.requests) == 9

    assert (await client.fetch(endpoint())).error_code == "circuit_open"
    assert len(transport.requests) == 9

    clock.advance(network.CIRCUIT_COOLDOWN_SECONDS)
    assert (await client.fetch(endpoint())).error_code == "timeout"
    assert len(transport.requests) == 12


@_async_test
async def test_fetches_limit_concurrency_per_logical_host() -> None:
    per_host_limit = 4
    resolver = FakeResolver({"feed.example": ["93.184.216.34"], "other.example": ["93.184.216.34"]})
    transport = HostTrackingTransport()
    client = PublicFeedClient(resolver, transport=transport)
    same_host_tasks = [
        asyncio.create_task(client.fetch(endpoint(f"https://feed.example/{index}")))
        for index in range(per_host_limit + 1)
    ]
    other_host_task = asyncio.create_task(client.fetch(endpoint("https://other.example/rss")))

    try:
        await asyncio.wait_for(transport.entered["feed.example"].wait(), timeout=0.1)
        await asyncio.wait_for(transport.entered["other.example"].wait(), timeout=0.1)
        assert transport.peak_active["feed.example"] == per_host_limit
        assert transport.peak_active["other.example"] == 1
    finally:
        transport.release.set()
        results = await asyncio.gather(*same_host_tasks, other_host_task)

    assert all(result.ok for result in results)


@_async_test
async def test_host_queue_does_not_consume_global_concurrency() -> None:
    resolver = FakeResolver({"feed.example": ["93.184.216.34"], "other.example": ["93.184.216.34"]})
    transport = HostTrackingTransport()
    client = PublicFeedClient(resolver, transport=transport)
    same_host_tasks = [
        asyncio.create_task(client.fetch(endpoint(f"https://feed.example/{index}")))
        for index in range(network.MAX_CONCURRENT_REQUESTS)
    ]

    for _ in range(10):
        limiters = client._host_semaphores.get(asyncio.get_running_loop())
        limiter = limiters.get("feed.example") if limiters is not None else None
        if limiter is not None and limiter.reservations == network.MAX_CONCURRENT_REQUESTS:
            break
        await asyncio.sleep(0)
    else:
        pytest.fail("same-host requests did not queue")

    other_host_task = asyncio.create_task(client.fetch(endpoint("https://other.example/rss")))
    try:
        await asyncio.wait_for(transport.entered["other.example"].wait(), timeout=0.1)
        assert transport.peak_active["feed.example"] == network.MAX_CONCURRENT_REQUESTS_PER_HOST
        assert transport.peak_active["other.example"] == 1
    finally:
        transport.release.set()
        results = await asyncio.gather(*same_host_tasks, other_host_task)

    assert all(result.ok for result in results)


@_async_test
async def test_retry_wait_does_not_consume_global_concurrency() -> None:
    retry_sleep = BlockingRetrySleep(expected_calls=network.MAX_CONCURRENT_REQUESTS)
    resolver = FakeResolver({f"feed-{index}.example": ["93.184.216.34"] for index in range(17)})
    slow_tasks = [
        asyncio.create_task(
            PublicFeedClient(
                resolver,
                transport=SequenceTransport([httpx.Response(429), rss_response()]),
                sleep=retry_sleep,
            ).fetch(endpoint(f"https://feed-{index}.example/rss"))
        )
        for index in range(network.MAX_CONCURRENT_REQUESTS)
    ]
    await asyncio.wait_for(retry_sleep.entered.wait(), timeout=0.1)
    fast_transport = FakeTransport({"https://93.184.216.34/rss": rss_response()})
    fast_task = asyncio.create_task(
        PublicFeedClient(resolver, transport=fast_transport).fetch(endpoint("https://feed-16.example/rss"))
    )

    try:
        await asyncio.wait_for(asyncio.shield(fast_task), timeout=0.1)
    finally:
        retry_sleep.release.set()
        results = await asyncio.gather(*slow_tasks, fast_task)

    assert all(result.ok for result in results)


@_async_test
async def test_host_limiter_cache_evicts_idle_hostnames(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(network, "MAX_HOST_SEMAPHORE_CACHE_SIZE", 4, raising=False)
    resolver = FakeResolver({f"feed-{index}.example": ["93.184.216.34"] for index in range(5)})
    transport = FakeTransport(
        {f"https://93.184.216.34/{index}": rss_response() for index in range(5)}
    )
    client = PublicFeedClient(resolver, transport=transport)

    for index in range(5):
        assert (await client.fetch(endpoint(f"https://feed-{index}.example/{index}"))).ok

    host_semaphores = client._host_semaphores[asyncio.get_running_loop()]
    assert len(host_semaphores) <= 4


@_async_test
async def test_fetch_maps_unexpected_resolver_failures_to_a_stable_code() -> None:
    result = await PublicFeedClient(BrokenResolver(), transport=FakeTransport()).fetch(endpoint())

    assert result.body is None
    assert result.error_code == "dns_failed"


@_async_test
async def test_fetch_applies_a_total_deadline_to_dns_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(network, "TOTAL_FETCH_TIMEOUT_SECONDS", 0.001, raising=False)

    result = await asyncio.wait_for(
        PublicFeedClient(HangingResolver(), transport=FakeTransport()).fetch(endpoint()), timeout=0.1
    )

    assert result.body is None
    assert result.error_code == "timeout"


@_async_test
async def test_fetch_applies_a_total_deadline_to_a_slow_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(network, "TOTAL_FETCH_TIMEOUT_SECONDS", 0.02)
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})
    transport = FakeTransport(
        {"https://93.184.216.34/rss": httpx.Response(200, stream=_ByteStream([b"a"] * 10, delay=0.04))}
    )

    result = await PublicFeedClient(resolver, transport=transport).fetch(endpoint())

    assert result.body is None
    assert result.error_code == "timeout"


@_async_test
async def test_fetch_applies_total_deadline_across_redirect_request_stages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(network, "TOTAL_FETCH_TIMEOUT_SECONDS", 0.01)
    transport = RedirectThenBlockingTransport()
    resolver = FakeResolver({"feed.example": ["93.184.216.34"]})

    try:
        result = await asyncio.wait_for(PublicFeedClient(resolver, transport=transport).fetch(endpoint()), timeout=0.1)
    finally:
        transport.release.set()

    assert result.body is None
    assert result.error_code == "timeout"
    assert len(transport.requests) == 2
    assert transport.second_request_started.is_set()


@_async_test
async def test_fetch_applies_total_deadline_while_waiting_for_global_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolver = FakeResolver({f"feed-{index}.example": ["93.184.216.34"] for index in range(17)})
    transport = BlockingTransport(expected_requests=16)
    client = PublicFeedClient(resolver, transport=transport)
    holders = [
        asyncio.create_task(client.fetch(endpoint(f"https://feed-{index}.example/{index}"))) for index in range(16)
    ]
    await asyncio.wait_for(transport.entered.wait(), timeout=0.1)
    monkeypatch.setattr(network, "TOTAL_FETCH_TIMEOUT_SECONDS", 0.01)

    try:
        result = await asyncio.wait_for(client.fetch(endpoint("https://feed-16.example/queued")), timeout=0.1)
    finally:
        transport.release.set()
        await asyncio.gather(*holders)

    assert result.body is None
    assert result.error_code == "timeout"
    assert len(transport.requests) == 16


@_async_test
async def test_fetches_share_a_global_concurrency_limit_of_sixteen() -> None:
    resolver = FakeResolver({f"feed-{index}.example": ["93.184.216.34"] for index in range(20)})
    responses = {
        f"https://93.184.216.34/{index}": httpx.Response(200, stream=_ByteStream([b"ok"])) for index in range(20)
    }
    transport = FakeTransport(responses, delay=0.01)
    client = PublicFeedClient(resolver, transport=transport)

    results = await asyncio.gather(
        *(client.fetch(endpoint(f"https://feed-{index}.example/{index}")) for index in range(20))
    )

    assert all(result.body == b"ok" for result in results)
    assert transport.peak_active == 16
