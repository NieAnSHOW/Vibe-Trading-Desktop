"""Trading-calendar abstraction separating content freshness from request health (spec §5.2)."""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Protocol


class TradingCalendar(Protocol):
    """内容新鲜度判定接口：交易时段内的静默才参与游标停滞计数。"""

    def is_trading_day(self, day: date) -> bool:
        """Return True when *day* is a trading day."""
        ...

    def current_session(self, at: datetime) -> str:
        """Return "open" or "closed" for the session containing *at*."""
        ...

    def expected_flash_interval(self) -> float:
        """Return the expected flash cadence in seconds."""
        ...


class ConservativeCalendar:
    """默认兜底实现：所有工作日视为交易时段，内容静默永不触发 degraded（规格 §5.2 安全兜底）。"""

    def is_trading_day(self, day: date) -> bool:
        return day.weekday() < 5

    def current_session(self, at: datetime) -> str:
        return "open" if at.weekday() < 5 else "closed"

    def expected_flash_interval(self) -> float:
        return math.inf  # 期望间隔无穷大 → 停滞判定永不为真（静默永不降级）
