# Solver Testing Guide

This document explains the testing infrastructure for the shift scheduler solver, including dedicated fixtures that mimic real-world radiology department setups.

---

## Quick Start

```bash
# Run all solver tests (the glob also picks up test_solver_benchmark.py,
# ~7 min, which CI skips; add --ignore=backend/tests/test_solver_benchmark.py)
python3 -m pytest backend/tests/test_solver*.py -v

# Run just the continuity tests
python3 -m pytest backend/tests/test_solver_continuity.py -v

# Run a specific test
python3 -m pytest backend/tests/test_solver_continuity.py::TestMartinLikeFixture::test_martin_like_monday_no_gaps -v
```

---

## Test Files Overview

| File | Purpose |
|------|---------|
| `test_solver.py` | Core solver functionality (qualifications, vacations, overlaps, etc.) |
| `test_solver_continuity.py` | Continuity constraint tests (no split shifts) |
| `test_solver_coverage.py` | Coverage tests (required slots, multi-slot, working hours) |
| `test_solver_preferences.py` | Time window preferences and hours distribution |
| `test_solver_time.py` | Time parsing and interval handling |
| `test_solver_monitor.py` | Background-run monitor end states: watchdog kill, salvaged plans stored as `aborted`, torn queue messages, agent spend recorded once (v1.64; fake processes, no CP-SAT) |
| `test_solver_run_endpoints.py` | `POST /v1/solve/range` date validation (422), discard 409s, draft apply replacing vacation-hidden solver rows (v1.64) |
| `fixtures_martin_like.py` | Realistic test fixtures mimicking Martin's radiology department |
| `conftest.py` | Shared pytest fixtures and factory functions |

---

## Constraint Types

The solver uses two types of constraints:

### HARD Constraints (Must be satisfied)

| Constraint | Description | Test File |
|------------|-------------|-----------|
| **Qualifications** | Clinicians can only be assigned to sections they are qualified for | `test_solver.py`, `test_solver_coverage.py` |
| **No Overlaps** | A clinician cannot be assigned to overlapping time slots | `test_solver.py` |
| **Vacations** | Clinicians on vacation cannot be assigned | `test_solver.py` |
| **Location per Day** | When enabled, clinician stays at one location per day | `test_solver.py` |

### SOFT Constraints (Best effort)

| Constraint | Description | Test File |
|------------|-------------|-----------|
| **Working Hours** | Distribute work according to `workingHoursPerWeek` | `test_solver_coverage.py` |
| **Continuity** | Prefer continuous shifts (no gaps) | `test_solver_continuity.py` |
| **Preferences** | Prefer clinician's preferred sections | `test_solver_preferences.py` |
| **Time Windows** | Respect mandatory/preferred time windows | `test_solver_preferences.py` |

**Note:** Soft constraints are enforced as penalties in the objective function. The solver tries to satisfy them but may not always succeed, especially when:
- There aren't enough qualified clinicians
- Required slots conflict with soft constraints
- Capacity is limited

---

## Using the Martin-Like Fixtures

The `fixtures_martin_like.py` module provides realistic test data without needing to access real user data.

### Basic Usage

```python
from backend.tests.fixtures_martin_like import (
    make_martin_like_state,
    get_slot_times,
    check_for_gaps,
)

# Create a state for Monday only
state = make_martin_like_state(day_types=["mon"])

# Create a state for the full work week
state = make_martin_like_state(day_types=["mon", "tue", "wed", "thu", "fri"])

# Include vacation data for edge case testing
state = make_martin_like_state(day_types=["mon"], include_vacations=True)
```

### What's Included

The fixture creates a realistic radiology department:

**Locations (2):**
- Main Campus (loc-main-campus)
- North Wing (loc-north-wing)

**Clinicians (8):**
| ID | Name | Specialization |
|----|------|----------------|
| clin-chen | Dr. Sarah Chen | Senior, broad qualifications |
| clin-patel | Dr. Raj Patel | Senior, cardiac focus |
| clin-johnson | Dr. Emily Johnson | Senior, mammography focus |
| clin-williams | Dr. Michael Williams | Junior, CT/Ultrasound |
| clin-garcia | Dr. Maria Garcia | Junior, North Wing focus |
| clin-kim | Dr. James Kim | Junior, neuro focus |
| clin-nguyen | Dr. Lisa Nguyen | Specialist, cardiac MRI |
| clin-brown | Dr. David Brown | Specialist, mammography |

