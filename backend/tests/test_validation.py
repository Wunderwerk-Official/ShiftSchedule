"""Unit tests for backend.validation.

These tests intentionally go through the conftest factories (``make_app_state``,
``make_clinician``, etc.) so the validator is exercised against the same
shapes the solver tests use. Every test is independent of CP-SAT / OR-Tools.
"""

from __future__ import annotations

import pytest

from backend.models import (
    AppState,
    Assignment,
    Holiday,
    Location,
    PreferredWorkingTime,
    SolverSettings,
    TemplateBlock,
    TemplateRowBand,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
)
from backend.validation import (
    VIOLATION_CAPACITY,
    VIOLATION_MANDATORY_WINDOW,
    VIOLATION_ON_CALL_REST,
    VIOLATION_OVERLAP,
    VIOLATION_QUALIFICATION,
    VIOLATION_REST_DAY,
    VIOLATION_SAME_LOCATION,
    VIOLATION_SOLVER_RULE,
    VIOLATION_SPLIT_SHIFT,
    VIOLATION_UNKNOWN_CLINICIAN,
    VIOLATION_UNKNOWN_SLOT,
    VIOLATION_VACATION,
    VIOLATION_WEEKLY_HOURS,
    validate_assignments,
    validate_capacity,
    validate_mandatory_windows,
    validate_on_call_rest,
    validate_overlaps,
    validate_qualifications,
    validate_references,
    validate_rest_days,
    validate_same_location_per_day,
    validate_solver_rules,
    validate_split_shifts,
    validate_vacations,
    validate_weekly_hours,
)

from .conftest import (
    make_app_state,
    make_assignment,
    make_clinician,
    make_location,
    make_pool_row,
    make_template_col_band,
    make_template_slot,
    make_workplace_row,
)

DAY_TYPES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday")


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_valid_schedule_has_no_violations():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", qualified_class_ids=["section-a"])],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    report = validate_assignments(state, state.assignments)
    assert report.is_valid
    assert report.violations == []


def test_empty_assignment_list_is_valid():
    state = make_app_state()
    report = validate_assignments(state, [])
    assert report.is_valid


def test_repeated_validation_reads_changed_holidays_and_template_times():
    state = make_app_state()
    assignments = [make_assignment("a", "slot-a__mon", "2026-01-05", "clin-1"),
                   make_assignment("b", "slot-a__mon", "2026-01-05", "clin-1")]
    assert validate_capacity(state, assignments, only_fill_required=True)
    state.holidays.append(Holiday(dateISO="2026-01-05", name="new holiday"))
    assert not validate_capacity(state, assignments, only_fill_required=True)
    state.holidays.clear()
    assert validate_capacity(state, assignments, only_fill_required=True)
    state.clinicians[0].preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="08:00", endTime="12:00", requirement="mandatory")}
    assert validate_mandatory_windows(state, assignments)
    state.weeklyTemplate.locations[0].slots[0].endTime = "12:00"
    assert not validate_mandatory_windows(state, assignments)
    state.clinicians[0].preferredWorkingTimes["mon"].endTime = "11:00"
    assert validate_mandatory_windows(state, assignments)


def test_work_windows_do_not_leak_between_people_or_separate_states():
    clinicians = [make_clinician("a", "Alice"), make_clinician("b", "Bob")]
    clinicians[0].preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="08:00", endTime="12:00", requirement="mandatory")}
    state = make_app_state(clinicians=clinicians)
    assignments = [make_assignment(cid, "slot-a__mon", "2026-01-05", cid) for cid in ("a", "b")]
    assert [v.clinician_id for v in validate_mandatory_windows(state, assignments)] == ["a"]
    other = state.model_copy(deep=True)
    other.clinicians[1].preferredWorkingTimes = other.clinicians[0].preferredWorkingTimes
    other.clinicians[0].preferredWorkingTimes = {}
    assert [v.clinician_id for v in validate_mandatory_windows(other, assignments)] == ["b"]
    assert [v.clinician_id for v in validate_mandatory_windows(state, assignments)] == ["a"]


