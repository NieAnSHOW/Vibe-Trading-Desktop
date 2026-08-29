"""TDD：源健康降级状态机——请求健康与内容新鲜度分离（规格 §5.1/§5.3）。"""

from __future__ import annotations

from datetime import datetime, timezone

from src.news.calendar import ConservativeCalendar
from src.news.health import FAIL_FAILURE_THRESHOLD, HealthTracker

WEDNESDAY = datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc)
SUNDAY = datetime(2026, 8, 30, 10, 0, tzinfo=timezone.utc)


class _FiniteCalendar:
    """工作日开市、快讯期望间隔 30s 的日历（停滞计数可累积，用于验证 §5.1 停滞降级）。"""

    def __init__(self, closed: bool = False) -> None:
        self._closed = closed

    def is_trading_day(self, day):
        return not self._closed

    def current_session(self, at):
        return "closed" if self._closed else "open"

    def expected_flash_interval(self):
        return 30.0


def _tracker(now_value: datetime = WEDNESDAY, calendar=None) -> HealthTracker:
    return HealthTracker(calendar or ConservativeCalendar(), now=lambda: now_value)


def test_initial_state_failed_until_first_success():
    tracker = _tracker()
    assert tracker.state_of("eastmoney") == "failed"
    tracker.record_success("eastmoney", advanced=True)
    assert tracker.state_of("eastmoney") == "ok"


def test_three_consecutive_failures_degrade_six_fail():
    tracker = _tracker()
    for _ in range(3):
        tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "degraded"
    for _ in range(FAIL_FAILURE_THRESHOLD - 3):
        tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "failed"


def test_success_resets_failure_streak():
    tracker = _tracker()
    tracker.record_failure("sina", "timeout")
    tracker.record_failure("sina", "timeout")
    tracker.record_success("sina", advanced=False)
    tracker.record_failure("sina", "timeout")
    tracker.record_failure("sina", "timeout")
    assert tracker.state_of("sina") == "ok"  # 3 次失败才降级；成功重置计数


def test_stall_counts_only_in_session_and_degrades_after_three():
    tracker = _tracker(WEDNESDAY, calendar=_FiniteCalendar())
    for _ in range(3):
        tracker.record_success("eastmoney", advanced=False)  # 会话内游标停滞
    assert tracker.state_of("eastmoney") == "degraded"


def test_stall_not_counted_when_market_closed():
    tracker = _tracker(SUNDAY, calendar=_FiniteCalendar(closed=True))
    for _ in range(10):
        tracker.record_success("eastmoney", advanced=False)
    assert tracker.state_of("eastmoney") == "ok"  # 闭市时段静默不计数（§5.1 内容新鲜度）


def test_conservative_calendar_silence_never_degrades():
    tracker = _tracker(WEDNESDAY)  # ConservativeCalendar：interval=inf
    for _ in range(10):
        tracker.record_success("eastmoney", advanced=False)
    assert tracker.state_of("eastmoney") == "ok"  # 静默永不触发 degraded（§5.2）


def test_recovery_requires_three_consecutive_successes():
    tracker = _tracker()
    for _ in range(3):
        tracker.record_failure("sse", "http_status")
    assert tracker.state_of("sse") == "degraded"
    tracker.record_success("sse", advanced=True)
    tracker.record_success("sse", advanced=True)
    assert tracker.state_of("sse") == "degraded"  # 探活连续 3 次才回切
    tracker.record_success("sse", advanced=True)
    assert tracker.state_of("sse") == "ok"


def test_snapshot_covers_all_four_sources():
    snapshot = {health.source_id: health.state for health in _tracker().snapshot()}
    assert snapshot == {"eastmoney": "failed", "sina": "failed", "sse": "failed", "szse": "failed"}
