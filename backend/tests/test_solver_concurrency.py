"""Multi-user solver run tests: abort ownership and per-user concurrency.

Like test_agent_integration.py these exercise the REAL path (endpoint ->
spawned subprocess -> mock agent provider). The fixture's identity holder is
mutable so one TestClient can act as different users between requests; both
users' subprocesses read their own state from the shared SCHEDULE_DB_PATH.
Long-running runs come from a mock script with per-turn delays
(mock_provider caps each delay at 3000 ms).
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _get_current_user
from backend.main import app
from backend.models import UserPublic
from backend.state import _save_state

from .conftest import make_app_state, make_clinician

MON = "2026-01-05"
TERMINAL_STATUSES = {"finished", "aborted", "failed", "crashed"}

# Three provider turns at the 3000 ms cap keep a run alive for ~9 s plus
# subprocess spawn time — enough to observe and abort it deterministically.
SLOW_SCRIPT = [
    {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}], "delay_ms": 3000},
    {"tool_calls": [{"name": "list_open_slots", "arguments": {}}], "delay_ms": 3000},
    {"text": "done", "delay_ms": 3000},
]


@pytest.fixture
def multi_user_client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "concurrency.db")
    # Parent process reads the module global; the spawned subprocess re-reads
    # the environment variable. Point both at the same temp DB.
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    monkeypatch.setenv("AGENT_PROVIDER", "mock")

    script_path = tmp_path / "slow-script.json"
    script_path.write_text(json.dumps(SLOW_SCRIPT))
    monkeypatch.setenv("AGENT_MOCK_SCRIPT", str(script_path))

    current = {"user": UserPublic(username="user-a", role="user", active=True)}
    app.dependency_overrides[_get_current_user] = lambda: current["user"]

    def as_user(username: str, role: str = "user") -> None:
        current["user"] = UserPublic(username=username, role=role, active=True)

    client = TestClient(app)
    try:
        yield client, as_user
    finally:
        # Hygiene: no run may leak into the next test. Abort every user's
        # own run and wait for the registry to drain.
        try:
            for username in ("user-a", "user-b", "admin-c"):
                as_user(username, role="admin")
                client.post("/v1/solve/abort?force=true")
            deadline = time.time() + 30.0
            from backend import solver as solver_module

            while solver_module.active_run_count() > 0 and time.time() < deadline:
                time.sleep(0.2)
        finally:
            app.dependency_overrides.pop(_get_current_user, None)


def _seed_user(username: str) -> None:
    state = make_app_state(clinicians=[make_clinician(f"clin-{username}", f"Doc {username}")])
    _save_state(state, username)


def _start_agent_run(client: TestClient, run_token: str) -> None:
    resp = client.post(
        "/v1/solve/range",
        json={
            "startISO": MON,
            "endISO": MON,
            "only_fill_required": True,
            "solver_mode": "agent",
            "agent_strategy": "repair",
            "timeout_seconds": 60,
            "run_token": run_token,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["run_id"] == run_token


def _run_status(client: TestClient, run_id: str) -> str:
    resp = client.get(f"/v1/solve/runs/{run_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["status"]


def _wait_terminal(client: TestClient, run_id: str, timeout_s: float = 60.0) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status = _run_status(client, run_id)
        if status in TERMINAL_STATUSES:
            return status
        time.sleep(0.2)
    raise AssertionError(f"run {run_id} did not reach a terminal status in time")


def test_abort_is_user_scoped(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")
    _seed_user("user-b")

    as_user("user-a")
    _start_agent_run(client, "run-a")
    assert _run_status(client, "run-a") == "running"

    # A foreign user without run_id has no own run to abort.
    as_user("user-b")
    resp = client.post("/v1/solve/abort")
    assert resp.json()["status"] == "no_solver_running"

    # A foreign user WITH the run id must not learn about or touch the run.
    resp = client.post("/v1/solve/abort?run_id=run-a&force=true")
    assert resp.json()["status"] == "no_solver_running"

    as_user("user-a")
    assert _run_status(client, "run-a") == "running"

    # Admins may abort any run by id.
    as_user("admin-c", role="admin")
    resp = client.post("/v1/solve/abort?run_id=run-a&force=true")
    assert resp.json()["status"] == "force_killed"

    as_user("user-a")
    assert _wait_terminal(client, "run-a") in {"aborted", "failed"}


def test_owner_aborts_own_run_without_run_id(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")

    as_user("user-a")
    _start_agent_run(client, "run-own")
    assert _run_status(client, "run-own") == "running"

    resp = client.post("/v1/solve/abort")
    assert resp.json()["status"] == "abort_requested"
    assert _wait_terminal(client, "run-own") in {"aborted", "finished"}
