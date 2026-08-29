"""TDD：TradingCalendar 抽象与 ConservativeCalendar 兜底实现（规格 §5.2）。"""

from __future__ import annotations

from datetime import datetime, timezone

from src.news.calendar import ConservativeCalendar, TradingCalendar

# 2026-08-26 周三（交易时段判定样本）；2026-08-30 周日
WEDNESDAY = datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc)
SUNDAY = datetime(2026, 8, 30, 10, 0, tzinfo=timezone.utc)


def test_protocol_structure():
    calendar: TradingCalendar = ConservativeCalendar()
    assert callable(calendar.is_trading_day)
    assert callable(calendar.current_session)
    assert callable(calendar.expected_flash_interval)


def test_conservative_calendar_treats_weekdays_as_sessions():
    calendar = ConservativeCalendar()
    assert calendar.is_trading_day(WEDNESDAY.date()) is True
    assert calendar.current_session(WEDNESDAY) == "open"


def test_conservative_calendar_closes_weekends():
    calendar = ConservativeCalendar()
    assert calendar.is_trading_day(SUNDAY.date()) is False
    assert calendar.current_session(SUNDAY) == "closed"


def test_expected_flash_interval_is_infinite():
    import math

    assert math.isinf(ConservativeCalendar().expected_flash_interval())  # 静默永不触发 degraded（§5.2）
