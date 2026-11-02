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


def test_holiday_source_round_trips_and_untagged_keeps_the_revision(client):
    initial = client.get("/v1/state").json()
    assert initial["holidays"]
    assert all("source" not in holiday for holiday in initial["holidays"])
    revision = initial["revision"]

    resaved = client.post("/v1/state", json=initial)
    assert resaved.status_code == 200, resaved.text
    assert resaved.json()["revision"] == revision

    manual = {"dateISO": "2026-03-02", "name": "Clinic day", "source": "manual"}
    tagged = {**initial, "holidays": [{**initial["holidays"][0], "source": "public"}, *initial["holidays"][1:], manual]}
    saved = client.post("/v1/state", json=tagged)
    assert saved.status_code == 200, saved.text
    assert saved.json()["holidays"][0]["source"] == "public"
    assert saved.json()["holidays"][-1] == manual
    assert saved.json()["revision"] != revision
    assert client.get("/v1/state").json()["holidays"][-1] == manual

    # A malformed tag is dropped, not rejected.
    odd = {**saved.json(), "holidays": [{**manual, "source": "auto"}]}
    response = client.post("/v1/state", json=odd)
    assert response.status_code == 200, response.text
    assert response.json()["holidays"] == [{"dateISO": "2026-03-02", "name": "Clinic day"}]


