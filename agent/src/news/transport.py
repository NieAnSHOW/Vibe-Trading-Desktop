"""Generalized, SSRF-hardened transport extracted from network.py (catalog-free, spec §6.5)."""

from __future__ import annotations

import asyncio
import ipaddress
import math
import socket
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import SplitResult, urlencode, urljoin, urlsplit, urlunsplit
from weakref import WeakKeyDictionary

import httpx

CONNECT_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 15.0
TOTAL_FETCH_TIMEOUT_SECONDS = 15.0
MAX_CONCURRENT_REQUESTS = 16
MAX_CONCURRENT_REQUESTS_PER_HOST = 2  # 规格 §5.4：单 IP 并发 ≤2
MAX_HOST_SEMAPHORE_CACHE_SIZE = 64
READ_CHUNK_BYTES = 64 * 1024
MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = frozenset({408, 429, *range(500, 600)})
RETRY_BASE_DELAY_SECONDS = 1.0
CIRCUIT_FAILURE_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECONDS = 60.0
# Transparent proxy Fake-IP mode uses this RFC 2544 benchmarking range for approved hosts.
_PROXY_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")


class TransportError(Exception):
    """Transport failure carrying a stable, non-sensitive error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _Retryable(Exception):
    """Internal: failure that should consume another attempt."""

    def __init__(self, code: str, retry_after: float | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


@dataclass(frozen=True)
class TransportRequest:
    """Caller-controlled generalized request contract (spec §6.5, verbatim fields)."""

    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: Mapping[str, str] | None = None
    body: bytes | None = None
    content_type: str | None = None
    query: Mapping[str, str] | None = None
    max_redirects: int = 3
    allowed_content_types: frozenset[str] = frozenset({"application/json", "text/html", "text/plain"})
    max_response_bytes: int = 2 * 1024 * 1024


@dataclass(frozen=True)
class TransportResponse:
    """Content-type-validated response payload (spec §6.5, verbatim fields)."""

    status_code: int
    content_type: str
    body: bytes
    elapsed_ms: float
    final_url: str


class HostResolver(Protocol):
    """Resolve a hostname to numeric IP addresses."""

    async def resolve(self, host: str) -> Sequence[str]: ...


class _SystemResolver:
    async def resolve(self, host: str) -> Sequence[str]:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
        return tuple(record[4][0] for record in records)


@dataclass
class _CircuitState:
    failures: int = 0
    opened_until: float | None = None


class _Circuit:
    """Keep transient endpoint failures from repeatedly consuming transport capacity."""

    def __init__(self) -> None:
        self._states: dict[str, _CircuitState] = {}

    def is_open(self, url: str, now: float) -> bool:
        state = self._states.get(url)
        return state is not None and state.opened_until is not None and state.opened_until > now

    def record_success(self, url: str) -> None:
        self._states.pop(url, None)

    def record_failure(self, url: str, now: float) -> None:
        state = self._states.setdefault(url, _CircuitState())
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


def _normalized_hostname(value: str) -> str | None:
    try:
        hostname = urlsplit(value).hostname
    except ValueError:
        return None
    if not hostname:
        return None
    try:
        return hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return None


def _request_url(parsed: SplitResult, address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int | None) -> str:
    rendered_address = f"[{address.compressed}]" if address.version == 6 else address.compressed
    netloc = f"{rendered_address}:{port}" if port is not None else rendered_address
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", parsed.query, ""))


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        delay = float(value)
    except ValueError:
        return None
    return delay if math.isfinite(delay) and delay >= 0 else None


def _content_length_too_large(response: httpx.Response, maximum: int) -> bool:
    try:
        return int(response.headers.get("content-length", "0")) > maximum
    except ValueError:
        return False


async def _read_body(response: httpx.Response, maximum: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes(chunk_size=READ_CHUNK_BYTES):
        body.extend(chunk)
        if len(body) > maximum:
            raise TransportError("response_too_large")
    return bytes(body)


class TransportClient:
    """Fetch one generalized request with SSRF validation, redirects, retries and a circuit."""

    _semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()
    _host_semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, OrderedDict[str, _HostLimiter]] = WeakKeyDictionary()

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
        self._circuit = _Circuit()

    async def fetch(self, request: TransportRequest) -> TransportResponse:
        """Fetch *request*, raising TransportError with a stable code on failure."""
        try:
            async with asyncio.timeout(TOTAL_FETCH_TIMEOUT_SECONDS):
                if self._circuit.is_open(request.url, self._now()):
                    raise TransportError("circuit_open")
                for attempt in range(MAX_ATTEMPTS):
                    try:
                        response = await self._fetch_once(request)
                        self._circuit.record_success(request.url)
                        return response
                    except _Retryable as retryable:
                        if attempt == MAX_ATTEMPTS - 1:
                            self._circuit.record_failure(request.url, self._now())
                            raise TransportError(retryable.code) from None
                        await self._sleep(self._retry_delay(attempt, retryable.retry_after))
        except TimeoutError:
            self._circuit.record_failure(request.url, self._now())
            raise TransportError("timeout") from None
        raise TransportError("network_error")  # pragma: no cover - unreachable

    async def _fetch_once(self, request: TransportRequest) -> TransportResponse:
        current_url = request.url
        if request.query:
            separator = "&" if "?" in current_url else "?"
            current_url = current_url + separator + urlencode(list(request.query.items()))
        configured_hostname = _normalized_hostname(request.url)
        redirects = 0
        timeout = httpx.Timeout(
            connect=CONNECT_TIMEOUT_SECONDS,
            read=READ_TIMEOUT_SECONDS,
            write=READ_TIMEOUT_SECONDS,
            pool=CONNECT_TIMEOUT_SECONDS,
        )
        method = request.method.upper()
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                timeout=timeout,
                limits=httpx.Limits(max_keepalive_connections=0),
            ) as client:
                while True:
                    target, error_code = await self._validated_target(
                        current_url, allowed_fake_ip_hostname=configured_hostname
                    )
                    if error_code is not None:
                        raise TransportError(error_code)
                    assert target is not None
                    headers = {"Host": target.host_header, "Connection": "close"}
                    if request.headers:
                        headers.update(dict(request.headers))
                    if request.content_type is not None:
                        headers["Content-Type"] = request.content_type
                    try:
                        http_request = httpx.Request(
                            method,
                            target.request_url,
                            headers=headers,
                            content=request.body,
                            extensions={"sni_hostname": target.hostname},
                        )
                    except (UnicodeError, ValueError, httpx.InvalidURL):
                        raise TransportError("invalid_url") from None
                    async with self._host_limit(target.hostname):
                        async with self._semaphore():
                            started = time.perf_counter()
                            response = await client.send(http_request, stream=True)
                            try:
                                if response.is_redirect:
                                    if redirects >= request.max_redirects:
                                        raise TransportError("too_many_redirects")
                                    location = response.headers.get("location")
                                    if not location:
                                        raise TransportError("invalid_redirect")
                                    current_url = urljoin(current_url, location)
                                    redirects += 1
                                    continue  # 每一跳都重新走 SSRF 校验
                                if response.status_code < 200 or response.status_code >= 300:
                                    retry_after = _retry_after(response) if response.status_code == 429 else None
                                    if response.status_code == 429:
                                        code = "rate_limited"
                                    elif response.status_code == 403:
                                        code = "forbidden"
                                    else:
                                        code = "http_status"
                                    if response.status_code in RETRYABLE_STATUS_CODES:
                                        raise _Retryable(code, retry_after)
                                    raise TransportError(code)
                                content_type = response.headers.get("content-type") or "application/octet-stream"
                                content_type = content_type.split(";")[0].strip().lower()
                                if content_type not in request.allowed_content_types:
                                    raise TransportError("unsupported_content_type")
                                if _content_length_too_large(response, request.max_response_bytes):
                                    raise TransportError("response_too_large")
                                body = await _read_body(response, request.max_response_bytes)
                                return TransportResponse(
                                    status_code=response.status_code,
                                    content_type=content_type,
                                    body=body,
                                    elapsed_ms=(time.perf_counter() - started) * 1000.0,
                                    final_url=current_url,
                                )
                            finally:
                                await response.aclose()
        except httpx.TimeoutException:
            raise _Retryable("timeout") from None
        except httpx.RequestError:
            raise _Retryable("network_error") from None

    @classmethod
    def _semaphore(cls) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        semaphore = cls._semaphores.get(loop)
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
            cls._semaphores[loop] = semaphore
        return semaphore

    @classmethod
    def _host_limiter(cls, hostname: str) -> _HostLimiter:
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
                return

    @staticmethod
    def _retry_delay(attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return retry_after
        return RETRY_BASE_DELAY_SECONDS * (2**attempt)

    async def _validated_target(
        self, value: str, *, allowed_fake_ip_hostname: str | None = None
    ) -> tuple[_RequestTarget | None, str | None]:
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
        all_proxy_fake_ips = all(address in _PROXY_FAKE_IP_NETWORK for address in parsed_addresses)
        if any(not address.is_global or address.is_multicast for address in parsed_addresses) and not (
            hostname == allowed_fake_ip_hostname and all_proxy_fake_ips
        ):
            return None, "unsafe_target"

        selected = parsed_addresses[0]
        host_header = _host_with_port(hostname, port)
        request_url = _request_url(parsed, selected, port)
        return _RequestTarget(request_url=request_url, hostname=hostname, host_header=host_header), None