# ---------------------------------------------------------------------------
# Qualification
# ---------------------------------------------------------------------------


def test_qualification_violation_when_section_not_in_qualified_list():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", qualified_class_ids=["section-b"])
        ],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    violations = validate_qualifications(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_QUALIFICATION
    assert violations[0].clinician_id == "clin-1"
    assert violations[0].context["section_id"] == "section-a"


def test_qualification_ok_when_section_matches():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", qualified_class_ids=["section-a", "section-c"])
        ],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    assert validate_qualifications(state, state.assignments) == []


def test_qualification_skips_pool_assignments():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", qualified_class_ids=[])],
        assignments=[
            make_assignment("a1", "pool-vacation", "2026-01-05", "clin-1"),
            make_assignment("a2", "pool-rest-day", "2026-01-05", "clin-1"),
        ],
    )
    assert validate_qualifications(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Vacation
# ---------------------------------------------------------------------------


def test_vacation_violation_when_clinician_on_vacation():
    clinician = make_clinician(
        "clin-1",
        "Alice",
        vacations=[VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-09")],
    )
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    violations = validate_vacations(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_VACATION


def test_vacation_boundaries_are_inclusive():
    clinician = make_clinician(
        "clin-1",
        "Alice",
        vacations=[VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-05")],
    )
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    assert len(validate_vacations(state, state.assignments)) == 1


def test_vacation_ignored_for_pool_rows():
    clinician = make_clinician(
        "clin-1",
        "Alice",
        vacations=[VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-09")],
    )
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "pool-vacation", "2026-01-05", "clin-1")],
    )
    assert validate_vacations(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Rest Day row (v1.75)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rest_source", ["manual", "solver", None])
@pytest.mark.parametrize("slot_source", ["manual", "solver"])
def test_rest_day_violation_for_slot_on_stored_rest_day(rest_source, slot_source):
    state = make_app_state(
        assignments=[
            make_assignment("rest", "pool-rest-day", "2026-01-05", "clin-1", rest_source),
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1", slot_source),
        ],
    )
    violations = validate_rest_days(state, state.assignments)
    assert [(v.code, v.clinician_id, v.date_iso, v.slot_id) for v in violations] == [
        (VIOLATION_REST_DAY, "clin-1", "2026-01-05", "slot-a__mon")
    ]
    assert violations[0].message == (
        "Dr. Alice has a rest day on 2026-01-05 but is assigned to slot slot-a__mon"
    )
    report = validate_assignments(state, state.assignments)
    assert [v.code for v in report.violations] == [VIOLATION_REST_DAY]


def test_rest_day_is_read_from_state_and_from_the_checked_list():
    rest = make_assignment("rest", "pool-rest-day", "2026-01-05", "clin-1", "manual")
    slot = make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1", "solver")
    in_state = make_app_state(assignments=[rest])
    # The candidate list alone (as the agent's dry runs pass it) is enough.
    assert [v.code for v in validate_rest_days(in_state, [slot])] == [VIOLATION_REST_DAY]
    in_list = make_app_state(assignments=[])
    assert [v.code for v in validate_rest_days(in_list, [rest, slot])] == [VIOLATION_REST_DAY]


def test_rest_day_only_blocks_its_own_date_and_person():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        slots=[
            make_template_slot("slot-a__mon", col_band_id="col-mon-1", required_slots=2),
            make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
        ],
        assignments=[
            make_assignment("rest", "pool-rest-day", "2026-01-05", "clin-1", "manual"),
            make_assignment("a1", "slot-a__tue", "2026-01-06", "clin-1", "solver"),
            make_assignment("a2", "slot-a__mon", "2026-01-05", "clin-2", "solver"),
        ],
    )
    assert validate_rest_days(state, state.assignments) == []
    assert validate_assignments(state, state.assignments).is_valid


def test_rest_day_follows_vacation_date_semantics_for_overnight_shifts():
    # A shift counts on its start date: a night shift starting the evening
    # before the rest day is allowed, exactly like vacation.
    state = make_app_state(
        slots=[make_template_slot("night", col_band_id="col-mon-1",
                                  start_time="20:00", end_time="08:00", end_day_offset=1)],
        assignments=[
            make_assignment("rest", "pool-rest-day", "2026-01-06", "clin-1", "manual"),
            make_assignment("n1", "night", "2026-01-05", "clin-1", "solver"),
        ],
    )
    assert validate_rest_days(state, state.assignments) == []
    vacation_state = make_app_state(
        clinicians=[make_clinician("clin-1", "Dr. Alice", vacations=[
            VacationRange(id="v1", startISO="2026-01-06", endISO="2026-01-06")])],
        slots=state.weeklyTemplate.locations[0].slots,
        assignments=[make_assignment("n1", "night", "2026-01-05", "clin-1", "solver")],
    )
    assert validate_vacations(vacation_state, vacation_state.assignments) == []


def test_rest_day_ignores_pool_rows_and_legacy_vacation_entries():
    state = make_app_state(
        assignments=[
            make_assignment("rest", "pool-rest-day", "2026-01-05", "clin-1", "manual"),
            make_assignment("vac", "pool-vacation", "2026-01-05", "clin-1", "manual"),
            # A stored Vacation row entry is legacy: it neither marks a rest
            # day nor a vacation for the planners.
            make_assignment("legacy", "pool-vacation", "2026-01-06", "clin-1", "manual"),
        ],
    )
    assert validate_rest_days(state, state.assignments) == []
    tuesday = make_assignment("a1", "slot-a__mon", "2026-01-06", "clin-1", "solver")
    assert validate_rest_days(state, [tuesday]) == []
    assert validate_vacations(state, [tuesday]) == []


# ---------------------------------------------------------------------------
# Overlap
# ---------------------------------------------------------------------------


def test_overlap_detected_same_day():
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    slots = [
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-lunch", col_band_id="col-mon-1",
                           start_time="11:00", end_time="15:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        col_bands=col_bands,
        slots=slots,
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-lunch", "2026-01-05", "clin-1"),
        ],
    )
    violations = validate_overlaps(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_OVERLAP


def test_overlap_not_detected_when_adjacent_but_not_overlapping():
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    slots = [
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-afternoon", col_band_id="col-mon-1",
                           start_time="12:00", end_time="16:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        col_bands=col_bands,
        slots=slots,
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-afternoon", "2026-01-05", "clin-1"),
        ],
    )
    assert validate_overlaps(state, state.assignments) == []


def test_overlap_detects_overnight_slot_crossing_into_next_day():
    """22:00-06:00 Monday must conflict with 00:00-08:00 Tuesday."""
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    slots = [
        make_template_slot("slot-night-mon", col_band_id="col-mon-1",
                           start_time="22:00", end_time="06:00", end_day_offset=1),
        make_template_slot("slot-morning-tue", col_band_id="col-tue-1",
                           start_time="00:00", end_time="08:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        col_bands=col_bands,
        slots=slots,
        assignments=[
            make_assignment("a1", "slot-night-mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-morning-tue", "2026-01-06", "clin-1"),
        ],
    )
    violations = validate_overlaps(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_OVERLAP


def test_overlap_different_clinicians_is_not_a_conflict():
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    slots = [
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-lunch", col_band_id="col-mon-1",
                           start_time="11:00", end_time="15:00"),
    ]
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice"),
            make_clinician("clin-2", "Bob"),
        ],
        col_bands=col_bands,
        slots=slots,
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-lunch", "2026-01-05", "clin-2"),
        ],
    )
    assert validate_overlaps(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Same-location-per-day
# ---------------------------------------------------------------------------


def _make_two_location_state(enforce: bool) -> AppState:
    """Factory: state with one clinician assigned to two locations on the same day.

    The default ``make_app_state`` only creates a single ``WeeklyTemplateLocation``
    and uses THAT location's id for every slot underneath (matching the solver's
    behaviour — see ``_build_slot_contexts`` in solver.py). So to exercise the
    multi-location rule we have to build the template by hand with two locations.
    """
    berlin_slot = make_template_slot(
        "slot-berlin", location_id="loc-berlin",
        col_band_id="col-mon-1", start_time="08:00", end_time="12:00",
    )
    munich_slot = make_template_slot(
        "slot-munich", location_id="loc-munich",
        col_band_id="col-mon-1", start_time="13:00", end_time="17:00",
    )
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id="block-a", sectionId="section-a", requiredSlots=0)],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-berlin",
                rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                colBands=col_bands,
                slots=[berlin_slot],
            ),
            WeeklyTemplateLocation(
                locationId="loc-munich",
                rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                colBands=col_bands,
                slots=[munich_slot],
            ),
        ],
    )
    return AppState(
        locations=[Location(id="loc-berlin", name="Berlin"), Location(id="loc-munich", name="Munich")],
        locationsEnabled=True,
        rows=[make_workplace_row(), make_pool_row("pool-rest-day", "Rest Day"),
              make_pool_row("pool-vacation", "Vacation")],
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[
            make_assignment("a1", "slot-berlin", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-munich", "2026-01-05", "clin-1"),
        ],
        minSlotsByRowId={},
        slotOverridesByKey={},
        weeklyTemplate=template,
        holidays=[],
        solverSettings={
            "enforceSameLocationPerDay": enforce,
            "onCallRestEnabled": False,
            "workingHoursToleranceHours": 5,
        },
        solverRules=[],
        publishedWeekStartISOs=[],
    )


def test_same_location_violation_when_enabled():
    state = _make_two_location_state(enforce=True)
    violations = validate_same_location_per_day(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_SAME_LOCATION
    assert violations[0].context["locations"] == ["loc-berlin", "loc-munich"]


def test_same_location_ok_when_setting_disabled():
    state = _make_two_location_state(enforce=False)
    assert validate_same_location_per_day(state, state.assignments) == []


# ---------------------------------------------------------------------------
# On-call rest
# ---------------------------------------------------------------------------


def test_on_call_rest_before_and_after_violations():
    col_bands = [make_template_col_band(f"col-{d}-1", "", 1, d) for d in DAY_TYPES]
    slots = [
        make_template_slot(
            f"slot-{d}-regular",
            col_band_id=f"col-{d}-1",
            block_id="block-a",
            start_time="08:00",
            end_time="16:00",
        )
        for d in DAY_TYPES
    ]
    slots.append(
        make_template_slot(
            "slot-tue-oncall",
            col_band_id="col-tue-1",
            block_id="block-oncall",
            start_time="18:00",
            end_time="08:00",
            end_day_offset=1,
        )
    )
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", qualified_class_ids=["section-a", "oncall-section"])],
        col_bands=col_bands,
        slots=slots,
        solver_settings={
            "onCallRestEnabled": True,
            "onCallRestClassId": "oncall-section",
            "onCallRestDaysBefore": 1,
            "onCallRestDaysAfter": 1,
            "enforceSameLocationPerDay": False,
        },
        assignments=[
            # Regular shift the day before (must be blocked)
            make_assignment("a1", "slot-mon-regular", "2026-01-05", "clin-1"),
            # On-call on Tue
            make_assignment("a2", "slot-tue-oncall", "2026-01-06", "clin-1"),
            # Regular shift the day after (must be blocked)
            make_assignment("a3", "slot-wed-regular", "2026-01-07", "clin-1"),
        ],
    )
    # Patch the template to know about oncall-section
    state.weeklyTemplate.blocks.append(
        type(state.weeklyTemplate.blocks[0])(
            id="block-oncall", sectionId="oncall-section", requiredSlots=0
        )
    )
    violations = validate_on_call_rest(state, state.assignments)
    codes = {v.context.get("direction") for v in violations}
    assert all(v.code == VIOLATION_ON_CALL_REST for v in violations)
    assert codes == {"before", "after"}


def test_on_call_rest_disabled_skips_check():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        solver_settings={"onCallRestEnabled": False},
    )
    assert validate_on_call_rest(state, []) == []


