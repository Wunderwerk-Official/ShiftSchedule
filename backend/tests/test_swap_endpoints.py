"""The swap endpoints against a temporary database: candidates, apply, undo and
history, with the clock fixed through policy.utc_now."""

import json
import re
import sqlite3
from collections import Counter
from contextlib import closing
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List

import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.swaps.apply as swap_apply
from backend import solver_runs
from backend.auth import _create_user, _delete_user, _get_current_user
from backend.main import app
from backend.models import AppState, Assignment, Clinician, VacationRange
from backend.run_apply import planning_fingerprint
from backend.state import _load_state, _normalize_state, _save_state
from backend.swaps import matching, policy, store
from backend.swaps.blocks import slot_fingerprint
from backend.validation import build_validation_context

from .conftest import make_clinician
from .swap_fixtures import (
    ALL_SECTIONS,
    FRI,
    MON,
    NOW,
    SAT,
    SUN,
    THU,
    TUE,
    WED,
    asg,
    default_clinicians,
    make_swap_state,
)

USER = "swap-endpoint-test"
OTHER = "swap-endpoint-other"
WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "swaps.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setattr(policy, "utc_now", lambda: NOW)
    current_user = _create_user(USER, "swap-endpoint-password", "user")
    app.dependency_overrides[_get_current_user] = lambda: current_user
    yield TestClient(app)
    app.dependency_overrides.pop(_get_current_user, None)


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _seed(assignments: List[Assignment], **kwargs: Any) -> str:
    _save_state(make_swap_state(assignments, **kwargs), USER)
    return _load_state(USER).revision


def _edit(change: Callable[[AppState], None]) -> str:
    """Change the stored calendar as another tab would; returns the new revision."""
    state = _load_state(USER)
    change(state)
    _save_state(state, USER)
    return _load_state(USER).revision


def _ref(a: Assignment) -> Dict[str, str]:
    return {"assignmentId": a.id, "rowId": a.rowId, "dateISO": a.dateISO, "clinicianId": a.clinicianId}


