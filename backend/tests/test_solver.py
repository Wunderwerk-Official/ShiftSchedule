"""Tests for the solver logic.

These tests verify that the day and week solvers correctly:
- Create assignments only for template slots
- Respect clinician qualifications
- Block vacation days
- Block rest days when on-call rest is enabled
- Enforce same-location-per-day constraints
- Prevent time overlaps
- Allow touching intervals (end == start)
- Keep manual assignments fixed
- Return safe responses for infeasible configurations
"""

from typing import Dict, List

import pytest

from backend.models import (
    AppState,
    Assignment,
    Clinician,
    Location,
    SolveRangeRequest,
    SolveRangeResponse,
    TemplateBlock,
    TemplateColBand,
    TemplateRowBand,
    TemplateSlot,
    UserPublic,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
    WorkplaceRow,
)
from backend.solver import _solve_range_impl

from .conftest import (
    DAY_TYPES,
    make_app_state,
    make_clinician,
    make_location,
    make_pool_row,
    make_template_col_band,
    make_template_slot,
    make_workplace_row,
)


def _build_solver_state(
    clinicians: List[Clinician],
    slots: List[TemplateSlot],
    col_bands: List[TemplateColBand],
    solver_settings: Dict[str, object],
    rows: List[WorkplaceRow] = None,
    assignments: List[Assignment] = None,
) -> AppState:
    """Build a complete AppState for solver testing."""
    location = Location(id="loc-default", name="Berlin")
    if rows is None:
        rows = [
            WorkplaceRow(
                id="section-a",
                name="Section A",
                kind="class",
                dotColorClass="bg-slate-400",
                blockColor="#E8E1F5",
                locationId="loc-default",
                subShifts=[],
            ),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ]
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id="block-a", sectionId="section-a", requiredSlots=0)],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-default",
                rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                colBands=col_bands,
                slots=slots,
            )
        ],
    )
    return AppState(
        locations=[location],
        locationsEnabled=True,
        rows=rows,
        clinicians=clinicians,
        assignments=assignments or [],
        minSlotsByRowId={},
        slotOverridesByKey={},
        weeklyTemplate=template,
        holidays=[],
        solverSettings=solver_settings,
        solverRules=[],
        publishedWeekStartISOs=[],
    )


TEST_USER = UserPublic(username="test", role="admin", active=True)


class TestDaySolverBasics:
    """Basic day solver functionality tests."""

    def test_creates_assignments_for_template_slots_only(self, monkeypatch) -> None:
        """Solver should only create assignments for slots in the template."""
        clinicians = [make_clinician()]
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        assert len(response.assignments) == 1
        assert response.assignments[0].rowId == "slot-a"

    def test_respects_clinician_qualifications(self, monkeypatch) -> None:
        """Solver should only assign clinicians to sections they're qualified for."""
        # Clinician is qualified for section-b, not section-a
        clinicians = [
            Clinician(
                id="clin-1",
                name="Dr. Alice",
                qualifiedClassIds=["section-b"],  # Not qualified for section-a
                preferredClassIds=[],
                vacations=[],
            )
        ]
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # No assignment possible because clinician isn't qualified
        assert len(response.assignments) == 0

    def test_blocks_vacation_days(self, monkeypatch) -> None:
        """Solver should not assign clinicians who are on vacation."""
        clinicians = [
            Clinician(
                id="clin-1",
                name="Dr. Alice",
                qualifiedClassIds=["section-a"],
                preferredClassIds=[],
                vacations=[
                    VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-10")
                ],
            )
        ]
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Clinician is on vacation, no assignment possible
        assert len(response.assignments) == 0


class TestDaySolverOverlapConstraints:
    """Tests for time overlap constraints."""

    def test_prevents_overlapping_intervals(self, monkeypatch) -> None:
        """Solver should prevent assigning a clinician to overlapping time slots."""
        clinicians = [make_clinician()]
        col_bands = [
            make_template_col_band("col-mon-1", "", 1, "mon"),
            make_template_col_band("col-mon-2", "", 2, "mon"),
        ]
        # Two slots that overlap (08:00-12:00 and 10:00-14:00)
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
                start_time="08:00",
                end_time="12:00",
            ),
            make_template_slot(
                slot_id="slot-b",
                col_band_id="col-mon-2",
                required_slots=1,
                start_time="10:00",
                end_time="14:00",
            ),
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Only one slot can be filled due to overlap
        assert len(response.assignments) == 1

    def test_allows_touching_intervals(self, monkeypatch) -> None:
        """Solver should allow adjacent slots where end == start."""
        clinicians = [make_clinician()]
        col_bands = [
            make_template_col_band("col-mon-1", "", 1, "mon"),
            make_template_col_band("col-mon-2", "", 2, "mon"),
        ]
        # Two adjacent slots (08:00-12:00 and 12:00-16:00)
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
                start_time="08:00",
                end_time="12:00",
            ),
            make_template_slot(
                slot_id="slot-b",
                col_band_id="col-mon-2",
                required_slots=1,
                start_time="12:00",
                end_time="16:00",
            ),
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Both slots should be filled (touching is allowed)
        assert len(response.assignments) == 2
        row_ids = {a.rowId for a in response.assignments}
        assert "slot-a" in row_ids
        assert "slot-b" in row_ids