**Sections (20+):**
- CT General MC, CT Interventional MC
- MRI Neuro MC, MRI General MC, MRI Cardiac MC
- Ultrasound General MC
- Mammography General MC, Mammography Stereo MC
- CT General NW, CT Biopsy NW
- MRI General NW, MRI Breast NW, MRI Neuro NW
- Ultrasound General NW, Mammography General NW
- Morning Rounds, MDT meetings, On-call shifts

**Time Patterns:**
| Slot Type | Time | Notes |
|-----------|------|-------|
| Morning Rounds | 06:30-07:30 | Main Campus & North Wing |
| Morning | 07:30-13:00 | Main Campus |
| Morning | 07:30-11:30 | North Wing |
| Midday | 11:30-15:30 | North Wing only |
| Afternoon | 13:00-16:00 | Main Campus |
| Afternoon | 15:30-19:00 | North Wing |
| Evening | 16:00-19:00 | Main Campus |

### Checking for Gaps

```python
from backend.tests.fixtures_martin_like import get_slot_times, check_for_gaps

# After running the solver
slot_times = get_slot_times(state)
gaps = check_for_gaps(response.assignments, slot_times, "2026-01-05")

if gaps:
    for gap in gaps:
        print(f"{gap['clinician']}: {gap['gap_hours']}h gap between {gap['slot1']} and {gap['slot2']}")
```

---

## Writing New Solver Tests

### Template for Continuity Tests

```python
from backend.models import SolveRangeRequest, UserPublic
from backend.solver import _solve_range_impl
from backend.tests.fixtures_martin_like import (
    make_martin_like_state,
    get_slot_times,
    check_for_gaps,
)

TEST_USER = UserPublic(username="test", role="user", active=True)
TEST_DATE = "2026-01-05"  # Monday

def test_my_scenario(monkeypatch) -> None:
    """Description of what this test verifies."""
    # 1. Create state
    state = make_martin_like_state(day_types=["mon"])

    # 2. Mock the state loader
    monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

    # 3. Run solver
    response = _solve_range_impl(
        SolveRangeRequest(
            startISO=TEST_DATE,
            endISO=TEST_DATE,
            only_fill_required=True,  # or False for "Distribute All" mode
        ),
        current_user=TEST_USER,
    )

    # 4. Check for gaps
    slot_times = get_slot_times(state)
    gaps = check_for_gaps(response.assignments, slot_times, TEST_DATE)

    assert len(gaps) == 0, f"Found gaps: {gaps}"
```

### Template for Custom Slot Tests

```python
from backend.models import (
    AppState, Location, TemplateSlot, TemplateBlock,
    TemplateRowBand, TemplateColBand, WeeklyCalendarTemplate,
    WeeklyTemplateLocation, WorkplaceRow, Clinician,
)
from backend.tests.conftest import make_clinician, make_pool_row

def test_custom_scenario(monkeypatch) -> None:
    """Test with custom slot configuration."""

    # Create clinicians
    clinicians = [
        make_clinician("clin-1", "Dr. Alice", qualified_class_ids=["section-a"]),
        make_clinician("clin-2", "Dr. Bob", qualified_class_ids=["section-a", "section-b"]),
    ]

    # Create slots
    slots = [
        TemplateSlot(
            id="slot-1__mon",
            locationId="loc-default",
            rowBandId="row-1",
            colBandId="col-mon-1",
            blockId="block-a",
            requiredSlots=1,
            startTime="08:00",
            endTime="12:00",
            endDayOffset=0,
        ),
        # Add more slots...
    ]

    # Build full state (see _build_continuity_test_state in test_solver_continuity.py)
    state = _build_continuity_test_state(clinicians, slots, solver_settings)

    monkeypatch.setattr("backend.solver._load_state", lambda _user_id: state)

    # Run and verify...
```

---

## Solver Settings Reference

When creating test states, these solver settings control behavior:

```python
solver_settings = {
    # Require clinicians to stay at one location per day
    "enforceSameLocationPerDay": True,

    # Prevent gaps between shifts (split shifts)
    "preferContinuousShifts": True,

    # Block day before/after on-call shifts
    "onCallRestEnabled": False,
    "onCallRestClassId": "garde-hk",
    "onCallRestDaysBefore": 1,
    "onCallRestDaysAfter": 1,
}
```