def _search(client: TestClient, body: Dict[str, Any]) -> Dict[str, Any]:
    response = client.post("/v1/swaps/candidates", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _find(client: TestClient, a: Assignment, mode: str = "swap", **fields: Any) -> Dict[str, Any]:
    return _search(client, {"mode": mode, "assignment": _ref(a), **fields})


def _option(result: Dict[str, Any], key: str) -> Dict[str, Any]:
    return next(o for o in result["best"] + result["possible"] + result["blocked"] if o["key"] == key)


def _item_refs(unit: Dict[str, Any]) -> List[Dict[str, str]]:
    return [{"rowId": i["rowId"], "dateISO": i["dateISO"], "clinicianId": i["clinicianId"], "fp": i["fp"]}
            for i in unit["items"]]


def _apply_body(result: Dict[str, Any], option: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
    """The request the preview sends for one option (all rest-day moves ticked)."""
    target = result["target"]
    if target["mode"] == "cover":
        item = target["unit"]["items"][0]
        hidden = option["hiddenRemoval"]
        body: Dict[str, Any] = {
            "give": [], "take": None,
            "slot": {"rowId": item["rowId"], "dateISO": item["dateISO"], "fp": item["fp"]},
            "removeHidden": {"clinicianId": hidden["clinicianId"]} if hidden else None,
        }
    else:
        body = {"give": _item_refs(target["unit"]), "slot": None, "removeHidden": None,
                "take": _item_refs(option["take"]) if option["take"] else None}
    body.update(
        mode=target["mode"], wholeDay=target["wholeDay"], partnerId=option["partnerId"],
        restDayMoves=option["restDayMoves"], expectedRevision=result["revision"], consent=True, note=None,
        approverName=None, overrideNotice=False, acknowledgedWarnings=[w["id"] for w in option["warnings"]],
    )
    body.update(overrides)
    return body


def _apply(client: TestClient, body: Dict[str, Any], status: int = 200) -> Dict[str, Any]:
    response = client.post("/v1/swaps/apply", json=body)
    assert response.status_code == status, response.text
    return response.json()


def _error(response_json: Dict[str, Any], code: str) -> Dict[str, Any]:
    detail = response_json["detail"]
    assert detail["code"] == code, detail
    return detail


def _rows(table: str) -> List[sqlite3.Row]:
    with closing(db._get_connection()) as conn:
        return conn.execute(f"SELECT * FROM {table} WHERE username = ?", (USER,)).fetchall()


def _multiset(assignments: List[Any]) -> Counter:
    dumps = [a.model_dump() if isinstance(a, Assignment) else a for a in assignments]
    return Counter((d["id"], d["rowId"], d["dateISO"], d["clinicianId"], d["source"], d["locked"])
                   for d in dumps)


def _held(state: Dict[str, Any]) -> set:
    return {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in state["assignments"]}


def _refused(client: TestClient, body: Dict[str, Any], status: int, code: str, message: str) -> Dict[str, Any]:
    """An apply refused with ``code`` and ``message``: the stored calendar and
    the swap tables stay as they were."""
    before = _load_state(USER)
    detail = _error(_apply(client, body, status), code)
    assert detail["message"] == message
    after = _load_state(USER)
    assert after.revision == before.revision
    assert _multiset(after.assignments) == _multiset(before.assignments)
    assert _rows("swap_requests") == [] and _rows("swap_events") == []
    return detail


def _fp(row_id: str) -> str:
    return slot_fingerprint(build_validation_context(_load_state(USER)), row_id)


def _crafted(mode: str, revision: str, **fields: Any) -> Dict[str, Any]:
    """An apply body built by hand, not from a preview."""
    return {"mode": mode, "give": [], "take": None, "wholeDay": False, "slot": None, "partnerId": "clin-ben",
            "restDayMoves": [], "removeHidden": None, "expectedRevision": revision, "consent": True,
            "acknowledgedWarnings": [], **fields}


NIGHT = asg("anna-night", "night-thu", THU, "clin-anna")
BEN_CT = asg("ben-ct", "ct-sat", SAT, "clin-ben")
SWAP_KEY = "clin-ben|ct-sat@2026-01-10"


def _swap_option(client: TestClient) -> tuple:
    result = _find(client, NIGHT)
    return result, _option(result, SWAP_KEY)


# --- Apply --------------------------------------------------------------------


def test_happy_path_swap(client):
    revision = _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    assert result["revision"] == revision
    assert option["group"] == "best"
    assert result["targetFindings"] == []
    body = _apply(client, _apply_body(result, option, note="  Ben agreed by phone ",
                                      approverName="K. Berger"))
    swap, state = body["swap"], body["state"]

    assert re.fullmatch(r"swp-[0-9a-f]+-[0-9a-f]{6}", swap["id"])
    assert state["revision"] not in (None, revision) and state["revision"] == _load_state(USER).revision
    assert _held(state) == {("night-thu", THU, "clin-ben"), ("ct-sat", SAT, "clin-anna")}
    for a in state["assignments"]:
        assert (a["source"], a["locked"]) == ("manual", True)
        assert a["id"].startswith(swap["id"])
    now_iso = store.iso_utc(NOW)
    assert swap == {
        "id": swap["id"], "kind": "swap", "status": "applied",
        "requesterId": "clin-anna", "requesterName": "Anna Weber",
        "partnerId": "clin-ben", "partnerName": "Ben Ott",
        "give": [{"rowId": "night-thu", "dateISO": THU, "sectionName": "Night duty",
                  "start": "2026-01-08T20:00", "end": "2026-01-09T08:00"}],
        "take": [{"rowId": "ct-sat", "dateISO": SAT, "sectionName": "CT", "start": "2026-01-10T08:00",
                  "end": "2026-01-10T16:00"}],
        "restDayMoves": [], "restDaysRemoved": [], "hiddenRemoved": None,
        "note": "Ben agreed by phone", "approverName": "K. Berger", "consent": "confirmed_by_planner",
        "noticeOverride": False, "acknowledgedWarnings": [],
        "createdAt": now_iso, "appliedAt": now_iso, "revertedAt": None,
        "canUndo": True, "undoBlockedReason": None,
    }

    (row,) = _rows("swap_requests")
    assert (row["status"], row["consent"], row["created_via"], row["created_by"]) == (
        "applied", "confirmed_by_planner", "planner", f"user:{USER}")
    assert row["created_at"] == row["applied_at"] == row["decided_at"] == row["updated_at"] == now_iso
    assert row["applied_revision"] == state["revision"]
    assert row["starts_at"] == "2026-01-08T19:00:00+00:00"
    patch = json.loads(row["applied_patch"])
    assert patch["removed"] == [NIGHT.model_dump(), BEN_CT.model_dump()]
    assert patch["added"] == [
        {"id": f"{swap['id']}-0", "rowId": "night-thu", "dateISO": THU, "clinicianId": "clin-ben",
         "source": "manual", "locked": True},
        {"id": f"{swap['id']}-1", "rowId": "ct-sat", "dateISO": SAT, "clinicianId": "clin-anna",
         "source": "manual", "locked": True},
    ]
    assert json.loads(row["give_items"]) == [{"assignmentId": "anna-night", "rowId": "night-thu",
                                              "dateISO": THU, "clinicianId": "clin-anna",
                                              "fp": "1200-1920@loc-default#sec-night"}]
    (event,) = _rows("swap_events")
    assert (event["request_id"], event["action"], event["actor"]) == (swap["id"], "applied", f"user:{USER}")
    assert json.loads(event["detail"]) == {"revision": state["revision"], "noticeOverride": False,
                                           "acknowledgedWarnings": [], "approverName": "K. Berger"}
    (change,) = _rows("schedule_changes")
    assert change["kind"] == "swap_applied" and change["id"] == row["change_id"]
    diff = json.loads(change["diff"])
    assert (diff["swap_id"], diff["swap_kind"]) == (swap["id"], "swap")
    assert len(diff["assignments"]["added"]) == len(diff["assignments"]["removed"]) == 2
    assert [r for r in _rows("calendar_snapshots") if r["kind"] == "auto_backup"] == []


def test_handover_moves_and_removes_rest_days_and_undo_restores_them(client):
    anna_rest = asg("anna-rest", "pool-rest-day", FRI, "clin-anna", locked=False)
    ben_rest = asg("ben-rest", "pool-rest-day", THU, "clin-ben", locked=False)
    _seed([NIGHT, anna_rest, ben_rest])
    before = _load_state(USER).assignments
    result = _find(client, NIGHT, "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    assert option["restDayMoves"] == [{"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben",
                                       "dateISO": FRI}]
    assert option["restDayRemovals"] == [{"clinicianId": "clin-ben", "name": "Ben Ott", "dateISO": THU}]
    # Anna's lost hours are one note on the target, never the option's; Ben's
    # lost day off is the option's own note, so it is no best match.
    assert result["targetFindings"] == [{"code": "giver_below_contract", "clinicianId": "clin-anna",
                                         "message": "Anna Weber: week 2 drops to 0.0 h (contract 40 h).",
                                         "short": "−40 h under contract"}]
    assert (option["group"], option["findings"]) == ("possible", [
        {"code": "rest_day_removed", "clinicianId": "clin-ben",
         "message": "Ben Ott has a Rest Day on Thu 8 Jan; it will be removed.", "short": "Rest Day removed"}])

    swap = _apply(client, _apply_body(result, option))["swap"]
    state = _load_state(USER)
    moved = [a for a in state.assignments if a.rowId == "pool-rest-day"]
    assert [(a.dateISO, a.clinicianId, a.source, a.locked) for a in moved] == [
        (FRI, "clin-ben", "manual", False)]
    assert {(a.rowId, a.clinicianId) for a in state.assignments} == {("night-thu", "clin-ben"),
                                                                     ("pool-rest-day", "clin-ben")}
    assert swap["restDaysRemoved"] == option["restDayRemovals"]
    assert swap["restDayMoves"] == option["restDayMoves"]
    assert json.loads(_rows("swap_requests")[0]["summary"])["restDaysRemoved"] == option["restDayRemovals"]

    response = client.post(f"/v1/swaps/{swap['id']}/undo", json={"expectedRevision": state.revision})
    assert response.status_code == 200, response.text
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def _anna_on_vacation_thu() -> List:
    anna = make_clinician("clin-anna", "Anna Weber", list(ALL_SECTIONS), working_hours_per_week=40,
                          vacations=[VacationRange(id="v", startISO=THU, endISO=THU)])
    return [anna] + default_clinicians()[1:]


def test_cover_removes_the_hidden_holder(client):
    _seed([asg("anna-ct", "ct-thu", THU, "clin-anna")], clinicians=_anna_on_vacation_thu())
    result = _search(client, {"mode": "cover", "slot": {"rowId": "ct-thu", "dateISO": THU}})
    option = _option(result, "clin-ben|-")
    assert option["hiddenRemoval"] == {"clinicianId": "clin-anna", "name": "Anna Weber",
                                       "assignmentId": "anna-ct", "required": True}
    assert result["targetFindings"] == []
    body = _apply_body(result, option)

    capacity = _error(_apply(client, {**body, "removeHidden": None}, 409), "swap_invalid")
    assert capacity["reasons"] == ["CT on Thu 8 Jan would be overfilled."]
    assert capacity["violations"][0]["code"] == "CAPACITY_EXCEEDED"
    _apply(client, {**body, "slot": {**body["slot"], "fp": None}}, 422)

    swap = _apply(client, body)["swap"]
    assert _held({"assignments": [a.model_dump() for a in _load_state(USER).assignments]}) == {
        ("ct-thu", THU, "clin-ben")}
    assert (swap["kind"], swap["requesterId"], swap["requesterName"]) == ("cover", None, None)
    assert swap["hiddenRemoved"] == {"clinicianId": "clin-anna", "name": "Anna Weber"}
    assert swap["give"] == [{"rowId": "ct-thu", "dateISO": THU, "sectionName": "CT",
                             "start": "2026-01-08T08:00", "end": "2026-01-08T16:00"}]
    row = _rows("swap_requests")[0]
    assert json.loads(row["give_items"]) == [{"assignmentId": None, "rowId": "ct-thu", "dateISO": THU,
                                              "clinicianId": None, "fp": "480-960@loc-default#sec-ct"}]
    assert row["requester_id"] is None and row["take_items"] is None


def test_revision_mismatch_gives_state_changed(client):
    revision = _seed([NIGHT, BEN_CT])
    response = client.post("/v1/swaps/candidates", json={"mode": "swap", "assignment": _ref(NIGHT),
                                                           "expectedRevision": "outdated"})
    assert response.status_code == 409
    assert _error(response.json(), "state_changed")["revision"] == revision
    result, option = _swap_option(client)
    body = _apply_body(result, option, expectedRevision="outdated")
    detail = _error(_apply(client, body, 409), "state_changed")
    assert detail == {"code": "state_changed", "revision": revision,
                      "message": "The calendar changed in another tab or operation. Reload it and try again."}


def _drop_ben_ct(state: AppState) -> None:
    state.assignments = [a for a in state.assignments if a.id != "ben-ct"]


def _longer_ct_sat(state: AppState) -> None:
    slot = next(s for s in state.weeklyTemplate.locations[0].slots if s.id == "ct-sat")
    slot.endTime = "17:00"


@pytest.mark.parametrize("change, message", [
    (_drop_ben_ct, "Ben Ott's shift on Sat 10 Jan changed. Refresh and try again."),
    (_longer_ct_sat, "Ben Ott's shift on Sat 10 Jan changed. Refresh and try again."),
], ids=["deleted", "fingerprint"])
def test_a_changed_shift_is_stale(client, change: Callable[[AppState], None], message: str):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    revision = _edit(change)
    detail = _error(_apply(client, _apply_body(result, option, expectedRevision=revision), 409), "swap_stale")
    assert detail["message"] == message


def test_a_changed_block_is_stale(client):
    early = asg("anna-early", "early-thu", THU, "clin-anna")
    _seed([early, BEN_CT])
    result = _find(client, early)
    option = _option(result, SWAP_KEY)
    revision = _edit(lambda state: state.assignments.append(asg("anna-late", "late-thu", THU, "clin-anna")))
    detail = _error(_apply(client, _apply_body(result, option, expectedRevision=revision), 409), "swap_stale")
    assert detail["message"] == "Anna Weber's shift on Thu 8 Jan changed. Refresh and try again."


def test_a_cover_slot_with_new_times_is_stale(client):
    _seed([])
    result = _search(client, {"mode": "cover", "slot": {"rowId": "ct-thu", "dateISO": THU}})
    option = _option(result, "clin-ben|-")

    def later_end(state: AppState) -> None:
        next(s for s in state.weeklyTemplate.locations[0].slots if s.id == "ct-thu").endTime = "18:00"

    revision = _edit(later_end)
    detail = _error(_apply(client, _apply_body(result, option, expectedRevision=revision), 409), "swap_stale")
    assert detail["message"] == "This slot's times or place changed. Refresh and try again."


def test_a_started_shift_cannot_be_swapped(client, monkeypatch):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    monkeypatch.setattr(policy, "utc_now", lambda: _utc("2026-01-08T19:30Z"))  # Thu 20:30 in Berlin
    detail = _error(_apply(client, _apply_body(result, option), 409), "swap_started")
    assert detail["message"] == "This shift has already started and can't be swapped."


def test_inside_notice_needs_the_override(client, monkeypatch):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    monkeypatch.setattr(policy, "utc_now", lambda: _utc("2026-01-08T09:00Z"))  # 10 h before the night
    detail = _error(_apply(client, _apply_body(result, option), 409), "notice_override_required")
    assert detail["hoursLeft"] == 10.0
    assert detail["message"] == ("This swap starts in 10 h, inside the 48 h notice period. "
                                 "Confirm the override to apply it.")
    swap = _apply(client, _apply_body(result, option, overrideNotice=True))["swap"]
    assert swap["noticeOverride"] is True
    assert _rows("swap_requests")[0]["notice_override"] == 1


def test_consent_and_text_limits(client):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    response = client.post("/v1/swaps/apply", json=_apply_body(result, option, consent=False))
    assert response.status_code == 400
    assert response.json()["detail"] == {"code": "consent_required",
                                         "message": "Confirm that the colleague agreed to the swap."}
    _apply(client, _apply_body(result, option, note="x" * 281), 422)
    _apply(client, _apply_body(result, option, approverName="x" * 81), 422)
    assert _rows("swap_requests") == []


def test_a_rule_breaking_handover_is_refused_with_reasons(client):
    week = [asg(f"ben-{d}", f"ct-{d}", day, "clin-ben") for d, day in
            [("mon", MON), ("tue", TUE), ("wed", WED), ("thu", THU), ("fri", FRI)]]
    saturday = asg("anna-sat", "ct-sat", SAT, "clin-anna")
    _seed(week + [saturday])
    result = _find(client, saturday, "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    assert option["group"] == "blocked"
    detail = _error(_apply(client, _apply_body(result, option), 409), "swap_invalid")
    assert detail["reasons"][0] == "Ben Ott: week 2 would reach 48.0 h (limit 45.0 h)."
    assert detail["message"] == ("This swap breaks a planning rule: "
                                 "Ben Ott: week 2 would reach 48.0 h (limit 45.0 h).")
    assert detail["violations"][0]["code"] == "WEEKLY_HOURS"


def test_a_refused_handover_names_both_shifts_of_an_overlap_the_partner_would_receive(client):
    # The demo lies inside the night, so Ben would receive both shifts of the overlap.
    night = asg("anna-night", "night-wed", WED, "clin-anna")
    _seed([night, asg("anna-demo", "demo-thu", THU, "clin-anna")])
    result = _find(client, night, "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    text = ("Ben Ott would get two overlapping shifts: Night duty (Wed 7 Jan, 20:00 → 08:00) "
            "and Demo (Thu 8 Jan, 07:15–07:45).")
    assert option["reason"] == {"code": "overlap", "message": text}
    detail = _error(_apply(client, _apply_body(result, option), 409), "swap_invalid")
    assert detail["reasons"][0] == text


def test_a_change_normalization_would_alter_is_refused(client, monkeypatch):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)

    def dropping_last(state: AppState):
        normalized, changed = _normalize_state(state)
        normalized.assignments = normalized.assignments[:-1]
        return normalized, changed

    monkeypatch.setattr(swap_apply, "_normalize_state", dropping_last)
    detail = _error(_apply(client, _apply_body(result, option), 409), "plan_invalid")
    assert detail["message"] == ("This swap no longer matches the weekly template or holidays. "
                                 "Refresh and try again.")


def test_working_time_warnings_need_an_acknowledgement(client):
    # Without the split-day rule a night after a day shift is valid, with a 4 h rest.
    _seed([asg("ben-ct", "ct-thu", THU, "clin-ben"), NIGHT],
          solver_settings={"preferContinuousShifts": False})
    result = _find(client, NIGHT, "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    rest_id = "rest:clin-ben:2026-01-08T16:00:2026-01-08T20:00"
    assert [w["id"] for w in option["warnings"]] == [rest_id]
    detail = _error(_apply(client, _apply_body(result, option, acknowledgedWarnings=[]), 409),
                    "warnings_unacknowledged")
    assert detail["message"] == "Check the working-time warnings first."
    assert detail["warnings"][0]["id"] == rest_id
    assert detail["warnings"] == option["warnings"]
    body = _apply_body(result, option, acknowledgedWarnings=[rest_id, "ignored-extra"])
    swap = _apply(client, body)["swap"]
    acknowledged = [{"id": rest_id, "code": "rest_short", "message": option["warnings"][0]["message"]}]
    assert swap["acknowledgedWarnings"] == acknowledged
    assert json.loads(_rows("swap_requests")[0]["acknowledged_warnings"]) == acknowledged


def test_a_stretch_longer_than_the_search_window_is_acknowledged_once(client):
    # Ben's background on-call every day from Mon 29 Dec, then Anna's Monday CT.
    days = [date(2025, 12, 29) + timedelta(days=n) for n in range(14)]
    calls = [asg(f"call-{n}", f"oncall-{WEEKDAY_KEYS[day.weekday()]}", day.isoformat(), "clin-ben")
             for n, day in enumerate(days)]
    clinicians = default_clinicians()
    clinicians[1].workingHoursPerWeek = None
    monday_ct = asg("anna-ct", "ct-mon", "2026-01-12", "clin-anna")
    _seed(calls + [monday_ct], clinicians=clinicians, solver_settings={"onCallRestEnabled": False})
    result = _find(client, monday_ct, "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    assert [(w["id"], w["message"]) for w in option["warnings"]] == [(
        "long:clin-ben:2025-12-29T08:00:2026-01-12T16:00",
        "Ben Ott: 344.0 h without a break, Mon 29 Dec 08:00 → Mon 12 Jan 16:00 (maximum 24 h).")]
    swap = _apply(client, _apply_body(result, option))["swap"]
    assert [w["id"] for w in swap["acknowledgedWarnings"]] == [option["warnings"][0]["id"]]


def test_apply_refuses_requests_that_do_not_describe_one_swap(client):
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    body = _apply_body(result, option)
    for changed, message in [
        ({"partnerId": "clin-nobody"}, "This person is not in the plan."),
        ({"partnerId": "clin-anna", "take": [{**body["take"][0], "clinicianId": "clin-anna"}]},
         "Choose another person."),
        ({"take": [{**body["take"][0], "clinicianId": "clin-clara"}]},
         "These shifts do not belong to the chosen people. Refresh and try again."),
    ]:
        detail = _error(_apply(client, {**body, **changed}, 400), "invalid_request")
        assert detail["message"] == message


# --- Crafted requests ---------------------------------------------------------
# The preview never sends these, so apply refuses them itself: for a forged Rest
# Day move or hidden removal no planning rule would.


def _unlocked(assignment_id: str, slot: str, clinician_id: str) -> Assignment:
    return asg(assignment_id, slot, THU, clinician_id, source="solver", locked=False)


@pytest.mark.parametrize("assignments, target", [
    # Anna's early and late form one block; Ben holds the second late (target 2).
    ([_unlocked("anna-early", "early-thu", "clin-anna"), _unlocked("anna-late", "late-thu", "clin-anna"),
      _unlocked("ben-late", "late-thu", "clin-ben")], "anna-early"),
    ([_unlocked("anna-late", "late-thu", "clin-anna"), _unlocked("ben-late", "late-thu", "clin-ben")],
     "anna-late"),
], ids=["partial-share", "full-share"])
def test_a_swap_whose_two_sides_share_a_slot_is_refused(client, assignments: List[Assignment], target: str):
    revision = _seed(assignments, slot_overrides={f"late-thu__{THU}": 1})
    result = _find(client, next(a for a in assignments if a.id == target), partnerId="clin-ben")
    # The search skips the pair, as it would mean a hand-over of the rest, or nothing.
    assert result["checked"] == 0
    give = _item_refs(result["target"]["unit"])
    take = [{"rowId": "late-thu", "dateISO": THU, "clinicianId": "clin-ben", "fp": _fp("late-thu")}]
    _refused(client, _crafted("swap", revision, give=give, take=take), 400, "invalid_request",
             "Both shifts are in the same slot. Choose another shift.")


STALE_REST_DAY = "The Rest Day entries changed. Refresh and try again."


@pytest.mark.parametrize("assignments, forged", [
    # Dora's Saturday Rest Day has nothing to do with the hand-over.
    ([asg("anna-ct", "ct-thu", THU, "clin-anna"), asg("dora-rest", "pool-rest-day", SAT, "clin-dora", locked=False)],
     {"fromClinicianId": "clin-dora", "toClinicianId": "clin-ben", "dateISO": SAT}),
    # A Rest Day follows the night from Anna to Ben, never the other way (Ben
    # rests on Friday himself, so nothing moves at all).
    ([NIGHT, asg("anna-rest", "pool-rest-day", FRI, "clin-anna", locked=False),
      asg("ben-rest", "pool-rest-day", FRI, "clin-ben", locked=False)],
     {"fromClinicianId": "clin-ben", "toClinicianId": "clin-anna", "dateISO": FRI}),
], ids=["third-person", "reversed"])
def test_a_rest_day_move_the_server_did_not_detect_is_refused(client, assignments: List[Assignment],
                                                             forged: Dict[str, str]):
    _seed(assignments)
    result = _find(client, assignments[0], "handover", partnerId="clin-ben")
    option = _option(result, "clin-ben|-")
    assert forged not in option["restDayMoves"]
    _refused(client, _apply_body(result, option, restDayMoves=option["restDayMoves"] + [forged]), 409,
             "swap_stale", STALE_REST_DAY)


def _away_thu(*clinician_ids: str) -> List[Clinician]:
    return [c.model_copy(update={"vacations": [VacationRange(id="v", startISO=THU, endISO=THU)]})
            if c.id in clinician_ids else c for c in default_clinicians()]


@pytest.mark.parametrize("away, holders, named", [
    # Clara's shift is visible: removeHidden never deletes a shift on the grid.
    (("clin-anna",), ("clin-anna", "clin-clara"), "clin-clara"),
    # Anna and Dora are both away; the cover removes the first hidden holder by name only.
    (("clin-anna", "clin-dora"), ("clin-anna", "clin-dora"), "clin-dora"),
], ids=["visible-holder", "second-hidden-holder"])
def test_a_hidden_removal_of_anyone_but_the_first_hidden_holder_is_refused(client, away: tuple, holders: tuple,
                                                                           named: str):
    revision = _seed([asg(f"{cid}-ct", "ct-thu", THU, cid) for cid in holders], clinicians=_away_thu(*away),
                     slot_overrides={f"ct-thu__{THU}": 1})
    slot = {"rowId": "ct-thu", "dateISO": THU, "fp": _fp("ct-thu")}
    _refused(client, _crafted("cover", revision, slot=slot, removeHidden={"clinicianId": named}), 409,
             "swap_stale", "The hidden shift in this slot changed. Refresh and try again.")


@pytest.mark.parametrize("holder, overrides, message", [
    ("clin-clara", {}, "This slot is no longer open. Refresh and try again."),
    ("clin-ben", {f"ct-thu__{THU}": 1}, "Ben Ott already works in this slot."),
], ids=["full-slot", "partner-in-slot"])
def test_a_cover_of_a_full_slot_or_by_one_of_its_holders_is_refused(client, holder: str, overrides: Dict[str, int],
                                                                    message: str):
    revision = _seed([asg("held", "ct-thu", THU, holder)], slot_overrides=overrides)
    slot = {"rowId": "ct-thu", "dateISO": THU, "fp": _fp("ct-thu")}
    _refused(client, _crafted("cover", revision, slot=slot), 409, "swap_stale", message)


def test_a_shift_whose_holder_went_on_vacation_after_the_preview_is_refused(client):
    anna_ct = asg("anna-ct", "ct-thu", THU, "clin-anna")
    _seed([anna_ct])
    result = _find(client, anna_ct, "handover", partnerId="clin-ben")

    def vacation(state: AppState) -> None:
        next(c for c in state.clinicians if c.id == "clin-anna").vacations.append(
            VacationRange(id="v", startISO=THU, endISO=THU))

    revision = _edit(vacation)
    _refused(client, _apply_body(result, _option(result, "clin-ben|-"), expectedRevision=revision), 409,
             "swap_stale", "Anna Weber is now on vacation on Thu 8 Jan. Refresh and try again.")


# --- Undo and history ---------------------------------------------------------


def _applied_swap(client: TestClient) -> Dict[str, Any]:
    _seed([NIGHT, BEN_CT])
    result, option = _swap_option(client)
    return _apply(client, _apply_body(result, option))


def test_undo_restores_the_exact_assignments(client):
    _seed([NIGHT, BEN_CT])
    before = _load_state(USER).assignments
    result, option = _swap_option(client)
    applied = _apply(client, _apply_body(result, option))
    response = client.post(f"/v1/swaps/{applied['swap']['id']}/undo",
                           json={"expectedRevision": applied["state"]["revision"]})
    assert response.status_code == 200, response.text
    swap, state = response.json()["swap"], response.json()["state"]
    assert _multiset(state["assignments"]) == _multiset(before) == _multiset(_load_state(USER).assignments)
    assert (swap["status"], swap["canUndo"], swap["undoBlockedReason"]) == ("reverted", False, None)
    assert swap["revertedAt"] == store.iso_utc(NOW)
    (row,) = _rows("swap_requests")
    assert (row["status"], row["reverted_by"], row["reverted_revision"]) == (
        "reverted", f"user:{USER}", state["revision"])
    changes = {r["kind"]: r for r in _rows("schedule_changes")}
    assert set(changes) == {"swap_applied", "swap_reverted"}
    assert row["revert_change_id"] == changes["swap_reverted"]["id"]
    assert json.loads(changes["swap_reverted"]["diff"])["swap_id"] == swap["id"]
    assert sorted(e["action"] for e in _rows("swap_events")) == ["applied", "reverted"]


def _undo(client: TestClient, swap_id: str, revision: str, status: int = 200) -> Dict[str, Any]:
    response = client.post(f"/v1/swaps/{swap_id}/undo", json={"expectedRevision": revision})
    assert response.status_code == status, response.text
    return response.json()


def _resolved(swap_id: str) -> List[Dict[str, Any]]:
    row = next(r for r in _rows("swap_requests") if r["id"] == swap_id)
    return json.loads(row["applied_patch"])["resolved"]


def test_undo_of_a_cover_brings_back_the_hidden_shift_it_removed(client):
    _seed([asg("anna-ct", "ct-thu", THU, "clin-anna")], clinicians=_anna_on_vacation_thu())
    before = _load_state(USER).assignments
    result = _search(client, {"mode": "cover", "slot": {"rowId": "ct-thu", "dateISO": THU}})
    applied = _apply(client, _apply_body(result, _option(result, "clin-ben|-")))
    # The hidden entry was a VACATION violation before the cover: undo may restore it.
    assert [(v["code"], v["clinician_id"]) for v in _resolved(applied["swap"]["id"])] == [
        ("VACATION", "clin-anna")]
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def test_undo_brings_back_a_weekly_overload_the_swap_eased_but_never_a_worse_one(client):
    ben_week = [asg(f"ben-{d}", f"ct-{d}", day, "clin-ben") for d, day in
                [("mon", MON), ("tue", TUE), ("wed", WED), ("thu", THU), ("fri", FRI), ("sat", SAT)]]
    _seed(ben_week)  # 48 h in week 2, limit 45 h
    before = _load_state(USER).assignments

    def hand_over_saturday() -> Dict[str, Any]:
        result = _find(client, ben_week[-1], "handover", partnerId="clin-anna")
        return _apply(client, _apply_body(result, _option(result, "clin-anna|-")))

    applied = hand_over_saturday()
    assert [(v["code"], v["context"]["assigned_minutes"]) for v in _resolved(applied["swap"]["id"])] == [
        ("WEEKLY_HOURS", 48 * 60)]
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)

    applied = hand_over_saturday()
    revision = _edit(lambda state: state.assignments.append(asg("ben-sun", "early-sun", SUN, "clin-ben")))
    detail = _error(_undo(client, applied["swap"]["id"], revision, 409), "swap_invalid")
    assert detail["reasons"] == ["Ben Ott: week 2 would reach 53.0 h (limit 45.0 h)."]
    # It is the undo, not the swap, that would break the rule.
    assert detail["message"] == ("Undoing this swap would break a planning rule: "
                                 "Ben Ott: week 2 would reach 53.0 h (limit 45.0 h).")


