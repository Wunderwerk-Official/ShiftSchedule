"""The swap endpoints against a temporary database: candidates, apply, undo and
history, with the clock fixed through policy.utc_now."""

import json
import re
import sqlite3
from collections import Counter
from contextlib import closing
from datetime import datetime
from typing import Any, Callable, Dict, List

import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.swaps.apply as swap_apply
from backend import solver_runs
from backend.auth import _create_user, _delete_user, _get_current_user
from backend.main import app
from backend.models import AppState, Assignment, VacationRange
from backend.run_apply import planning_fingerprint
from backend.state import _load_state, _normalize_state, _save_state
from backend.swaps import policy, store

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
    # Anna's lost hours are one note on the target, so the option stays a best match.
    assert result["targetFindings"] == [{"code": "giver_below_contract", "clinicianId": "clin-anna",
                                         "message": "Anna Weber: week 2 drops to 0.0 h (contract 40 h).",
                                         "short": "−40 h under contract"}]
    assert (option["group"], option["findings"]) == ("best", [])

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
