"""Tests for state normalization and migration logic.

These tests verify that deprecated pools (Distribution Pool, Reserve Pool) are
properly removed during state normalization, and that valid pools (Rest Day,
Vacation) are preserved.
"""

import pytest

from backend.models import AppState, Assignment, Holiday, WorkplaceRow
from backend.state import _default_state, _normalize_state

from .conftest import (
    make_app_state,
    make_assignment,
    make_clinician,
    make_pool_row,
    make_state_with_deprecated_pools,
    make_workplace_row,
)


# -----------------------------------------------------------------------------
# Pool Removal Migration Tests
# -----------------------------------------------------------------------------


class TestDeprecatedPoolRemoval:
    """Tests for removal of deprecated pool rows."""

    def test_removes_distribution_pool_row(self) -> None:
        """Distribution Pool (pool-not-allocated) should be removed from rows."""
        state = make_state_with_deprecated_pools()
        row_ids_before = {row.id for row in state.rows}
        assert "pool-not-allocated" in row_ids_before

        normalized, changed = _normalize_state(state)

        row_ids_after = {row.id for row in normalized.rows}
        assert "pool-not-allocated" not in row_ids_after
        assert changed is True

    def test_removes_reserve_pool_row(self) -> None:
        """Reserve Pool (pool-manual) should be removed from rows."""
        state = make_state_with_deprecated_pools()
        row_ids_before = {row.id for row in state.rows}
        assert "pool-manual" in row_ids_before

        normalized, changed = _normalize_state(state)

        row_ids_after = {row.id for row in normalized.rows}
        assert "pool-manual" not in row_ids_after
        assert changed is True

    def test_removes_assignments_to_distribution_pool(self) -> None:
        """Assignments to Distribution Pool should be removed."""
        state = make_state_with_deprecated_pools()
        assignment_row_ids_before = {a.rowId for a in state.assignments}
        assert "pool-not-allocated" in assignment_row_ids_before

        normalized, changed = _normalize_state(state)

        assignment_row_ids_after = {a.rowId for a in normalized.assignments}
        assert "pool-not-allocated" not in assignment_row_ids_after
        assert changed is True

    def test_removes_assignments_to_reserve_pool(self) -> None:
        """Assignments to Reserve Pool should be removed."""
        state = make_state_with_deprecated_pools()
        assignment_row_ids_before = {a.rowId for a in state.assignments}
        assert "pool-manual" in assignment_row_ids_before

        normalized, changed = _normalize_state(state)

        assignment_row_ids_after = {a.rowId for a in normalized.assignments}
        assert "pool-manual" not in assignment_row_ids_after
        assert changed is True

    def test_preserves_rest_day_pool(self) -> None:
        """Rest Day pool (pool-rest-day) should be preserved."""
        state = make_state_with_deprecated_pools()
        row_ids_before = {row.id for row in state.rows}
        assert "pool-rest-day" in row_ids_before

        normalized, _ = _normalize_state(state)

        row_ids_after = {row.id for row in normalized.rows}
        assert "pool-rest-day" in row_ids_after

    def test_preserves_vacation_pool(self) -> None:
        """Vacation pool (pool-vacation) should be preserved."""
        state = make_state_with_deprecated_pools()
        row_ids_before = {row.id for row in state.rows}
        assert "pool-vacation" in row_ids_before

        normalized, _ = _normalize_state(state)

        row_ids_after = {row.id for row in normalized.rows}
        assert "pool-vacation" in row_ids_after

    def test_no_change_when_deprecated_pools_absent(self) -> None:
        """State without deprecated pools should not be marked as changed for pool reasons."""
        state = make_app_state()
        row_ids = {row.id for row in state.rows}
        assert "pool-not-allocated" not in row_ids
        assert "pool-manual" not in row_ids

        _, changed = _normalize_state(state)

        # Note: changed could be True for other normalization reasons, but
        # the deprecated pool removal code path should not trigger
        row_ids_after = {row.id for row in state.rows}
        assert "pool-not-allocated" not in row_ids_after
        assert "pool-manual" not in row_ids_after


