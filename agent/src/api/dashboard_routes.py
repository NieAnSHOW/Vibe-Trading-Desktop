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
import re
import time as _time
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional, Union
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
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


class BoardHeatItem(BaseModel):
    code: str
    name: str
    change_pct: Optional[float] = None
    rise_count: Optional[float] = None
    fall_count: Optional[float] = None
    leading_stock: Optional[str] = None
    leading_stock_change_pct: Optional[float] = None


class BoardHeatResponse(BaseModel):
    data: list[BoardHeatItem]
    as_of: str
    source: str = "10jqka-hot-list"
    stale: bool = False


class DailyBar(BaseModel):
    time: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class DailyBarsResponse(BaseModel):
    data: list[DailyBar]
    as_of: str
    source: str = "tencent"
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
# Read-only market data providers
# ---------------------------------------------------------------------------

_THS_HOT_LIST_URL = (
    "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate"
)
_A_SHARE_SYMBOL = re.compile(r"^(?:(sh|sz))?(\d{6})(?:\.(SH|SZ))?$", re.IGNORECASE)
_CHINA_TZ = ZoneInfo("Asia/Shanghai")


def _optional_float(value) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _fetch_board_heat(kind: Literal["concept", "industry"]) -> list[dict]:
    """Fetch the current 10jqka hot-board ranking and normalize its rows."""
    from backtest.loaders._http import throttled_get_json
    from backtest.loaders.registry import _apply_china_direct_no_proxy

    _apply_china_direct_no_proxy()
    payload = throttled_get_json(
        _THS_HOT_LIST_URL,
        host_key="10jqka-hot-list",
        min_interval=0.2,
        params={"type": kind},
        headers={
            "Accept": "application/json",
            "Referer": "https://eq.10jqka.com.cn/",
        },
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    rows = data.get("plate_list") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError("10jqka board response did not contain plate_list")

    normalized = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("code") or not row.get("name"):
            continue
        normalized.append(
            {
                "code": str(row["code"]),
                "name": str(row["name"]),
                "change_pct": _optional_float(row.get("rise_and_fall")),
                "rise_count": None,
                "fall_count": None,
                "leading_stock": None,
                "leading_stock_change_pct": None,
            }
        )
    return normalized


def _qualify_a_share_symbol(symbol: str) -> str:
    match = _A_SHARE_SYMBOL.fullmatch(symbol.strip())
    if match is None:
        raise ValueError("symbol must be a 6-digit A-share code with an optional sh/sz prefix")
    prefix, code, suffix = match.groups()
    exchange = (suffix or prefix or ("SH" if code.startswith(("5", "6", "9")) else "SZ")).upper()
    return f"{code}.{exchange}"


def _fetch_daily_bars(symbol: str) -> list[dict]:
    """Load two years of daily A-share/index bars from the Tencent loader."""
    from backtest.loaders.tencent_loader import DataLoader

    qualified = _qualify_a_share_symbol(symbol)
    end_date = date.today()
    start_date = end_date - timedelta(days=800)
    frames = DataLoader().fetch(
        [qualified],
        start_date.isoformat(),
        end_date.isoformat(),
        interval="1D",
    )
    frame = frames.get(qualified)
    if frame is None or frame.empty:
        return []

    return [
        {
            "time": index.strftime("%Y-%m-%d"),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row.get("volume", 0) or 0),
        }
        for index, row in frame.iterrows()
    ]


def _is_dashboard_index_symbol(symbol: str, code: str) -> bool:
    """Indices use exchange-prefixed symbols; watchlist stocks use bare codes."""
    return code in _SUPPORTED_INDEX_CODES and symbol.strip().lower().startswith(("sh", "sz"))


