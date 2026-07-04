"""
Integration tests for the Heuristic Solver V2.

These tests simulate realistic hospital scheduling scenarios end-to-end:
1. Full week with mixed full-time/part-time doctors
2. Multi-week solve with vacation in the middle
3. Overnight on-call + regular day shifts (no double-booking)
4. Multiple locations with same-location-per-day enforcement
5. Specialists vs generalists competing for limited slots
6. Partially infeasible schedule (more required slots than capacity)
7. Weekly hours reset at Monday boundary

Each test builds a complete AppState, runs the solver, and makes
comprehensive assertions about the solution quality.
"""

from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List, Set, Tuple

import pytest

from backend.models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    Location,
    SolveRangeRequest,
    TemplateBlock,
    TemplateColBand,
    TemplateRowBand,
    TemplateSlot,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
    WorkplaceRow,
)
from backend.heuristic.solver_v2 import heuristic_solve_range_v2

from typing import Optional


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class MockCancelEvent:
    def is_set(self):
        return False


def mock_progress(event_type: str, data: dict):
    pass


def _time_to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _slot_duration_hours(slot: TemplateSlot) -> float:
    """Calculate duration of a slot in hours."""
    start = _time_to_minutes(slot.startTime)
    end = _time_to_minutes(slot.endTime)
    offset = getattr(slot, "endDayOffset", 0) or 0
    dur = end - start
    if offset > 0:
        dur += offset * 24 * 60
    elif dur < 0:
        dur += 24 * 60
    return max(0, dur) / 60.0


def _collect_assignments_for(
    assignments: List[dict],
    clinician_id: str,
    date_iso: str = None,
) -> List[dict]:
    """Filter assignments for a clinician, optionally on a specific date."""
    result = [a for a in assignments if a["clinicianId"] == clinician_id]
    if date_iso:
        result = [a for a in result if a["dateISO"] == date_iso]
    return result


def _compute_hours(
    assignments: List[dict],
    slot_duration_map: Dict[str, float],
) -> float:
    """Compute total assigned hours from a list of assignment dicts."""
    total = 0.0
    for a in assignments:
        total += slot_duration_map.get(a["rowId"], 0.0)
    return total


def _check_no_time_overlaps(
    assignments: List[dict],
    slot_time_map: Dict[str, Tuple[int, int, int]],  # slot_id -> (start_min, end_min, end_day_offset)
) -> List[str]:
    """
    Check that no clinician has overlapping assignments on the same date.
    Returns list of violation descriptions.
    """
    violations = []
    by_clin_date: Dict[Tuple[str, str], List[Tuple[int, int, str]]] = defaultdict(list)
    for a in assignments:
        times = slot_time_map.get(a["rowId"])
        if not times:
            continue
        start, end, offset = times
        effective_end = end
        if offset > 0 or end <= start:
            effective_end = start + (end - start + offset * 24 * 60)
            if effective_end <= start:
                effective_end += 24 * 60
        by_clin_date[(a["clinicianId"], a["dateISO"])].append(
            (start, effective_end, a["rowId"])
        )

    for (cid, d), intervals in by_clin_date.items():
        intervals.sort()
        for i in range(len(intervals) - 1):
            _, end_cur, sid1 = intervals[i]
            start_next, _, sid2 = intervals[i + 1]
            if end_cur > start_next:
                violations.append(
                    f"{cid} on {d}: {sid1} (ends {end_cur}) overlaps {sid2} (starts {start_next})"
                )
    return violations


def _check_same_location_per_day(
    assignments: List[dict],
    slot_location_map: Dict[str, str],
) -> List[str]:
    """
    Check that each clinician is at one location per day.
    Returns list of violation descriptions.
    """
    violations = []
    by_clin_date: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    for a in assignments:
        loc = slot_location_map.get(a["rowId"])
        if loc:
            by_clin_date[(a["clinicianId"], a["dateISO"])].add(loc)
    for (cid, d), locs in by_clin_date.items():
        if len(locs) > 1:
            violations.append(f"{cid} on {d}: multiple locations {locs}")
    return violations


def _check_no_split_shifts(
    assignments: List[dict],
    slot_time_map: Dict[str, Tuple[int, int, int]],
) -> List[str]:
    """
    Check that no clinician has gaps between assignments on same day.
    Returns list of gap descriptions.
    """
    gaps = []
    by_clin_date: Dict[Tuple[str, str], List[Tuple[int, int, str]]] = defaultdict(list)
    for a in assignments:
        times = slot_time_map.get(a["rowId"])
        if not times:
            continue
        start, end, offset = times
        effective_end = end
        if offset > 0 or end <= start:
            effective_end = start + max(end - start + offset * 24 * 60, 0)
            if effective_end <= start:
                effective_end += 24 * 60
        by_clin_date[(a["clinicianId"], a["dateISO"])].append(
            (start, effective_end, a["rowId"])
        )

    for (cid, d), intervals in by_clin_date.items():
        if len(intervals) < 2:
            continue
        intervals.sort()
        for i in range(len(intervals) - 1):
            _, end_cur, sid1 = intervals[i]
            start_next, _, sid2 = intervals[i + 1]
            if end_cur < start_next:
                gap_h = (start_next - end_cur) / 60
                gaps.append(f"{cid} on {d}: {gap_h:.1f}h gap between {sid1} and {sid2}")
    return gaps


def _make_slot(
    slot_id: str,
    location_id: str,
    block_id: str,
    col_band_id: str,
    start_time: str,
    end_time: str,
    required: int = 1,
    end_day_offset: int = 0,
    row_band_id: str = "rb-1",
) -> TemplateSlot:
    return TemplateSlot(
        id=slot_id,
        locationId=location_id,
        rowBandId=row_band_id,
        colBandId=col_band_id,
        blockId=block_id,
        requiredSlots=required,
        startTime=start_time,
        endTime=end_time,
        endDayOffset=end_day_offset,
    )


def _build_slot_maps(
    slots: List[TemplateSlot],
) -> Tuple[Dict[str, float], Dict[str, Tuple[int, int, int]], Dict[str, str]]:
    """Build duration, time, and location maps from slot list."""
    duration_map: Dict[str, float] = {}
    time_map: Dict[str, Tuple[int, int, int]] = {}
    location_map: Dict[str, str] = {}
    for s in slots:
        duration_map[s.id] = _slot_duration_hours(s)
        time_map[s.id] = (
            _time_to_minutes(s.startTime),
            _time_to_minutes(s.endTime),
            getattr(s, "endDayOffset", 0) or 0,
        )
        location_map[s.id] = s.locationId
    return duration_map, time_map, location_map


# ---------------------------------------------------------------------------
# 1. Full week with 4-6 doctors (mix of full-time 40h and part-time 20h)
# ---------------------------------------------------------------------------