def test_undo_is_refused_after_a_conflicting_edit_twice_or_for_unknown_swaps(client):
    applied = _applied_swap(client)
    swap_id = applied["swap"]["id"]
    state = applied["state"]
    edited = {**state, "assignments": [a for a in state["assignments"] if a["rowId"] != "night-thu"]}
    saved = client.post("/v1/state", json=edited)
    assert saved.status_code == 200, saved.text
    revision = saved.json()["revision"]
    response = client.post(f"/v1/swaps/{swap_id}/undo", json={"expectedRevision": revision})
    assert response.status_code == 409
    assert _error(response.json(), "undo_conflict")["message"] == (
        "The shifts changed after the swap. Edit them in the plan.")
    history = client.get("/v1/swaps/history").json()["swaps"]
    assert (history[0]["canUndo"], history[0]["undoBlockedReason"]) == (False, "Not in the current plan.")

    response = client.post("/v1/swaps/swp-unknown/undo", json={"expectedRevision": revision})
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "swap_not_found", "message": "Swap not found."}


def test_a_second_undo_is_refused(client):
    applied = _applied_swap(client)
    url = f"/v1/swaps/{applied['swap']['id']}/undo"
    first = client.post(url, json={"expectedRevision": applied["state"]["revision"]})
    assert first.status_code == 200
    second = client.post(url, json={"expectedRevision": first.json()["state"]["revision"]})
    assert second.status_code == 409
    assert second.json()["detail"] == {"code": "already_reverted", "message": "This swap was already undone."}


