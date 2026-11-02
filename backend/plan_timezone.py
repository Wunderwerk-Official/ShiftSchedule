"""Time zone of a plan, derived from its holiday country.

Mirrors src/lib/planTimeZone.ts; backend/tests/test_plan_timezone.py checks
that both maps stay identical. Shift times in the template are local wall
clock times in this zone.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_PLAN_TIME_ZONE = "Europe/Berlin"

PLAN_TIME_ZONES = {
    "CH": "Europe/Zurich",
    "DE": "Europe/Berlin",
    "ES": "Europe/Madrid",
    "FR": "Europe/Paris",
    "GB": "Europe/London",
    "IT": "Europe/Rome",
    "LU": "Europe/Luxembourg",
    "NL": "Europe/Amsterdam",
    "PL": "Europe/Warsaw",
    "RO": "Europe/Bucharest",
    "RU": "Europe/Moscow",
    "UA": "Europe/Kyiv",
}

# Older zone databases only know the former name.
ZONE_FALLBACKS = {"Europe/Kyiv": "Europe/Kiev"}


@lru_cache(maxsize=None)
def _load_zone(name: str) -> tuple[str, ZoneInfo]:
    try:
        return name, ZoneInfo(name)
    except ZoneInfoNotFoundError:
        fallback = ZONE_FALLBACKS.get(name)
        if not fallback:
            raise
        return fallback, ZoneInfo(fallback)


def plan_time_zone(holiday_country: Any) -> tuple[str, ZoneInfo]:
    """(zone name, zone) of the plan; the name is the one the zone was loaded under."""
    code = holiday_country.strip().upper() if isinstance(holiday_country, str) else ""
    return _load_zone(PLAN_TIME_ZONES.get(code, DEFAULT_PLAN_TIME_ZONE))


def wall_clock_to_utc(day: date, minutes: int, zone: ZoneInfo) -> datetime:
    """UTC instant of the wall clock time `minutes` after midnight of `day` (may roll into later days).

    Uses fold=0: a time that does not exist (spring gap) or exists twice
    (autumn) is read with the offset in force before the change.
    """
    local = datetime(day.year, day.month, day.day) + timedelta(minutes=minutes)
    return local.replace(tzinfo=zone).astimezone(timezone.utc)