---

## Test Categories

### 1. Basic Continuity (`TestContinuityBasic`)
- Gap prevention with non-required middle slots
- Filling continuous blocks

### 2. Multiple Clinicians (`TestContinuityMultipleClinicians`)
- Each clinician maintains their own continuous block

### 3. Manual Assignments (`TestContinuityWithManualAssignments`)
- Solver extends existing manual assignments continuously

### 4. Overnight Shifts (`TestContinuityOvernightShifts`)
- Handling `endDayOffset=1` for shifts crossing midnight

### 5. Realistic Scenarios (`TestContinuityRealisticScenario`)
- Multiple sections (MRI, CT) at same location
- Matching real Kirchberg/Zitha patterns

### 6. Real-World Gap Reproductions (`TestContinuityRealWorldGap`)
- Exact reproductions of gaps observed in production
- Multiple clinicians competing for bridge slots

### 7. Distribute All Mode (`TestContinuityDistributeAllMode`)
- Testing `only_fill_required=False` mode

### 8. Martin-Like Fixture (`TestMartinLikeFixture`)
- Full realistic setup with 8 clinicians, 2 locations
- Single day, full week, with vacations

### 9. Disabled Continuity (`TestContinuityDisabled`)
- Verifying gaps are allowed when constraint is off

### 10. Required Slots Coverage (`TestRequiredSlotsCoverage`)
- All required slots get filled when possible
- Warning when slots cannot be filled

### 11. Multi-Slot Coverage (`TestMultiSlotCoverage`)
- Slots requiring multiple people (`requiredSlots > 1`)
- Partial filling when not enough clinicians available

### 12. Working Hours (`TestWorkingHoursConstraint`)
- Respecting `workingHoursPerWeek` limits
- Part-time vs full-time distribution
- Behavior when exceeding hours limits (soft constraint)

### 13. Qualifications (`TestQualificationsHardConstraint`)
- Only qualified clinicians get assigned (hard constraint)
- Unqualified slots remain empty

### 14. Multi-Week Scenarios (`TestMultiWeekScenarios`)
- **3-week scheduling** (15 working days)
- No gaps across all days
- Working hours distribution over multiple weeks
- Required slots coverage over time
- Distribute All mode over 3 weeks
- Vacations across multiple weeks
- Qualifications respected over time

### 15. Multi-Week Working Hours (`TestMultiWeekWorkingHours`)
- Fair distribution between clinicians with same hours
- Part-time vs full-time ratio over 3 weeks
- Coverage consistency over time

---

## Key Findings

The solver's constraints **work correctly**. Testing revealed:

1. **No bugs in current solver** - All solver tests pass
2. **Continuity works** - No split shifts when `preferContinuousShifts=True`
3. **Multi-week works** - 3-week schedules solve correctly (~3 minutes)
4. **Historical gaps** - Gaps in existing data were created by older solver versions
5. **Hard constraints enforced** - Qualifications, overlaps, and vacations are always respected
6. **Soft constraints optimized** - Working hours and preferences are best-effort

The continuity constraint enforces `max_blocks = 1` per clinician per day per location, meaning each clinician can only have one continuous work block (no gaps).

**Multi-week performance**: A full 3-week solve (15 days, 8 clinicians, 2 locations) completes in ~140 seconds.

---

## Debugging Tips

### Print Assignments
```python
for a in response.assignments:
    if a.dateISO == TEST_DATE:
        print(f"{a.clinicianId}: {a.rowId}")
```

### Print Gaps
```python
gaps = check_for_gaps(response.assignments, slot_times, TEST_DATE)
for gap in gaps:
    print(f"Gap: {gap['clinician']} has {gap['gap_hours']:.1f}h gap")
```

### Check Solver Notes
```python
print(response.notes)  # Solver status messages
print(response.debugInfo.solver_status)  # OPTIMAL, FEASIBLE, INFEASIBLE
```

---

## Related Files

- [TEST_PLAN.md](../../TEST_PLAN.md) - Overall test strategy for the application
- [solver.py](../solver.py) - The CP-SAT solver implementation
- [models.py](../models.py) - Pydantic models for AppState, Clinician, etc.