# ---------------------------------------------------------------------------
# Reference integrity
# ---------------------------------------------------------------------------


def test_unknown_clinician_reported():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "missing-clin")],
    )
    violations = validate_references(state, state.assignments)
    codes = [v.code for v in violations]
    assert VIOLATION_UNKNOWN_CLINICIAN in codes


def test_unknown_slot_reported():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("a1", "nonexistent-slot", "2026-01-05", "clin-1")],
    )
    violations = validate_references(state, state.assignments)
    codes = [v.code for v in violations]
    assert VIOLATION_UNKNOWN_SLOT in codes


def test_unknown_references_skipped_when_flag_set():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("a1", "missing-slot", "2026-01-05", "missing-clin")],
    )
    report = validate_assignments(state, state.assignments, skip_references=True)
    codes = {v.code for v in report.violations}
    assert VIOLATION_UNKNOWN_CLINICIAN not in codes
    assert VIOLATION_UNKNOWN_SLOT not in codes


# ---------------------------------------------------------------------------
# Aggregate entry point
# ---------------------------------------------------------------------------


def test_aggregate_reports_multiple_codes_at_once():
    # ``qualified_class_ids=["section-b"]`` (not the slot's section) forces a
    # qualification violation. We can't use ``[]`` because the conftest factory
    # treats an empty list as "use default" via ``or``.
    clinician = make_clinician(
        "clin-1",
        "Alice",
        qualified_class_ids=["section-b"],
        vacations=[VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-05")],
    )
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    report = validate_assignments(state, state.assignments)
    codes = {v.code for v in report.violations}
    assert VIOLATION_QUALIFICATION in codes
    assert VIOLATION_VACATION in codes
    assert not report.is_valid


def test_by_code_groups_violations():
    clinician = make_clinician("clin-1", "Alice", qualified_class_ids=["section-b"])
    state = make_app_state(
        clinicians=[clinician],
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
        ],
    )
    report = validate_assignments(state, state.assignments)
    grouped = report.by_code()
    assert VIOLATION_QUALIFICATION in grouped
    assert len(grouped[VIOLATION_QUALIFICATION]) == 1


