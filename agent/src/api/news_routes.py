"""Authenticated, input-free HTTP routes for investment-news refreshes."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Protocol, cast

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status

from src.news.catalog import NewsScope
from src.news.coordinator import NewsCoordinatorRegistry
from src.news.models import RefreshAcceptedResponse, RefreshStatus, SnapshotResponse

logger = logging.getLogger(__name__)


class _NewsCoordinator(Protocol):
    async def snapshot_response(self) -> SnapshotResponse: ...

    async def start(self) -> RefreshAcceptedResponse: ...

    async def status(self) -> RefreshStatus: ...


class _NewsCoordinatorRegistry(Protocol):
    def get(self, scope: NewsScope) -> _NewsCoordinator: ...


async def _parse_scope(request: Request) -> NewsScope:
    """Accept one optional scope and reject every caller-controlled refresh input."""
    if await request.body():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="News API accepts no request body")
    parameters = list(request.query_params.multi_items())
    if not parameters:
        return "a_share"
    if len(parameters) != 1 or parameters[0][0] != "scope":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="News API accepts only one scope parameter")
    scope = parameters[0][1]
    if scope not in {"a_share", "global_industry"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="News API scope is invalid")
    return cast(NewsScope, scope)


def create_news_router(registry: _NewsCoordinatorRegistry) -> APIRouter:
    """Build routes that obtain a scope-local coordinator after input validation."""
    router = APIRouter(prefix="/news-api", tags=["news"])

    @router.get("/snapshot", response_model=SnapshotResponse)
    async def get_snapshot(request: Request) -> SnapshotResponse:
        scope = await _parse_scope(request)
        return await registry.get(scope).snapshot_response()

    @router.post("/refresh", response_model=RefreshAcceptedResponse, status_code=status.HTTP_202_ACCEPTED)
    async def refresh_news(request: Request) -> RefreshAcceptedResponse:
        scope = await _parse_scope(request)
        try:
            return await registry.get(scope).start()
        except RuntimeError:
            logger.warning("news refresh request rejected by unavailable coordinator")
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="News refresh is unavailable") from None

    @router.get("/refresh/status", response_model=RefreshStatus)
    async def get_refresh_status(request: Request) -> RefreshStatus:
        scope = await _parse_scope(request)
        return await registry.get(scope).status()

    return router


def register_news_routes(
    app: FastAPI,
    require_auth: Callable[..., Awaitable[None]],
    registry: NewsCoordinatorRegistry,
) -> None:
    """Attach the news boundary with the server's existing auth dependency."""
    app.include_router(create_news_router(registry), dependencies=[Depends(require_auth)])
