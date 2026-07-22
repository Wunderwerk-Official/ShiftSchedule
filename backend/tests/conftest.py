"""Shared pytest fixtures for backend tests."""

from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    Location,
    MinSlots,
    SolverSettings,
    SubShift,
    TemplateBlock,
    TemplateColBand,
    TemplateRowBand,
    TemplateSlot,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
    WorkplaceRow,
)

DAY_TYPES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday")


# -----------------------------------------------------------------------------
# Factory functions for test data creation
# -----------------------------------------------------------------------------


def make_clinician(
    clinician_id: str = "clin-1",
    name: str = "Dr. Alice",
    qualified_class_ids: Optional[List[str]] = None,
    preferred_class_ids: Optional[List[str]] = None,
    vacations: Optional[List[VacationRange]] = None,
    working_hours_per_week: Optional[float] = None,
    planning_wishes: Optional[str] = None,
) -> Clinician:
    """Create a test clinician with sensible defaults."""
    return Clinician(
        id=clinician_id,
        name=name,
        qualifiedClassIds=qualified_class_ids or ["section-a"],
        preferredClassIds=preferred_class_ids or [],
        vacations=vacations or [],
        workingHoursPerWeek=working_hours_per_week,
        planningWishes=planning_wishes,
    )


def make_location(location_id: str = "loc-default", name: str = "Berlin") -> Location:
    """Create a test location."""
    return Location(id=location_id, name=name)


def make_workplace_row(
    row_id: str = "section-a",
    name: str = "Section A",
    kind: str = "class",
    location_id: str = "loc-default",
    sub_shifts: Optional[List[SubShift]] = None,
) -> WorkplaceRow:
    """Create a test workplace row."""
    if sub_shifts is None:
        sub_shifts = [
            SubShift(
                id="s1",
                name="Shift 1",
                order=1,
                startTime="08:00",
                endTime="16:00",
                endDayOffset=0,
            )
        ]
    return WorkplaceRow(
        id=row_id,
        name=name,
        kind=kind,
        dotColorClass="bg-slate-400",
        blockColor="#E8E1F5",
        locationId=location_id,
        subShifts=sub_shifts,
    )


def make_pool_row(row_id: str, name: str) -> WorkplaceRow:
    """Create a pool row (rest day, vacation, etc.)."""
    return WorkplaceRow(
        id=row_id,
        name=name,
        kind="pool",
        dotColorClass="bg-slate-200",
    )


def make_template_slot(
    slot_id: str = "slot-1",
    location_id: str = "loc-default",
    row_band_id: str = "row-1",
    col_band_id: str = "col-mon-1",
    block_id: str = "block-a",
    required_slots: int = 1,
    start_time: str = "08:00",
    end_time: str = "16:00",
    end_day_offset: int = 0,
) -> TemplateSlot:
    """Create a test template slot."""
    return TemplateSlot(
        id=slot_id,
        locationId=location_id,
        rowBandId=row_band_id,
        colBandId=col_band_id,
        blockId=block_id,
        requiredSlots=required_slots,
        startTime=start_time,
        endTime=end_time,
        endDayOffset=end_day_offset,
    )


def make_template_col_band(
    col_band_id: str = "col-mon-1",
    label: str = "",
    order: int = 1,
    day_type: str = "mon",
) -> TemplateColBand:
    """Create a test column band."""
    return TemplateColBand(
        id=col_band_id,
        label=label,
        order=order,
        dayType=day_type,
    )


def make_assignment(
    assignment_id: str = "assign-1",
    row_id: str = "slot-1",
    date_iso: str = "2026-01-05",
    clinician_id: str = "clin-1",
    source: Optional[str] = None,
) -> Assignment:
    """Create a test assignment."""
    return Assignment(
        id=assignment_id,
        rowId=row_id,
        dateISO=date_iso,
        clinicianId=clinician_id,
        source=source,
    )


