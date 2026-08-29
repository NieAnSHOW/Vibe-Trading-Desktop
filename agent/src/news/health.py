"""Per-source degradation state machine separating request health from content freshness (spec §5.1/§5.3)."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from src.news.calendar import TradingCalendar

DEGRADE_FAILURE_THRESHOLD = 3  # 连续 3 次失败 → degraded（§5.1）
FAIL_FAILURE_THRESHOLD = 6  # 再度翻倍 → failed（全源失败边界的源级判定）
STALL_DEGRADE_ROUNDS = 3  # 游标停滞 ≥3 轮 → degraded（§5.1）
RECOVERY_STREAK = 3  # 连续 3 次成功回切（§5.3）
SOURCE_IDS = ("eastmoney", "sina", "sse", "szse")


@dataclass
class SourceHealth:
    source_id: str
    state: str = "failed"  # "ok" | "degraded" | "failed"；从未成功即 failed
    last_success_at: str | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    stalled_rounds: int = 0
    success_streak: int = 0
    degraded_by_failures: bool = False  # 由失败（而非停滞）进入 degraded/failed 时需要 3 连成功回切


class HealthTracker:
    """请求健康由失败计数判定；内容静默仅在工作日交易时段（calendar 判定）参与停滞计数。"""

    def __init__(self, calendar: TradingCalendar, now: Callable[[], datetime] | None = None) -> None:
        self._calendar = calendar
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._sources = {source_id: SourceHealth(source_id=source_id) for source_id in SOURCE_IDS}

    def record_success(self, source_id: str, *, advanced: bool) -> None:
        health = self._sources[source_id]
        at = self._now()
        health.last_error = None
        health.last_success_at = at.isoformat()
        if advanced:
            health.stalled_rounds = 0
        in_session = self._calendar.is_trading_day(at.date()) and self._calendar.current_session(at) == "open"
        # 停滞判定防御：expected_flash_interval 为 inf（ConservativeCalendar）→ 静默永不计停滞（§5.2）
        if not advanced and in_session and not math.isinf(self._calendar.expected_flash_interval()):
            health.stalled_rounds += 1
        if health.state != "ok" and health.degraded_by_failures:
            # 探活回切：连续 3 次成功才恢复（§5.3）
            health.success_streak += 1
            if health.success_streak >= RECOVERY_STREAK:
                health.state = "ok"
                health.degraded_by_failures = False
                health.success_streak = 0
                health.consecutive_failures = 0
            return
        health.state = "ok"
        health.consecutive_failures = 0
        if health.stalled_rounds >= STALL_DEGRADE_ROUNDS and not advanced and in_session:
            health.state = "degraded"

    def record_failure(self, source_id: str, error: str) -> None:
        health = self._sources[source_id]
        health.consecutive_failures += 1
        health.success_streak = 0
        health.last_error = error[:200]
        if health.consecutive_failures >= FAIL_FAILURE_THRESHOLD:
            health.state = "failed"
            health.degraded_by_failures = True
        elif health.consecutive_failures >= DEGRADE_FAILURE_THRESHOLD:
            health.state = "degraded"
            health.degraded_by_failures = True

    def state_of(self, source_id: str) -> str:
        return self._sources[source_id].state

    def snapshot(self) -> list[SourceHealth]:
        return [self._sources[source_id] for source_id in SOURCE_IDS]