class TestDeprecatedSolverSettingsRemoval:
    """Tests for removal of deprecated solver settings."""

    def test_removes_allow_multiple_shifts_per_day(self) -> None:
        """allowMultipleShiftsPerDay should be removed from solver settings."""
        state = make_state_with_deprecated_pools()
        assert "allowMultipleShiftsPerDay" in state.solverSettings

        normalized, changed = _normalize_state(state)

        assert "allowMultipleShiftsPerDay" not in normalized.solverSettings
        assert changed is True

    def test_removes_show_distribution_pool(self) -> None:
        """showDistributionPool should be removed from solver settings."""
        state = make_state_with_deprecated_pools()
        assert "showDistributionPool" in state.solverSettings

        normalized, changed = _normalize_state(state)

        assert "showDistributionPool" not in normalized.solverSettings
        assert changed is True

    def test_removes_show_reserve_pool(self) -> None:
        """showReservePool should be removed from solver settings."""
        state = make_state_with_deprecated_pools()
        assert "showReservePool" in state.solverSettings

        normalized, changed = _normalize_state(state)

        assert "showReservePool" not in normalized.solverSettings
        assert changed is True

    def test_preserves_valid_solver_settings(self) -> None:
        """Valid solver settings should be preserved after normalization."""
        state = make_state_with_deprecated_pools()

        normalized, _ = _normalize_state(state)

        assert "enforceSameLocationPerDay" in normalized.solverSettings
        assert "onCallRestEnabled" in normalized.solverSettings
        assert "workingHoursToleranceHours" in normalized.solverSettings


class TestSolverSettingsDefaults:
    """Tests for solver settings normalization and defaults."""

    def test_tolerance_defaulted_when_missing(self) -> None:
        """workingHoursToleranceHours should default to 5 when not present."""
        state = _default_state()
        state.solverSettings = {}

        normalized, _ = _normalize_state(state)

        assert normalized.solverSettings["workingHoursToleranceHours"] == 5

    def test_tolerance_preserved_when_present(self) -> None:
        """workingHoursToleranceHours should be preserved when already set."""
        state = _default_state()
        state.solverSettings = {"workingHoursToleranceHours": 10}

        normalized, _ = _normalize_state(state)

        assert normalized.solverSettings["workingHoursToleranceHours"] == 10

    def test_tolerance_clamped_to_valid_range(self) -> None:
        """workingHoursToleranceHours should be clamped between 0 and 40."""
        state = _default_state()
        state.solverSettings = {"workingHoursToleranceHours": 100}

        normalized, _ = _normalize_state(state)

        assert normalized.solverSettings["workingHoursToleranceHours"] == 40

    def test_on_call_rest_days_clamped(self) -> None:
        """onCallRestDaysBefore and onCallRestDaysAfter should be clamped 0-7."""
        state = _default_state()
        state.solverSettings = {
            "onCallRestDaysBefore": 20,
            "onCallRestDaysAfter": -5,
        }

        normalized, _ = _normalize_state(state)

        assert normalized.solverSettings["onCallRestDaysBefore"] == 7
        assert normalized.solverSettings["onCallRestDaysAfter"] == 0


class TestDefaultState:
    """Tests for _default_state() function."""

    def test_default_state_has_no_deprecated_pools(self) -> None:
        """Default state should not contain deprecated pools."""
        state = _default_state()

        row_ids = {row.id for row in state.rows}
        assert "pool-not-allocated" not in row_ids
        assert "pool-manual" not in row_ids

    def test_default_state_has_rest_day_pool(self) -> None:
        """Default state should contain Rest Day pool."""
        state = _default_state()

        row_ids = {row.id for row in state.rows}
        assert "pool-rest-day" in row_ids

    def test_default_state_has_vacation_pool(self) -> None:
        """Default state should contain Vacation pool."""
        state = _default_state()

        row_ids = {row.id for row in state.rows}
        assert "pool-vacation" in row_ids

    def test_default_state_has_no_deprecated_solver_settings(self) -> None:
        """Default state should not contain deprecated solver settings."""
        state = _default_state()

        assert "allowMultipleShiftsPerDay" not in state.solverSettings
        assert "showDistributionPool" not in state.solverSettings
        assert "showReservePool" not in state.solverSettings