def make_app_state(
    clinicians: Optional[List[Clinician]] = None,
    slots: Optional[List[TemplateSlot]] = None,
    col_bands: Optional[List[TemplateColBand]] = None,
    rows: Optional[List[WorkplaceRow]] = None,
    assignments: Optional[List[Assignment]] = None,
    solver_settings: Optional[Dict[str, Any]] = None,
    holidays: Optional[List[Holiday]] = None,
    published_week_start_isos: Optional[List[str]] = None,
) -> AppState:
    """
    Create a fully configured AppState for testing.

    This is the primary factory function for creating test states.
    It sets up a valid template structure with sensible defaults.
    """
    location = make_location()

    if rows is None:
        rows = [
            make_workplace_row(),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ]

    if clinicians is None:
        clinicians = [make_clinician()]

    if col_bands is None:
        col_bands = [make_template_col_band(f"col-{day_type}-1", "", 1, day_type) for day_type in DAY_TYPES]

    if slots is None:
        slots = [
            make_template_slot(
                slot_id="slot-a__mon",
                col_band_id="col-mon-1",
            )
        ]

    if solver_settings is None:
        solver_settings = {
            "enforceSameLocationPerDay": False,
            "onCallRestEnabled": False,
            "onCallRestClassId": "",
            "onCallRestDaysBefore": 1,
            "onCallRestDaysAfter": 1,
            "workingHoursToleranceHours": 5,
        }

    # Build template structure
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[
            TemplateBlock(
                id="block-a",
                sectionId="section-a",
                requiredSlots=0,
            )
        ],
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
        holidays=holidays or [],
        solverSettings=solver_settings,
        solverRules=[],
        publishedWeekStartISOs=published_week_start_isos or [],
    )


def make_state_with_deprecated_pools() -> AppState:
    """
    Create an AppState with deprecated Distribution Pool and Reserve Pool rows.

    Used for testing migration/normalization logic that removes these pools.
    """
    location = make_location()
    rows = [
        make_workplace_row(),
        make_pool_row("pool-not-allocated", "Distribution Pool"),  # DEPRECATED
        make_pool_row("pool-manual", "Reserve Pool"),  # DEPRECATED
        make_pool_row("pool-rest-day", "Rest Day"),
        make_pool_row("pool-vacation", "Vacation"),
    ]
    clinicians = [make_clinician()]

    # Include assignments to deprecated pools
    assignments = [
        make_assignment("assign-1", "pool-not-allocated", "2026-01-05", "clin-1"),
        make_assignment("assign-2", "pool-manual", "2026-01-05", "clin-1"),
    ]

    col_bands = [make_template_col_band(f"col-{day_type}-1", "", 1, day_type) for day_type in DAY_TYPES]
    slots = [make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1")]

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

    # Include deprecated solver settings
    solver_settings = {
        "allowMultipleShiftsPerDay": True,  # DEPRECATED
        "showDistributionPool": True,  # DEPRECATED
        "showReservePool": True,  # DEPRECATED
        "enforceSameLocationPerDay": False,
        "onCallRestEnabled": False,
        "workingHoursToleranceHours": 5,
    }

    return AppState(
        locations=[location],
        locationsEnabled=True,
        rows=rows,
        clinicians=clinicians,
        assignments=assignments,
        minSlotsByRowId={},
        slotOverridesByKey={},
        weeklyTemplate=template,
        holidays=[],
        solverSettings=solver_settings,
        solverRules=[],
        publishedWeekStartISOs=[],
    )


# -----------------------------------------------------------------------------
# Pytest fixtures
# -----------------------------------------------------------------------------


@pytest.fixture
def default_clinician() -> Clinician:
    """Single clinician with basic qualifications."""
    return make_clinician()


@pytest.fixture
def default_state(default_clinician: Clinician) -> AppState:
    """Minimal valid AppState with one clinician and one slot."""
    return make_app_state(clinicians=[default_clinician])


@pytest.fixture
def state_with_deprecated_pools() -> AppState:
    """State containing Distribution and Reserve pools for migration testing."""
    return make_state_with_deprecated_pools()


@pytest.fixture
def test_client() -> TestClient:
    """FastAPI test client."""
    return TestClient(app)


def solve_via_endpoint(client, payload: dict, timeout_s: float = 120.0) -> dict:
    """POST /v1/solve/range (async since v1.43: returns a run id instantly)
    and poll the run record until it leaves 'running'. Returns the full run
    dict including the stored result."""
    import time as _time

    res = client.post("/v1/solve/range", json=payload)
    assert res.status_code == 200, res.text
    run_id = res.json()["run_id"]
    deadline = _time.time() + timeout_s
    while _time.time() < deadline:
        run = client.get(f"/v1/solve/runs/{run_id}")
        assert run.status_code == 200, run.text
        body = run.json()
        if body["status"] != "running":
            return body
        _time.sleep(0.2)
    raise AssertionError(f"Run {run_id} still running after {timeout_s}s")
