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

from .conftest import make_app_state, make_clinician

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

    response = solve_client.post(
        "/v1/solve/range",
        json={
            "startISO": MON,
            "endISO": MON,
            "only_fill_required": True,
            "solver_mode": "agent",
            "timeout_seconds": 60,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["assignments"]) == 1  # heuristic seed filled the slot
    assert body["assignments"][0]["clinicianId"] == "clin-1"
    assert body["assignments"][0]["source"] == "solver"
    assert any("Agent solver" in note for note in body["notes"])
    assert body["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert body["debugInfo"]["agent"]["iterations"] == 3


def test_agent_mode_without_script_uses_default_mock_behaviour(solve_client):
    _seeded_state()
    response = solve_client.post(
        "/v1/solve/range",
        json={
            "startISO": MON,
            "endISO": MON,
            "only_fill_required": True,
            "solver_mode": "agent",
            "timeout_seconds": 60,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert len(body["assignments"]) == 1


def test_use_heuristic_flag_still_routes_to_heuristic(solve_client):
    _seeded_state()
    response = solve_client.post(
        "/v1/solve/range",
        json={
            "startISO": MON,
            "endISO": MON,
            "only_fill_required": True,
            "use_heuristic": True,
            "timeout_seconds": 60,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["debugInfo"]["solver_status"] == "HEURISTIC_COMPLETE_V2"
    assert len(body["assignments"]) == 1