def test_undo_of_a_started_swap_is_refused(client, monkeypatch):
    applied = _applied_swap(client)
    monkeypatch.setattr(policy, "utc_now", lambda: _utc("2026-01-08T19:30Z"))
    response = client.post(f"/v1/swaps/{applied['swap']['id']}/undo",
                           json={"expectedRevision": applied["state"]["revision"]})
    assert response.status_code == 409
    assert _error(response.json(), "swap_started")["message"] == (
        "A swapped shift has already started; change it in the plan instead.")
    history = client.get("/v1/swaps/history").json()["swaps"]
    assert (history[0]["canUndo"], history[0]["undoBlockedReason"]) == (False, "Already started.")


def _undo_refused(client: TestClient, swap_id: str, revision: str, reason: str, message: str) -> None:
    """History shows ``reason`` instead of Undo, and undo is refused with ``message``,
    changing nothing."""
    (record,) = [s for s in client.get("/v1/swaps/history").json()["swaps"] if s["id"] == swap_id]
    assert (record["canUndo"], record["undoBlockedReason"]) == (False, reason)
    before = _multiset(_load_state(USER).assignments)
    assert _error(_undo(client, swap_id, revision, 409), "undo_conflict")["message"] == message
    assert _multiset(_load_state(USER).assignments) == before
    assert [row["status"] for row in _rows("swap_requests") if row["id"] == swap_id] == ["applied"]


