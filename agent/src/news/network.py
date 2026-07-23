"""Bounded, SSRF-hardened transport for configured public news feeds."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
import ipaddress
import math
import socket
import time
from typing import Protocol
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit
from weakref import WeakKeyDictionary

import httpx

from .catalog import FeedEndpoint


CONNECT_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 15.0
TOTAL_FETCH_TIMEOUT_SECONDS = 15.0
MAX_REDIRECTS = 3
MAX_CONCURRENT_REQUESTS = 16
MAX_CONCURRENT_REQUESTS_PER_HOST = 4
MAX_HOST_SEMAPHORE_CACHE_SIZE = 64
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = frozenset({408, 429, *range(500, 600)})
RETRY_BASE_DELAY_SECONDS = 1.0
CIRCUIT_FAILURE_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECONDS = 60.0


class HostResolver(Protocol):
    """Resolve a hostname to numeric IP addresses."""

    def resolve(self, host: str) -> Awaitable[Sequence[str]]:
        """Return all addresses currently resolved for *host*."""


class _SystemResolver:
    async def resolve(self, host: str) -> Sequence[str]:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
        return tuple(record[4][0] for record in records)


@dataclass(frozen=True)
class EndpointFetchResult:
    """A feed payload or a non-sensitive, stable failure code."""

    endpoint: FeedEndpoint
    body: bytes | None
    error_code: str | None
    final_url: str | None = None

    @property
    def ok(self) -> bool:
        return self.body is not None and self.error_code is None


class PublicFeedClient:
    """Fetch fixed feed endpoints without allowing DNS or redirect SSRF bypasses."""

    _semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()
    _host_semaphores: WeakKeyDictionary[
        asyncio.AbstractEventLoop, OrderedDict[str, "_HostLimiter"]
    ] = WeakKeyDictionary()

    def __init__(
        self,
        resolver: HostResolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._resolver = resolver or _SystemResolver()
        self._transport = transport
        self._sleep = sleep
        self._now = now
        self._circuit = _EndpointCircuit()

    async def fetch(self, endpoint: FeedEndpoint) -> EndpointFetchResult:
        """Fetch one configured endpoint, returning failures as stable codes."""
        try:
            async with asyncio.timeout(TOTAL_FETCH_TIMEOUT_SECONDS):
                if self._circuit.is_open(endpoint.url, self._now()):
                    return self._failure(endpoint, "circuit_open")
                for attempt in range(MAX_ATTEMPTS):
                    result, retry_after, retryable = await self._fetch_once(endpoint)
                    if result.ok:
                        self._circuit.record_success(endpoint.url)
                        return result
                    if not retryable or attempt == MAX_ATTEMPTS - 1:
                        self._circuit.record_failure(endpoint.url, self._now())
                        return result
                    await self._sleep(self._retry_delay(attempt, retry_after))
        except TimeoutError:
            self._circuit.record_failure(endpoint.url, self._now())
            return self._failure(endpoint, "timeout")

    async def _fetch_once(self, endpoint: FeedEndpoint) -> tuple[EndpointFetchResult, float | None, bool]:
        current_url = endpoint.url
        redirects = 0
        timeout = httpx.Timeout(
            connect=CONNECT_TIMEOUT_SECONDS,
            read=READ_TIMEOUT_SECONDS,
            write=READ_TIMEOUT_SECONDS,
            pool=CONNECT_TIMEOUT_SECONDS,
        )
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                timeout=timeout,
                limits=httpx.Limits(max_keepalive_connections=0),
            ) as client:
                while True:
                    target, error_code = await self._validated_target(current_url)
                    if error_code is not None:
                        return self._failure(endpoint, error_code), None, False
                    assert target is not None

                    try:
                        request = httpx.Request(
                            "GET",
                            target.request_url,
                            headers={
                                "Host": target.host_header,
                                "Accept": "application/atom+xml, application/rss+xml, application/xml",
                                "Connection": "close",
                            },
                            extensions={"sni_hostname": target.hostname},
                        )
                    except (UnicodeError, ValueError, httpx.InvalidURL):
                        return self._failure(endpoint, "invalid_url"), None, False
                    async with self._host_limit(target.hostname):
                        async with self._semaphore():
                            response = await client.send(request, stream=True)
                            try:
                                if response.is_redirect:
                                    if redirects >= MAX_REDIRECTS:
                                        return self._failure(endpoint, "too_many_redirects"), None, False
                                    location = response.headers.get("location")
                                    if not location:
                                        return self._failure(endpoint, "invalid_redirect"), None, False
                                    current_url = urljoin(current_url, location)
                                    redirects += 1
                                    continue
                                if response.status_code < 200 or response.status_code >= 300:
                                    retry_after = self._retry_after(response) if response.status_code == 429 else None
                                    code = "rate_limited" if response.status_code == 429 else "http_status"
                                    return (
                                        self._failure(endpoint, code),
                                        retry_after,
                                        response.status_code in RETRYABLE_STATUS_CODES,
                                    )
                                if self._content_length_too_large(response):
                                    return self._failure(endpoint, "response_too_large"), None, False
                                body, error_code = await self._read_body(response)
                                if error_code is not None:
                                    return self._failure(endpoint, error_code), None, False
                                return EndpointFetchResult(endpoint=endpoint, body=body, error_code=None, final_url=current_url), None, False
                            finally:
                                await response.aclose()
        except httpx.TimeoutException:
            return self._failure(endpoint, "timeout"), None, True
        except httpx.RequestError:
            return self._failure(endpoint, "network_error"), None, True

    @classmethod
    def _semaphore(cls) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        semaphore = cls._semaphores.get(loop)
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
            cls._semaphores[loop] = semaphore
        return semaphore

    @classmethod
    def _host_limiter(cls, hostname: str) -> "_HostLimiter":
        loop = asyncio.get_running_loop()
        semaphores = cls._host_semaphores.get(loop)
        if semaphores is None:
            semaphores = OrderedDict()
            cls._host_semaphores[loop] = semaphores
        limiter = semaphores.get(hostname)
        if limiter is None:
            limiter = _HostLimiter(asyncio.Semaphore(MAX_CONCURRENT_REQUESTS_PER_HOST))
            semaphores[hostname] = limiter
        else:
            semaphores.move_to_end(hostname)
        return limiter

    @classmethod
    @asynccontextmanager
    async def _host_limit(cls, hostname: str) -> AsyncIterator[None]:
        limiter = cls._host_limiter(hostname)
        limiter.reservations += 1
        try:
            async with limiter.semaphore:
                yield
        finally:
            limiter.reservations -= 1
            cls._prune_host_limiters()

    @classmethod
    def _prune_host_limiters(cls) -> None:
        semaphores = cls._host_semaphores.get(asyncio.get_running_loop())
        if semaphores is None:
            return
        while len(semaphores) > MAX_HOST_SEMAPHORE_CACHE_SIZE:
            for hostname, limiter in semaphores.items():
                if limiter.reservations == 0:
                    del semaphores[hostname]
                    break
            else:
                return

    @staticmethod
    def _retry_delay(attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return retry_after
        return RETRY_BASE_DELAY_SECONDS * (2**attempt)

    @staticmethod
    def _retry_after(response: httpx.Response) -> float | None:
        value = response.headers.get("retry-after")
        if value is None:
            return None
        try:
            delay = float(value)
        except ValueError:
            return None
        return delay if math.isfinite(delay) and delay >= 0 else None

    async def _validated_target(self, value: str) -> tuple["_RequestTarget | None", str | None]:
        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            return None, "invalid_url"
        if parsed.scheme not in {"http", "https"}:
            return None, "unsupported_scheme"
        if not hostname or parsed.username is not None or parsed.password is not None:
            return None, "invalid_url"
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            return None, "invalid_url"

        try:
            addresses = await self._resolver.resolve(hostname)
        except Exception:  # Resolver implementations are untrusted network boundaries.
            return None, "dns_failed"
        if not addresses:
            return None, "dns_failed"
        try:
            parsed_addresses = tuple(ipaddress.ip_address(address) for address in addresses)
        except ValueError:
            return None, "dns_failed"
        if any(not address.is_global or address.is_multicast for address in parsed_addresses):
            return None, "unsafe_target"

        selected = parsed_addresses[0]
        host_header = _host_with_port(hostname, port)
        request_url = _request_url(parsed, selected, port)
        return _RequestTarget(request_url=request_url, hostname=hostname, host_header=host_header), None

    @staticmethod
    def _content_length_too_large(response: httpx.Response) -> bool:
        try:
            return int(response.headers.get("content-length", "0")) > MAX_RESPONSE_BYTES
        except ValueError:
            return False

    @staticmethod
    async def _read_body(response: httpx.Response) -> tuple[bytes | None, str | None]:
        body = bytearray()
        async for chunk in response.aiter_bytes(chunk_size=READ_CHUNK_BYTES):
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                return None, "response_too_large"
        return bytes(body), None

    @staticmethod
    def _failure(endpoint: FeedEndpoint, code: str) -> EndpointFetchResult:
        return EndpointFetchResult(endpoint=endpoint, body=None, error_code=code)


@dataclass
class _CircuitState:
    failures: int = 0
    opened_until: float | None = None


class _EndpointCircuit:
    """Keep transient endpoint failures from repeatedly consuming transport capacity."""

    def __init__(self) -> None:
        self._states: dict[str, _CircuitState] = {}

    def is_open(self, endpoint_url: str, now: float) -> bool:
        state = self._states.get(endpoint_url)
        if state is None or state.opened_until is None:
            return False
        if now < state.opened_until:
            return True
        self._states.pop(endpoint_url, None)
        return False

    def record_success(self, endpoint_url: str) -> None:
        self._states.pop(endpoint_url, None)

    def record_failure(self, endpoint_url: str, now: float) -> None:
        state = self._states.setdefault(endpoint_url, _CircuitState())
        state.failures += 1
        if state.failures >= CIRCUIT_FAILURE_THRESHOLD:
            state.opened_until = now + CIRCUIT_COOLDOWN_SECONDS


@dataclass
class _HostLimiter:
    semaphore: asyncio.Semaphore
    reservations: int = 0


@dataclass(frozen=True)
class _RequestTarget:
    request_url: str
    hostname: str
    host_header: str


def _host_with_port(hostname: str, port: int | None) -> str:
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{rendered_host}:{port}" if port is not None else rendered_host


def _request_url(parsed: SplitResult, address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int | None) -> str:
    rendered_address = f"[{address.compressed}]" if address.version == 6 else address.compressed
    netloc = f"{rendered_address}:{port}" if port is not None else rendered_address
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", parsed.query, ""))
