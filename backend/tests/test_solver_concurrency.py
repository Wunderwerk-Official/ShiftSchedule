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


def test_same_user_second_solve_409(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")

    as_user("user-a")
    _start_agent_run(client, "run-first")
    resp = client.post(
        "/v1/solve/range",
        json={
            "startISO": MON,
            "endISO": MON,
            "solver_mode": "agent",
            "run_token": "run-second",
        },
    )
    assert resp.status_code == 409
    assert "already have a planning run" in resp.json()["detail"]
    assert _wait_terminal(client, "run-first") == "finished"


def test_two_users_agent_runs_concurrently(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")
    _seed_user("user-b")

    as_user("user-a")
    _start_agent_run(client, "run-a")
    as_user("user-b")
    _start_agent_run(client, "run-b")  # would have been 409 under the old slot

    # Both runs are observably running at the same time.
    assert _run_status(client, "run-b") == "running"
    as_user("user-a")
    assert _run_status(client, "run-a") == "running"

    # Run listings stay strictly per user.
    as_user("user-b")
    own_ids = {run["id"] for run in client.get("/v1/solve/runs").json()["runs"]}
    assert "run-b" in own_ids
    assert "run-a" not in own_ids

    assert _wait_terminal(client, "run-b") == "finished"
    as_user("user-a")
    assert _wait_terminal(client, "run-a") == "finished"


def test_exclusive_mode_blocked_while_agent_runs(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")
    _seed_user("user-b")

    as_user("user-a")
    _start_agent_run(client, "run-agent")

    as_user("user-b")
    for legacy_payload in (
        {"solver_mode": "cpsat"},
        {"use_heuristic": True},
    ):
        resp = client.post(
            "/v1/solve/range",
            json={"startISO": MON, "endISO": MON, "run_token": "run-legacy", **legacy_payload},
        )
        assert resp.status_code == 409
        assert "exclusive access" in resp.json()["detail"]

    as_user("user-a")
    assert _wait_terminal(client, "run-agent") == "finished"


def test_admission_matrix():
    from types import SimpleNamespace

    from backend import solver as solver_module

    agent_handle = SimpleNamespace(exclusive=False)
    exclusive_handle = SimpleNamespace(exclusive=True)
    check = solver_module._admission_error

    # Empty registry admits both modes.
    assert check({}, "user-a", exclusive=False) is None
    assert check({}, "user-a", exclusive=True) is None
    # Self-overlap always rejected (and wins over other rules).
    assert "already have" in check({"user-a": agent_handle}, "user-a", exclusive=False)
    assert "already have" in check({"user-a": exclusive_handle}, "user-a", exclusive=True)
    # A live exclusive run blocks everyone else.
    assert "exclusive solver run" in check({"user-b": exclusive_handle}, "user-a", exclusive=False)
    # An exclusive start needs an empty registry.
    assert "exclusive access" in check({"user-b": agent_handle}, "user-a", exclusive=True)
    # Agent runs of different users coexist below the cap.
    assert check({"user-b": agent_handle}, "user-a", exclusive=False) is None
    # The cap rejects further agent runs.
    crowd = {f"user-{i}": agent_handle for i in range(solver_module.MAX_CONCURRENT_SOLVES)}
    assert "limit of concurrent" in check(crowd, "user-z", exclusive=False)


def test_run_token_cross_user_collision_rejected(multi_user_client):
    client, as_user = multi_user_client
    from backend import solver_runs

    _seed_user("user-b")
    solver_runs.create_run(
        "shared-token", "user-a", MON, MON, {"startISO": MON, "solver_mode": "agent"}
    )
    solver_runs.finish_run("shared-token", "finished")

    as_user("user-b")
    resp = client.post(
        "/v1/solve/range",
        json={"startISO": MON, "endISO": MON, "solver_mode": "agent", "run_token": "shared-token"},
    )
    assert resp.status_code == 409
    assert "already in use" in resp.json()["detail"]
    # The original row was not hijacked.
    assert solver_runs.get_run_any_user("shared-token")["username"] == "user-a"


def test_recovery_restarts_one_run_per_user(multi_user_client):
    client, as_user = multi_user_client
    from backend import solver_runs
    from backend.solver import recover_interrupted_runs

    _seed_user("user-a")
    _seed_user("user-b")
    params = {
        "startISO": MON,
        "endISO": MON,
        "only_fill_required": True,
        "solver_mode": "agent",
        "agent_strategy": "repair",
        "timeout_seconds": 60,
    }
    # Older stranded run of user-a (created first), then the newer one, plus
    # one stranded run of user-b.
    solver_runs.create_run("stranded-a-old", "user-a", MON, MON, {**params, "run_token": "stranded-a-old"})
    time.sleep(1.1)  # created_at has second resolution
    solver_runs.create_run("stranded-a-new", "user-a", MON, MON, {**params, "run_token": "stranded-a-new"})
    solver_runs.create_run("stranded-b", "user-b", MON, MON, {**params, "run_token": "stranded-b"})

    recover_interrupted_runs()

    as_user("user-a")
    assert _run_status(client, "stranded-a-old") == "crashed"
    assert _wait_terminal(client, "stranded-a-new") == "finished"
    as_user("user-b")
    assert _wait_terminal(client, "stranded-b") == "finished"

    as_user("user-a")
    new_run = client.get("/v1/solve/runs/stranded-a-new").json()
    assert new_run["attempt"] == 2
    assert any("restarted" in (note or "") for note in [new_run.get("notes")])


def test_health_counts_running_solves(multi_user_client):
    client, as_user = multi_user_client
    _seed_user("user-a")

    as_user("user-a")
    _start_agent_run(client, "run-health")
    body = client.get("/health").json()
    assert body["solver_running"] is True
    assert body["running_solves"] == 1

    assert _wait_terminal(client, "run-health") == "finished"
    deadline = time.time() + 10.0
    while time.time() < deadline:
        body = client.get("/health").json()
        if body["running_solves"] == 0:
            break
        time.sleep(0.2)
    assert body == {"status": "ok", "solver_running": False, "running_solves": 0}


def test_broadcast_is_owner_scoped():
    import asyncio

    from backend import solver as solver_module

    queue_a: asyncio.Queue = asyncio.Queue()
    queue_b: asyncio.Queue = asyncio.Queue()
    entry_a = ("user-a", queue_a)
    entry_b = ("user-b", queue_b)
    with solver_module._subscribers_lock:
        solver_module._solver_progress_subscribers.extend([entry_a, entry_b])
    try:
        solver_module._broadcast_solver_progress("user-a", "tok-1", "phase", {"phase": "x"})
        assert queue_b.empty()
        event = queue_a.get_nowait()
        assert event["event"] == "phase"
        assert event["data"]["run_token"] == "tok-1"
    finally:
        with solver_module._subscribers_lock:
            solver_module._solver_progress_subscribers.remove(entry_a)
            solver_module._solver_progress_subscribers.remove(entry_b)