def _hand_over(client: TestClient, a: Assignment) -> Dict[str, Any]:
    result = _find(client, a, "handover", partnerId="clin-ben")
    return _apply(client, _apply_body(result, _option(result, "clin-ben|-")))


def _rest(assignment_id: str, date_iso: str, clinician_id: str) -> Assignment:
    return asg(assignment_id, "pool-rest-day", date_iso, clinician_id, locked=False)


@pytest.mark.parametrize("seeded, given, later, person_day", [
    # The hand-over removed Ben's Thursday Rest Day; then Ben got the Thursday night by hand.
    ([asg("anna-ct", "ct-thu", THU, "clin-anna"), _rest("ben-rest", THU, "clin-ben")], "anna-ct",
     asg("ben-night", "night-thu", THU, "clin-ben"), "Ben Ott a Rest Day and a shift on Thu 8 Jan"),
    # Anna's Friday Rest Day followed her night to Ben; then the free Anna got Friday's late shift.
    ([NIGHT, _rest("anna-rest", FRI, "clin-anna")], "anna-night",
     asg("anna-late", "late-fri", FRI, "clin-anna"), "Anna Weber a Rest Day and a shift on Fri 9 Jan"),
    # Anna handed over her Thursday CT; then Thursday became her Rest Day by hand.
    ([asg("anna-ct", "ct-thu", THU, "clin-anna")], "anna-ct", _rest("anna-rest", THU, "clin-anna"),
     "Anna Weber a Rest Day and a shift on Thu 8 Jan"),
], ids=["rest-day-back-onto-work", "rest-day-back-onto-work-of-the-giver", "shift-back-onto-rest-day"])
def test_undo_never_leaves_someone_resting_and_working_on_one_day(client, seeded: List[Assignment], given: str,
                                                                    later: Assignment, person_day: str):
    _seed(seeded)
    swap_id = _hand_over(client, next(a for a in seeded if a.id == given))["swap"]["id"]
    revision = _edit(lambda state: state.assignments.append(later))
    reason = f"Undo would give {person_day}."
    _undo_refused(client, swap_id, revision, reason, f"{reason} Edit them in the plan.")