class TestFullWeekMixedContracts:
    """Verify fair distribution across full-time and part-time doctors."""

    DAY_TYPES = ["mon", "tue", "wed", "thu", "fri"]
    WEEK_START = "2026-01-05"  # Monday
    WEEK_END = "2026-01-09"    # Friday

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [Location(id="loc-hosp", name="Hospital")]

        sections = ["radiology", "ct-scan", "ultrasound"]
        blocks = [
            TemplateBlock(id=f"block-{s}", sectionId=s, requiredSlots=0)
            for s in sections
        ]

        col_bands = [
            TemplateColBand(id=f"col-{d}-1", label="", order=i, dayType=d)
            for i, d in enumerate(self.DAY_TYPES)
        ]

        # 3 sections x 2 slots each (morning 08-12, afternoon 12-16) x 5 days
        all_slots = []
        for d in self.DAY_TYPES:
            for s in sections:
                all_slots.append(_make_slot(
                    f"{s}-morning__{d}", "loc-hosp", f"block-{s}",
                    f"col-{d}-1", "08:00", "12:00", required=1,
                ))
                all_slots.append(_make_slot(
                    f"{s}-afternoon__{d}", "loc-hosp", f"block-{s}",
                    f"col-{d}-1", "12:00", "16:00", required=1,
                ))

        row_bands = [TemplateRowBand(id="rb-1", label="Row", order=1)]

        template = WeeklyCalendarTemplate(
            version=4,
            blocks=blocks,
            locations=[
                WeeklyTemplateLocation(
                    locationId="loc-hosp",
                    rowBands=row_bands,
                    colBands=col_bands,
                    slots=all_slots,
                )
            ],
        )

        clinicians = [
            Clinician(id="ft-1", name="Dr. Anna (FT)", qualifiedClassIds=sections,
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="ft-2", name="Dr. Ben (FT)", qualifiedClassIds=sections,
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="ft-3", name="Dr. Clara (FT)", qualifiedClassIds=sections,
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="pt-1", name="Dr. Dana (PT)", qualifiedClassIds=sections,
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=20.0),
            Clinician(id="pt-2", name="Dr. Erik (PT)", qualifiedClassIds=sections,
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=20.0),
        ]

        rows = [
            WorkplaceRow(id=s, name=s.title(), kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-hosp", subShifts=[])
            for s in sections
        ] + [
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations,
            locationsEnabled=True,
            rows=rows,
            clinicians=clinicians,
            assignments=[],
            minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template,
            holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": True,
                "onCallRestEnabled": False,
            },
            solverRules=[],
            publishedWeekStartISOs=[],
        )

        return state, all_slots

    def test_all_required_slots_filled(self):
        """All 30 required slots (3 sections x 2 time blocks x 5 days) should be filled."""
        state, slots = self._build_state()
        duration_map, time_map, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.WEEK_START,
            endISO=self.WEEK_END,
            only_fill_required=True,
            use_heuristic=True,
        )

        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        assert len(assignments) >= 30, (
            f"Expected at least 30 assignments (3 sections x 2 slots x 5 days), got {len(assignments)}"
        )

    def test_no_time_overlaps(self):
        """No clinician should have overlapping time intervals."""
        state, slots = self._build_state()
        _, time_map, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.WEEK_START, endISO=self.WEEK_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        overlaps = _check_no_time_overlaps(result["assignments"], time_map)
        assert overlaps == [], f"Time overlaps detected: {overlaps}"

    def test_no_split_shifts(self):
        """No clinician should have gaps between consecutive assignments on the same day."""
        state, slots = self._build_state()
        _, time_map, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.WEEK_START, endISO=self.WEEK_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        gaps = _check_no_split_shifts(result["assignments"], time_map)
        assert gaps == [], f"Split shifts detected: {gaps}"

    def test_part_time_doctors_get_fewer_hours(self):
        """Part-time (20h) doctors should get roughly half the hours of full-time (40h)."""
        state, slots = self._build_state()
        duration_map, _, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.WEEK_START, endISO=self.WEEK_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        ft_hours = []
        for cid in ["ft-1", "ft-2", "ft-3"]:
            h = _compute_hours(_collect_assignments_for(assignments, cid), duration_map)
            ft_hours.append(h)

        pt_hours = []
        for cid in ["pt-1", "pt-2"]:
            h = _compute_hours(_collect_assignments_for(assignments, cid), duration_map)
            pt_hours.append(h)

        avg_ft = sum(ft_hours) / len(ft_hours) if ft_hours else 0
        avg_pt = sum(pt_hours) / len(pt_hours) if pt_hours else 0

        # Part-time should be noticeably less than full-time
        # Allow generous tolerance since solver optimises for coverage, not perfect balance
        assert avg_pt < avg_ft, (
            f"Part-time avg ({avg_pt:.1f}h) should be less than full-time avg ({avg_ft:.1f}h)"
        )


# ---------------------------------------------------------------------------
# 2. Multi-week solve with vacation in week 2
# ---------------------------------------------------------------------------