# ---------------------------------------------------------------------------
# Mandatory working windows
# ---------------------------------------------------------------------------


def test_mandatory_window_violation_when_slot_outside_window():
    clinician = make_clinician("clin-1", "Alice")
    clinician.preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="08:00", endTime="12:00", requirement="mandatory")
    }
    state = make_app_state(
        clinicians=[clinician],
        # default slot-a__mon is 08:00-16:00 — extends past the 12:00 window end
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    violations = validate_mandatory_windows(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_MANDATORY_WINDOW
    assert violations[0].context["window_end"] == 12 * 60


def test_mandatory_window_ok_when_slot_fits():
    clinician = make_clinician("clin-1", "Alice")
    clinician.preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="06:00", endTime="18:00", requirement="mandatory")
    }
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    assert validate_mandatory_windows(state, state.assignments) == []


def test_mandatory_window_preference_requirement_is_soft_and_ignored():
    clinician = make_clinician("clin-1", "Alice")
    clinician.preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="08:00", endTime="12:00", requirement="preference")
    }
    state = make_app_state(
        clinicians=[clinician],
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    assert validate_mandatory_windows(state, state.assignments) == []


def test_mandatory_window_only_applies_to_matching_weekday():
    clinician = make_clinician("clin-1", "Alice")
    clinician.preferredWorkingTimes = {
        "tue": PreferredWorkingTime(startTime="08:00", endTime="12:00", requirement="mandatory")
    }
    state = make_app_state(
        clinicians=[clinician],
        # Assignment is on Monday; the mandatory window is for Tuesday
        assignments=[make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1")],
    )
    assert validate_mandatory_windows(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Weekly hours cap
# ---------------------------------------------------------------------------


def _three_day_slots():
    return [
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
        make_template_slot("slot-a__wed", col_band_id="col-wed-1"),
    ]


def test_weekly_hours_violation_when_cap_exceeded():
    # 8h contract + 5h default tolerance = 13h cap; three 8h shifts = 24h
    clinician = make_clinician("clin-1", "Alice", working_hours_per_week=8.0)
    state = make_app_state(
        clinicians=[clinician],
        slots=_three_day_slots(),
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__tue", "2026-01-06", "clin-1"),
            make_assignment("a3", "slot-a__wed", "2026-01-07", "clin-1"),
        ],
    )
    violations = validate_weekly_hours(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_WEEKLY_HOURS
    assert violations[0].clinician_id == "clin-1"
    assert violations[0].context["assigned_minutes"] == 24 * 60
    assert violations[0].context["max_minutes"] == 13 * 60


def test_weekly_hours_ok_within_cap():
    # 40h contract + 5h tolerance; three 8h shifts = 24h — fine
    clinician = make_clinician("clin-1", "Alice", working_hours_per_week=40.0)
    state = make_app_state(
        clinicians=[clinician],
        slots=_three_day_slots(),
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__tue", "2026-01-06", "clin-1"),
            make_assignment("a3", "slot-a__wed", "2026-01-07", "clin-1"),
        ],
    )
    assert validate_weekly_hours(state, state.assignments) == []


def test_weekly_hours_skips_clinicians_without_contract():
    clinician = make_clinician("clin-1", "Alice", working_hours_per_week=None)
    state = make_app_state(
        clinicians=[clinician],
        slots=_three_day_slots(),
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__tue", "2026-01-06", "clin-1"),
            make_assignment("a3", "slot-a__wed", "2026-01-07", "clin-1"),
        ],
    )
    assert validate_weekly_hours(state, state.assignments) == []


def test_weekly_hours_counts_per_iso_week_separately():
    # Two 8h shifts in DIFFERENT ISO weeks each stay under the 13h cap
    clinician = make_clinician("clin-1", "Alice", working_hours_per_week=8.0)
    state = make_app_state(
        clinicians=[clinician],
        slots=_three_day_slots(),
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__mon", "2026-01-12", "clin-1"),
        ],
    )
    assert validate_weekly_hours(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Split shifts (continuity)
# ---------------------------------------------------------------------------


def _gap_slots():
    return [
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-late", col_band_id="col-mon-1",
                           start_time="13:00", end_time="17:00"),
        make_template_slot("slot-noon", col_band_id="col-mon-1",
                           start_time="12:00", end_time="13:00"),
    ]


