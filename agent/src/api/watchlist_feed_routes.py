"""/news-api/watchlist-feed read + manual force-refresh routes (spec §6.1/§6.1.1)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from src.news.matcher import WatchlistFeedService
from src.news.refresh import FeedRefreshCoordinator, RefreshDecision

MAX_CURSOR_LENGTH = 512


class MatchedStockDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    name: str
    match_rule: Literal["structured_field", "code_pattern", "name_exact"]


class FeedItemDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    source: Literal["eastmoney", "sina", "sse", "szse"]
    type: Literal["flash", "announcement"]
    published_at: str
    title: str
    summary: str
    url: str | None
    matched_stocks: list[MatchedStockDTO]
    confidence: Literal["high", "medium"]


class SourceHealthDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: Literal["eastmoney", "sina", "sse", "szse"]
    state: Literal["ok", "degraded", "failed"]
    last_success_at: str | None
    last_error: str | None


class WatchlistFeedResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[FeedItemDTO] = Field(max_length=50)
    new_cursor: str | None
    next_cursor: str | None
    source_health: list[SourceHealthDTO]
    last_updated_at: str | None
    watchlist_version: str = Field(min_length=64, max_length=64)
    reset_required: bool


class FeedRefreshResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    task_id: str | None
    reused: bool


def create_watchlist_feed_router(service: WatchlistFeedService, refresher: FeedRefreshCoordinator) -> APIRouter:
    router = APIRouter(prefix="/news-api", tags=["news"])

    @router.get("/watchlist-feed", response_model=WatchlistFeedResponse)
    async def get_watchlist_feed(
        after_cursor: str | None = None, before_cursor: str | None = None, limit: int = 50
    ) -> WatchlistFeedResponse:
        if after_cursor and before_cursor:
            raise HTTPException(status_code=400, detail="after_cursor and before_cursor are mutually exclusive")
        if len(after_cursor or "") > MAX_CURSOR_LENGTH or len(before_cursor or "") > MAX_CURSOR_LENGTH:
            raise HTTPException(status_code=422, detail="cursor is too long")
        try:
            payload = await service.feed(after_cursor, before_cursor, limit)
        except ValueError:
            raise HTTPException(
                status_code=400, detail="after_cursor and before_cursor are mutually exclusive"
            ) from None
        return WatchlistFeedResponse.model_validate(payload)

    @router.post("/watchlist-feed/refresh", response_model=FeedRefreshResponse, status_code=202)
    async def refresh_watchlist_feed() -> FeedRefreshResponse:
        decision: RefreshDecision = await refresher.trigger()
        if decision.rate_limited:
            raise HTTPException(status_code=429, detail="refresh rate limited")
        return FeedRefreshResponse(accepted=decision.accepted, task_id=decision.task_id, reused=decision.reused)

    return router


def register_watchlist_feed_routes(
    app: FastAPI,
    require_auth: Callable[..., Awaitable[None]],
    service: WatchlistFeedService,
    refresher: FeedRefreshCoordinator,
) -> None:
    """Attach the feed boundary with the server's existing auth dependency (spec §6.1)."""
    app.include_router(create_watchlist_feed_router(service, refresher), dependencies=[Depends(require_auth)])
