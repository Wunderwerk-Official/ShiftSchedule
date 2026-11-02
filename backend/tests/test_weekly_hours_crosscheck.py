"""One weekly-hours rule (v1.81) on src/lib/weeklyHours.crossCheck.json.

The swap assistant's hours card (worktime.week_minutes, person_hours), its
cover search and the planner's gate (validate_weekly_hours) must count every
week and limit of the shared calendar exactly as the person picker does
(src/lib/weeklyHours.crossCheck.test.ts reads the same file): a person the
picker marks "Over weekly limit" for an open slot is never offered as its
cover, and one it does not mark is never blocked by the weekly hours. The
reason prints the hours the picker prints, an exact half rounded up (32.25 h
is 32.3 h in both).
"""

import json
from datetime import date
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _create_user, _get_current_user
from backend.main import app
from backend.models import AppState, Assignment
from backend.state import _load_state, _save_state
from backend.swaps import policy
from backend.swaps.worktime import person_hours, week_minutes
from backend.validation import build_validation_context, validate_weekly_hours

from .swap_fixtures import NOW

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "src/lib/weeklyHours.crossCheck.json").read_text()
)
USER = "weekly-hours-crosscheck"
IsoWeek = Tuple[int, int]
# validate_weekly_hours reports a week only when it is over its limit: 20
# nights of 12 h more push any week over, and are taken off again.
OVERLOAD_NIGHTS = 20


def _week(key: str) -> IsoWeek:
    year, week = key.split("-W")
    return int(year), int(week)


@pytest.fixture
def server(tmp_path, monkeypatch):
    """The fixture calendar as the server keeps (normalizes) and serves it, and
    a client of its owner."""
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "crosscheck.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setattr(policy, "utc_now", lambda: NOW)
    user = _create_user(USER, "weekly-hours-crosscheck-password", "user")
    _save_state(AppState.model_validate(FIXTURE["state"]), USER)
    app.dependency_overrides[_get_current_user] = lambda: user
    yield TestClient(app), _load_state(USER)
    app.dependency_overrides.pop(_get_current_user, None)


def _gate_week(state: AppState, clinician_id: str, week: IsoWeek) -> Optional[Tuple[int, int]]:
    """(minutes, limit) of one person-week as validate_weekly_hours counts
    them; None for a person without contract hours (the gate exempts them)."""
    monday = date.fromisocalendar(*week, 1).isoformat()
    overload = [Assignment(id=f"overload-{k}", rowId="night-mon", dateISO=monday, clinicianId=clinician_id)
                for k in range(OVERLOAD_NIGHTS)]
    found = [v for v in validate_weekly_hours(state, state.assignments + overload)
             if v.clinician_id == clinician_id and (v.context["iso_year"], v.context["iso_week"]) == week]
    if not found:
        return None
    (violation,) = found
    return violation.context["assigned_minutes"] - OVERLOAD_NIGHTS * 720, violation.context["max_minutes"]


def test_the_server_keeps_the_calendar_both_sides_read(server):
    """Saving normalizes the calendar; slots, assignments and the hours fields
    must survive, so the picker reads what the swap search reads."""
    _client, stored = server
    raw = FIXTURE["state"]
    assert sorted((a.id, a.rowId, a.dateISO, a.clinicianId) for a in stored.assignments) == sorted(
        (a["id"], a["rowId"], a["dateISO"], a["clinicianId"]) for a in raw["assignments"])
    slots = {s.id: (s.startTime, s.endTime, s.endDayOffset or 0)
             for loc in stored.weeklyTemplate.locations for s in loc.slots}
    assert slots == {s["id"]: (s.get("startTime"), s.get("endTime"), s.get("endDayOffset", 0))
                     for s in raw["weeklyTemplate"]["locations"][0]["slots"]}
    hours = {c.id: (c.workingHoursPerWeek, c.workingHoursToleranceHours) for c in stored.clinicians}
    # A missing tolerance is stored as the default 5 h, which is also the picker's default.
    assert hours == {c["id"]: (c.get("workingHoursPerWeek"), c.get("workingHoursToleranceHours", 5))
                     for c in raw["clinicians"]}


@pytest.mark.parametrize("expected", FIXTURE["expected"]["weeks"],
                         ids=lambda e: f"{e['clinicianId']}-{e['week']}")
def test_hours_card_and_gate_count_every_week_like_the_picker(server, expected):
    _client, stored = server
    vctx = build_validation_context(stored)
    clinician = vctx.clinicians_by_id[expected["clinicianId"]]
    week = _week(expected["week"])
    assert week_minutes(vctx, stored.assignments, clinician.id, [week]) == {week: expected["minutes"]}
    card = person_hours(vctx, clinician, stored.assignments, stored.assignments, [week])["weeks"][0]
    assert (card["beforeMinutes"], card["limitMinutes"]) == (expected["minutes"], expected["limitMinutes"])
    gate = _gate_week(stored, clinician.id, week)
    if expected["limitMinutes"] is None:
        assert gate is None
    else:
        assert gate == (expected["minutes"], expected["limitMinutes"])


@pytest.mark.parametrize("cover", FIXTURE["expected"]["covers"],
                         ids=lambda c: f"{c['slot']['rowId']}-{c['slot']['dateISO']}")
def test_cover_search_blocks_exactly_whom_the_picker_marks(server, cover):
    client, stored = server
    result = client.post("/v1/swaps/candidates", json={"mode": "cover", "slot": cover["slot"]})
    assert result.status_code == 200, result.text
    body: Dict[str, Any] = result.json()
    target = body["target"]
    assert target["blocked"] is None
    assert target["excludedPartnerIds"] == sorted(cover["holders"])
    hidden = target["hiddenHolder"]
    assert ([hidden["clinicianId"]] if hidden else []) == cover["holders"]
    offered = {o["partnerId"]: o for o in body["best"] + body["possible"]}
    blocked = {o["partnerId"]: o for o in body["blocked"]}
    names = {c.id: c.name for c in stored.clinicians}
    iso_week = _week(cover["week"])[1]
    for candidate in cover["candidates"]:
        cid = candidate["clinicianId"]
        if candidate["over"]:
            assert cid not in offered
            # The hours the picker prints too ("32.3/30 h in 2026-W50"); written out
            # here, not built with labels.weekly_hours, so a change in rounding shows.
            shown = candidate["shown"]
            assert blocked[cid]["reason"] == {
                "code": "weekly_hours",
                "message": f"{names[cid]}: week {iso_week} would reach {shown['after']:.1f} h "
                           f"(limit {shown['limit']:.1f} h).",
            }
        else:
            assert cid not in blocked, blocked.get(cid)
            (week,) = offered[cid]["hours"][0]["weeks"]
            assert (week["afterMinutes"], week["limitMinutes"]) == (candidate["afterMinutes"],
                                                                      candidate["limitMinutes"])
    assert set(offered) | set(blocked) == {c["clinicianId"] for c in cover["candidates"]}