def test_split_shift_violation_on_gap():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=_gap_slots(),
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-late", "2026-01-05", "clin-1"),
        ],
    )
    violations = validate_split_shifts(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_SPLIT_SHIFT
    assert violations[0].context["blocks"] == 2


def test_split_shift_ok_when_slots_adjacent():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=_gap_slots(),
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-noon", "2026-01-05", "clin-1"),
            make_assignment("a3", "slot-late", "2026-01-05", "clin-1"),
        ],
    )
    assert validate_split_shifts(state, state.assignments) == []


def test_split_shift_ignored_when_setting_disabled():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=_gap_slots(),
        solver_settings={"preferContinuousShifts": False},
        assignments=[
            make_assignment("a1", "slot-morning", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-late", "2026-01-05", "clin-1"),
        ],
    )
    assert validate_split_shifts(state, state.assignments) == []


# ---------------------------------------------------------------------------
# Capacity
# ---------------------------------------------------------------------------


def test_capacity_violation_in_only_fill_required_mode():
    # Default slot has requiredSlots=1; two assignments exceed it
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__mon", "2026-01-05", "clin-2"),
        ],
    )
    violations = validate_capacity(state, state.assignments, only_fill_required=True)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_CAPACITY
    assert violations[0].context == {"count": 2, "capacity": 1, "target": 1}


