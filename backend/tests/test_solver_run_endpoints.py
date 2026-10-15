"""Run endpoints: range validation, discard vs. apply, draft replacement rule.

All state lives in temporary SQLite databases; no solver process is started.
"""
import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.solver as solver
from backend import solver_runs
from backend.assignment_policy import is_replaced_by_draft
from backend.auth import _create_user, _get_current_user
from backend.main import app
from backend.models import VacationRange
from backend.run_apply import planning_fingerprint
from backend.state import _load_state, _save_state
from backend.tests.conftest import make_app_state, make_assignment, make_clinician, make_template_slot

MON = "2026-01-05"
USER = "run-endpoint-test"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "runs.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    current_user = _create_user(USER, "run-endpoint-password", "admin")
    app.dependency_overrides[_get_current_user] = lambda: current_user
    yield TestClient(app)
    app.dependency_overrides.pop(_get_current_user, None)


def seed_run(state, assignments, *, status="finished"):
    _save_state(state, USER)
    solver_runs.create_run(
        "run-1", USER, MON, MON, {"solver_mode": "agent", "only_fill_required": True},
        input_fingerprint=planning_fingerprint(_load_state(USER)),
    )
    solver_runs.finish_run("run-1", status, result={
        "startISO": MON, "endISO": MON,
        "assignments": [a.model_dump() for a in assignments], "notes": [],
    })


@pytest.mark.parametrize("payload", [
    {"startISO": "not-a-date", "solver_mode": "cpsat"},
    {"startISO": "2026-01-10", "endISO": "2026-01-05", "solver_mode": "heuristic"},
    {"startISO": "20260105", "solver_mode": "agent"},
    {"startISO": MON, "endISO": "2026-1-9", "solver_mode": "agent"},
])
def test_invalid_range_is_rejected_before_any_run_exists(client, payload):
    response = client.post("/v1/solve/range", json=payload)
    assert response.status_code == 422, response.text
    assert solver.active_run_count() == 0
    assert solver_runs.list_runs(USER) == []


def test_discard_cannot_overwrite_an_applied_run(client):
    seed_run(make_app_state(), [make_assignment("new", "slot-a__mon", MON, "clin-1", "solver")])
    assert client.post("/v1/solve/runs/run-1/apply").status_code == 200
    response = client.post("/v1/solve/runs/run-1/discard")
    assert response.status_code == 409
    assert "applied" in response.json()["detail"]
    assert solver_runs.get_run("run-1", USER)["status"] == "applied"


def test_discard_rejects_failed_runs_and_is_idempotent_for_open_ones(client):
    seed_run(make_app_state(), [], status="failed")
    assert client.post("/v1/solve/runs/run-1/discard").status_code == 409
    assert solver_runs.get_run("run-1", USER)["status"] == "failed"

    seed_run(make_app_state(), [])
    assert client.post("/v1/solve/runs/run-1/discard").status_code == 200
    assert client.post("/v1/solve/runs/run-1/discard").status_code == 200
    assert solver_runs.get_run("run-1", USER)["status"] == "discarded"


def test_draft_replaces_unlocked_solver_row_hidden_by_vacation(client):
    state = make_app_state(clinicians=[
        make_clinician("clin-1", "Alice", vacations=[VacationRange(id="v", startISO=MON, endISO=MON)]),
        make_clinician("clin-2", "Bob"),
    ], slots=[make_template_slot("slot-a__mon", required_slots=1)], assignments=[
        make_assignment("hidden", "slot-a__mon", MON, "clin-1", "solver"),
    ])
    seed_run(state, [make_assignment("new", "slot-a__mon", MON, "clin-2", "solver")])
    response = client.post("/v1/solve/runs/run-1/apply")
    assert response.status_code == 200, response.text
    assert [(a.clinicianId, a.rowId) for a in _load_state(USER).assignments] == [("clin-2", "slot-a__mon")]


def test_is_replaced_by_draft_keeps_protected_pool_and_out_of_range_rows():
    def row(source="solver", locked=False, row_id="slot-a__mon", date=MON):
        assignment = make_assignment("a", row_id, date, "clin-1", source)
        assignment.locked = locked
        return assignment

    assert is_replaced_by_draft(row(), MON, MON)
    assert not is_replaced_by_draft(row(source="manual"), MON, MON)
    assert not is_replaced_by_draft(row(locked=True), MON, MON)
    assert not is_replaced_by_draft(row(row_id="pool-vacation"), MON, MON)
    assert not is_replaced_by_draft(row(date="2026-01-06"), MON, MON)
