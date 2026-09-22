"""Full-calendar regression cases for the repository review."""

from threading import Event
import time

import pytest

from backend.heuristic.solver_v2 import heuristic_solve_range_v2
from backend.models import Assignment, Holiday, SolveRangeRequest, UserPublic, VacationRange
from backend.solver import _solve_range_impl
from backend.validation import (
    VIOLATION_UNKNOWN_SLOT,
    validate_assignments,
    validate_references,
    validate_weekly_hours,
)
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot


def solve_cpsat(state, day):
    return _solve_range_impl(
        SolveRangeRequest(startISO=day, endISO=day, only_fill_required=True, timeout_seconds=5),
        UserPublic(username="review", role="admin", active=True),
        state_override=state,
    ).assignments


@pytest.mark.parametrize("offset", [2, 3])
def test_cpsat_respects_multiday_fixed_duty_before_range(offset):
    # A Monday duty is still running Wednesday/Thursday at 08:00.
    day = "2026-01-07" if offset == 2 else "2026-01-08"
    weekday = "wed" if offset == 2 else "thu"
    state = make_app_state(
        slots=[
            make_template_slot("long", end_time="12:00", end_day_offset=offset),
            make_template_slot("new", col_band_id=f"col-{weekday}-1"),
        ],
        assignments=[make_assignment("fixed", "long", "2026-01-05")],
    )
    added = solve_cpsat(state, day)
    assert added == []
    assert validate_assignments(state, state.assignments + added).is_valid


@pytest.mark.parametrize("fixed_day,target_day,fixed_weekday,target_weekday", [
    ("2026-01-05", "2026-01-09", "mon", "fri"),
    ("2026-01-11", "2026-01-05", "sun", "mon"),
])
def test_heuristic_counts_all_fixed_hours_in_target_iso_week(
    fixed_day, target_day, fixed_weekday, target_weekday
):
    clinician = make_clinician(working_hours_per_week=8)
    clinician.workingHoursToleranceHours = 0
    state = make_app_state(
        clinicians=[clinician],
        slots=[
            make_template_slot("fixed-slot", col_band_id=f"col-{fixed_weekday}-1"),
            make_template_slot("target-slot", col_band_id=f"col-{target_weekday}-1"),
        ],
        assignments=[make_assignment("fixed", "fixed-slot", fixed_day)],
    )
    result = heuristic_solve_range_v2(
        SolveRangeRequest(startISO=target_day, endISO=target_day, only_fill_required=True),
        state, Event(), lambda *_: None, time.time(),
    )
    added = [Assignment.model_validate(a) for a in result["assignments"]]
    assert not validate_weekly_hours(state, state.assignments + added)
    assert added == []


@pytest.mark.parametrize("day,holiday", [("2026-01-06", False), ("2026-01-05", True)])
def test_references_reject_slot_on_inactive_day_type(day, holiday):
    state = make_app_state()
    if holiday:
        state.holidays = [Holiday(dateISO=day, name="Holiday")]
    assignment = make_assignment("invalid", "slot-a__mon", day)
    violations = validate_references(state, [assignment])
    assert [v.code for v in violations] == [VIOLATION_UNKNOWN_SLOT]


@pytest.mark.parametrize("missing", ["block", "column", "section"])
def test_references_reject_unresolvable_slot(missing):
    state = make_app_state()
    if missing == "block":
        state.weeklyTemplate.blocks.clear()
    elif missing == "column":
        state.weeklyTemplate.locations[0].colBands.clear()
    else:
        state.rows = [r for r in state.rows if r.kind != "class"]
    violations = validate_references(
        state, [make_assignment("invalid", "slot-a__mon", "2026-01-05")]
    )
    assert [v.code for v in violations] == [VIOLATION_UNKNOWN_SLOT]


def test_cpsat_preexisting_manual_overlap_does_not_block_unrelated_work():
    state = make_app_state(
        clinicians=[make_clinician("a", "Alice"), make_clinician("b", "Bob")],
        slots=[make_template_slot("one"), make_template_slot("two")],
        assignments=[
            make_assignment("fixed-one", "one", "2026-01-05", "a"),
            make_assignment("fixed-two", "two", "2026-01-05", "a"),
        ],
    )
    state.weeklyTemplate.locations[0].slots[0].requiredSlots = 2
    added = solve_cpsat(state, "2026-01-05")
    assert [(a.clinicianId, a.rowId) for a in added] == [("b", "one")]


