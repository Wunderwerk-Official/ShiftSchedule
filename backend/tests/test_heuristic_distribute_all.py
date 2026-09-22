"""Distribute-all adds bounded optional work only after mandatory coverage."""
from threading import Event
import time

import pytest

from backend.heuristic.solver_v2 import heuristic_solve_range_v2
from backend.models import Assignment, SolveRangeRequest
from backend.validation import validate_assignments
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot

MON = "2026-01-05"


def solve(state, *, required=False, start=MON, end=MON, cancel=None, progress=None, timeout=None):
    response = heuristic_solve_range_v2(
        SolveRangeRequest(startISO=start, endISO=end, only_fill_required=required, timeout_seconds=timeout),
        state, cancel or Event(), progress or (lambda *_: None), time.time(),
    )
    return [Assignment.model_validate(a) for a in response["assignments"]], response


@pytest.mark.parametrize("required,expected", [(True, 1), (False, 2)])
def test_distribute_all_adds_one_eligible_clinician_beyond_required_capacity(required, expected):
    state = make_app_state(clinicians=[make_clinician(cid, cid) for cid in ("a", "b", "c")])
    before = state.model_dump()
    added, _ = solve(state, required=required)
    assert len(added) == expected
    assert validate_assignments(state, added, only_fill_required=required).is_valid
    assert state.model_dump() == before


@pytest.mark.parametrize("override,expected", [(0, 0), (1, 2)])
def test_optional_capacity_uses_actual_target_and_never_opens_zero_target_slots(override, expected):
    state = make_app_state(
        clinicians=[make_clinician(cid, cid) for cid in ("a", "b", "c")],
        slots=[make_template_slot("zero-target", required_slots=0)],
    )
    state.slotOverridesByKey = {f"zero-target__{MON}": override}
    added, _ = solve(state)
    assert len(added) == expected
    assert validate_assignments(state, added, only_fill_required=False).is_valid


@pytest.mark.parametrize("locked", [False, True])
def test_existing_fixed_service_consumes_capacity_and_is_never_replanned(locked):
    fixed = make_assignment("fixed", "slot-a__mon", MON, "a")
    if locked:
        fixed.source, fixed.locked = "solver", True
    state = make_app_state(
        clinicians=[make_clinician(cid, cid) for cid in ("a", "b", "c")], assignments=[fixed],
    )
    before = state.model_dump()
    added, _ = solve(state)
    assert len(added) == 1 and added[0].clinicianId != "a"
    assert state.model_dump() == before
    assert validate_assignments(state, state.assignments + added, only_fill_required=False).is_valid


@pytest.mark.parametrize("fixed_day,target_day,target_weekday", [
    ("2026-01-05", "2026-01-09", "fri"),
    ("2025-12-29", "2026-01-04", "sun"),
])
def test_optional_work_counts_complete_iso_week_and_preserves_locked_services(fixed_day, target_day, target_weekday):
    clinicians = [make_clinician(cid, cid, working_hours_per_week=8) for cid in ("a", "b", "c")]
    for clinician in clinicians:
        clinician.workingHoursToleranceHours = 0
    fixed = make_assignment("target-fixed", "target", target_day, "b")
    fixed.source, fixed.locked = "solver", True
    state = make_app_state(
        clinicians=clinicians,
        slots=[make_template_slot("outside"), make_template_slot("target", col_band_id=f"col-{target_weekday}-1")],
        assignments=[make_assignment("outside-fixed", "outside", fixed_day, "a"), fixed],
    )
    before = state.model_dump()
    added, _ = solve(state, start=target_day, end=target_day)
    assert [(a.clinicianId, a.rowId) for a in added] == [("c", "target")]
    assert state.model_dump() == before
    assert validate_assignments(state, state.assignments + added, only_fill_required=False).is_valid


def test_optional_work_cannot_take_clinician_needed_by_later_required_on_call():
    state = make_app_state(
        clinicians=[make_clinician(cid, cid) for cid in ("a", "b")],
        slots=[make_template_slot("monday"), make_template_slot("tuesday", col_band_id="col-tue-1")],
        solver_settings={"onCallRestEnabled": True, "onCallRestClassId": "section-a",
                         "onCallRestDaysBefore": 0, "onCallRestDaysAfter": 1},
    )
    added, _ = solve(state, end="2026-01-06")
    assert sorted(a.rowId for a in added) == ["monday", "tuesday"]
    assert validate_assignments(state, added, only_fill_required=False).is_valid


@pytest.mark.parametrize("stop", ["cancel", "deadline"])
def test_optional_phase_obeys_interruption_and_retains_required_draft(monkeypatch, stop):
    import backend.planning_deadline as planning_deadline
    clock = [0.0]
    monkeypatch.setattr(planning_deadline.time, "monotonic", lambda: clock[0])
    cancel = Event()
    optional_started = []

    def on_progress(event, data):
        if event == "phase" and data.get("phase") == "distribute_extra":
            optional_started.append(True)
            if stop == "cancel":
                cancel.set()
            else:
                clock[0] = 10.0

    state = make_app_state(clinicians=[make_clinician(cid, cid) for cid in ("a", "b", "c")])
    added, response = solve(state, cancel=cancel, progress=on_progress, timeout=5)
    assert optional_started
    assert len(added) == 1
    assert response["debugInfo"]["solver_status"] == "ABORTED"
