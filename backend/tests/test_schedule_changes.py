"""Tests for the schedule change log: diffing, coalescing, and the hooks in
POST /v1/state and the run apply endpoint."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.schedule_changes as schedule_changes
from backend import solver_runs
from backend.auth import _get_current_user
from backend.main import app
from backend.models import UserPublic, VacationRange
from backend.schedule_changes import compute_diff, merge_diffs
from backend.state import _normalize_state, _save_state

from .conftest import make_app_state, make_assignment, make_clinician

MON = "2026-01-05"
USER = "changes-user"
# A row id that survives _normalize_state (the Monday slot of the default
# conftest template, MON is a Monday); unknown row ids get stripped.
ROW = "slot-a__mon"


# ---------------------------------------------------------------------------
# Pure diff tests


def _blob(assignments=None, clinicians=None, holidays=None, min_slots=None):
    return {
        "assignments": assignments or [],
        "clinicians": clinicians or [],
        "holidays": holidays or [],
        "minSlotsByRowId": min_slots or {},
    }


def _assignment(row="slot-1", date=MON, clinician="c1", source="manual", assignment_id="a1"):
    return {
        "id": assignment_id,
        "rowId": row,
        "dateISO": date,
        "clinicianId": clinician,
        "source": source,
    }


ALICE = {"id": "c1", "name": "Alice", "vacations": []}


def test_diff_assignment_added_and_removed():
    old = _blob(assignments=[_assignment(row="slot-1")], clinicians=[ALICE])
    new = _blob(assignments=[_assignment(row="slot-2")], clinicians=[ALICE])
    diff = compute_diff(old, new)
    assert diff["assignments"]["added"] == [
        {"row": "slot-2", "date": MON, "clinician_id": "c1", "clinician": "Alice", "source": "manual"}
    ]
    assert diff["assignments"]["removed"] == [
        {"row": "slot-1", "date": MON, "clinician_id": "c1", "clinician": "Alice", "source": "manual"}
    ]


def test_diff_ignores_assignment_ids():
    old = _blob(assignments=[_assignment(assignment_id="a1")])
    new = _blob(assignments=[_assignment(assignment_id="a2-regenerated")])
    assert compute_diff(old, new) == {}


def test_diff_vacation_resize_is_removed_plus_added():
    old = _blob(
        clinicians=[{"id": "c1", "name": "Alice", "vacations": [{"id": "v1", "startISO": "2026-02-02", "endISO": "2026-02-06"}]}]
    )
    new = _blob(
        clinicians=[{"id": "c1", "name": "Alice", "vacations": [{"id": "v1", "startISO": "2026-02-02", "endISO": "2026-02-10"}]}]
    )
    diff = compute_diff(old, new)
    assert diff["vacations"]["added"] == [
        {"clinician_id": "c1", "clinician": "Alice", "start": "2026-02-02", "end": "2026-02-10"}
    ]
    assert diff["vacations"]["removed"] == [
        {"clinician_id": "c1", "clinician": "Alice", "start": "2026-02-02", "end": "2026-02-06"}
    ]


def test_diff_holidays_and_min_slots():
    old = _blob(holidays=[{"dateISO": "2026-12-24", "name": "Xmas"}], min_slots={"row-1": 2})
    new = _blob(min_slots={"row-1": 3, "row-2": 1})
    diff = compute_diff(old, new)
    assert diff["holidays"]["removed"] == [{"date": "2026-12-24", "name": "Xmas"}]
    assert diff["minSlots"]["changed"] == {
        "row-1": {"old": 2, "new": 3},
        "row-2": {"old": None, "new": 1},
    }


def test_diff_identical_blobs_is_empty():
    blob = _blob(assignments=[_assignment()], clinicians=[ALICE])
    assert compute_diff(blob, dict(blob)) == {}


# ---------------------------------------------------------------------------
# Merge tests


def test_merge_add_then_remove_cancels():
    add = {"assignments": {"added": [{"row": "s1", "date": MON, "clinician_id": "c1", "clinician": "Alice", "source": "manual"}]}}
    remove = {"assignments": {"removed": [{"row": "s1", "date": MON, "clinician_id": "c1", "clinician": "Alice", "source": "manual"}]}}
    assert merge_diffs(add, remove) == {}
    assert merge_diffs(remove, add) == {}


def test_merge_keeps_distinct_changes():
    first = {"assignments": {"added": [{"row": "s1", "date": MON, "clinician_id": "c1", "clinician": "Alice", "source": "manual"}]}}
    second = {"vacations": {"added": [{"clinician_id": "c1", "clinician": "Alice", "start": "2026-02-02", "end": "2026-02-06"}]}}
    merged = merge_diffs(first, second)
    assert "assignments" in merged and "vacations" in merged


def test_merge_min_slots_keeps_first_old_and_second_new():
    first = {"minSlots": {"changed": {"row-1": {"old": 1, "new": 2}}}}
    second = {"minSlots": {"changed": {"row-1": {"old": 2, "new": 3}}}}
    assert merge_diffs(first, second) == {"minSlots": {"changed": {"row-1": {"old": 1, "new": 3}}}}
    # Back to the original value -> fully cancelled
    back = {"minSlots": {"changed": {"row-1": {"old": 2, "new": 1}}}}
    assert merge_diffs(first, back) == {}


# ---------------------------------------------------------------------------
# DB / API tests


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "schedule-changes.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)

    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=USER, role="admin", active=True
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(_get_current_user, None)


def _seed_state(**kwargs):
    # Seed the NORMALIZED form: in production the stored blob has always
    # been through _normalize_state, so diffs must not see normalization
    # artifacts (added minSlots defaults etc.) as manual edits.
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")], **kwargs)
    state, _ = _normalize_state(state)
    _save_state(state, USER)
    return state


def _list_rows():
    with db._get_connection() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM schedule_changes ORDER BY created_at ASC, id ASC"
        ).fetchall()]


def test_manual_edit_is_logged_and_coalesced(client):
    state = _seed_state()
    state.assignments = [make_assignment("a1", ROW, MON, "clin-1", source="manual")]
    assert client.post("/v1/state", json=state.model_dump()).status_code == 200

    rows = _list_rows()
    assert len(rows) == 1
    assert rows[0]["kind"] == "manual_edit"
    assert rows[0]["after_run_id"] is None

    # A second save inside the coalesce window merges into the same row.
    state.clinicians[0].vacations = [
        VacationRange(id="v1", startISO="2026-02-02", endISO="2026-02-06")
    ]
    assert client.post("/v1/state", json=state.model_dump()).status_code == 200
    rows = _list_rows()
    assert len(rows) == 1
    changes = schedule_changes.list_changes(username=USER)
    assert changes[0]["diff"]["assignments"]["added"][0]["row"] == ROW
    assert changes[0]["diff"]["vacations"]["added"][0]["clinician"] == "Alice"


def test_undoing_everything_deletes_the_coalesced_row(client):
    state = _seed_state()
    original = state.model_dump()
    state.assignments = [make_assignment("a1", ROW, MON, "clin-1", source="manual")]
    assert client.post("/v1/state", json=state.model_dump()).status_code == 200
    assert len(_list_rows()) == 1
    assert client.post("/v1/state", json=original).status_code == 200
    assert _list_rows() == []


def test_noop_save_logs_nothing(client):
    state = _seed_state()
    assert client.post("/v1/state", json=state.model_dump()).status_code == 200
    assert _list_rows() == []


def test_apply_run_logs_run_applied_and_links_later_edits(client):
    _seed_state()
    solver_runs.create_run("run-x", USER, MON, MON, params={})
    solver_runs.finish_run(
        "run-x",
        "finished",
        result={
            "assignments": [
                {"id": "ra-1", "rowId": ROW, "dateISO": MON, "clinicianId": "clin-1", "source": "solver"}
            ],
            "notes": [],
            "debugInfo": {},
        },
    )
    response = client.post("/v1/solve/runs/run-x/apply")
    assert response.status_code == 200, response.text

    rows = _list_rows()
    assert len(rows) == 1
    assert rows[0]["kind"] == "run_applied"
    assert rows[0]["run_id"] == "run-x"
    changes = schedule_changes.list_changes(username=USER, kind="run_applied")
    assert changes[0]["diff"]["assignments_added"] == 1
    assert changes[0]["diff"]["assignments_replaced"] == 0

    # A manual edit after the apply is linked to the run (a pool assignment
    # survives normalization on any weekday).
    state = client.get("/v1/state").json()
    state["assignments"].append(
        {"id": "a2", "rowId": "pool-rest-day", "dateISO": "2026-01-06", "clinicianId": "clin-1", "source": "manual"}
    )
    assert client.post("/v1/state", json=state).status_code == 200

    edits = schedule_changes.list_changes(username=USER, kind="manual_edit")
    assert len(edits) == 1
    assert edits[0]["after_run_id"] == "run-x"

    # The admin filter by run id returns both the apply and the follow-up edit.
    response = client.get("/v1/admin/schedule-changes", params={"after_run_id": "run-x"})
    assert response.status_code == 200
    kinds = {c["kind"] for c in response.json()["changes"]}
    assert kinds == {"run_applied", "manual_edit"}


def test_admin_endpoints_require_admin(client):
    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=USER, role="user", active=True
    )
    assert client.get("/v1/admin/schedule-changes").status_code == 403
    assert client.get("/v1/admin/solver-runs").status_code == 403


def test_admin_solver_runs_listing(client):
    solver_runs.create_run("run-a", USER, MON, MON, params={})
    solver_runs.finish_run("run-a", "finished", result={"assignments": [], "notes": [], "debugInfo": {}})
    solver_runs.create_run("run-b", "other-user", MON, MON, params={})
    response = client.get("/v1/admin/solver-runs")
    assert response.status_code == 200
    runs = response.json()["runs"]
    assert {r["id"] for r in runs} == {"run-a", "run-b"}
    assert all("result" not in r for r in runs)
    filtered = client.get("/v1/admin/solver-runs", params={"username": USER}).json()["runs"]
    assert [r["id"] for r in filtered] == ["run-a"]


def test_pruning_caps_rows_per_user(client, monkeypatch):
    monkeypatch.setattr(schedule_changes, "KEPT_CHANGES_PER_USER", 3)
    for index in range(5):
        schedule_changes.record_run_applied(USER, f"run-{index}", MON, MON, 1, 0)
    assert len(_list_rows()) == 3


def test_moved_assignments_are_derived_at_read_time(client):
    state = _seed_state(
        assignments=[make_assignment("a1", ROW, MON, "clin-1", source="manual")]
    )
    state.assignments = [make_assignment("a1", "pool-rest-day", MON, "clin-1", source="manual")]
    assert client.post("/v1/state", json=state.model_dump()).status_code == 200
    changes = schedule_changes.list_changes(username=USER)
    assignments = changes[0]["diff"]["assignments"]
    assert assignments["moved"] == [
        {
            "clinician_id": "clin-1",
            "clinician": "Alice",
            "date": MON,
            "from_row": ROW,
            "to_row": "pool-rest-day",
        }
    ]
    assert "added" not in assignments
    assert "removed" not in assignments