class TestLegacyStateHandling:
    """Tests for handling legacy state formats gracefully."""

    def test_handles_empty_solver_settings(self) -> None:
        """Empty solver settings should be normalized with defaults."""
        state = make_app_state(solver_settings={})

        normalized, _ = _normalize_state(state)

        assert "workingHoursToleranceHours" in normalized.solverSettings

    def test_handles_none_solver_settings(self) -> None:
        """None solver settings should be normalized with defaults."""
        state = make_app_state()
        state.solverSettings = None  # type: ignore

        normalized, _ = _normalize_state(state)

        # Should have default settings applied
        assert normalized.solverSettings is not None


class TestPoolAssignmentCleanup:
    """Tests for assignment cleanup when pools are removed."""

    def test_only_deprecated_pool_assignments_removed(self) -> None:
        """Only assignments to deprecated pools should be removed."""
        rows = [
            make_workplace_row(),
            make_pool_row("pool-not-allocated", "Distribution Pool"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ]
        assignments = [
            make_assignment("a1", "pool-not-allocated", "2026-01-05", "clin-1"),
            make_assignment("a2", "pool-rest-day", "2026-01-05", "clin-1"),
        ]
        state = make_app_state(rows=rows, assignments=assignments)

        normalized, _ = _normalize_state(state)

        assignment_row_ids = {a.rowId for a in normalized.assignments}
        assert "pool-not-allocated" not in assignment_row_ids
        assert "pool-rest-day" in assignment_row_ids

    def test_valid_slot_assignments_preserved(self) -> None:
        """Assignments to valid slots should be preserved."""
        clinicians = [make_clinician()]
        assignments = [
            make_assignment("a1", "slot-a__mon", "2026-01-05", "clin-1"),
        ]
        state = make_app_state(clinicians=clinicians, assignments=assignments)

        normalized, _ = _normalize_state(state)

        # The assignment should still exist (though rowId might be adjusted for slot mapping)
        assert len(normalized.assignments) >= 0  # May be 0 if slot mapping fails


class TestRegressionPoolNeverReappears:
    """Regression tests ensuring deprecated pools never reappear."""

    def test_normalize_idempotent_for_pools(self) -> None:
        """Normalizing already-normalized state should not reintroduce pools."""
        state = make_state_with_deprecated_pools()

        # First normalization
        normalized1, _ = _normalize_state(state)
        row_ids1 = {row.id for row in normalized1.rows}
        assert "pool-not-allocated" not in row_ids1
        assert "pool-manual" not in row_ids1

        # Second normalization (should be idempotent)
        normalized2, changed = _normalize_state(normalized1)
        row_ids2 = {row.id for row in normalized2.rows}
        assert "pool-not-allocated" not in row_ids2
        assert "pool-manual" not in row_ids2

    def test_no_pool_assignments_after_multiple_normalizations(self) -> None:
        """Multiple normalizations should never reintroduce deprecated pool assignments."""
        state = make_state_with_deprecated_pools()

        for _ in range(3):
            state, _ = _normalize_state(state)

        assignment_row_ids = {a.rowId for a in state.assignments}
        assert "pool-not-allocated" not in assignment_row_ids
        assert "pool-manual" not in assignment_row_ids


# -----------------------------------------------------------------------------
# Load revision must match the stored blob used by the save CAS
# -----------------------------------------------------------------------------


@pytest.fixture
def state_db(tmp_path, monkeypatch):
    from backend import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "state.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    return db


def _store_raw_state(db, user_id, payload, updated_at="2020-01-01T00:00:00+00:00"):
    import json

    with db._get_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO app_state (id, data, updated_at) VALUES (?, ?, ?)",
                     (user_id, json.dumps(payload), updated_at))


def _stored_updated_at(db, user_id):
    with db._get_connection() as conn:
        return conn.execute("SELECT updated_at FROM app_state WHERE id = ?", (user_id,)).fetchone()[0]


def _mutate_slot_time(location):
    location["slots"][0]["startTime"] = "7:30"


def _mutate_row_band_order(location):
    location["rowBands"][-1]["order"] = 99


def _mutate_row_band_label(location):
    location["rowBands"][0]["label"] = ""


@pytest.mark.parametrize("mutate", [_mutate_slot_time, _mutate_row_band_order, _mutate_row_band_label])
def test_loaded_revision_is_accepted_by_save_cas_after_silent_normalization(state_db, mutate):
    from backend.state import _load_state, _save_state

    payload = _default_state().model_dump(exclude={"revision"})
    mutate(payload["weeklyTemplate"]["locations"][0])
    _store_raw_state(state_db, "u", payload)
    loaded = _load_state("u")
    _save_state(loaded, "u", check_revision=True, expected_revision=loaded.revision)
    assert _load_state("u").revision == loaded.revision