class TestDaySolverLocationConstraints:
    """Tests for same-location-per-day constraints."""

    def test_enforces_same_location_per_day(self, monkeypatch) -> None:
        """Solver should prevent assignments at different locations on the same day."""
        clinicians = [make_clinician(qualified_class_ids=["section-a", "section-b"])]
        rows = [
            WorkplaceRow(
                id="section-a",
                name="Section A",
                kind="class",
                dotColorClass="bg-slate-400",
                blockColor="#E8E1F5",
                locationId="loc-1",
                subShifts=[],
            ),
            WorkplaceRow(
                id="section-b",
                name="Section B",
                kind="class",
                dotColorClass="bg-slate-400",
                blockColor="#FDE2E4",
                locationId="loc-2",
                subShifts=[],
            ),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ]
        col_bands = [
            make_template_col_band("col-mon-1", "", 1, "mon"),
            make_template_col_band("col-mon-2", "", 2, "mon"),
        ]
        # Non-overlapping slots at different locations
        slots = [
            TemplateSlot(
                id="slot-a",
                locationId="loc-1",
                rowBandId="row-1",
                colBandId="col-mon-1",
                blockId="block-a",
                requiredSlots=1,
                startTime="08:00",
                endTime="12:00",
                endDayOffset=0,
            ),
            TemplateSlot(
                id="slot-b",
                locationId="loc-2",
                rowBandId="row-1",
                colBandId="col-mon-2",
                blockId="block-b",
                requiredSlots=1,
                startTime="13:00",
                endTime="17:00",
                endDayOffset=0,
            ),
        ]
        template = WeeklyCalendarTemplate(
            version=4,
            blocks=[
                TemplateBlock(id="block-a", sectionId="section-a", requiredSlots=0),
                TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0),
            ],
            locations=[
                WeeklyTemplateLocation(
                    locationId="loc-1",
                    rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                    colBands=col_bands,
                    slots=[slots[0]],
                ),
                WeeklyTemplateLocation(
                    locationId="loc-2",
                    rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                    colBands=col_bands,
                    slots=[slots[1]],
                ),
            ],
        )
        state = AppState(
            locations=[
                Location(id="loc-1", name="Location 1"),
                Location(id="loc-2", name="Location 2"),
            ],
            locationsEnabled=True,
            rows=rows,
            clinicians=clinicians,
            assignments=[],
            minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template,
            holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": True,  # Enable constraint
                "onCallRestEnabled": False,
            },
            solverRules=[],
            publishedWeekStartISOs=[],
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Only one location can be used
        assert len(response.assignments) == 1