def test_cpsat_does_not_add_work_to_already_violated_on_call_rest_day():
    state = make_app_state(
        slots=[
            make_template_slot("call"),
            make_template_slot("morning", col_band_id="col-tue-1", end_time="12:00"),
            make_template_slot("afternoon", col_band_id="col-tue-1", start_time="12:00"),
        ],
        assignments=[
            make_assignment("fixed-call", "call", "2026-01-05"),
            make_assignment("fixed-morning", "morning", "2026-01-06"),
        ],
        solver_settings={"onCallRestEnabled": True, "onCallRestClassId": "section-a",
                         "onCallRestDaysBefore": 0, "onCallRestDaysAfter": 1},
    )
    assert solve_cpsat(state, "2026-01-06") == []


def test_cpsat_fixed_overnight_work_is_busy_even_if_start_day_is_vacation():
    clinician = make_clinician(vacations=[
        VacationRange(id="v", startISO="2026-01-05", endISO="2026-01-05"),
    ])
    state = make_app_state(
        clinicians=[clinician],
        slots=[
            make_template_slot("call", start_time="20:00", end_time="12:00", end_day_offset=1),
            make_template_slot("day", col_band_id="col-tue-1"),
        ],
        assignments=[make_assignment("fixed-call", "call", "2026-01-05")],
    )
    assert solve_cpsat(state, "2026-01-06") == []


def test_overlapping_vacation_ranges_do_not_change_hours_scoring():
    from backend.scoring import build_scoring_context, plan_stats
    clinician = make_clinician(working_hours_per_week=40)
    clinician.workingHoursToleranceHours = 0
    clinician.vacations = [VacationRange(id="v", startISO="2026-01-05", endISO="2026-01-06")]
    state = make_app_state(clinicians=[clinician])
    original = plan_stats(build_scoring_context(state, "2026-01-05", "2026-01-11"), [])
    clinician.vacations.append(VacationRange(id="v2", startISO="2026-01-06", endISO="2026-01-06"))
    overlapping = plan_stats(build_scoring_context(state, "2026-01-05", "2026-01-11"), [])
    assert original.working_hours_deviation_minutes == overlapping.working_hours_deviation_minutes


def test_overlapping_vacation_ranges_do_not_change_ytd_targets():
    from datetime import date
    from backend.heuristic.solver_v2 import ClinicianState
    from backend.solver import _build_slot_contexts_and_intervals, _compute_ytd_deficit_hours
    clinician = make_clinician(working_hours_per_week=40)
    clinician.vacations = [VacationRange(id="v", startISO="2026-01-05", endISO="2026-01-06")]
    state = make_app_state(clinicians=[clinician], assignments=[
        make_assignment("fixed", "slot-a__mon", "2026-01-12"),
    ])
    intervals = _build_slot_contexts_and_intervals(state)[-1]
    start = date(2026, 1, 19)
    expected = ClinicianState(clinician, start).ytd_expected
    deficit = _compute_ytd_deficit_hours(state, start, intervals)
    clinician.vacations.append(VacationRange(id="v2", startISO="2026-01-06", endISO="2026-01-06"))
    assert ClinicianState(clinician, start).ytd_expected == expected
    assert _compute_ytd_deficit_hours(state, start, intervals) == deficit


def test_cpsat_week_fallback_keeps_previous_week_as_fixed_context(monkeypatch):
    from ortools.sat.python import cp_model
    state = make_app_state(slots=[
        make_template_slot("night", col_band_id="col-sun-1", start_time="22:00",
                           end_time="12:00", end_day_offset=1),
        make_template_slot("day"),
    ])
    original_solve = cp_model.CpSolver.SolveWithSolutionCallback
    first_call = True

    def fail_full_range_once(self, model, callback):
        nonlocal first_call
        if first_call:
            first_call = False
            self.parameters.max_time_in_seconds = 0
        return original_solve(self, model, callback)

    monkeypatch.setattr(cp_model.CpSolver, "SolveWithSolutionCallback", fail_full_range_once)
    response = _solve_range_impl(
        SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-19", only_fill_required=True,
                          timeout_seconds=5),
        UserPublic(username="review", role="admin", active=True), state_override=state,
    )
    assert any("Week-by-week solving completed" in note for note in response.notes)
    assert response.assignments
    assert validate_assignments(state, response.assignments).is_valid
    assert state.assignments == []  # solving must not mutate saved input