def _saved_calendar(client):
    """A calendar with one person (clin-1), a Monday slot and one shift on it."""
    from .conftest import make_app_state, make_assignment

    state = make_app_state(assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")])
    revision = client.get("/v1/state").json()["revision"]
    saved = client.post("/v1/state", json={**state.model_dump(), "revision": revision})
    assert saved.status_code == 200, saved.text
    return saved.json()


@pytest.mark.parametrize(
    "row_id, date_iso",
    [
        ("slot-a__mon", "2026-02-30"),
        ("slot-a__mon", "garbage"),
        ("pool-rest-day", "not-a-date"),
        ("pool-rest-day", "2026-02-30"),
        ("pool-rest-day", "2026-1-05"),
        ("pool-rest-day", "2026-W02-1"),
    ],
)
def test_save_rejects_a_shift_with_an_impossible_date(client, row_id, date_iso):
    calendar = _saved_calendar(client)
    bad = {"id": "bad", "rowId": row_id, "dateISO": date_iso, "clinicianId": "clin-1"}
    response = client.post("/v1/state", json={**calendar, "assignments": [*calendar["assignments"], bad]})
    assert response.status_code == 422, response.text
    [error] = response.json()["detail"]
    assert error["loc"] == ["body", "assignments", 1, "dateISO"]
    assert f"'{date_iso}' is not a valid date (YYYY-MM-DD)" in error["msg"]
    # Nothing was stored.
    assert client.get("/v1/state").json()["revision"] == calendar["revision"]


@pytest.mark.parametrize(
    "field, value, loc",
    [
        ("holidays", [{"dateISO": "2026-13-01", "name": "Broken"}], ["body", "holidays", 0, "dateISO"]),
        ("publishedWeekStartISOs", ["2026-02-30"], ["body", "publishedWeekStartISOs", 0]),
        ("slotOverridesByKey", {"slot-a__mon__mon": 1}, ["body", "slotOverridesByKey"]),
        ("slotOverridesByKey", {"slot-a__mon": 1}, ["body", "slotOverridesByKey"]),
    ],
)
def test_save_rejects_other_impossible_calendar_dates(client, field, value, loc):
    calendar = _saved_calendar(client)
    response = client.post("/v1/state", json={**calendar, field: value})
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"] == loc


def test_save_rejects_a_vacation_with_an_impossible_date(client):
    calendar = _saved_calendar(client)
    clinician = {**calendar["clinicians"][0], "vacations": [{"id": "v", "startISO": "2026-04-31", "endISO": "2026-05-02"}]}
    response = client.post("/v1/state", json={**calendar, "clinicians": [clinician]})
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"] == ["body", "clinicians", 0, "vacations", 0, "startISO"]


def test_save_accepts_the_date_formats_the_app_writes(client):
    calendar = _saved_calendar(client)
    clinician = {**calendar["clinicians"][0], "vacations": [{"id": "v", "startISO": "2026-02-28", "endISO": "2026-03-01"}]}
    response = client.post("/v1/state", json={
        **calendar,
        "clinicians": [clinician],
        "holidays": [{"dateISO": "2028-02-29", "name": "Leap day", "source": "manual"}],
        "publishedWeekStartISOs": ["2026-01-05"],
        "slotOverridesByKey": {"slot-a__mon__2026-01-05": 1},
    })
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["slotOverridesByKey"] == {"slot-a__mon__2026-01-05": 1}
    assert saved["publishedWeekStartISOs"] == ["2026-01-05"]


def test_save_drops_shifts_of_people_no_longer_listed(client):
    calendar = _saved_calendar(client)
    orphan = {"id": "orphan", "rowId": "pool-rest-day", "dateISO": "2026-01-06", "clinicianId": "nobody"}
    response = client.post("/v1/state", json={**calendar, "assignments": [*calendar["assignments"], orphan]})
    assert response.status_code == 200, response.text
    assert [a["id"] for a in response.json()["assignments"]] == ["a1"]
    assert [a["id"] for a in client.get("/v1/state").json()["assignments"]] == ["a1"]


def test_a_calendar_stored_with_impossible_dates_still_loads_and_saves(client):
    """Calendars saved before the checks existed must still load: the
    impossible entries are dropped on load and the result saves again."""
    import json

    calendar = _saved_calendar(client)
    conn = db._get_connection()
    blob = json.loads(conn.execute("SELECT data FROM app_state WHERE id = 'routes-user'").fetchone()["data"])
    blob["assignments"] += [
        {"id": "bad-slot", "rowId": "slot-a__mon", "dateISO": "2026-02-30", "clinicianId": "clin-1"},
        {"id": "bad-pool", "rowId": "pool-rest-day", "dateISO": "garbage", "clinicianId": "clin-1"},
        {"id": "orphan", "rowId": "pool-rest-day", "dateISO": "2026-01-06", "clinicianId": "nobody"},
    ]
    blob["holidays"] = [{"dateISO": "2026-13-01", "name": "Broken"}, {"dateISO": "2026-01-01", "name": "Neujahr"}]
    blob["publishedWeekStartISOs"] = ["2026-01-05", "not-a-week"]
    blob["slotOverridesByKey"] = {"slot-a__mon__2026-02-30": 1, "slot-a__mon__2026-01-05": 2}
    blob["clinicians"][0]["vacations"] = [
        {"id": "v-bad", "startISO": "", "endISO": "2026-01-09"},
        {"id": "v-ok", "startISO": "2026-01-12", "endISO": "2026-01-16"},
    ]
    conn.execute("UPDATE app_state SET data = ? WHERE id = 'routes-user'", (json.dumps(blob),))
    conn.commit()
    conn.close()

    loaded = client.get("/v1/state")
    assert loaded.status_code == 200, loaded.text
    state = loaded.json()
    assert [a["id"] for a in state["assignments"]] == ["a1"]
    assert state["holidays"] == [{"dateISO": "2026-01-01", "name": "Neujahr"}]
    assert state["publishedWeekStartISOs"] == ["2026-01-05"]
    assert state["slotOverridesByKey"] == {"slot-a__mon__2026-01-05": 2}
    assert [v["id"] for v in state["clinicians"][0]["vacations"]] == ["v-ok"]
    # The cleaned calendar is what is stored now, so the browser can save it back.
    resaved = client.post("/v1/state", json=state)
    assert resaved.status_code == 200, resaved.text
    assert resaved.json()["revision"] == state["revision"]
