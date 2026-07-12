"""Integration tests for solver_mode dispatch through POST /v1/solve/range.

These exercise the REAL path: FastAPI endpoint -> spawned solver subprocess
-> mode switch -> agent harness with the mock provider. The subprocess cannot
see monkeypatched module state, so everything it needs travels through the
inherited environment: SCHEDULE_DB_PATH for state, AGENT_PROVIDER /
AGENT_MOCK_SCRIPT for the provider.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _get_current_user
from backend.main import app
from backend.models import SolveRangeRequest, UserPublic
from backend.state import _save_state

from .conftest import make_app_state, make_assignment, make_clinician, solve_via_endpoint

MON = "2026-01-05"
USER = "agent-integration-user"


def test_resolved_mode_backward_compatibility():
    assert SolveRangeRequest(startISO=MON).resolved_mode() == "cpsat"
    assert SolveRangeRequest(startISO=MON, use_heuristic=True).resolved_mode() == "heuristic"
    assert SolveRangeRequest(startISO=MON, solver_mode="agent").resolved_mode() == "agent"
    # solver_mode wins over the legacy flag
    assert (
        SolveRangeRequest(startISO=MON, use_heuristic=True, solver_mode="cpsat").resolved_mode()
        == "cpsat"
    )


@pytest.fixture
def solve_client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "agent-integration.db")
    # Parent process reads the module global; the spawned subprocess re-reads
    # the environment variable. Point both at the same temp DB.
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    monkeypatch.delenv("AGENT_MOCK_SCRIPT", raising=False)

    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=USER, role="admin", active=True
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(_get_current_user, None)


def _seeded_state():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    _save_state(state, USER)
    return state


def test_agent_mode_through_endpoint_with_mock_script(solve_client, tmp_path, monkeypatch):
    _seeded_state()
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        {"tool_calls": [{"name": "list_open_slots", "arguments": {}}]},
        {"text": "Seed accepted."},
    ]
    script_path = tmp_path / "mock-script.json"
    script_path.write_text(json.dumps(script))
    monkeypatch.setenv("AGENT_MOCK_SCRIPT", str(script_path))

    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "timeout_seconds": 60,
    })
    assert run["status"] == "finished", run
    body = run["result"]
    assert len(body["assignments"]) == 1  # heuristic seed filled the slot
    assert body["assignments"][0]["clinicianId"] == "clin-1"
    assert body["assignments"][0]["source"] == "solver"
    assert any("Agent solver" in note for note in body["notes"])
    assert body["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert body["debugInfo"]["agent"]["iterations"] == 3


def test_agent_mode_without_script_uses_default_mock_behaviour(solve_client):
    _seeded_state()
    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "timeout_seconds": 60,
    })
    body = run["result"]
    assert body["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert len(body["assignments"]) == 1


def test_agent_mode_defaults_to_day_by_day(solve_client):
    """Since v1.38 a solve WITHOUT agent_strategy runs the day-by-day
    planner (the mock's inspection-only default applies no moves, so the
    zero-progress guard returns the heuristic draft — but the strategy
    decision itself is what this pins down)."""
    _seeded_state()
    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "timeout_seconds": 60,
    })
    body = run["result"]
    assert body["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("day-by-day" in n for n in body["notes"])
    assert len(body["assignments"]) == 1


def test_use_heuristic_flag_still_routes_to_heuristic(solve_client):
    _seeded_state()
    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "use_heuristic": True,
        "timeout_seconds": 60,
    })
    body = run["result"]
    assert body["debugInfo"]["solver_status"] == "HEURISTIC_COMPLETE_V2"
    assert len(body["assignments"]) == 1


def test_run_inbox_lifecycle_apply(solve_client):
    """The background-run flow end to end: start -> run row -> finished
    result stored (NOT applied) -> apply writes it into the schedule with
    the same semantics the frontend used (replace in-range solver
    assignments, keep manual ones)."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[
            # A manual entry inside the range must survive the apply.
            make_assignment("m-keep", "slot-a__mon", MON, "clin-1", source="manual"),
        ],
    )
    _save_state(state, USER)

    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "timeout_seconds": 60,
        "run_token": "inbox-test-run",
    })
    assert run["id"] == "inbox-test-run"
    assert run["status"] == "finished"
    assert run["has_result"] is True

    # Nothing applied yet: state still has only the manual assignment.
    listed = solve_client.get("/v1/solve/runs").json()["runs"]
    assert listed[0]["id"] == "inbox-test-run"
    assert listed[0]["status"] == "finished"
    state_now = solve_client.get("/v1/state").json()
    solver_rows = [a for a in state_now["assignments"] if a["source"] == "solver"]
    assert solver_rows == []

    applied = solve_client.post("/v1/solve/runs/inbox-test-run/apply")
    assert applied.status_code == 200, applied.text
    state_after = solve_client.get("/v1/state").json()
    manual = [a for a in state_after["assignments"] if a["source"] == "manual"]
    assert len(manual) == 1  # the manual entry survived

    run_after = solve_client.get("/v1/solve/runs/inbox-test-run").json()
    assert run_after["status"] == "applied"
    # A second apply is refused (already applied).
    again = solve_client.post("/v1/solve/runs/inbox-test-run/apply")
    assert again.status_code == 409

    missing = solve_client.get("/v1/solve/runs/no-such-run")
    assert missing.status_code == 404