class TestDaySolverManualAssignments:
    """Tests for manual assignment handling."""

    def test_manual_assignments_remain_fixed(self, monkeypatch) -> None:
        """Solver should not override existing manual assignments."""
        clinicians = [make_clinician()]
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        # Pre-existing assignment
        assignments = [
            Assignment(
                id="manual-1",
                rowId="slot-a",
                dateISO="2026-01-05",
                clinicianId="clin-1",
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
            assignments=assignments,
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # No new assignments needed - slot is already filled
        assert len(response.assignments) == 0


class TestDaySolverInfeasible:
    """Tests for infeasible configuration handling."""

    def test_returns_empty_for_no_solution(self, monkeypatch) -> None:
        """Solver should return empty assignments when no solution exists."""
        # No clinicians available
        clinicians = []
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Empty response but valid structure
        assert response.assignments == []
        assert isinstance(response, SolveRangeResponse)


class TestWeekSolverRestDays:
    """Tests for on-call rest day constraints."""

    def test_blocks_rest_days_before_on_call(self, monkeypatch) -> None:
        """Solver should block assignments on days before on-call shift."""
        clinicians = [make_clinician()]
        col_bands = [make_template_col_band(f"col-{day_type}-1", "", 1, day_type) for day_type in DAY_TYPES]
        # Slots for Monday and Tuesday
        slots = [
            make_template_slot(
                slot_id="slot-mon",
                col_band_id="col-mon-1",
                required_slots=1,
                start_time="08:00",
                end_time="16:00",
            ),
            make_template_slot(
                slot_id="slot-tue",
                col_band_id="col-tue-1",
                required_slots=1,
                start_time="08:00",
                end_time="16:00",
            ),
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {
                "enforceSameLocationPerDay": False,
                "onCallRestEnabled": True,
                "onCallRestClassId": "section-a",
                "onCallRestDaysBefore": 1,
                "onCallRestDaysAfter": 0,
            },
        )
        # Manual on-call assignment on Tuesday
        state.assignments = [
            Assignment(
                id="manual-tue",
                rowId="slot-tue",
                dateISO="2026-01-06",  # Tuesday
                clinicianId="clin-1",
            )
        ]
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(
                startISO="2026-01-05",  # Monday
                endISO="2026-01-06",  # Tuesday
                only_fill_required=True,
            ),
            current_user=TEST_USER,
        )

        # Monday should not have an assignment (rest day before Tuesday on-call)
        monday_assignments = [a for a in response.assignments if a.dateISO == "2026-01-05"]
        assert len(monday_assignments) == 0

    @pytest.mark.parametrize("range_day, expect_note", [
        ("2026-01-05", True),   # on-call in range, manual work on the context day after
        ("2026-01-06", False),  # on-call itself on the context day before
    ])
    def test_boundary_rest_conflict_note(self, monkeypatch, range_day, expect_note) -> None:
        clinicians = [make_clinician(), make_clinician("clin-2", "Bob")]
        for clinician in clinicians:
            clinician.qualifiedClassIds = ["section-a"]
        col_bands = [make_template_col_band(f"col-{day_type}-1", "", 1, day_type) for day_type in DAY_TYPES]
        slots = [
            make_template_slot(slot_id="slot-mon", col_band_id="col-mon-1", required_slots=2,
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-tue", col_band_id="col-tue-1", required_slots=2,
                               start_time="08:00", end_time="16:00"),
        ]
        state = _build_solver_state(clinicians, slots, col_bands, {
            "enforceSameLocationPerDay": False,
            "onCallRestEnabled": True,
            "onCallRestClassId": "section-a",
            "onCallRestDaysBefore": 0,
            "onCallRestDaysAfter": 1,
        }, assignments=[
            Assignment(id="manual-mon", rowId="slot-mon", dateISO="2026-01-05", clinicianId="clin-1"),
            Assignment(id="manual-tue", rowId="slot-tue", dateISO="2026-01-06", clinicianId="clin-1"),
        ])
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO=range_day, endISO=range_day, only_fill_required=True),
            current_user=TEST_USER,
        )

        note = "Rest day conflicts outside the selected range; some boundary days are already assigned."
        assert (note in response.notes) is expect_note

    def test_solver_on_call_never_collides_with_manual_context_work(self, monkeypatch) -> None:
        # No manual on-call at all: the only manual entry is work on the
        # context day after the range. The model must not place an on-call
        # whose rest day is that work, so no boundary note can arise from
        # solver-placed on-calls.
        clinicians = [make_clinician(), make_clinician("clin-2", "Bob")]
        for clinician in clinicians:
            clinician.qualifiedClassIds = ["section-a"]
        col_bands = [make_template_col_band(f"col-{day_type}-1", "", 1, day_type) for day_type in DAY_TYPES]
        slots = [
            make_template_slot(slot_id="slot-mon", col_band_id="col-mon-1", required_slots=2,
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-tue", col_band_id="col-tue-1", required_slots=1,
                               start_time="08:00", end_time="16:00"),
        ]
        state = _build_solver_state(clinicians, slots, col_bands, {
            "enforceSameLocationPerDay": False,
            "onCallRestEnabled": True,
            "onCallRestClassId": "section-a",
            "onCallRestDaysBefore": 0,
            "onCallRestDaysAfter": 1,
        }, assignments=[
            Assignment(id="manual-tue", rowId="slot-tue", dateISO="2026-01-06", clinicianId="clin-1"),
        ])
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        monday = {a.clinicianId for a in response.assignments if a.dateISO == "2026-01-05"}
        # Two open Monday on-call seats, but clin-1 works Tuesday (rest day).
        assert monday == {"clin-2"}
        note = "Rest day conflicts outside the selected range; some boundary days are already assigned."
        assert note not in response.notes