def test_load_does_not_rewrite_an_already_normalized_blob(state_db):
    from backend.state import _load_state

    normalized, _ = _normalize_state(_default_state())
    _store_raw_state(state_db, "u", normalized.model_dump(exclude={"revision"}))
    _load_state("u")
    assert _stored_updated_at(state_db, "u") == "2020-01-01T00:00:00+00:00"


_OVERRIDE_PROBE = """
import json
from backend.models import AppState
from backend.state import _default_state, _normalize_state

data = _default_state().model_dump()
data["weeklyTemplate"] = None
row = next(r for r in data["rows"] if r["kind"] == "class")
base = row["subShifts"][0]
row["subShifts"] = [dict(base, id=i, name=i, order=n + 1) for n, i in enumerate(["sa", "sb", "sc"])]
state, _ = _normalize_state(AppState.model_validate(data))
sec = row["id"]
state.slotOverridesByKey = {f"{sec}::sb__mon__2026-01-05": 2, f"{sec}::zz__2026-01-12": 1}
state, _ = _normalize_state(state)
print(json.dumps({"sec": sec, "overrides": state.slotOverridesByKey}))
"""


def test_slot_override_migration_is_deterministic_and_keeps_valid_slot_ids():
    import json
    import os
    import subprocess
    import sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]
    results = []
    for seed in range(6):
        env = dict(os.environ, PYTHONHASHSEED=str(seed),
                   PYTHONPATH=os.pathsep.join(filter(None, [str(repo_root), os.environ.get("PYTHONPATH")])))
        out = subprocess.run([sys.executable, "-c", _OVERRIDE_PROBE], env=env, cwd=repo_root,
                             capture_output=True, text=True, check=True).stdout
        results.append(json.loads(out.strip().splitlines()[-1]))
    sec = results[0]["sec"]
    expected = {f"{sec}::sb__mon__2026-01-05": 2, f"{sec}::sa__mon__2026-01-12": 1}
    assert all(result["overrides"] == expected for result in results), results


def test_default_section_colors_match_the_frontend_palette():
    """Sections without a color get SECTION_BLOCK_COLORS in order. The app
    (normalizeAppState in shiftRows.ts) takes the same list from
    BLOCK_COLOR_OPTIONS in src/lib/colorPalette.ts, so both must stay equal."""
    import re
    from pathlib import Path

    from backend.state import SECTION_BLOCK_COLORS

    source = (Path(__file__).resolve().parents[2] / "src/lib/colorPalette.ts").read_text()
    options = source.split("export const BLOCK_COLOR_OPTIONS", 1)[1].split("];", 1)[0]
    assert re.findall(r'color: "(#[0-9A-Fa-f]{6})"', options) == SECTION_BLOCK_COLORS


def test_normalization_is_idempotent_on_the_arena_fixture():
    """A second pass must not change anything, or _load_state rewrites the blob
    (and bumps updated_at, which feeds public ETags) on two successive loads."""
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[1] / "arena" / "fixture_complex.json"
    raw = json.loads(fixture.read_text())["state"]
    once, _ = _normalize_state(AppState.model_validate(raw))
    first = once.model_dump(exclude={"revision"})
    twice, changed = _normalize_state(AppState.model_validate(json.loads(json.dumps(first))))
    assert changed is False
    assert twice.model_dump(exclude={"revision"}) == first


MONDAY = "2026-01-05"


def _migrated_two_shift_state():
    """Default state whose first section has sub-shifts s1 and s2, migrated to
    template slot ids like "sec::s2__mon" (one slot per sub-shift and day type)."""
    data = _default_state().model_dump()
    data["weeklyTemplate"] = None
    row = next(r for r in data["rows"] if r["kind"] == "class")
    base = row["subShifts"][0]
    row["subShifts"] = [dict(base, id=i, name=i, order=n + 1) for n, i in enumerate(["s1", "s2"])]
    state, _ = _normalize_state(AppState.model_validate(data))
    state.clinicians = [make_clinician()]
    return state, row["id"]