def test_capacity_distribute_all_allows_extra_assignment():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__mon", "2026-01-05", "clin-2"),
        ],
    )
    # target 1 + distribute-all extra 1 = capacity 2
    assert validate_capacity(state, state.assignments, only_fill_required=False) == []


def test_capacity_respects_slot_overrides():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-a__mon", "2026-01-05", "clin-2"),
        ],
    )
    state.slotOverridesByKey = {"slot-a__mon__2026-01-05": 1}
    # target 1 + override 1 = 2 — two assignments fit even in only-fill-required
    assert validate_capacity(state, state.assignments, only_fill_required=True) == []


def test_capacity_skips_instances_on_non_matching_day_type():
    # slot-a__mon targets Mondays; an assignment on Tuesday is not a capacity
    # concern (the solver never creates such instances)
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        assignments=[
            make_assignment("a1", "slot-a__mon", "2026-01-06", "clin-1"),
            make_assignment("a2", "slot-a__mon", "2026-01-06", "clin-2"),
        ],
    )
    assert validate_capacity(state, state.assignments, only_fill_required=True) == []


# ---------------------------------------------------------------------------
# Solver rules (soft, separate from validate_assignments)
# ---------------------------------------------------------------------------


def _rule_state(then_type: str, then_shift_row_id=None, enabled=True, assignments=None):
    slots = [
        make_template_slot("slot-night", col_band_id="col-mon-1",
                           start_time="20:00", end_time="06:00", end_day_offset=1),
        make_template_slot("slot-day-tue", col_band_id="col-tue-1"),
        make_template_slot("slot-alt-tue", col_band_id="col-tue-1",
                           start_time="10:00", end_time="18:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=slots,
        assignments=assignments or [],
    )
    state.solverRules = [
        {
            "id": "rule-1",
            "name": "After night shift",
            "enabled": enabled,
            "ifShiftRowId": "slot-night",
            "dayDelta": 1,
            "thenType": then_type,
            "thenShiftRowId": then_shift_row_id,
        }
    ]
    return state


def test_solver_rule_off_violation():
    state = _rule_state(
        "off",
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-day-tue", "2026-01-06", "clin-1"),
        ],
    )
    violations = validate_solver_rules(state, state.assignments)
    assert len(violations) == 1
    assert violations[0].code == VIOLATION_SOLVER_RULE
    assert violations[0].date_iso == "2026-01-06"