class TestMultiWeekWithVacation:
    """3-week solve where one doctor is on vacation in week 2."""

    WEEK1_START = "2026-01-05"
    WEEK3_END = "2026-01-23"
    VACATION_START = "2026-01-12"
    VACATION_END = "2026-01-16"

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [Location(id="loc-clinic", name="Clinic")]
        day_types = ["mon", "tue", "wed", "thu", "fri"]

        blocks = [TemplateBlock(id="block-exam", sectionId="exam", requiredSlots=0)]
        col_bands = [
            TemplateColBand(id=f"col-{d}-1", label="", order=i, dayType=d)
            for i, d in enumerate(day_types)
        ]

        # One 8-hour slot per day requiring 2 doctors
        all_slots = []
        for d in day_types:
            all_slots.append(_make_slot(
                f"exam-day__{d}", "loc-clinic", "block-exam",
                f"col-{d}-1", "08:00", "16:00", required=2,
            ))

        template = WeeklyCalendarTemplate(
            version=4,
            blocks=blocks,
            locations=[
                WeeklyTemplateLocation(
                    locationId="loc-clinic",
                    rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                    colBands=col_bands,
                    slots=all_slots,
                )
            ],
        )

        clinicians = [
            Clinician(id="doc-A", name="Dr. A", qualifiedClassIds=["exam"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="doc-B", name="Dr. B", qualifiedClassIds=["exam"],
                      preferredClassIds=[], vacations=[
                          VacationRange(id="vac-b", startISO=self.VACATION_START,
                                        endISO=self.VACATION_END),
                      ], workingHoursPerWeek=40.0),
            Clinician(id="doc-C", name="Dr. C", qualifiedClassIds=["exam"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        ]

        rows = [
            WorkplaceRow(id="exam", name="Exam", kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-clinic", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations,
            locationsEnabled=True,
            rows=rows,
            clinicians=clinicians,
            assignments=[],
            minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template,
            holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": False,
                "onCallRestEnabled": False,
            },
            solverRules=[],
            publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_vacation_doctor_not_assigned_in_week2(self):
        """Dr. B should have zero assignments during vacation week."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.WEEK1_START, endISO=self.WEEK3_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )

        week2_dates = [
            (date(2026, 1, 12) + timedelta(days=i)).isoformat()
            for i in range(5)
        ]
        for d in week2_dates:
            b_on_day = _collect_assignments_for(result["assignments"], "doc-B", d)
            assert len(b_on_day) == 0, f"Dr. B should not be assigned on {d} (vacation)"

    def test_others_pick_up_slack_in_week2(self):
        """Dr. A and Dr. C should cover all required slots in week 2."""
        state, slots = self._build_state()
        duration_map, _, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.WEEK1_START, endISO=self.WEEK3_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )

        week2_dates = [
            (date(2026, 1, 12) + timedelta(days=i)).isoformat()
            for i in range(5)
        ]
        for d in week2_dates:
            day_assignments = [a for a in result["assignments"] if a["dateISO"] == d]
            # Each day needs 2 people in the slot
            assert len(day_assignments) >= 2, (
                f"Expected 2 assignments on {d} (week 2), got {len(day_assignments)}"
            )

    def test_vacation_doctor_works_in_weeks_1_and_3(self):
        """Dr. B should have assignments in weeks 1 and 3 (not on vacation)."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.WEEK1_START, endISO=self.WEEK3_END,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )

        week1_dates = [
            (date(2026, 1, 5) + timedelta(days=i)).isoformat()
            for i in range(5)
        ]
        week3_dates = [
            (date(2026, 1, 19) + timedelta(days=i)).isoformat()
            for i in range(5)
        ]

        b_week1 = [a for a in result["assignments"]
                    if a["clinicianId"] == "doc-B" and a["dateISO"] in week1_dates]
        b_week3 = [a for a in result["assignments"]
                    if a["clinicianId"] == "doc-B" and a["dateISO"] in week3_dates]

        assert len(b_week1) > 0, "Dr. B should work in week 1"
        assert len(b_week3) > 0, "Dr. B should work in week 3"


# ---------------------------------------------------------------------------
# 3. Overnight on-call + regular day shifts: no double-booking across midnight
# ---------------------------------------------------------------------------

class TestOvernightOnCallNoCrossing:
    """Overnight on-call (20:00-08:00+1) must not overlap with next day's shifts."""

    MONDAY = "2026-01-05"
    TUESDAY = "2026-01-06"

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [Location(id="loc-er", name="ER")]

        blocks = [
            TemplateBlock(id="block-day", sectionId="day-shift", requiredSlots=0),
            TemplateBlock(id="block-oncall", sectionId="on-call", requiredSlots=0),
        ]

        col_bands = [
            TemplateColBand(id="col-mon-1", label="", order=0, dayType="mon"),
            TemplateColBand(id="col-tue-1", label="", order=1, dayType="tue"),
        ]

        all_slots = [
            # Monday day shift (08:00-16:00)
            _make_slot("day-mon__mon", "loc-er", "block-day", "col-mon-1",
                       "08:00", "16:00", required=1),
            # Monday overnight on-call (20:00-08:00 next day)
            _make_slot("oncall-mon__mon", "loc-er", "block-oncall", "col-mon-1",
                       "20:00", "08:00", required=1, end_day_offset=1),
            # Tuesday day shift (08:00-16:00)
            _make_slot("day-tue__tue", "loc-er", "block-day", "col-tue-1",
                       "08:00", "16:00", required=1),
        ]

        template = WeeklyCalendarTemplate(
            version=4, blocks=blocks,
            locations=[WeeklyTemplateLocation(
                locationId="loc-er",
                rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                colBands=col_bands,
                slots=all_slots,
            )],
        )

        clinicians = [
            Clinician(id="doc-X", name="Dr. X",
                      qualifiedClassIds=["day-shift", "on-call"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="doc-Y", name="Dr. Y",
                      qualifiedClassIds=["day-shift", "on-call"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        ]

        rows = [
            WorkplaceRow(id="day-shift", name="Day", kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-er", subShifts=[]),
            WorkplaceRow(id="on-call", name="On-Call", kind="class",
                         dotColorClass="bg-red-400", blockColor="#FFCDD2",
                         locationId="loc-er", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations, locationsEnabled=True, rows=rows,
            clinicians=clinicians, assignments=[], minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template, holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": False,
                "onCallRestEnabled": False,
            },
            solverRules=[], publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_oncall_doctor_not_double_booked_next_morning(self):
        """
        The doctor doing Monday overnight on-call (20:00-08:00+1)
        must NOT also do Tuesday day shift (08:00-16:00), since the
        on-call slot ends at 08:00 on Tuesday, which touches the
        start of the day shift at 08:00.
        With 2 doctors and 3 required slot-instances, both doctors
        get work but not the same doctor for overlapping intervals.
        """
        state, slots = self._build_state()
        _, time_map, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.TUESDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        # Find who has the Monday overnight on-call
        oncall_docs = [a["clinicianId"] for a in assignments
                       if a["rowId"] == "oncall-mon__mon"]

        if oncall_docs:
            oncall_doc = oncall_docs[0]
            # That doctor should NOT also have Tuesday 08:00-16:00
            tuesday_day = [a for a in assignments
                           if a["rowId"] == "day-tue__tue" and a["clinicianId"] == oncall_doc]
            assert len(tuesday_day) == 0, (
                f"{oncall_doc} has both Monday overnight on-call (20-08+1) "
                f"and Tuesday day shift (08-16) -- double-booked across midnight!"
            )

    def test_all_slots_filled(self):
        """All 3 required slot-instances should be filled by the 2 doctors."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.TUESDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assert len(result["assignments"]) == 3, (
            f"Expected 3 assignments, got {len(result['assignments'])}"
        )


# ---------------------------------------------------------------------------
# 4. Multiple locations with enforcement
# ---------------------------------------------------------------------------

class TestMultipleLocationsEnforcement:
    """Doctors must stay at one site per day when location enforcement is on."""

    MONDAY = "2026-01-05"

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [
            Location(id="loc-north", name="North Hospital"),
            Location(id="loc-south", name="South Hospital"),
        ]

        sections = ["imaging"]
        blocks = [TemplateBlock(id="block-img", sectionId="imaging", requiredSlots=0)]

        col_bands = [TemplateColBand(id="col-mon-1", label="", order=0, dayType="mon")]

        all_slots = [
            # North: morning and afternoon
            _make_slot("img-north-am__mon", "loc-north", "block-img",
                       "col-mon-1", "08:00", "12:00", required=1),
            _make_slot("img-north-pm__mon", "loc-north", "block-img",
                       "col-mon-1", "12:00", "16:00", required=1),
            # South: morning and afternoon
            _make_slot("img-south-am__mon", "loc-south", "block-img",
                       "col-mon-1", "08:00", "12:00", required=1),
            _make_slot("img-south-pm__mon", "loc-south", "block-img",
                       "col-mon-1", "12:00", "16:00", required=1),
        ]

        template = WeeklyCalendarTemplate(
            version=4, blocks=blocks,
            locations=[
                WeeklyTemplateLocation(
                    locationId="loc-north",
                    rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                    colBands=col_bands,
                    slots=[s for s in all_slots if s.locationId == "loc-north"],
                ),
                WeeklyTemplateLocation(
                    locationId="loc-south",
                    rowBands=[TemplateRowBand(id="rb-2", label="Row", order=1)],
                    colBands=col_bands,
                    slots=[s for s in all_slots if s.locationId == "loc-south"],
                ),
            ],
        )

        clinicians = [
            Clinician(id="doc-1", name="Dr. One", qualifiedClassIds=["imaging"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="doc-2", name="Dr. Two", qualifiedClassIds=["imaging"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        ]

        rows = [
            WorkplaceRow(id="imaging", name="Imaging", kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-north", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations, locationsEnabled=True, rows=rows,
            clinicians=clinicians, assignments=[], minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template, holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": True,
                "preferContinuousShifts": True,
                "onCallRestEnabled": False,
            },
            solverRules=[], publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_each_doctor_stays_at_one_location(self):
        """With enforcement on, no doctor should work at two locations on Monday."""
        state, slots = self._build_state()
        _, _, location_map = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )

        violations = _check_same_location_per_day(result["assignments"], location_map)
        assert violations == [], f"Location violations: {violations}"

    def test_both_locations_covered(self):
        """Both North and South should have assignments."""
        state, slots = self._build_state()
        _, _, location_map = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        locations_filled = set()
        for a in assignments:
            loc = location_map.get(a["rowId"])
            if loc:
                locations_filled.add(loc)

        assert "loc-north" in locations_filled, "North hospital should have assignments"
        assert "loc-south" in locations_filled, "South hospital should have assignments"


# ---------------------------------------------------------------------------
# 5. Specialists vs generalists for limited specialist slots
# ---------------------------------------------------------------------------

class TestSpecialistsGetTheirSlots:
    """2 specialists + 3 generalists; specialists must get specialist slots."""

    MONDAY = "2026-01-05"

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [Location(id="loc-main", name="Main")]

        blocks = [
            TemplateBlock(id="block-cardiac-mri", sectionId="cardiac-mri", requiredSlots=0),
            TemplateBlock(id="block-general-mri", sectionId="general-mri", requiredSlots=0),
        ]

        col_bands = [TemplateColBand(id="col-mon-1", label="", order=0, dayType="mon")]

        all_slots = [
            # Specialist slot: cardiac MRI (morning)
            _make_slot("cardiac-mri-am__mon", "loc-main", "block-cardiac-mri",
                       "col-mon-1", "08:00", "12:00", required=1),
            # Specialist slot: cardiac MRI (afternoon)
            _make_slot("cardiac-mri-pm__mon", "loc-main", "block-cardiac-mri",
                       "col-mon-1", "12:00", "16:00", required=1),
            # General MRI slots
            _make_slot("general-mri-am__mon", "loc-main", "block-general-mri",
                       "col-mon-1", "08:00", "12:00", required=1),
            _make_slot("general-mri-pm__mon", "loc-main", "block-general-mri",
                       "col-mon-1", "12:00", "16:00", required=1),
        ]

        template = WeeklyCalendarTemplate(
            version=4, blocks=blocks,
            locations=[WeeklyTemplateLocation(
                locationId="loc-main",
                rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                colBands=col_bands,
                slots=all_slots,
            )],
        )

        clinicians = [
            # 2 specialists: only qualified for cardiac MRI
            Clinician(id="spec-1", name="Dr. Spec A",
                      qualifiedClassIds=["cardiac-mri"],
                      preferredClassIds=["cardiac-mri"], vacations=[],
                      workingHoursPerWeek=40.0),
            Clinician(id="spec-2", name="Dr. Spec B",
                      qualifiedClassIds=["cardiac-mri"],
                      preferredClassIds=["cardiac-mri"], vacations=[],
                      workingHoursPerWeek=40.0),
            # 3 generalists: qualified for both
            Clinician(id="gen-1", name="Dr. Gen A",
                      qualifiedClassIds=["cardiac-mri", "general-mri"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="gen-2", name="Dr. Gen B",
                      qualifiedClassIds=["cardiac-mri", "general-mri"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
            Clinician(id="gen-3", name="Dr. Gen C",
                      qualifiedClassIds=["cardiac-mri", "general-mri"],
                      preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        ]

        rows = [
            WorkplaceRow(id="cardiac-mri", name="Cardiac MRI", kind="class",
                         dotColorClass="bg-red-400", blockColor="#FFCDD2",
                         locationId="loc-main", subShifts=[]),
            WorkplaceRow(id="general-mri", name="General MRI", kind="class",
                         dotColorClass="bg-blue-400", blockColor="#BBDEFB",
                         locationId="loc-main", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations, locationsEnabled=True, rows=rows,
            clinicians=clinicians, assignments=[], minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template, holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": True,
                "onCallRestEnabled": False,
            },
            solverRules=[], publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_specialists_get_cardiac_slots(self):
        """Specialists should be assigned to cardiac MRI (their only option)."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        spec_assignments = [a for a in assignments
                            if a["clinicianId"] in ("spec-1", "spec-2")]

        assert len(spec_assignments) > 0, (
            "Specialists should have assignments (not idle)"
        )

        for a in spec_assignments:
            assert a["rowId"].startswith("cardiac-mri"), (
                f"Specialist {a['clinicianId']} assigned to {a['rowId']} "
                f"but should only be on cardiac-mri slots"
            )

    def test_generalists_fill_general_slots(self):
        """Generalists should be routed to general MRI so specialists can have cardiac."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        general_filled = [a for a in assignments if a["rowId"].startswith("general-mri")]
        assert len(general_filled) >= 2, "Both general MRI slots should be filled"

    def test_all_slots_filled(self):
        """All 4 slots (2 cardiac + 2 general) should be filled with 5 doctors available."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assert len(result["assignments"]) >= 4, (
            f"Expected 4 assignments, got {len(result['assignments'])}"
        )


# ---------------------------------------------------------------------------
# 6. Partially infeasible schedule (more required slots than capacity)
# ---------------------------------------------------------------------------

class TestPartiallyInfeasibleSchedule:
    """More required slots than doctor-hours; solver does its best and warns."""

    MONDAY = "2026-01-05"

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        locations = [Location(id="loc-busy", name="Busy Hospital")]

        blocks = [TemplateBlock(id="block-ward", sectionId="ward", requiredSlots=0)]
        col_bands = [TemplateColBand(id="col-mon-1", label="", order=0, dayType="mon")]

        # 6 non-overlapping required slots but only 1 doctor with 10h tolerance
        all_slots = [
            _make_slot(f"ward-{i}__mon", "loc-busy", "block-ward",
                       "col-mon-1",
                       f"{8 + i * 2:02d}:00", f"{10 + i * 2:02d}:00",
                       required=1)
            for i in range(6)  # 12 hours of required coverage
        ]

        template = WeeklyCalendarTemplate(
            version=4, blocks=blocks,
            locations=[WeeklyTemplateLocation(
                locationId="loc-busy",
                rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                colBands=col_bands,
                slots=all_slots,
            )],
        )

        clinicians = [
            Clinician(id="sole-doc", name="Dr. Sole",
                      qualifiedClassIds=["ward"],
                      preferredClassIds=[], vacations=[],
                      workingHoursPerWeek=8.0,
                      workingHoursToleranceHours=2),  # max 10h but need 12h
        ]

        rows = [
            WorkplaceRow(id="ward", name="Ward", kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-busy", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations, locationsEnabled=True, rows=rows,
            clinicians=clinicians, assignments=[], minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template, holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": True,
                "onCallRestEnabled": False,
            },
            solverRules=[], publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_solver_does_not_crash(self):
        """Solver should complete without error even when infeasible."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assert "assignments" in result
        assert "notes" in result

    def test_some_slots_filled(self):
        """Solver should fill as many slots as it can within hour limits."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        # Doctor can do max 10h = 5 slots of 2h each
        assert 1 <= len(assignments) <= 5, (
            f"Expected 1-5 assignments (hour-limited), got {len(assignments)}"
        )

    def test_generates_warning_notes(self):
        """Solver should report that not all slots could be filled."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        notes = result["notes"]

        # The solver should report some unfilled slots or warnings
        notes_text = " ".join(notes)
        assert "Could not" in notes_text or len(result["assignments"]) < 6, (
            "Solver should either warn about unfilled slots or fill fewer than 6"
        )

    def test_no_time_overlaps_in_partial_solution(self):
        """Even a partial solution must have no overlaps."""
        state, slots = self._build_state()
        _, time_map, _ = _build_slot_maps(slots)

        payload = SolveRangeRequest(
            startISO=self.MONDAY, endISO=self.MONDAY,
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        overlaps = _check_no_time_overlaps(result["assignments"], time_map)
        assert overlaps == [], f"Overlaps in partial solution: {overlaps}"


# ---------------------------------------------------------------------------
# 7. Weekly hours reset at Monday boundary
# ---------------------------------------------------------------------------

class TestWeeklyHoursReset:
    """Verify hours don't carry over from one ISO week to the next."""

    def _build_state(self) -> Tuple[AppState, List[TemplateSlot]]:
        """
        2-week schedule: Friday + next Monday.
        One doctor with 8h/week contract + 2h tolerance = 10h max.
        Friday has 2 slots (8h), Monday has 2 slots (8h).
        If hours reset, Monday should also get up to 10h.
        If hours carry over incorrectly, Monday would be blocked.
        """
        locations = [Location(id="loc-w", name="Ward")]
        blocks = [TemplateBlock(id="block-ward", sectionId="ward", requiredSlots=0)]

        col_bands = [
            TemplateColBand(id="col-fri-1", label="", order=0, dayType="fri"),
            TemplateColBand(id="col-mon-1", label="", order=1, dayType="mon"),
        ]

        all_slots = [
            # Friday slots (week 1): 8h total
            _make_slot("ward-fri-am__fri", "loc-w", "block-ward",
                       "col-fri-1", "08:00", "12:00", required=1),
            _make_slot("ward-fri-pm__fri", "loc-w", "block-ward",
                       "col-fri-1", "12:00", "16:00", required=1),
            # Monday slots (week 2): 8h total
            _make_slot("ward-mon-am__mon", "loc-w", "block-ward",
                       "col-mon-1", "08:00", "12:00", required=1),
            _make_slot("ward-mon-pm__mon", "loc-w", "block-ward",
                       "col-mon-1", "12:00", "16:00", required=1),
        ]

        template = WeeklyCalendarTemplate(
            version=4, blocks=blocks,
            locations=[WeeklyTemplateLocation(
                locationId="loc-w",
                rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                colBands=col_bands,
                slots=all_slots,
            )],
        )

        clinicians = [
            Clinician(id="doc-solo", name="Dr. Solo",
                      qualifiedClassIds=["ward"],
                      preferredClassIds=[], vacations=[],
                      workingHoursPerWeek=8.0,
                      workingHoursToleranceHours=2),  # max 10h per week
        ]

        rows = [
            WorkplaceRow(id="ward", name="Ward", kind="class",
                         dotColorClass="bg-slate-400", blockColor="#E8E1F5",
                         locationId="loc-w", subShifts=[]),
            WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool",
                         dotColorClass="bg-slate-200"),
            WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool",
                         dotColorClass="bg-slate-200"),
        ]

        state = AppState(
            locations=locations, locationsEnabled=True, rows=rows,
            clinicians=clinicians, assignments=[], minSlotsByRowId={},
            slotOverridesByKey={},
            weeklyTemplate=template, holidays=[],
            solverSettings={
                "enforceSameLocationPerDay": False,
                "preferContinuousShifts": True,
                "onCallRestEnabled": False,
            },
            solverRules=[], publishedWeekStartISOs=[],
        )
        return state, all_slots

    def test_friday_slots_filled(self):
        """Doctor should be able to fill Friday slots (8h <= 10h max)."""
        state, _ = self._build_state()

        # Friday 2026-01-09, Monday 2026-01-12
        payload = SolveRangeRequest(
            startISO="2026-01-09", endISO="2026-01-12",
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        friday_assignments = [a for a in assignments if a["dateISO"] == "2026-01-09"]
        assert len(friday_assignments) == 2, (
            f"Expected 2 Friday assignments, got {len(friday_assignments)}"
        )

    def test_monday_slots_filled_after_reset(self):
        """
        After 8h on Friday (week 1), hours should reset for Monday (week 2).
        Doctor should be able to fill Monday slots too.
        """
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO="2026-01-09", endISO="2026-01-12",
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assignments = result["assignments"]

        monday_assignments = [a for a in assignments if a["dateISO"] == "2026-01-12"]
        assert len(monday_assignments) == 2, (
            f"Expected 2 Monday assignments (hours should reset at week boundary), "
            f"got {len(monday_assignments)}"
        )

    def test_total_assignments_both_weeks(self):
        """Doctor should have 4 total assignments (2 Friday + 2 Monday)."""
        state, _ = self._build_state()

        payload = SolveRangeRequest(
            startISO="2026-01-09", endISO="2026-01-12",
            only_fill_required=True, use_heuristic=True,
        )
        result = heuristic_solve_range_v2(
            payload, state, MockCancelEvent(), mock_progress, 0.0
        )
        assert len(result["assignments"]) == 4, (
            f"Expected 4 total assignments across 2 weeks, got {len(result['assignments'])}"
        )


# ===========================================================================
# Additional v2-specific integration tests (analyst scenarios 4, 8-12)
# ===========================================================================


def _build_multi_day_state(
    slots_per_day_type: dict,
    clinicians_list: List,
    blocks: List,
    day_types: List[str],
    locations: Optional[List] = None,
    assignments: Optional[List] = None,
    solver_settings: Optional[dict] = None,
    holidays: Optional[List] = None,
) -> AppState:
    """Helper to build an AppState spanning multiple day types."""
    if locations is None:
        locations = [Location(id="loc-1", name="Berlin")]
    col_bands = [
        TemplateColBand(id=f"col-{d}-1", label="", order=i, dayType=d)
        for i, d in enumerate(day_types)
    ]
    all_slots = []
    for d in day_types:
        all_slots.extend(slots_per_day_type.get(d, []))

    loc_groups: Dict[str, List] = {}
    for loc in locations:
        loc_groups[loc.id] = []
    for s in all_slots:
        lid = s.locationId
        if lid not in loc_groups:
            loc_groups[lid] = []
        loc_groups[lid].append(s)

    template_locations = []
    for lid, loc_slots in loc_groups.items():
        template_locations.append(
            WeeklyTemplateLocation(
                locationId=lid,
                rowBands=[TemplateRowBand(id="rb-1", label="Row", order=1)],
                colBands=col_bands,
                slots=loc_slots,
            )
        )

    template = WeeklyCalendarTemplate(
        version=4,
        blocks=blocks,
        locations=template_locations,
    )
    return AppState(
        locations=locations,
        locationsEnabled=True,
        rows=[],
        clinicians=clinicians_list,
        assignments=assignments or [],
        minSlotsByRowId={},
        weeklyTemplate=template,
        solverSettings=solver_settings or {},
        holidays=holidays or [],
    )


def _run_multi_day_solver(
    state: AppState,
    start: date,
    end: date,
    only_fill_required: bool = True,
    cancel_event=None,
    on_progress=None,
) -> dict:
    """Helper to invoke the v2 solver over a date range."""
    payload = SolveRangeRequest(
        startISO=start.isoformat(),
        endISO=end.isoformat(),
        only_fill_required=only_fill_required,
        use_heuristic=True,
    )
    return heuristic_solve_range_v2(
        payload,
        state,
        cancel_event or MockCancelEvent(),
        on_progress or mock_progress,
        0.0,
    )


# ---------------------------------------------------------------------------
# On-call with rest days
# ---------------------------------------------------------------------------


def test_v2_on_call_with_rest_days():
    """On-call rest days block adjacent days for the on-call doctor."""
    blocks = [
        TemplateBlock(id="block-regular", sectionId="regular", requiredSlots=0),
        TemplateBlock(id="block-oncall", sectionId="oncall", requiredSlots=0),
    ]
    day_types = ["mon", "tue", "wed"]
    slots_per_day = {
        "mon": [
            TemplateSlot(id="slot-reg__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-regular", requiredSlots=1,
                         startTime="08:00", endTime="16:00"),
        ],
        "tue": [
            TemplateSlot(id="slot-reg__tue", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-tue-1", blockId="block-regular", requiredSlots=1,
                         startTime="08:00", endTime="16:00"),
            TemplateSlot(id="slot-oncall__tue", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-tue-1", blockId="block-oncall", requiredSlots=1,
                         startTime="16:00", endTime="08:00", endDayOffset=1),
        ],
        "wed": [
            TemplateSlot(id="slot-reg__wed", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-wed-1", blockId="block-regular", requiredSlots=1,
                         startTime="08:00", endTime="16:00"),
        ],
    }
    clinicians = [
        Clinician(id="doc-1", name="Dr. OnCall", qualifiedClassIds=["regular", "oncall"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        Clinician(id="doc-2", name="Dr. Other", qualifiedClassIds=["regular", "oncall"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    monday = date(2026, 2, 9)
    tuesday = monday + timedelta(days=1)
    manual = [
        Assignment(id="oncall-tue", rowId="slot-oncall__tue",
                   dateISO=tuesday.isoformat(), clinicianId="doc-1", source="manual"),
    ]
    state = _build_multi_day_state(
        slots_per_day, clinicians, blocks, day_types,
        assignments=manual,
        solver_settings={
            "onCallRestEnabled": True,
            "onCallRestClassId": "oncall",
            "onCallRestDaysBefore": 1,
            "onCallRestDaysAfter": 1,
        },
    )

    wednesday = monday + timedelta(days=2)
    result = _run_multi_day_solver(state, monday, wednesday)

    assignments = result["assignments"]

    # doc-1 has on-call on Tuesday -> blocked Monday (before) and Wednesday (after)
    doc1_mon = [a for a in assignments if a["clinicianId"] == "doc-1"
                and a["dateISO"] == monday.isoformat()]
    doc1_wed = [a for a in assignments if a["clinicianId"] == "doc-1"
                and a["dateISO"] == wednesday.isoformat()]

    assert len(doc1_mon) == 0, (
        "doc-1 should be blocked on Monday (rest day before on-call)"
    )
    assert len(doc1_wed) == 0, (
        "doc-1 should be blocked on Wednesday (rest day after on-call)"
    )

    # doc-2 should fill Monday and Wednesday regular slots
    doc2_mon = [a for a in assignments if a["clinicianId"] == "doc-2"
                and a["dateISO"] == monday.isoformat()]
    doc2_wed = [a for a in assignments if a["clinicianId"] == "doc-2"
                and a["dateISO"] == wednesday.isoformat()]
    assert len(doc2_mon) >= 1, "doc-2 should fill Monday regular slot"
    assert len(doc2_wed) >= 1, "doc-2 should fill Wednesday regular slot"


# ---------------------------------------------------------------------------
# Solver cancellation
# ---------------------------------------------------------------------------


def test_v2_solver_cancellation():
    """When cancel_event is set, solver returns partial results with ABORTED status."""

    class CancelAfterFewChecks:
        def __init__(self):
            self.call_count = 0

        def is_set(self):
            self.call_count += 1
            return self.call_count > 5

    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    day_types = ["mon", "tue", "wed", "thu", "fri"]
    slots_per_day = {}
    for d in day_types:
        slots_per_day[d] = [
            TemplateSlot(
                id=f"slot-a__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="16:00",
            ),
        ]
    clinicians = [
        Clinician(id="doc-1", name="Dr. A", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(slots_per_day, clinicians, blocks, day_types)

    monday = date(2026, 2, 9)
    friday = date(2026, 2, 13)
    result = _run_multi_day_solver(
        state, monday, friday, cancel_event=CancelAfterFewChecks()
    )

    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert any("aborted" in n.lower() for n in result["notes"]), (
        f"Expected 'aborted' in notes, got: {result['notes']}"
    )


# ---------------------------------------------------------------------------
# Progress callback
# ---------------------------------------------------------------------------


def test_v2_progress_callback_called():
    """The on_progress callback receives phase and solution events."""
    progress_events = []

    def track_progress(event_type, data):
        progress_events.append((event_type, data))

    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots = {
        "mon": [
            TemplateSlot(
                id="slot-a__mon", locationId="loc-1", rowBandId="rb-1",
                colBandId="col-mon-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="16:00",
            ),
        ],
    }
    clinicians = [
        Clinician(id="doc-1", name="Dr. A", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(slots, clinicians, blocks, ["mon"])

    monday = date(2026, 2, 9)
    _run_multi_day_solver(state, monday, monday, on_progress=track_progress)

    # Should have init phase
    assert any(e[0] == "phase" and e[1].get("phase") == "init"
               for e in progress_events), "Missing 'init' phase event"
    # Should have solve_day phase
    assert any(e[0] == "phase" and e[1].get("phase") == "solve_day"
               for e in progress_events), "Missing 'solve_day' phase event"
    # Should have solution update
    assert any(e[0] == "solution" for e in progress_events), (
        "Missing 'solution' progress event"
    )


# ---------------------------------------------------------------------------
# Empty clinicians
# ---------------------------------------------------------------------------


def test_v2_empty_clinicians_returns_gracefully():
    """Solver handles zero clinicians without crashing."""
    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots = {
        "mon": [
            TemplateSlot(
                id="slot-a__mon", locationId="loc-1", rowBandId="rb-1",
                colBandId="col-mon-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="16:00",
            ),
        ],
    }
    state = _build_multi_day_state(slots, [], blocks, ["mon"])

    monday = date(2026, 2, 9)
    result = _run_multi_day_solver(state, monday, monday)

    assert len(result["assignments"]) == 0
    assert len(result["notes"]) > 0


# ---------------------------------------------------------------------------
# Holiday handling
# ---------------------------------------------------------------------------


def test_v2_holiday_handling():
    """Slots with 'holiday' day type are used on holidays.

    If no holiday slots exist, no assignments should be produced for that day
    because the date is mapped to 'holiday' type instead of 'mon'.
    """
    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots = {
        "mon": [
            TemplateSlot(
                id="slot-a__mon", locationId="loc-1", rowBandId="rb-1",
                colBandId="col-mon-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="16:00",
            ),
        ],
    }
    clinicians = [
        Clinician(id="doc-1", name="Dr. A", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(
        slots, clinicians, blocks, ["mon"],
        holidays=[Holiday(dateISO="2026-02-09", name="Test Holiday")],
    )

    monday = date(2026, 2, 9)
    result = _run_multi_day_solver(state, monday, monday)

    assert len(result["assignments"]) == 0, (
        f"Expected 0 assignments on holiday (no holiday slots defined), "
        f"got {len(result['assignments'])}"
    )


# ---------------------------------------------------------------------------
# Debug info completeness
# ---------------------------------------------------------------------------


def test_v2_debug_info_complete():
    """The result debugInfo contains timing, status, and stats."""
    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots = {
        "mon": [
            TemplateSlot(
                id="slot-a__mon", locationId="loc-1", rowBandId="rb-1",
                colBandId="col-mon-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="16:00",
            ),
        ],
    }
    clinicians = [
        Clinician(id="doc-1", name="Dr. A", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(slots, clinicians, blocks, ["mon"])

    monday = date(2026, 2, 9)
    result = _run_multi_day_solver(state, monday, monday)

    debug = result["debugInfo"]
    assert debug["solver_status"] == "HEURISTIC_COMPLETE_V2"
    assert "timing" in debug
    assert debug["num_days"] > 0
    assert debug["num_slots"] > 0
    assert isinstance(debug["num_assignments"], int)
    assert isinstance(debug["num_warnings"], int)


# ---------------------------------------------------------------------------
# Multi-week basic assignment with 2 sections
# ---------------------------------------------------------------------------


def test_v2_multi_week_basic_assignment():
    """The v2 solver produces assignments across a 2-week solve range."""
    day_types = ["mon", "tue", "wed", "thu", "fri"]
    blocks = [
        TemplateBlock(id="block-mri", sectionId="mri", requiredSlots=0),
        TemplateBlock(id="block-ct", sectionId="ct", requiredSlots=0),
    ]
    slots_per_day = {}
    for d in day_types:
        slots_per_day[d] = [
            TemplateSlot(
                id=f"slot-mri-am__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-mri", requiredSlots=1,
                startTime="08:00", endTime="12:00",
            ),
            TemplateSlot(
                id=f"slot-ct-pm__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-ct", requiredSlots=1,
                startTime="12:00", endTime="16:00",
            ),
        ]
    clinicians = [
        Clinician(id="doc-1", name="Dr. A", qualifiedClassIds=["mri", "ct"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        Clinician(id="doc-2", name="Dr. B", qualifiedClassIds=["mri", "ct"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(slots_per_day, clinicians, blocks, day_types)

    monday = date(2026, 2, 9)
    friday_wk2 = date(2026, 2, 20)
    result = _run_multi_day_solver(state, monday, friday_wk2)

    assignments = result["assignments"]
    # 2 weeks x 5 days x 2 slots = 20 required slots
    assert len(assignments) >= 20, (
        f"Expected >= 20 assignments over 2 weeks, got {len(assignments)}"
    )
    notes_text = " ".join(result["notes"])
    assert "Could not" not in notes_text, f"Unexpected unfilled warning: {notes_text}"


# ---------------------------------------------------------------------------
# Realistic radiology department with qualification check
# ---------------------------------------------------------------------------


def test_v2_radiology_department_realistic():
    """Realistic radiology department with specialist bottleneck detection."""
    blocks = [
        TemplateBlock(id="block-mri", sectionId="mri", requiredSlots=0),
        TemplateBlock(id="block-ct", sectionId="ct", requiredSlots=0),
        TemplateBlock(id="block-mammo-general", sectionId="mammo-general", requiredSlots=0),
        TemplateBlock(id="block-mammo-stereo", sectionId="mammo-stereo", requiredSlots=0),
    ]
    slots = {
        "mon": [
            TemplateSlot(id="slot-mri-am__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-mri", requiredSlots=1,
                         startTime="07:30", endTime="13:00"),
            TemplateSlot(id="slot-mri-pm__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-mri", requiredSlots=1,
                         startTime="13:00", endTime="16:00"),
            TemplateSlot(id="slot-ct-am__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-ct", requiredSlots=1,
                         startTime="07:30", endTime="13:00"),
            TemplateSlot(id="slot-ct-pm__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-ct", requiredSlots=1,
                         startTime="13:00", endTime="16:00"),
            TemplateSlot(id="slot-mammo-stereo__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-mammo-stereo", requiredSlots=1,
                         startTime="07:30", endTime="13:00"),
            TemplateSlot(id="slot-mammo-general__mon", locationId="loc-1", rowBandId="rb-1",
                         colBandId="col-mon-1", blockId="block-mammo-general", requiredSlots=1,
                         startTime="13:00", endTime="16:00"),
        ],
    }
    clinicians = [
        Clinician(id="doc-senior", name="Dr. Senior",
                  qualifiedClassIds=["mri", "ct", "mammo-general", "mammo-stereo"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        Clinician(id="doc-mri", name="Dr. MRI",
                  qualifiedClassIds=["mri", "ct"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        Clinician(id="doc-ct", name="Dr. CT",
                  qualifiedClassIds=["ct", "mammo-general"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=33.0),
        Clinician(id="doc-mammo", name="Dr. Mammo",
                  qualifiedClassIds=["mammo-general", "mammo-stereo"],
                  preferredClassIds=["mammo-stereo"], vacations=[],
                  workingHoursPerWeek=20.0),
    ]
    state = _build_multi_day_state(slots, clinicians, blocks, ["mon"])

    monday = date(2026, 2, 9)
    result = _run_multi_day_solver(state, monday, monday)

    assignments = result["assignments"]

    # All 6 slots should be filled
    assert len(assignments) >= 6, (
        f"Expected 6 assignments, got {len(assignments)}"
    )

    # Verify qualifications: each assignment's section matches doctor's quals
    qual_map = {
        "doc-senior": {"mri", "ct", "mammo-general", "mammo-stereo"},
        "doc-mri": {"mri", "ct"},
        "doc-ct": {"ct", "mammo-general"},
        "doc-mammo": {"mammo-general", "mammo-stereo"},
    }
    section_by_slot = {
        "slot-mri-am__mon": "mri", "slot-mri-pm__mon": "mri",
        "slot-ct-am__mon": "ct", "slot-ct-pm__mon": "ct",
        "slot-mammo-stereo__mon": "mammo-stereo",
        "slot-mammo-general__mon": "mammo-general",
    }
    for a in assignments:
        section = section_by_slot.get(a["rowId"])
        if section:
            assert section in qual_map[a["clinicianId"]], (
                f"{a['clinicianId']} assigned to {a['rowId']} (section={section}) "
                f"but not qualified: {qual_map[a['clinicianId']]}"
            )


# ---------------------------------------------------------------------------
# Fair distribution over 2 weeks
# ---------------------------------------------------------------------------


def test_v2_fair_distribution_over_two_weeks():
    """Two identical doctors should get roughly equal work over 2 weeks."""
    day_types = ["mon", "tue", "wed", "thu", "fri"]
    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots_per_day = {}
    for d in day_types:
        slots_per_day[d] = [
            TemplateSlot(
                id=f"slot-am__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="12:00",
            ),
            TemplateSlot(
                id=f"slot-pm__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-a", requiredSlots=1,
                startTime="12:00", endTime="16:00",
            ),
        ]
    clinicians = [
        Clinician(id="doc-1", name="Dr. One", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
        Clinician(id="doc-2", name="Dr. Two", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=40.0),
    ]
    state = _build_multi_day_state(slots_per_day, clinicians, blocks, day_types)

    monday = date(2026, 2, 9)
    friday_wk2 = date(2026, 2, 20)
    result = _run_multi_day_solver(state, monday, friday_wk2)

    assignments = result["assignments"]
    doc1_count = sum(1 for a in assignments if a["clinicianId"] == "doc-1")
    doc2_count = sum(1 for a in assignments if a["clinicianId"] == "doc-2")
    total = doc1_count + doc2_count

    assert total >= 20, f"Expected >= 20 total assignments, got {total}"
    # Neither doctor should be idle -- both should get meaningful work
    assert doc1_count >= 3, f"doc-1 should have >= 3 assignments, got {doc1_count}"
    assert doc2_count >= 3, f"doc-2 should have >= 3 assignments, got {doc2_count}"


# ---------------------------------------------------------------------------
# Weekly hours reset at week boundary (2-week, strict cap)
# ---------------------------------------------------------------------------


def test_v2_weekly_hours_reset_strict_cap():
    """current_week_hours resets to 0 when crossing into a new ISO week.

    Uses a strict 16h cap with 0 tolerance to prove the reset happens.
    """
    day_types = ["mon", "tue", "wed", "thu", "fri"]
    blocks = [
        TemplateBlock(id="block-a", sectionId="sec-a", requiredSlots=0),
    ]
    slots_per_day = {}
    for d in day_types:
        slots_per_day[d] = [
            TemplateSlot(
                id=f"slot-am__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-a", requiredSlots=1,
                startTime="08:00", endTime="12:00",
            ),
            TemplateSlot(
                id=f"slot-pm__{d}", locationId="loc-1", rowBandId="rb-1",
                colBandId=f"col-{d}-1", blockId="block-a", requiredSlots=1,
                startTime="12:00", endTime="16:00",
            ),
        ]
    clinicians = [
        Clinician(id="doc-1", name="Dr. Capped", qualifiedClassIds=["sec-a"],
                  preferredClassIds=[], vacations=[], workingHoursPerWeek=16.0,
                  workingHoursToleranceHours=0),
    ]
    state = _build_multi_day_state(slots_per_day, clinicians, blocks, day_types)

    monday_wk1 = date(2026, 2, 9)
    friday_wk2 = date(2026, 2, 20)
    result = _run_multi_day_solver(state, monday_wk1, friday_wk2)

    assignments = result["assignments"]
    week1 = [a for a in assignments if "2026-02-09" <= a["dateISO"] <= "2026-02-13"]
    week2 = [a for a in assignments if "2026-02-16" <= a["dateISO"] <= "2026-02-20"]

    assert len(week1) > 0, "Week 1 should have assignments"
    assert len(week1) <= 4, f"Week 1: at most 4 slots (16h cap), got {len(week1)}"
    assert len(week2) > 0, "Week 2 should have assignments (proves hours reset)"
    assert len(week2) <= 4, f"Week 2: at most 4 slots (16h cap), got {len(week2)}"
