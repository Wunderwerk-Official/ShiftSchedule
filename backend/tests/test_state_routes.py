"""Regression tests for backend.state_routes helper functions.

The previous ``_get_day_type`` returned ``"saturday"``/``"sunday"``/``"weekday"``
while the weekly template uses ``"mon"|"tue"|...|"sun"|"holiday"``, so the
weekly-inspection endpoint silently returned zero slots. Lock the mapping
so it can't regress.

The endpoint tests at the end pin what ``GET``/``POST /v1/state`` return for
optional state fields such as ``holidayRegion``.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _create_user, _get_current_user
from backend.main import app
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


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "state-routes.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    user = _create_user("routes-user", "routes-test-password", "user")
    app.dependency_overrides[_get_current_user] = lambda: user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(_get_current_user, None)


def test_holiday_region_round_trips_and_unset_keeps_the_revision(client):
    initial = client.get("/v1/state").json()
    assert "holidayRegion" not in initial
    revision = initial["revision"]

    # An open tab re-saving a calendar without a region keeps its revision.
    resaved = client.post("/v1/state", json=initial)
    assert resaved.status_code == 200, resaved.text
    assert "holidayRegion" not in resaved.json()
    assert resaved.json()["revision"] == revision

    saved = client.post("/v1/state", json={**initial, "holidayRegion": "de-nw"})
    assert saved.status_code == 200, saved.text
    assert saved.json()["holidayRegion"] == "DE-NW"
    assert saved.json()["revision"] != revision
    reloaded = client.get("/v1/state").json()
    assert reloaded["holidayRegion"] == "DE-NW"
    assert reloaded["revision"] == saved.json()["revision"]

    # The region is calendar content: a tab still holding the old revision
    # cannot overwrite it.
    assert client.post("/v1/state", json=initial).status_code == 409

    cleared = client.post("/v1/state", json={**reloaded, "holidayRegion": None})
    assert cleared.status_code == 200, cleared.text
    assert "holidayRegion" not in cleared.json()
    assert cleared.json()["revision"] == revision