def _fetch_intraday_bars(symbol: str) -> list[dict]:
    """Load and normalize current-day one-minute A-share or index bars."""
    import akshare as ak
    import pandas as pd

    qualified = _qualify_a_share_symbol(symbol)
    code, exchange = qualified.split(".")
    now = datetime.now(_CHINA_TZ)
    today = now.date()
    start = f"{today.isoformat()} 00:00:00"
    end = now.strftime("%Y-%m-%d %H:%M:%S")
    if _is_dashboard_index_symbol(symbol, code):
        frame = ak.index_zh_a_hist_min_em(
            symbol=code,
            period="1",
            start_date=start,
            end_date=end,
        )
        columns = {
            "time": "时间",
            "open": "开盘",
            "high": "最高",
            "low": "最低",
            "close": "收盘",
            "volume": "成交量",
        }
    else:
        sina_columns = {
            "time": "day",
            "open": "open",
            "high": "high",
            "low": "low",
            "close": "close",
            "volume": "volume",
        }

        def fetch_sina_fallback(reason: str):
            logger.info(
                "dashboard intraday EastMoney source %s for %s; using Sina fallback",
                reason,
                symbol,
            )
            return ak.stock_zh_a_minute(
                symbol=f"{exchange.lower()}{code}",
                period="1",
                adjust="",
            )

        try:
            frame = ak.stock_zh_a_hist_min_em(
                symbol=code,
                period="1",
                start_date=start,
                end_date=end,
            )
            columns = {
                "time": "时间",
                "open": "开盘",
                "high": "最高",
                "low": "最低",
                "close": "收盘",
                "volume": "成交量",
            }
        except Exception as exc:
            frame = fetch_sina_fallback(f"failed ({exc})")
            columns = sina_columns
        else:
            if frame is None or frame.empty:
                frame = fetch_sina_fallback("returned no data")
                columns = sina_columns
    if frame is None or frame.empty:
        return []

    missing = [column for column in columns.values() if column not in frame.columns]
    if missing:
        raise ValueError(f"intraday data missing columns: {', '.join(missing)}")

    normalized = frame.loc[:, list(columns.values())].rename(
        columns={source: target for target, source in columns.items()}
    )
    normalized["time"] = pd.to_datetime(normalized["time"], errors="coerce")
    for column in ("open", "high", "low", "close", "volume"):
        normalized[column] = pd.to_numeric(normalized[column], errors="coerce")
    normalized = normalized.dropna().loc[normalized["time"].dt.date == today]

    return [
        {
            "time": row["time"].isoformat(),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
        }
        for _, row in normalized.iterrows()
    ]

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


@router.get("/board-heat", response_model=BoardHeatResponse)
async def get_board_heat(kind: Literal["concept", "industry"]):
    try:
        rows = await asyncio.to_thread(_fetch_board_heat, kind)
    except Exception as exc:
        logger.warning("dashboard board heat failed for %s: %s", kind, exc)
        raise HTTPException(status_code=503, detail=f"{kind} board data unavailable") from exc
    return BoardHeatResponse(
        data=rows,
        as_of=datetime.now(timezone.utc).isoformat(),
    )


@router.get("/daily-bars", response_model=DailyBarsResponse)
async def get_daily_bars(symbol: str):
    try:
        rows = await asyncio.to_thread(_fetch_daily_bars, symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("dashboard daily bars failed for %s: %s", symbol, exc)
        raise HTTPException(status_code=503, detail="daily bars unavailable") from exc
    return DailyBarsResponse(
        data=rows,
        as_of=datetime.now(timezone.utc).isoformat(),
    )


@router.get("/intraday-bars", response_model=DailyBarsResponse)
async def get_intraday_bars(symbol: str):
    try:
        rows = await asyncio.to_thread(_fetch_intraday_bars, symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("dashboard intraday bars failed for %s: %s", symbol, exc)
        raise HTTPException(status_code=503, detail="intraday bars unavailable") from exc
    return DailyBarsResponse(
        data=rows,
        as_of=datetime.now(timezone.utc).isoformat(),
        source="akshare",
    )


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_dashboard_routes(app, require_auth=None) -> None:
    """Register dashboard routes with the given FastAPI app.

    When require_auth is provided, the route is protected by that dependency.
    """
    if require_auth is not None:
        for r in router.routes:
            if not any(dependency.dependency is require_auth for dependency in r.dependencies):
                r.dependencies.append(Depends(require_auth))
    app.include_router(router)
