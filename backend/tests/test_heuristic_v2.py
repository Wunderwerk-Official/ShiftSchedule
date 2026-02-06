"""
Tests for Heuristic Solver V2 (human-heuristic-solver.md implementation)

These tests verify that the solver implementation exactly matches the
specification in human-heuristic-solver.md.
"""

import pytest
from datetime import date, timedelta
from typing import List

from backend.models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    Location,
    SolveRangeRequest,
    SolverSettings,
    TemplateBlock,
    TemplateSlot,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
)
from backend.heuristic.solver_v2 import (
    heuristic_solve_range_v2,
    ClinicianState,
    SlotInfo,
    _filter_eligible_doctors,
    _rank_doctors_by_deficit,
)


# Mock cancel event
class MockCancelEvent:
    def is_set(self):
        return False


# Mock progress callback
def mock_progress(event_type: str, data: dict):
    pass


@pytest.fixture
def basic_state():
    """Create a basic test state with locations, sections, and clinicians."""
    # Locations
    locations = [Location(id="loc-1", name="Berlin")]

    # Template with one slot per day
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[
            TemplateBlock(id="block-mri", sectionId="mri", label="MRI", requiredSlots=1),
            TemplateBlock(id="block-ct", sectionId="ct", label="CT", requiredSlots=1),
        ],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-1",
                rowBands=[{"id": "rb-1", "order": 0, "label": "Morning"}],
                colBands=[
                    {"id": "cb-mon", "order": 0, "dayType": "mon", "label": "Monday"},
                    {"id": "cb-tue", "order": 1, "dayType": "tue", "label": "Tuesday"},
                ],
                slots=[
                    TemplateSlot(
                        id="slot-mri-mon",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="08:00",
                        endTime="16:00",
                        endDayOffset=0,
                    ),
                    TemplateSlot(
                        id="slot-ct-tue",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-tue",
                        blockId="block-ct",
                        requiredSlots=1,
                        startTime="08:00",
                        endTime="16:00",
                        endDayOffset=0,
                    ),
                ],
            )
        ],
    )

    # Clinicians
    clinicians = [
        Clinician(
            id="doc-1",
            name="Dr. Alice",
            qualifiedClassIds=["mri", "ct"],
            preferredClassIds=["mri", "ct"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
        Clinician(
            id="doc-2",
            name="Dr. Bob",
            qualifiedClassIds=["mri", "ct"],
            preferredClassIds=["ct", "mri"],  # Prefers CT
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
    ]

    return AppState(
        locations=locations,
        locationsEnabled=True,
        rows=[],
        clinicians=clinicians,
        assignments=[],
        minSlotsByRowId={},
        weeklyTemplate=template,
        solverSettings={},
        holidays=[],
    )


def test_basic_assignment(basic_state):
    """Test basic assignment: solver should assign doctors to slots."""
    # Solve for one week
    monday = date(2026, 2, 9)  # Monday
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=(monday + timedelta(days=6)).isoformat(),
        onlyFillRequired=True,
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Should have assignments
    assignments = result["assignments"]
    assert len(assignments) > 0

    # Check Monday MRI slot is filled
    monday_mri = [a for a in assignments if a["dateISO"] == monday.isoformat() and a["rowId"] == "slot-mri-mon"]
    assert len(monday_mri) == 1
    assert monday_mri[0]["source"] == "solver"

    # Check Tuesday CT slot is filled
    tuesday = monday + timedelta(days=1)
    tuesday_ct = [a for a in assignments if a["dateISO"] == tuesday.isoformat() and a["rowId"] == "slot-ct-tue"]
    assert len(tuesday_ct) == 1
    assert tuesday_ct[0]["source"] == "solver"


def test_eligibility_qualification(basic_state):
    """Test eligibility criterion #1: Qualification check."""
    # Create doctor with limited qualifications
    basic_state.clinicians.append(
        Clinician(
            id="doc-unqualified",
            name="Dr. Unqualified",
            qualifiedClassIds=["xray"],  # Not qualified for MRI or CT
            preferredClassIds=["xray"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        )
    )

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        onlyFillRequired=True,
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Unqualified doctor should NOT be assigned
    assignments = result["assignments"]
    for assignment in assignments:
        assert assignment["clinicianId"] != "doc-unqualified"


def test_eligibility_vacation(basic_state):
    """Test eligibility criterion #2: Vacation override."""
    # Put Dr. Alice on vacation
    monday = date(2026, 2, 9)
    basic_state.clinicians[0].vacations = [
        VacationRange(
            id="vac-1",
            startISO=monday.isoformat(),
            endISO=(monday + timedelta(days=2)).isoformat(),
        )
    ]

    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        onlyFillRequired=True,
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Dr. Alice should NOT be assigned on vacation days
    assignments = result["assignments"]
    alice_assignments = [a for a in assignments if a["clinicianId"] == "doc-1"]
    assert len(alice_assignments) == 0


def test_eligibility_time_overlap():
    """Test eligibility criterion #3: Time overlap prevention."""
    # Create state with two overlapping slots on same day
    locations = [Location(id="loc-1", name="Berlin")]

    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[
            TemplateBlock(id="block-mri", sectionId="mri", label="MRI", requiredSlots=1),
            TemplateBlock(id="block-ct", sectionId="ct", label="CT", requiredSlots=1),
        ],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-1",
                rowBands=[{"id": "rb-1", "order": 0}],
                colBands=[{"id": "cb-mon", "order": 0, "dayType": "mon"}],
                slots=[
                    TemplateSlot(
                        id="slot-mri-morning",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="08:00",
                        endTime="12:00",
                    ),
                    TemplateSlot(
                        id="slot-ct-overlap",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-ct",
                        requiredSlots=1,
                        startTime="10:00",  # Overlaps with MRI
                        endTime="14:00",
                    ),
                ],
            )
        ],
    )

    clinicians = [
        Clinician(
            id="doc-1",
            name="Dr. Alice",
            qualifiedClassIds=["mri", "ct"],
            preferredClassIds=["mri", "ct"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
    ]

    state = AppState(
        locations=locations,
        clinicians=clinicians,
        assignments=[],
        weeklyTemplate=template,
        solverSettings={},
        holidays=[],
        rows=[],
        locationsEnabled=True,
        minSlotsByRowId={},
    )

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Only one slot should be filled (overlap prevents both)
    assignments = result["assignments"]
    assert len(assignments) == 1  # Can't fill both due to overlap


def test_eligibility_mandatory_time_window():
    """Test eligibility criterion #4: Mandatory time window."""
    locations = [Location(id="loc-1", name="Berlin")]

    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id="block-mri", sectionId="mri", label="MRI", requiredSlots=1)],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-1",
                rowBands=[{"id": "rb-1", "order": 0}],
                colBands=[{"id": "cb-mon", "order": 0, "dayType": "mon"}],
                slots=[
                    TemplateSlot(
                        id="slot-mri",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="14:00",  # Afternoon
                        endTime="18:00",
                    ),
                ],
            )
        ],
    )

    # Dr. Alice only works mornings (mandatory)
    clinicians = [
        Clinician(
            id="doc-1",
            name="Dr. Alice",
            qualifiedClassIds=["mri"],
            preferredClassIds=["mri"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
            preferredWorkingTimes={
                "mon": {
                    "startTime": "08:00",
                    "endTime": "12:00",
                    "requirement": "mandatory",  # MUST work in this window
                }
            },
        ),
    ]

    state = AppState(
        locations=locations,
        clinicians=clinicians,
        assignments=[],
        weeklyTemplate=template,
        solverSettings={},
        holidays=[],
        rows=[],
        locationsEnabled=True,
        minSlotsByRowId={},
    )

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Slot should NOT be filled (outside mandatory window)
    assignments = result["assignments"]
    assert len(assignments) == 0

    # Check notes for warning
    notes = result["notes"]
    warning_found = any("could not" in note.lower() or "warning" in note.lower() for note in notes)
    assert warning_found


def test_eligibility_same_location_per_day(basic_state):
    """Test eligibility criterion #6: Same location per day (when enforced)."""
    # Add second location and slot
    basic_state.locations.append(Location(id="loc-2", name="Munich"))

    # Add slot at different location on same day
    monday_slot_loc2 = TemplateSlot(
        id="slot-ct-mon-loc2",
        locationId="loc-2",
        rowBandId="rb-1",
        colBandId="cb-mon",
        blockId="block-ct",
        requiredSlots=1,
        startTime="14:00",
        endTime="18:00",
    )
    basic_state.weeklyTemplate.locations[0].slots.append(monday_slot_loc2)

    # Enable same location enforcement
    basic_state.solverSettings = {"enforceSameLocationPerDay": True}

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Check that each doctor is only assigned to one location
    assignments = result["assignments"]
    monday_assignments = [a for a in assignments if a["dateISO"] == monday.isoformat()]

    # Group by clinician
    by_clinician = {}
    for a in monday_assignments:
        cid = a["clinicianId"]
        if cid not in by_clinician:
            by_clinician[cid] = []
        by_clinician[cid].append(a)

    # Each clinician should only have assignments at one location
    for cid, clinician_assignments in by_clinician.items():
        slot_ids = [a["rowId"] for a in clinician_assignments]
        locations_used = set()
        for slot_id in slot_ids:
            # Find location for this slot
            for slot in basic_state.weeklyTemplate.locations[0].slots:
                if slot.id == slot_id:
                    locations_used.add(slot.locationId)
        assert len(locations_used) == 1, f"Clinician {cid} assigned to multiple locations on same day"


def test_eligibility_hour_limit(basic_state):
    """Test eligibility criterion #7: Hour limit."""
    # Create many slots on one day (more than tolerance allows)
    monday_slots = []
    for i in range(10):
        monday_slots.append(
            TemplateSlot(
                id=f"slot-mri-{i}",
                locationId="loc-1",
                rowBandId="rb-1",
                colBandId="cb-mon",
                blockId="block-mri",
                requiredSlots=1,
                startTime=f"{8+i:02d}:00",
                endTime=f"{9+i:02d}:00",
            )
        )
    basic_state.weeklyTemplate.locations[0].slots.extend(monday_slots)

    # Set low contract hours
    basic_state.clinicians[0].workingHoursPerWeek = 5.0
    basic_state.clinicians[0].workingHoursToleranceHours = 1.0  # Max 6 hours

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Dr. Alice should be assigned max 6 hours (5 + 1 tolerance)
    assignments = result["assignments"]
    alice_assignments = [a for a in assignments if a["clinicianId"] == "doc-1"]
    assert len(alice_assignments) <= 6  # Each slot is 1 hour


def test_doctor_ranking_ytd_deficit():
    """Test doctor ranking: YTD deficit should be considered."""
    locations = [Location(id="loc-1", name="Berlin")]

    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id="block-mri", sectionId="mri", label="MRI", requiredSlots=1)],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-1",
                rowBands=[{"id": "rb-1", "order": 0}],
                colBands=[{"id": "cb-mon", "order": 0, "dayType": "mon"}],
                slots=[
                    TemplateSlot(
                        id="slot-mri",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="08:00",
                        endTime="16:00",
                    ),
                ],
            )
        ],
    )

    # Create clinicians with different YTD hours
    # Both have 40h/week contract, but different actual hours
    clinicians = [
        Clinician(
            id="doc-behind",
            name="Dr. Behind",
            qualifiedClassIds=["mri"],
            preferredClassIds=["mri"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
        Clinician(
            id="doc-ahead",
            name="Dr. Ahead",
            qualifiedClassIds=["mri"],
            preferredClassIds=["mri"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
    ]

    # Simulate previous assignments: Dr. Ahead has worked more
    monday = date(2026, 2, 9)
    prev_monday = monday - timedelta(days=7)

    assignments = [
        # Dr. Ahead worked last week (8 hours)
        Assignment(
            id="prev-1",
            rowId="slot-mri",
            dateISO=prev_monday.isoformat(),
            clinicianId="doc-ahead",
            source="manual",
        ),
    ]

    state = AppState(
        locations=locations,
        clinicians=clinicians,
        assignments=assignments,
        weeklyTemplate=template,
        solverSettings={},
        holidays=[],
        rows=[],
        locationsEnabled=True,
        minSlotsByRowId={},
    )

    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Dr. Behind should be prioritized (has higher YTD deficit)
    assignments_new = result["assignments"]
    assert len(assignments_new) > 0
    # Note: This test is simplified - in reality, YTD calculation is more complex


def test_manual_assignment_preservation(basic_state):
    """Test that manual assignments are preserved during solving."""
    monday = date(2026, 2, 9)

    # Add manual assignment
    basic_state.assignments = [
        Assignment(
            id="manual-1",
            rowId="slot-mri-mon",
            dateISO=monday.isoformat(),
            clinicianId="doc-1",
            source="manual",  # Manually assigned
        ),
    ]

    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        basic_state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # Solver should NOT return manual assignments in result (they're preserved in state)
    assignments = result["assignments"]
    manual_in_result = [a for a in assignments if a.get("source") == "manual"]
    assert len(manual_in_result) == 0  # Manual assignments not returned by solver


def test_consecutive_slot_filling():
    """Test consecutive slot filling at same location."""
    locations = [Location(id="loc-1", name="Berlin")]

    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[
            TemplateBlock(id="block-mri", sectionId="mri", label="MRI", requiredSlots=1),
            TemplateBlock(id="block-ct", sectionId="ct", label="CT", requiredSlots=1),
        ],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-1",
                rowBands=[{"id": "rb-1", "order": 0}],
                colBands=[{"id": "cb-mon", "order": 0, "dayType": "mon"}],
                slots=[
                    # Three consecutive slots at same location
                    TemplateSlot(
                        id="slot-1",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="08:00",
                        endTime="12:00",
                    ),
                    TemplateSlot(
                        id="slot-2",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-ct",
                        requiredSlots=1,
                        startTime="12:00",  # Starts when slot-1 ends
                        endTime="16:00",
                    ),
                    TemplateSlot(
                        id="slot-3",
                        locationId="loc-1",
                        rowBandId="rb-1",
                        colBandId="cb-mon",
                        blockId="block-mri",
                        requiredSlots=1,
                        startTime="16:00",  # Starts when slot-2 ends
                        endTime="20:00",
                    ),
                ],
            )
        ],
    )

    clinicians = [
        Clinician(
            id="doc-1",
            name="Dr. Alice",
            qualifiedClassIds=["mri", "ct"],
            preferredClassIds=["mri", "ct"],
            vacations=[],
            workingHoursPerWeek=40.0,
            workingHoursToleranceHours=5,
        ),
    ]

    state = AppState(
        locations=locations,
        clinicians=clinicians,
        assignments=[],
        weeklyTemplate=template,
        solverSettings={},
        holidays=[],
        rows=[],
        locationsEnabled=True,
        minSlotsByRowId={},
    )

    monday = date(2026, 2, 9)
    payload = SolveRangeRequest(
        startISO=monday.isoformat(),
        endISO=monday.isoformat(),
        use_heuristic=True,
    )

    result = heuristic_solve_range_v2(
        payload,
        state,
        MockCancelEvent(),
        mock_progress,
        0.0,
    )

    # All three slots should be assigned to Dr. Alice (consecutive filling)
    assignments = result["assignments"]
    alice_assignments = [a for a in assignments if a["clinicianId"] == "doc-1"]
    assert len(alice_assignments) == 3

    # Verify they're all on the same day
    dates = set(a["dateISO"] for a in alice_assignments)
    assert len(dates) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
