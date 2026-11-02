"""The plan's time zone: one map per side, kept identical, and fold=0 conversions."""

import re
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from backend.plan_timezone import (
    DEFAULT_PLAN_TIME_ZONE,
    PLAN_TIME_ZONES,
    ZONE_FALLBACKS,
    plan_time_zone,
    wall_clock_to_utc,
)

TS_SOURCE = Path(__file__).resolve().parents[2] / "src" / "lib" / "planTimeZone.ts"


def _ts_object(source: str, name: str) -> dict[str, str]:
    body = re.search(rf"export const {name}: Record<string, string> = \{{(.*?)\}};", source, re.S)
    assert body, f"{name} not found in {TS_SOURCE}"
    return dict(re.findall(r'"?([\w/]+)"?:\s*"([^"]+)"', body.group(1)))


def test_frontend_and_backend_maps_are_identical() -> None:
    source = TS_SOURCE.read_text(encoding="utf-8")
    assert _ts_object(source, "PLAN_TIME_ZONES") == PLAN_TIME_ZONES
    assert _ts_object(source, "ZONE_FALLBACKS") == ZONE_FALLBACKS
    default = re.search(r'export const DEFAULT_PLAN_TIME_ZONE = "([^"]+)";', source)
    assert default and default.group(1) == DEFAULT_PLAN_TIME_ZONE


def test_every_holiday_country_has_a_zone() -> None:
    settings = (TS_SOURCE.parents[1] / "components" / "schedule" / "SettingsView.tsx").read_text(
        encoding="utf-8"
    )
    countries = set(re.findall(r'\{ code: "([A-Z]{2})", label:', settings))
    assert countries and countries <= set(PLAN_TIME_ZONES)


@pytest.mark.parametrize("country,expected", [
    ("DE", "Europe/Berlin"), ("fr", "Europe/Paris"), (" GB ", "Europe/London"),
    (None, "Europe/Berlin"), ("", "Europe/Berlin"), ("XX", "Europe/Berlin"), (42, "Europe/Berlin"),
])
def test_plan_time_zone(country, expected) -> None:
    assert plan_time_zone(country)[0] == expected


def test_every_mapped_zone_loads() -> None:
    for code in PLAN_TIME_ZONES:
        name, zone = plan_time_zone(code)
        assert name in (PLAN_TIME_ZONES[code], ZONE_FALLBACKS.get(PLAN_TIME_ZONES[code]))
        assert zone.key == name


# Same instants as src/lib/planTimeZone.test.ts.
@pytest.mark.parametrize("country,day,minutes,expected", [
    ("DE", date(2026, 1, 5), 8 * 60, "2026-01-05T07:00:00"),
    ("DE", date(2026, 7, 6), 8 * 60, "2026-07-06T06:00:00"),
    ("GB", date(2026, 7, 6), 8 * 60, "2026-07-06T07:00:00"),
    ("RU", date(2026, 7, 6), 8 * 60, "2026-07-06T05:00:00"),
    ("DE", date(2026, 11, 2), 24 * 60, "2026-11-02T23:00:00"),
    ("DE", date(2026, 10, 23), 18 * 60 + 2 * 1440, "2026-10-25T17:00:00"),
    # Spring gap and autumn repeat: the offset before the change (fold=0).
    ("DE", date(2026, 3, 29), 150, "2026-03-29T01:30:00"),
    ("DE", date(2026, 3, 29), 210, "2026-03-29T01:30:00"),
    ("GB", date(2026, 3, 29), 90, "2026-03-29T01:30:00"),
    ("DE", date(2026, 10, 25), 150, "2026-10-25T00:30:00"),
    ("GB", date(2026, 10, 25), 90, "2026-10-25T00:30:00"),
    # Moscow, 26 Oct 2014: +4 → +3 (not DST).
    ("RU", date(2014, 10, 25), 20 * 60, "2014-10-25T16:00:00"),
    ("RU", date(2014, 10, 26), 8 * 60, "2014-10-26T05:00:00"),
])
def test_wall_clock_to_utc(country, day, minutes, expected) -> None:
    result = wall_clock_to_utc(day, minutes, plan_time_zone(country)[1])
    assert result == datetime.fromisoformat(expected).replace(tzinfo=timezone.utc)
