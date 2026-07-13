"""Market dashboard AI summary route — bounded, cached, degrade-safe.

Implements POST /dashboard/market-summary with bounded MarketSnapshot
validation, 5-minute in-memory caching keyed by (market, 5-min bucket,
model_name), asyncio.Lock for concurrent cache misses, and degraded
available=False responses with stale-cache fallback on failure.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time as _time
from datetime import datetime, timezone
from typing import Literal, Optional, Union

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.providers.llm import build_llm

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

_SUPPORTED_INDEX_CODES = {"000001", "399001", "399006"}


class SnapshotIndex(BaseModel):
    code: str = Field(pattern=r"^(000001|399001|399006)$")
    name: str = Field(min_length=1, max_length=32)
    price: float = Field(ge=0)
    change_pct: float = Field(ge=-100, le=100)


class SnapshotSector(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    change_pct: float = Field(ge=-100, le=100)


class SnapshotWatchlistItem(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=1, max_length=32)
    change_pct: float = Field(ge=-100, le=100)


class MarketSnapshot(BaseModel):
    market: Literal["a_share"]
    market_as_of: datetime
    force_refresh: bool = False
    indices: list[SnapshotIndex] = Field(min_length=3, max_length=3)
    sectors: list[SnapshotSector] = Field(default_factory=list, max_length=12)
    watchlist: list[SnapshotWatchlistItem] = Field(default_factory=list, max_length=30)


class SummaryContent(BaseModel):
    headline: str = Field(max_length=200)
    drivers: list[str] = Field(default_factory=list, max_length=10)
    risks: list[str] = Field(default_factory=list, max_length=10)
    focus: list[str] = Field(default_factory=list, max_length=10)

    @classmethod
    def validated(cls, data: str) -> "SummaryContent":
        """Parse and validate JSON; raise if the structure is invalid."""
        parsed = json.loads(data)
        return cls.model_validate(parsed)


class MarketSummaryResponse(BaseModel):
    available: bool
    summary: Optional[SummaryContent] = None
    error_code: Optional[str] = None
    cached_at: Optional[str] = None
    stale: bool = False


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SUMMARY_SYSTEM_PROMPT = (
    "You are a concise A-share market analyst. Given a snapshot of indices, "
    "sectors, and watchlist stocks, produce a JSON summary in Chinese with "
    "exactly these fields:\n"
    '- "headline": one-line market sentiment (max 80 chars)\n'
    '- "drivers": list of 1-3 key drivers (each max 40 chars)\n'
    '- "risks": list of 0-2 notable risks (each max 40 chars)\n'
    '- "focus": list of 1-3 items to watch (each max 40 chars)\n'
    "Return ONLY valid JSON, no markdown, no commentary."
)


# ---------------------------------------------------------------------------
# LLM invocation — monkeypatchable for tests
# ---------------------------------------------------------------------------


def _invoke_summary(snapshot: MarketSnapshot) -> str:
    """Call build_llm().invoke() and return the text content.  Raises on failure."""
    llm = build_llm()
    result = llm.invoke(
        [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": snapshot.model_dump_json()},
        ]
    )
    return str(getattr(result, "content", ""))


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

FIVE_MINUTES_S = 300.0
_cache: dict[tuple, tuple[float, SummaryContent]] = {}
_cache_lock = asyncio.Lock()


def _five_minute_bucket(dt: datetime) -> str:
    """Round down to the nearest 5-minute boundary, return ISO string."""
    ts = dt.replace(tzinfo=timezone.utc).timestamp()
    bucket_ts = int(ts // FIVE_MINUTES_S) * FIVE_MINUTES_S
    return datetime.fromtimestamp(bucket_ts, tz=timezone.utc).isoformat()


def _model_name() -> str:
    return os.getenv("LANGCHAIN_MODEL_NAME", "unknown").strip()


def _cache_key(snapshot: MarketSnapshot) -> tuple:
    return (snapshot.market, _five_minute_bucket(snapshot.market_as_of), _model_name())


def _lookup_cache(key: tuple) -> Optional[SummaryContent]:
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, content = entry
    if _time.monotonic() - ts < FIVE_MINUTES_S:
        return content
    # TTL expired — evict
    _cache.pop(key, None)
    return None


def _store_cache(key: tuple, content: SummaryContent) -> None:
    _cache[key] = (_time.monotonic(), content)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class _SummaryService:
    """Encapsulates cache lookups + LLM invocation with stale-fallback."""

    async def get(self, snapshot: MarketSnapshot) -> MarketSummaryResponse:
        key = _cache_key(snapshot)

        # Cache hit (non-force)
        if not snapshot.force_refresh:
            cached = _lookup_cache(key)
            if cached is not None:
                return MarketSummaryResponse(
                    available=True,
                    summary=cached,
                    cached_at=datetime.now(timezone.utc).isoformat(),
                    stale=False,
                )

        # Cache miss — lock to prevent thundering herd
        async with _cache_lock:
            # Double-check inside lock
            if not snapshot.force_refresh:
                cached = _lookup_cache(key)
                if cached is not None:
                    return MarketSummaryResponse(
                        available=True,
                        summary=cached,
                        cached_at=datetime.now(timezone.utc).isoformat(),
                        stale=False,
                    )

            try:
                raw = await asyncio.to_thread(_invoke_summary, snapshot)
                content = SummaryContent.validated(raw)
            except json.JSONDecodeError:
                logger.warning("dashboard summary: invalid JSON from LLM")
                return MarketSummaryResponse(
                    available=False,
                    error_code="INVALID_JSON",
                    cached_at=None,
                    stale=False,
                )
            except Exception as exc:
                logger.warning("dashboard summary: LLM invocation failed: %s", exc)
                # Try stale fallback
                entry = _cache.get(key)
                if entry is not None:
                    _ts, stale_content = entry
                    return MarketSummaryResponse(
                        available=True,
                        summary=stale_content,
                        error_code="LLM_FAILURE_STALE",
                        cached_at=datetime.now(timezone.utc).isoformat(),
                        stale=True,
                    )
                return MarketSummaryResponse(
                    available=False,
                    error_code="LLM_FAILURE",
                    cached_at=None,
                    stale=False,
                )

            _store_cache(key, content)
            return MarketSummaryResponse(
                available=True,
                summary=content,
                cached_at=datetime.now(timezone.utc).isoformat(),
                stale=False,
            )


_summary_service = _SummaryService()

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.post(
    "/market-summary",
    response_model=MarketSummaryResponse,
    dependencies=[],
)
async def create_market_summary(snapshot: MarketSnapshot):
    result = await _summary_service.get(snapshot)
    if not result.available and result.error_code == "LLM_FAILURE":
        return JSONResponse(status_code=503, content=result.model_dump())
    return result


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_dashboard_routes(app, require_auth=None) -> None:
    """Register dashboard routes with the given FastAPI app.

    When require_auth is provided, the route is protected by that dependency.
    """
    if require_auth is not None:
        # Mutate the route's dependencies list in place
        route = None
        for r in router.routes:
            if r.path == "/dashboard/market-summary" and "POST" in r.methods:
                route = r
                break
        if route is not None:
            route.dependencies.append(Depends(require_auth))
    app.include_router(router)
