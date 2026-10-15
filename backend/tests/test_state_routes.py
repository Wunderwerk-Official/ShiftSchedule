"""Regression tests for backend.state_routes helper functions.

The previous ``_get_day_type`` returned ``"saturday"``/``"sunday"``/``"weekday"``
while the weekly template uses ``"mon"|"tue"|...|"sun"|"holiday"``, so the
weekly-inspection endpoint silently returned zero slots. Lock the mapping
so it can't regress.
"""

from __future__ import annotations

from datetime import datetime

from backend.models import Holiday
from backend.state import DAY_TYPES, _get_day_type


def test_get_day_type_returns_short_weekday_names():
    # 2026-01-05 is a Monday
    cases = [
        ("2026-01-05", "mon"),
        ("2026-01-06", "tue"),
        ("2026-01-07", "wed"),
        ("2026-01-08", "thu"),
        ("2026-01-09", "fri"),
        ("2026-01-10", "sat"),
        ("2026-01-11", "sun"),
    ]
    for iso, expected in cases:
        assert _get_day_type(iso, []) == expected


def test_get_day_type_returns_holiday_for_matching_date():
    holidays = [Holiday(dateISO="2026-01-05", name="New Year Observance")]
    assert _get_day_type("2026-01-05", holidays) == "holiday"


def test_get_day_type_values_are_valid_day_types():
    """Every possible return value must be one that template col-bands can carry."""
    for weekday_offset in range(7):
        dt = datetime(2026, 1, 5 + weekday_offset)  # Mon .. Sun
        assert _get_day_type(dt.strftime("%Y-%m-%d"), []) in DAY_TYPES
    assert _get_day_type("2026-01-01", [Holiday(dateISO="2026-01-01", name="NY")]) in DAY_TYPES
