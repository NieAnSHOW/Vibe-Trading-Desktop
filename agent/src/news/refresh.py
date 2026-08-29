"""Manual force-refresh coordinator: single-flight + 5s rate limit (spec §6.1.1)."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from src.news.flash.service import FlashAggregator

logger = logging.getLogger(__name__)

MIN_TRIGGER_INTERVAL_S = 5.0


class AnnouncementRefresher(Protocol):
    async def maybe_refresh(self, *, force: bool = False) -> None: ...


@dataclass(frozen=True)
class RefreshDecision:
    accepted: bool
    task_id: str | None
    reused: bool
    rate_limited: bool = False


class FeedRefreshCoordinator:
    """触发快讯立即增量拉取；公告仅当上次拉取 >2min（由 AnnouncementCollector.maybe_refresh 门控）。"""

    def __init__(
        self,
        flash: FlashAggregator,
        announcements: AnnouncementRefresher | None = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._flash = flash
        self._announcements = announcements
        self._now = now
        self._last_trigger = float("-inf")
        self._task: asyncio.Task[None] | None = None
        self._task_id: str | None = None

    async def trigger(self) -> RefreshDecision:
        # single-flight 优先于 5s 限流：运行中任务始终 reuse（§6.1.1），不返回 429
        if self._task is not None and not self._task.done():
            return RefreshDecision(accepted=True, task_id=self._task_id, reused=True)
        now = self._now()
        if now - self._last_trigger < MIN_TRIGGER_INTERVAL_S:
            return RefreshDecision(accepted=False, task_id=None, reused=False, rate_limited=True)
        self._last_trigger = now
        self._task_id = str(uuid.uuid4())
        self._task = asyncio.create_task(self._run())
        return RefreshDecision(accepted=True, task_id=self._task_id, reused=False)

    async def _run(self) -> None:
        try:
            await self._flash.poll_source_now("eastmoney")
            await self._flash.poll_source_now("sina")
            if self._announcements is not None:
                await self._announcements.maybe_refresh(force=False)
        except Exception:
            logger.warning("watchlist feed force refresh failed", exc_info=True)