def test_undo_after_a_cover_by_the_freed_giver_is_refused(client):
    # Only the assistant: Anna's night goes to Ben with her Friday Rest Day,
    # the now free Anna covers Friday's late shift, then the first swap is undone.
    _seed([NIGHT, _rest("anna-rest", FRI, "clin-anna")])
    first = _hand_over(client, NIGHT)["swap"]["id"]
    cover = _search(client, {"mode": "cover", "slot": {"rowId": "late-fri", "dateISO": FRI}})
    revision = _apply(client, _apply_body(cover, _option(cover, "clin-anna|-")))["state"]["revision"]
    reason = "Undo would give Anna Weber a Rest Day and a shift on Fri 9 Jan."
    _undo_refused(client, first, revision, reason, f"{reason} Edit them in the plan.")


def _rest_day_pairs(swap_id: str) -> List[tuple]:
    """The Rest Day and shift pairs the swap resolved: undo may bring them back."""
    return [(v["clinician_id"], v["date_iso"], v["slot_id"]) for v in _resolved(swap_id) if v["code"] == "REST_DAY"]


def test_undo_may_bring_back_a_rest_day_and_shift_that_were_there_before_the_swap(client):
    _seed([asg("anna-ct", "ct-thu", THU, "clin-anna"), _rest("anna-rest", THU, "clin-anna")])
    before = _load_state(USER).assignments
    applied = _hand_over(client, asg("anna-ct", "ct-thu", THU, "clin-anna"))
    assert _rest_day_pairs(applied["swap"]["id"]) == [("clin-anna", THU, "ct-thu")]
    assert applied["swap"]["canUndo"] is True
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def _ben_rests_on_a_thursday_he_works(client: TestClient) -> Dict[str, Any]:
    """Ben rests on Thursday but works its night, which already breaks
    REST_DAY; Anna hands him Thursday's early shift, which removes the Rest Day."""
    early = asg("anna-early", "early-thu", THU, "clin-anna")
    _seed([early, _rest("ben-rest", THU, "clin-ben"), asg("ben-night", "night-thu", THU, "clin-ben")],
          solver_settings={"preferContinuousShifts": False})
    return _hand_over(client, early)


def test_undo_brings_back_a_rest_day_the_swap_took_from_a_day_its_holder_worked(client):
    applied = _ben_rests_on_a_thursday_he_works(client)
    assert _rest_day_pairs(applied["swap"]["id"]) == [("clin-ben", THU, "night-thu")]
    (record,) = client.get("/v1/swaps/history").json()["swaps"]
    assert (record["canUndo"], record["undoBlockedReason"]) == (True, None)
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _held({"assignments": [a.model_dump() for a in _load_state(USER).assignments]}) == {
        ("early-thu", THU, "clin-anna"), ("pool-rest-day", THU, "clin-ben"), ("night-thu", THU, "clin-ben")}


def test_undo_refuses_a_new_rest_day_pair_on_a_day_that_had_one_before_the_swap(client):
    # Only the night was paired with Ben's Rest Day before the swap; the late
    # shift he got afterwards would be a new pair.
    applied = _ben_rests_on_a_thursday_he_works(client)
    revision = _edit(lambda state: state.assignments.append(asg("ben-late", "late-thu", THU, "clin-ben")))
    reason = "Undo would give Ben Ott a Rest Day and a shift on Thu 8 Jan."
    _undo_refused(client, applied["swap"]["id"], revision, reason, f"{reason} Edit them in the plan.")


def test_undo_refuses_a_rest_day_back_onto_a_shift_a_vacation_hides(client):
    # The hand-over removed Ben's Thursday Rest Day; then Ben got Thursday's
    # night and a vacation that day. The vacation hides the night on the grid,
    # but REST_DAY still counts it.
    ct = asg("anna-ct", "ct-thu", THU, "clin-anna")
    _seed([ct, _rest("ben-rest", THU, "clin-ben")])
    swap_id = _hand_over(client, ct)["swap"]["id"]

    def night_and_vacation(state: AppState) -> None:
        state.assignments.append(asg("ben-night", "night-thu", THU, "clin-ben"))
        next(c for c in state.clinicians if c.id == "clin-ben").vacations.append(
            VacationRange(id="v", startISO=THU, endISO=THU))

    revision = _edit(night_and_vacation)
    reason = "Undo would give Ben Ott a Rest Day and a shift on Thu 8 Jan."
    _undo_refused(client, swap_id, revision, reason, f"{reason} Edit them in the plan.")


ANNA_REST_TO_BEN = {"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben", "dateISO": FRI}