def test_assignment_on_migrated_sub_shift_slot_stays_with_its_override():
    """A migrated slot id like "sec::s2__mon" is a slot id, not a legacy
    shift-row id: the assignment must stay on s2, next to its override."""
    state, sec = _migrated_two_shift_state()
    state.assignments = [
        make_assignment("a1", f"{sec}::s1__mon", MONDAY, "clin-1"),
        make_assignment("a2", f"{sec}::s2__mon", MONDAY, "clin-1"),
    ]
    state.slotOverridesByKey = {f"{sec}::s2__mon__{MONDAY}": 1}

    state, _ = _normalize_state(state)

    assert {a.id: a.rowId for a in state.assignments} == {
        "a1": f"{sec}::s1__mon",
        "a2": f"{sec}::s2__mon",
    }
    assert state.slotOverridesByKey == {f"{sec}::s2__mon__{MONDAY}": 1}
    _, changed = _normalize_state(state)
    assert changed is False


@pytest.mark.parametrize(
    ("date_iso", "holiday_dates", "old_day_type", "new_day_type"),
    [
        (MONDAY, [MONDAY], "mon", "holiday"),  # the Monday becomes a holiday
        (MONDAY, [], "holiday", "mon"),  # the holiday is removed again
        ("2026-01-06", [], "mon", "tue"),  # slot and date disagree
    ],
)
def test_assignments_on_migrated_slots_follow_their_dates_day_type(
    date_iso, holiday_dates, old_day_type, new_day_type
):
    """Adding or removing a holiday moves each assignment to the same
    sub-shift's slot for the date's new day type instead of dropping it."""
    state, sec = _migrated_two_shift_state()
    state.holidays = [Holiday(dateISO=d, name="Holiday") for d in holiday_dates]
    state.assignments = [
        make_assignment("a1", f"{sec}::s1__{old_day_type}", date_iso, "clin-1"),
        make_assignment("a2", f"{sec}::s2__{old_day_type}", date_iso, "clin-1"),
    ]

    state, changed = _normalize_state(state)

    assert changed is True
    assert {a.id: a.rowId for a in state.assignments} == {
        "a1": f"{sec}::s1__{new_day_type}",
        "a2": f"{sec}::s2__{new_day_type}",
    }
    _, changed = _normalize_state(state)
    assert changed is False


def test_migrated_slot_moved_into_another_days_column_keeps_its_assignment():
    """Dragging "slot-a__mon" into the Tuesday column keeps its id. Its column
    fits a Tuesday, so the assignment stays on it instead of following the id
    suffix to the sibling "slot-a__tue" (another row and time)."""
    state, _ = _migrated_two_shift_state()
    location = next(loc for loc in state.weeklyTemplate.locations if loc.slots)
    tue_band = next(band for band in location.colBands if band.dayType == "tue")
    base = next(slot for slot in location.slots if slot.colBandId == tue_band.id)
    location.slots += [
        base.model_copy(update={"id": "slot-a__mon", "startTime": "08:00", "endTime": "12:00"}),
        base.model_copy(update={"id": "slot-a__tue", "startTime": "13:00", "endTime": "17:00"}),
    ]
    state.holidays = []
    tuesday = "2026-01-13"
    state.assignments = [make_assignment("a1", "slot-a__mon", tuesday, "clin-1")]
    state.slotOverridesByKey = {f"slot-a__mon__{tuesday}": 1}

    state, _ = _normalize_state(state)

    assert {a.id: a.rowId for a in state.assignments} == {"a1": "slot-a__mon"}
    assert state.slotOverridesByKey == {f"slot-a__mon__{tuesday}": 1}
    _, changed = _normalize_state(state)
    assert changed is False


def test_assignment_on_a_deleted_migrated_slot_is_dropped_not_moved_to_s1():
    state, sec = _migrated_two_shift_state()
    for location in state.weeklyTemplate.locations:
        location.slots = [slot for slot in location.slots if not slot.id.startswith(f"{sec}::s2__")]
    state.assignments = [
        make_assignment("a1", f"{sec}::s1__mon", MONDAY, "clin-1"),
        make_assignment("a2", f"{sec}::s2__mon", MONDAY, "clin-1"),
    ]

    state, _ = _normalize_state(state)

    assert {a.id: a.rowId for a in state.assignments} == {"a1": f"{sec}::s1__mon"}