class TestWeekSolverHoursDistribution:
    """Tests for working hours distribution."""

    def test_hours_tolerance_distributes_work(self, monkeypatch) -> None:
        """Solver should distribute work based on working hours with tolerance."""
        clinicians = [
            Clinician(
                id="clin-a",
                name="Clinician A",
                qualifiedClassIds=["section-a"],
                preferredClassIds=[],
                vacations=[],
                workingHoursPerWeek=7,  # 7 hours per week
            ),
            Clinician(
                id="clin-b",
                name="Clinician B",
                qualifiedClassIds=["section-a"],
                preferredClassIds=[],
                vacations=[],
                workingHoursPerWeek=7,  # 7 hours per week
            ),
        ]
        col_bands = [
            make_template_col_band("col-mon-1", "", 1, "mon"),
            make_template_col_band("col-mon-2", "", 2, "mon"),
        ]
        # Two 1-hour slots
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
                start_time="08:00",
                end_time="09:00",
            ),
            make_template_slot(
                slot_id="slot-b",
                col_band_id="col-mon-2",
                required_slots=1,
                start_time="09:00",
                end_time="10:00",
            ),
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {
                "enforceSameLocationPerDay": False,
                "onCallRestEnabled": False,
                "workingHoursToleranceHours": 0,  # Strict distribution
                "preferContinuousShifts": False,  # Disable to test pure hours distribution
            },
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(
                startISO="2026-01-05",
                endISO="2026-01-05",
                only_fill_required=True,
            ),
            current_user=TEST_USER,
        )

        # With zero tolerance, work should be distributed evenly
        assignments_by_clinician: Dict[str, int] = {}
        for assignment in response.assignments:
            assignments_by_clinician[assignment.clinicianId] = (
                assignments_by_clinician.get(assignment.clinicianId, 0) + 1
            )

        # Each clinician should get one slot
        assert assignments_by_clinician.get("clin-a", 0) == 1
        assert assignments_by_clinician.get("clin-b", 0) == 1


class TestSolverTimeIntervals:
    """Tests for time interval parsing and building."""

    def test_day_offset_handling(self, monkeypatch) -> None:
        """Solver should correctly handle endDayOffset for overnight shifts."""
        clinicians = [make_clinician()]
        col_bands = [
            make_template_col_band("col-mon-1", "", 1, "mon"),
            make_template_col_band("col-mon-2", "", 2, "mon"),
        ]
        # Overnight shift (22:00 to 06:00 next day)
        slots = [
            make_template_slot(
                slot_id="slot-night",
                col_band_id="col-mon-1",
                required_slots=1,
                start_time="22:00",
                end_time="06:00",
                end_day_offset=1,  # Ends next day
            ),
            make_template_slot(
                slot_id="slot-morning",
                col_band_id="col-mon-2",
                required_slots=1,
                start_time="08:00",
                end_time="12:00",
            ),
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {
                "enforceSameLocationPerDay": False,
                "onCallRestEnabled": False,
                "preferContinuousShifts": False,  # Disable to test just day offset handling
            },
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Both slots should be fillable (no overlap: night 22:00-30:00, morning 08:00-12:00)
        # Note: With preferContinuousShifts=False, gaps between shifts are allowed.
        assert len(response.assignments) == 2


class TestSolverPoolNonInterference:
    """Tests verifying solver doesn't reference deprecated pools."""

    def test_solver_ignores_deprecated_pool_assignments(self, monkeypatch) -> None:
        """Solver should ignore any legacy pool assignments in input state."""
        clinicians = [make_clinician()]
        col_bands = [make_template_col_band("col-mon-1", "", 1, "mon")]
        slots = [
            make_template_slot(
                slot_id="slot-a",
                col_band_id="col-mon-1",
                required_slots=1,
            )
        ]
        # Legacy assignment to deprecated pool (should be ignored)
        assignments = [
            Assignment(
                id="legacy-1",
                rowId="pool-not-allocated",  # Deprecated pool
                dateISO="2026-01-05",
                clinicianId="clin-1",
            )
        ]
        state = _build_solver_state(
            clinicians,
            slots,
            col_bands,
            {"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
            assignments=assignments,
        )
        monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

        response = _solve_range_impl(
            SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05", only_fill_required=True),
            current_user=TEST_USER,
        )

        # Solver should create new assignment, ignoring the deprecated pool assignment
        assert len(response.assignments) == 1
        assert response.assignments[0].rowId == "slot-a"
        # No assignment should reference deprecated pools
        for assignment in response.assignments:
            assert assignment.rowId != "pool-not-allocated"
            assert assignment.rowId != "pool-manual"