def test_solver_rule_off_satisfied_by_free_day_and_pool_rows():
    state = _rule_state(
        "off",
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            # Pool rows (rest day) do not count as work
            make_assignment("a2", "pool-rest-day", "2026-01-06", "clin-1"),
        ],
    )
    assert validate_solver_rules(state, state.assignments) == []


def test_solver_rule_shift_row_violation_and_satisfaction():
    violating = _rule_state(
        "shiftRow",
        then_shift_row_id="slot-day-tue",
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-alt-tue", "2026-01-06", "clin-1"),
        ],
    )
    violations = validate_solver_rules(violating, violating.assignments)
    assert len(violations) == 1
    assert violations[0].slot_id == "slot-day-tue"

    satisfied = _rule_state(
        "shiftRow",
        then_shift_row_id="slot-day-tue",
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-day-tue", "2026-01-06", "clin-1"),
        ],
    )
    assert validate_solver_rules(satisfied, satisfied.assignments) == []


def test_solver_rule_disabled_is_ignored():
    state = _rule_state(
        "off",
        enabled=False,
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-day-tue", "2026-01-06", "clin-1"),
        ],
    )
    assert validate_solver_rules(state, state.assignments) == []


def test_solver_rules_not_part_of_aggregate_report():
    state = _rule_state(
        "off",
        assignments=[
            make_assignment("a1", "slot-night", "2026-01-05", "clin-1"),
            make_assignment("a2", "slot-day-tue", "2026-01-06", "clin-1"),
        ],
    )
    report = validate_assignments(state, state.assignments)
    assert VIOLATION_SOLVER_RULE not in {v.code for v in report.violations}