def test_run_discard_and_unlimited_timeout(solve_client):
    """A run without timeout_seconds (no wall-clock limit, the new default)
    completes on the iteration budget alone; discard marks it rejected."""
    _seeded_state()
    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "run_token": "discard-test-run",
    })
    assert run["status"] == "finished"
    discarded = solve_client.post("/v1/solve/runs/discard-test-run/discard")
    assert discarded.status_code == 200
    assert (
        solve_client.get("/v1/solve/runs/discard-test-run").json()["status"]
        == "discarded"
    )


def test_interrupted_run_is_restarted_on_startup(solve_client):
    """A run row stuck in 'running' (backend restart killed its process) is
    restarted once and then finishes; a second-attempt row is only marked
    crashed."""
    import backend.solver_runs as solver_runs
    from backend.solver import recover_interrupted_runs

    _seeded_state()
    solver_runs.create_run(
        "stranded-run",
        USER,
        MON,
        MON,
        {
            "startISO": MON,
            "endISO": MON,
            "only_fill_required": True,
            "solver_mode": "agent",
            "agent_strategy": "repair",
            "timeout_seconds": 60,
            "run_token": "stranded-run",
        },
    )
    solver_runs.create_run(
        "too-old-run", USER, MON, MON, {"startISO": MON}, attempt=2
    )

    recover_interrupted_runs()

    assert (
        solve_client.get("/v1/solve/runs/too-old-run").json()["status"]
        == "crashed"
    )
    import time as _time

    deadline = _time.time() + 120
    while _time.time() < deadline:
        body = solve_client.get("/v1/solve/runs/stranded-run").json()
        if body["status"] != "running":
            break
        _time.sleep(0.2)
    assert body["status"] == "finished"
    assert body["attempt"] == 2
    assert "restarted" in (body.get("notes") or "")


def test_apply_warns_when_calendar_changed_after_run_start(solve_client):
    """Editing the calendar inside the run's range AFTER the run started
    must make apply refuse with a 'calendar_changed' conflict; force=true
    applies anyway (the admin confirmed the warning)."""
    _seeded_state()
    run = solve_via_endpoint(solve_client, {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "timeout_seconds": 60,
        "run_token": "conflict-test-run",
    })
    assert run["status"] == "finished"

    # Simulate a manual edit in the range after the run started.
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[
            make_assignment("m-new", "slot-a__mon", MON, "clin-1", source="manual"),
        ],
    )
    _save_state(state, USER)

    refused = solve_client.post("/v1/solve/runs/conflict-test-run/apply")
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "calendar_changed"

    forced = solve_client.post("/v1/solve/runs/conflict-test-run/apply?force=true")
    assert forced.status_code == 200, forced.text
    assert (
        solve_client.get("/v1/solve/runs/conflict-test-run").json()["status"]
        == "applied"
    )
