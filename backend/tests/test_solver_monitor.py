"""End-status logic of the run monitor: watchdog hard stop, salvage, spend.

The subprocess is replaced by a SimpleNamespace stand-in; no solver runs.
"""
import time
from queue import Empty, Queue
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import auth, db, solver, solver_runs
from backend.agent_budget import get_spend_usd
from backend.models import SolveRangeRequest
from backend.run_apply import apply_stored_run, planning_fingerprint
from backend.state import _load_state, _save_state
from backend.tests.conftest import make_app_state, make_assignment

MON = "2026-01-05"
USER = "monitor-test"


@pytest.fixture(autouse=True)
def user(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "monitor.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setattr(solver, "_broadcast_solver_progress", lambda *args: None)
    return auth._create_user(USER, "monitor-password", "user")


class FakeProcess:
    """Stays alive until kill(); terminate() is swallowed like the real
    worker's SIGTERM handler (it only sets the cancel event)."""

    def __init__(self, alive=True, exitcode=None):
        self.alive = alive
        self.exitcode = exitcode
        self.kills = 0
        self.terminates = 0

    def is_alive(self):
        # Safety valve so a regression fails instead of hanging the suite.
        return self.alive and self.terminates < 50

    def kill(self):
        self.kills += 1
        self.alive = False
        self.exitcode = -9

    def terminate(self):
        self.terminates += 1

    def join(self, **_):
        return None


def run_monitor(user, process, messages, *, started_at=None, timeout_seconds=None, queue=None):
    solver_runs.create_run("run-1", USER, MON, MON, {})
    if queue is None:
        queue = Queue()
        for message in messages:
            queue.put(message)
    handle = solver._RunHandle(
        run_id="run-1", username=USER, exclusive=False,
        process=process, progress_queue=queue, mp_cancel_event=Event(),
        heartbeat_value=SimpleNamespace(value=0),
        started_at=started_at if started_at is not None else time.time(),
        account_generation=user._account_generation,
    )
    solver._monitor_solver_job(
        handle, SolveRangeRequest(startISO=MON, endISO=MON, timeout_seconds=timeout_seconds),
    )
    return solver_runs.get_run("run-1", USER)


def solution_event():
    assignment = make_assignment("draft", "slot-a__mon", MON, "clin-1", "solver")
    return {"type": "progress", "event": "solution",
            "data": {"assignments": [assignment.model_dump()]}}


def test_overshoot_hard_stop_kills_the_process_once(user):
    process = FakeProcess()
    run = run_monitor(user, process, [], started_at=time.time() - 1000, timeout_seconds=1)
    assert process.kills == 1
    assert run["status"] == "failed"
    assert "exceeded its time budget" in run["error"]


def test_overshoot_hard_stop_salvages_last_streamed_solution(user):
    process = FakeProcess()
    run = run_monitor(user, process, [solution_event()],
                      started_at=time.time() - 1000, timeout_seconds=1)
    assert process.kills == 1
    assert run["status"] == "aborted"
    assert "stopped by the watchdog" in " ".join(run["result"]["notes"])


def test_unexpected_exit_with_streamed_solution_is_stored_as_aborted(user):
    _save_state(make_app_state(), USER)
    state = _load_state(USER)
    run = run_monitor(user, FakeProcess(alive=False, exitcode=-9), [solution_event()])
    assert run["status"] == "aborted"
    assert "ended unexpectedly (exit code -9)" in " ".join(run["result"]["notes"])

    # An interrupted draft must not be applied without explicit confirmation.
    solver_runs.set_fingerprint("run-1", planning_fingerprint(state))
    with pytest.raises(HTTPException) as error:
        apply_stored_run(USER, "run-1")
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "partial_result"
    assert _load_state(USER).assignments == []


def test_finished_agent_run_records_spend_once(user):
    result = {"assignments": [], "notes": [], "debugInfo": {"agent": {
        "model": "claude-sonnet-5", "input_tokens": 1_000_000,
    }}}
    run = run_monitor(user, FakeProcess(alive=False, exitcode=0), [{"type": "result", "data": result}])
    assert run["status"] == "finished"
    assert get_spend_usd(USER) == pytest.approx(2.0)


class TornQueue:
    """Hands out its messages, then blocks like a recv on a torn message
    (worker killed mid-put; the parent still holds the pipe's write end)."""

    def __init__(self, messages):
        self.messages = list(messages)
        self.release = Event()

    def get_nowait(self):
        if self.messages:
            return self.messages.pop(0)
        self.release.wait()
        raise Empty

    def get(self, timeout=None):
        return self.get_nowait()


def test_torn_message_after_kill_cannot_hang_the_monitor(user, monkeypatch):
    monkeypatch.setattr(solver, "RUN_QUEUE_DRAIN_TIMEOUT_SECONDS", 0.2)
    queue = TornQueue([solution_event()])
    try:
        started = time.monotonic()
        run = run_monitor(user, FakeProcess(alive=False, exitcode=-9), [], queue=queue)
        assert time.monotonic() - started < 5
    finally:
        queue.release.set()
    # The message read before the torn one is still salvaged.
    assert run["status"] == "aborted"
    assert "ended unexpectedly (exit code -9)" in " ".join(run["result"]["notes"])


def test_watchdog_kill_reaps_the_worker_before_draining(user, monkeypatch):
    monkeypatch.setattr(solver, "RUN_QUEUE_DRAIN_TIMEOUT_SECONDS", 0.2)
    process = FakeProcess()
    joins = []
    process.join = lambda **kwargs: joins.append(kwargs)
    queue = TornQueue([solution_event()])
    try:
        run = run_monitor(user, process, [], queue=queue,
                          started_at=time.time() - 1000, timeout_seconds=1)
    finally:
        queue.release.set()
    assert process.kills == 1
    assert joins[0] == {"timeout": 5.0}
    assert run["status"] == "aborted"
    assert "stopped by the watchdog" in " ".join(run["result"]["notes"])