@pytest.mark.parametrize("ticked", [True, False], ids=["moved", "unticked-so-removed"])
def test_a_swap_that_frees_the_partners_rest_day_applies_and_undoes(client, ticked: bool):
    # Anna's Friday Rest Day follows her night to Ben, who gives her his late
    # Friday shift. Unticked, the Rest Day is removed instead: Anna now works that Friday.
    _seed([NIGHT, _rest("anna-rest", FRI, "clin-anna"), asg("ben-late", "late-fri", FRI, "clin-ben")])
    before = _load_state(USER).assignments
    result = _find(client, NIGHT, partnerId="clin-ben")
    option = _option(result, "clin-ben|late-fri@2026-01-09")
    assert (option["group"], option["restDayMoves"], option["restDayRemovals"]) == ("best", [ANNA_REST_TO_BEN], [])
    applied = _apply(client, _apply_body(result, option, restDayMoves=[ANNA_REST_TO_BEN] if ticked else []))
    held = {("night-thu", THU, "clin-ben"), ("late-fri", FRI, "clin-anna")}
    assert _held(applied["state"]) == (held | {("pool-rest-day", FRI, "clin-ben")} if ticked else held)
    assert applied["swap"]["restDaysRemoved"] == ([] if ticked else [
        {"clinicianId": "clin-anna", "name": "Anna Weber", "dateISO": FRI}])
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def test_a_handover_removes_every_duplicate_of_the_takers_rest_day_and_undo_restores_them(client):
    ct = asg("anna-ct", "ct-thu", THU, "clin-anna")
    _seed([ct, _rest("ben-rest", THU, "clin-ben"), _rest("ben-rest-twice", THU, "clin-ben")])
    before = _load_state(USER).assignments
    applied = _hand_over(client, ct)
    assert applied["swap"]["restDaysRemoved"] == [{"clinicianId": "clin-ben", "name": "Ben Ott", "dateISO": THU}]
    assert _held(applied["state"]) == {("ct-thu", THU, "clin-ben")}
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def test_a_handover_moves_every_duplicate_of_the_givers_rest_day_and_undo_restores_them(client):
    # Anna's Friday Rest Day is stored twice. It follows her night to Ben as
    # one Rest Day: Anna keeps none (the preview said it moves), and undo,
    # which refuses when a removed entry is back, works right away.
    _seed([NIGHT, _rest("anna-rest", FRI, "clin-anna"), _rest("anna-rest-twice", FRI, "clin-anna")])
    before = _load_state(USER).assignments
    applied = _hand_over(client, NIGHT)
    swap = applied["swap"]
    assert swap["restDayMoves"] == [{"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben", "dateISO": FRI}]
    assert _held(applied["state"]) == {("night-thu", THU, "clin-ben"), ("pool-rest-day", FRI, "clin-ben")}
    assert len(applied["state"]["assignments"]) == 2
    assert (swap["canUndo"], swap["undoBlockedReason"]) == (True, None)
    (record,) = client.get("/v1/swaps/history").json()["swaps"]
    assert (record["canUndo"], record["undoBlockedReason"]) == (True, None)
    _undo(client, swap["id"], applied["state"]["revision"])
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def test_a_shift_on_a_rest_day_the_swap_keeps_is_refused_with_a_readable_reason(client, monkeypatch):
    # The search and apply always remove the taker's Rest Day; without that
    # removal Ben would rest and work on Thursday.
    monkeypatch.setattr(matching, "rest_day_removals", lambda ctx, plan: [])
    ct = asg("anna-ct", "ct-thu", THU, "clin-anna")
    revision = _seed([ct, _rest("ben-rest", THU, "clin-ben")])
    result = _find(client, ct, "handover", partnerId="clin-ben")
    reason = "Rest Day: Ben Ott has a Rest Day on Thu 8 Jan."
    assert _option(result, "clin-ben|-")["reason"] == {"code": "rest_day", "message": reason}
    body = _crafted("handover", revision, give=_item_refs(result["target"]["unit"]))
    detail = _refused(client, body, 409, "swap_invalid", f"This swap breaks a planning rule: {reason}")
    assert detail["reasons"] == [reason]
    assert [v["code"] for v in detail["violations"]] == ["REST_DAY"]


def _remove_person(clinician_id: str) -> Callable[[AppState], None]:
    """What the page does when a person is deleted: they and all their shifts go."""
    def change(state: AppState) -> None:
        state.clinicians = [c for c in state.clinicians if c.id != clinician_id]
        state.assignments = [a for a in state.assignments if a.clinicianId != clinician_id]
    return change


@pytest.mark.parametrize("cover, deleted, name", [
    (False, "clin-anna", "Anna Weber"),  # the giver of a hand-over
    (False, "clin-ben", "Ben Ott"),  # the partner, with the shift they got
    (True, "clin-anna", "Anna Weber"),  # the hidden holder a cover removed
], ids=["giver", "partner", "hidden-holder"])
def test_a_swap_whose_person_was_deleted_cannot_be_undone(client, cover: bool, deleted: str, name: str):
    anna_ct = asg("anna-ct", "ct-thu", THU, "clin-anna")
    if cover:
        _seed([anna_ct], clinicians=_anna_on_vacation_thu())
        result = _search(client, {"mode": "cover", "slot": {"rowId": "ct-thu", "dateISO": THU}})
        swap_id = _apply(client, _apply_body(result, _option(result, "clin-ben|-")))["swap"]["id"]
    else:
        _seed([anna_ct])
        swap_id = _hand_over(client, anna_ct)["swap"]["id"]
    revision = _edit(_remove_person(deleted))
    _undo_refused(client, swap_id, revision, f"{name} is no longer in the plan.",
                  f"{name} is no longer in the plan. This swap can't be undone.")


def test_history_and_undo_follow_a_restored_snapshot(client):
    # Snapshots keep whole calendars; swap rows stay. Restoring the calendar
    # from before the swap leaves nothing to undo; restoring the one after it
    # brings the swap's shifts back, ids and all, and undo works again. The
    # backup before a shifts file import changes nothing here.
    def snapshot(name: str) -> str:
        response = client.post("/v1/state/snapshots", json={"name": name, "state": _load_state(USER).model_dump()})
        return response.json()["id"]

    def restore(snapshot_id: str) -> str:
        return client.post(f"/v1/state/snapshots/{snapshot_id}/restore", json={}).json()["revision"]

    _seed([NIGHT, BEN_CT])
    before = _load_state(USER).assignments
    pre_swap = snapshot("Before the swap")
    swap_id = _apply(client, _apply_body(*_swap_option(client)))["swap"]["id"]
    post_swap = snapshot("After the swap")
    assert client.post("/v1/state/snapshots/import-backup",
                       json={"state": _load_state(USER).model_dump()}).status_code == 201
    revision = restore(pre_swap)
    _undo_refused(client, swap_id, revision, "Not in the current plan.",
                  "The shifts changed after the swap. Edit them in the plan.")
    revision = restore(post_swap)
    (record,) = client.get("/v1/swaps/history").json()["swaps"]
    assert (record["canUndo"], record["undoBlockedReason"]) == (True, None)
    _undo(client, swap_id, revision)
    assert _multiset(_load_state(USER).assignments) == _multiset(before)


def test_history_is_newest_first_and_pages_by_keyset(client):
    days = [("mon", MON), ("tue", TUE), ("wed", WED)]
    _seed([asg(f"anna-{d}", f"ct-{d}", day, "clin-anna") for d, day in days])
    for d, day in days:
        a = asg(f"anna-{d}", f"ct-{d}", day, "clin-anna")
        result = _find(client, a, "handover", partnerId="clin-ben")
        _apply(client, _apply_body(result, _option(result, "clin-ben|-")))
    every = client.get("/v1/swaps/history").json()["swaps"]
    assert len(every) == 3
    assert {s["createdAt"] for s in every} == {store.iso_utc(NOW)}
    assert [s["id"] for s in every] == sorted((s["id"] for s in every), reverse=True)
    assert all(s["canUndo"] for s in every)

    first = client.get("/v1/swaps/history", params={"limit": 2}).json()["swaps"]
    assert first == every[:2]
    rest = client.get("/v1/swaps/history",
                      params={"before": first[1]["createdAt"], "beforeId": first[1]["id"]}).json()["swaps"]
    assert rest == every[2:]
    assert client.get("/v1/swaps/history", params={"before": first[1]["createdAt"]}).json()["swaps"] == []
    assert client.get("/v1/swaps/history", params={"limit": 0}).status_code == 422


def test_insert_swap_refuses_rows_without_partner_or_consent(client):
    with closing(db._get_connection()) as conn:
        for missing in ("partner_id", "consent"):
            row = {column: None for column in store.SWAP_COLUMNS}
            row.update(id="swp-x", username=USER, kind="swap", status="applied", partner_id="clin-ben",
                       consent="confirmed_by_planner")
            row[missing] = None
            with pytest.raises(ValueError):
                store.insert_swap(conn, row)


