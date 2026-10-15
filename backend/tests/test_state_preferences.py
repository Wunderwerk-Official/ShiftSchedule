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


def test_location_color_normalized_and_survives_round_trip() -> None:
    from backend.models import AppState, Location

    state = _default_state()
    state.locations = [
        Location(id="loc-a", name="A", color="#e9eef5"),
        Location(id="loc-b", name="B", color="red"),
        Location(id="loc-c", name="C", color="#ABC"),
        Location(id="loc-d", name="D"),
        # Not trimmed, same as the frontend normalizer.
        Location(id="loc-e", name="E", color=" #E9EEF5 "),
    ]
    normalized, changed = _normalize_state(state)
    assert changed
    colors = {loc.id: loc.color for loc in normalized.locations}
    assert colors["loc-a"] == "#E9EEF5"
    assert [colors[k] for k in ("loc-b", "loc-c", "loc-d", "loc-e")] == [None] * 4
    revived = AppState.model_validate(normalized.model_dump())
    assert {loc.id: loc.color for loc in revived.locations} == colors
    _again, changed_again = _normalize_state(revived)
    assert not changed_again


def test_non_string_location_color_is_dropped_instead_of_rejected() -> None:
    """A bad color must not fail the whole calendar save with a 422."""
    from backend.models import AppState

    blob = _default_state().model_dump()
    blob["locations"] = [
        {"id": "loc-a", "name": "A", "color": 12},
        {"id": "loc-b", "name": "B", "color": {"hex": "#E9EEF5"}},
        {"id": "loc-c", "name": "C", "color": True},
    ]
    state = AppState.model_validate(blob)
    assert [loc.color for loc in state.locations] == [None, None, None]


def test_uncolored_location_dump_matches_pre_color_blobs() -> None:
    """Stored calendars without colors must keep their revision after deploy."""
    import hashlib
    import json

    from backend.models import AppState
    from backend.state import _state_revision

    blob = _default_state().model_dump(exclude={"revision"})
    assert all("color" not in loc for loc in blob["locations"])
    revived = AppState.model_validate(blob)
    assert revived.model_dump(exclude={"revision"}) == blob
    old_revision = hashlib.sha256(json.dumps(blob, sort_keys=True).encode()).hexdigest()
    assert _state_revision(revived) == old_revision
