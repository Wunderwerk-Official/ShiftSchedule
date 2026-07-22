from backend.models import Clinician
from backend.state import _default_state, _normalize_state


def test_solver_settings_tolerance_defaulted() -> None:
    state = _default_state()
    state.solverSettings = {}  # Empty settings - deprecated keys were removed
    normalized, _changed = _normalize_state(state)
    assert normalized.solverSettings["workingHoursToleranceHours"] == 5


def test_preferred_working_times_invalid_normalizes_to_default_times() -> None:
    state = _default_state()
    # _default_state() returns empty clinicians list, so we need to add one
    state.clinicians.append(
        Clinician(id="c1", name="Test Clinician", qualifiedClassIds=[], vacations=[])
    )
    state.clinicians[0].preferredWorkingTimes = {
        "mon": {"startTime": "25:00", "endTime": "12:00", "requirement": "mandatory"}
    }
    normalized, _changed = _normalize_state(state)
    monday = normalized.clinicians[0].preferredWorkingTimes["mon"]
    assert monday.requirement == "mandatory"
    assert monday.startTime == "07:00"
    assert monday.endTime == "17:00"


def test_planning_wishes_survive_model_round_trip() -> None:
    """Pins the extra='ignore' trap: an undeclared field would be silently
    dropped by model_validate on every save round-trip."""
    from backend.models import AppState

    state = _default_state()
    state.clinicians.append(
        Clinician(
            id="c1", name="Test Clinician", qualifiedClassIds=[], vacations=[],
            planningWishes="Prefers early shifts; no on-call before clinic days.",
        )
    )
    revived = AppState.model_validate(state.model_dump())
    revived_c1 = next(c for c in revived.clinicians if c.id == "c1")
    assert (
        revived_c1.planningWishes
        == "Prefers early shifts; no on-call before clinic days."
    )


def test_planning_wishes_normalized() -> None:
    state = _default_state()
    state.clinicians.append(
        Clinician(id="c1", name="A", qualifiedClassIds=[], vacations=[],
                  planningWishes="   ")
    )
    state.clinicians.append(
        Clinician(id="c2", name="B", qualifiedClassIds=[], vacations=[],
                  planningWishes="x" * 600)
    )
    normalized, changed = _normalize_state(state)
    assert changed
    by_id = {c.id: c for c in normalized.clinicians}
    assert by_id["c1"].planningWishes is None
    assert by_id["c2"].planningWishes == "x" * 500
