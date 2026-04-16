"""Unit tests for backend.validation.

These tests intentionally go through the conftest factories (``make_app_state``,
``make_clinician``, etc.) so the validator is exercised against the same
shapes the solver tests use. Every test is independent of CP-SAT / OR-Tools.
"""

from __future__ import annotations

from backend.models import (
    AppState,
    Assignment,
    Location,
    SolverSettings,
    TemplateBlock,
    TemplateRowBand,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
)
from backend.validation import (
    VIOLATION_ON_CALL_REST,
    VIOLATION_OVERLAP,
    VIOLATION_QUALIFICATION,
    VIOLATION_SAME_LOCATION,
    VIOLATION_UNKNOWN_CLINICIAN,
    VIOLATION_UNKNOWN_SLOT,
    VIOLATION_VACATION,
    validate_assignments,
    validate_on_call_rest,
    validate_overlaps,
    validate_qualifications,
    validate_references,
    validate_same_location_per_day,
    validate_vacations,
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