def test_deleting_the_account_removes_its_swap_rows(client):
    _applied_swap(client)
    with closing(db._get_connection()) as conn, conn:
        conn.execute("INSERT INTO swap_settings (username, data, updated_at) VALUES (?, ?, ?)",
                     (USER, json.dumps({"noticeHours": 24}), store.iso_utc(NOW)))
    assert [len(_rows(t)) for t in ("swap_requests", "swap_events", "swap_settings")] == [1, 1, 1]
    _delete_user(USER)
    assert [len(_rows(t)) for t in ("swap_requests", "swap_events", "swap_settings")] == [0, 0, 0]


def test_a_stored_run_after_a_swap_meets_the_changed_calendar(client):
    _seed([NIGHT, BEN_CT])
    solver_runs.create_run("run-1", USER, MON, MON, {"solver_mode": "agent", "only_fill_required": True},
                           input_fingerprint=planning_fingerprint(_load_state(USER)))
    solver_runs.finish_run("run-1", "finished", result={"startISO": MON, "endISO": MON, "assignments": [],
                                                        "notes": []})
    swapped = _apply(client, _apply_body(*_swap_option(client)))["state"]
    response = client.post("/v1/solve/runs/run-1/apply")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "calendar_changed"
    # The empty draft leaves Monday's slots open, so it also needs allow_partial.
    forced = client.post("/v1/solve/runs/run-1/apply", params={
        "force": True, "allow_partial": True, "expected_revision": swapped["revision"]})
    assert forced.status_code == 200, forced.text


# --- Accounts -----------------------------------------------------------------


def test_another_account_never_sees_or_undoes_a_swap(client):
    owner = app.dependency_overrides[_get_current_user]
    other = _create_user(OTHER, "swap-endpoint-password-2", "user")
    applied = _applied_swap(client)
    swap_id = applied["swap"]["id"]
    _save_state(make_swap_state([NIGHT, BEN_CT]), OTHER)
    other_revision = _load_state(OTHER).revision
    app.dependency_overrides[_get_current_user] = lambda: other
    try:
        assert client.get("/v1/swaps/history").json() == {"swaps": []}
        response = client.post(f"/v1/swaps/{swap_id}/undo", json={"expectedRevision": other_revision})
        assert response.status_code == 404
        assert response.json()["detail"] == {"code": "swap_not_found", "message": "Swap not found."}
        assert _load_state(OTHER).revision == other_revision
    finally:
        app.dependency_overrides[_get_current_user] = owner
    history = client.get("/v1/swaps/history").json()["swaps"]
    assert [(s["id"], s["status"], s["canUndo"]) for s in history] == [(swap_id, "applied", True)]
    assert [row["status"] for row in _rows("swap_requests")] == ["applied"]
    assert _undo(client, swap_id, applied["state"]["revision"])["swap"]["status"] == "reverted"


def test_the_store_reads_and_changes_only_the_callers_rows(client):
    swap_id = _applied_swap(client)["swap"]["id"]
    with closing(db._get_connection()) as conn, conn:
        assert store.get_swap(conn, OTHER, swap_id) is None
        assert store.get_swap(conn, USER, swap_id)["id"] == swap_id
        assert store.list_swaps(conn, OTHER, limit=50, before=None, before_id=None) == []
        assert [row["id"] for row in store.list_swaps(conn, USER, limit=50, before=None, before_id=None)] == [
            swap_id]
        store.mark_reverted(conn, OTHER, swap_id, reverted_at=store.iso_utc(NOW), reverted_by=f"user:{OTHER}",
                            revision="other-revision", change_id="other-change")
    (row,) = _rows("swap_requests")
    assert (row["status"], row["reverted_at"], row["reverted_by"], row["reverted_revision"]) == (
        "applied", None, None, None)


# --- Dates at the edge of the range -------------------------------------------


@pytest.mark.parametrize("path, body", [
    ("/v1/swaps/candidates", {"mode": "cover", "slot": {"rowId": "ct-fri", "dateISO": "9999-12-31"}}),
    ("/v1/swaps/candidates", {"mode": "cover", "slot": {"rowId": "ct-mon", "dateISO": "3000-01-06"}}),
    ("/v1/swaps/candidates", {"mode": "handover", "assignment": {
        "rowId": "ct-mon", "dateISO": "1899-12-25", "clinicianId": "clin-anna"}}),
    ("/v1/swaps/candidates", {"mode": "swap", "assignment": _ref(NIGHT), "range": "dates",
                              "dates": [FRI, "9999-12-31"]}),
    ("/v1/swaps/apply", {"mode": "cover", "slot": {"rowId": "night-fri", "dateISO": "9999-12-31", "fp": "x"},
                         "partnerId": "clin-ben", "expectedRevision": "r", "consent": True}),
    ("/v1/swaps/apply", {"mode": "handover", "give": [{"rowId": "ct-mon", "dateISO": "0001-01-01",
                                                       "clinicianId": "clin-anna", "fp": "x"}],
                         "partnerId": "clin-ben", "expectedRevision": "r", "consent": True}),
    ("/v1/swaps/apply", {"mode": "handover", "give": [{"rowId": "night-thu", "dateISO": THU,
                                                       "clinicianId": "clin-anna", "fp": "x"}],
                         "restDayMoves": [{"fromClinicianId": "clin-anna", "toClinicianId": "clin-ben",
                                           "dateISO": "3000-01-01"}],
                         "partnerId": "clin-ben", "expectedRevision": "r", "consent": True}),
], ids=["cover-last-day", "cover-year-3000", "before-1900", "picked-date", "apply-cover", "apply-give",
        "apply-rest-day-move"])
def test_request_dates_outside_1900_to_2999_are_refused(client, path: str, body: Dict[str, Any]):
    _seed([NIGHT, BEN_CT])
    response = client.post(path, json=body)
    assert response.status_code == 422, response.text
    assert "dates must lie between 1900-01-01 and 2999-12-31" in response.text
    assert _rows("swap_requests") == []


def test_the_first_and_last_day_of_the_range_are_accepted(client):
    _seed([])
    for day in ("1900-01-01", "2999-12-31"):
        response = client.post("/v1/swaps/candidates", json={"mode": "cover", "slot": {"rowId": "ct-mon",
                                                                                       "dateISO": day}})
        assert response.status_code == 200, response.text


def test_far_future_shifts_in_the_calendar_never_break_a_swap(client):
    # Saved by hand: Ben's night ends in year 10000; Dora's on-call rest days
    # run past 9999-12-31. Neither may stop a swap of this year.
    ct = asg("anna-ct", "ct-mon", "2026-01-12", "clin-anna")
    _seed([ct, asg("far-night", "night-fri", "9999-12-31", "clin-ben"),
           asg("far-call", "oncall-fri", "9999-12-31", "clin-dora")], solver_settings={"onCallRestDaysAfter": 3})
    assert {a.id for a in _load_state(USER).assignments} == {"anna-ct", "far-night", "far-call"}
    result = _find(client, ct, "handover")
    option = _option(result, "clin-ben|-")
    assert option["group"] == "best"
    applied = _apply(client, _apply_body(result, option))
    assert client.get("/v1/swaps/history").status_code == 200
    _undo(client, applied["swap"]["id"], applied["state"]["revision"])
    assert {(a.id, a.clinicianId) for a in _load_state(USER).assignments} == {
        ("anna-ct", "clin-anna"), ("far-night", "clin-ben"), ("far-call", "clin-dora")}
