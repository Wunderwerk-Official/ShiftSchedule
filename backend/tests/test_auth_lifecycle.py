"""Account deletion must not let a reused name inherit data or sessions."""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from jose import jwt

from backend import auth, db, solver
from backend.models import LoginRequest, UserUpdateRequest


@pytest.fixture(autouse=True)
def accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "accounts.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)


def token_for(username):
    return auth._create_access_token(auth._user_row_to_public(auth._get_user_by_username(username)))


def assert_unauthorized(token):
    with pytest.raises(HTTPException) as error:
        auth._verify_token_and_get_user(token)
    assert error.value.status_code == 401


def test_deleted_account_token_cannot_authenticate_recreated_username():
    auth._create_user("same", "first-password", "admin")
    old_token = token_for("same")
    auth._delete_user("same")
    auth._create_user("same", "different-password", "user")
    assert_unauthorized(old_token)
    assert auth._verify_token_and_get_user(token_for("same")).role == "user"


def test_name_only_legacy_token_is_rejected_even_for_existing_account():
    auth._create_user("alice", "password", "user")
    legacy = jwt.encode({"sub": "alice", "role": "admin",
                         "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                        auth.JWT_SECRET, algorithm=auth.JWT_ALGORITHM)
    assert_unauthorized(legacy)


def test_password_change_and_disable_reenable_revoke_existing_sessions():
    auth._create_user("alice", "password", "user")
    first = token_for("alice")
    auth._update_user("alice", UserUpdateRequest(password="new-password"))
    assert_unauthorized(first)
    second = token_for("alice")
    auth._update_user("alice", UserUpdateRequest(active=False))
    auth._update_user("alice", UserUpdateRequest(active=True))
    assert_unauthorized(second)
    assert auth._verify_token_and_get_user(token_for("alice")).username == "alice"


def seed_owned_data(username):
    now = datetime.now(timezone.utc).isoformat()
    with db._get_connection() as conn:
        conn.execute("INSERT INTO app_state VALUES (?, ?, ?)", (username, "{}", now))
        conn.execute("INSERT INTO ical_publications VALUES (?, ?, NULL, NULL, NULL, ?, ?)",
                     (username, f"ical-{username}", now, now))
        conn.execute("INSERT INTO ical_clinician_publications VALUES (?, ?, ?, ?, ?)",
                     (username, "clinician", f"ical-clinician-{username}", now, now))
        conn.execute("INSERT INTO web_publications VALUES (?, ?, ?, ?)",
                     (username, f"web-{username}", now, now))
        conn.execute("INSERT INTO agent_spend VALUES (?, ?, ?)", (username, 3.0, now))
        conn.execute("INSERT INTO solver_runs (id, username, status, start_iso, end_iso, params, created_at) "
                     "VALUES (?, ?, 'finished', '2026-01-05', '2026-01-05', '{}', ?)",
                     (f"run-{username}", username, now))
        conn.execute("INSERT INTO run_feedback VALUES (?, ?, ?, ?, ?)",
                     (f"feedback-{username}", f"run-{username}", username, "private comment", now))
        conn.execute("INSERT INTO schedule_changes VALUES (?, ?, 'manual_edit', NULL, NULL, '{}', ?, ?)",
                     (f"change-{username}", username, now, now))
        conn.execute("INSERT INTO calendar_snapshots VALUES (?, ?, 'private snapshot', 'named', '{}', ?, ?)",
                     (f"snapshot-{username}", username, now, now))


def owned_rows(username):
    result = {}
    with db._get_connection() as conn:
        for table, column in [("app_state", "id")] + [(table, "username") for table in (
            "users", "ical_publications", "ical_clinician_publications", "web_publications",
            "agent_spend", "solver_runs", "run_feedback", "schedule_changes", "calendar_snapshots",
        )]:
            result[table] = [dict(row) for row in conn.execute(
                f"SELECT * FROM {table} WHERE {column} = ?", (username,)).fetchall()]
    return result


def test_delete_atomically_removes_every_owned_table_and_stops_worker(monkeypatch):
    for name in ("victim", "other"):
        auth._create_user(name, "password", "user")
        seed_owned_data(name)
    before_other = owned_rows("other")
    stopped = []
    monkeypatch.setattr(solver, "stop_account_work", lambda username: stopped.append(username), raising=False)
    auth._delete_user("victim")
    assert stopped == ["victim"]
    assert all(not rows for rows in owned_rows("victim").values())
    assert owned_rows("other") == before_other
    auth._create_user("victim", "new-password", "user")
    assert all(not rows for table, rows in owned_rows("victim").items() if table != "users")


def test_failed_cleanup_rolls_back_all_database_deletes(monkeypatch):
    auth._create_user("victim", "password", "user")
    seed_owned_data("victim")
    before = owned_rows("victim")
    with db._get_connection() as conn:
        conn.execute("CREATE TRIGGER prevent_snapshot_delete BEFORE DELETE ON calendar_snapshots "
                     "BEGIN SELECT RAISE(ABORT, 'simulated failure'); END")
    monkeypatch.setattr(solver, "stop_account_work", lambda _: None, raising=False)
    with pytest.raises(sqlite3.IntegrityError, match="simulated failure"):
        auth._delete_user("victim")
    assert owned_rows("victim") == before


def test_existing_database_migration_preserves_accounts_and_data():
    with sqlite3.connect(db.DB_PATH) as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, "
                     "password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL)")
        conn.execute("INSERT INTO users VALUES (7, 'alice', 'old-hash', 'admin', 1, '2020-01-01')")
        conn.execute("CREATE TABLE app_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.execute("INSERT INTO app_state VALUES ('alice', ?, 'old-time')", (json.dumps({"private": "state"}),))
    migrated = dict(auth._get_user_by_username("alice"))
    assert migrated["id"] == 7 and migrated["password_hash"] == "old-hash"
    assert migrated["account_generation"] and migrated["token_version"] == 0
    before = owned_rows("alice")
    db._SCHEMA_READY = False  # Simulate another startup: identity must stay stable.
    assert dict(auth._get_user_by_username("alice")) == migrated
    assert owned_rows("alice") == before


def test_login_race_never_mints_new_account_token_with_old_password(monkeypatch):
    auth._create_user("same", "old-password", "admin")
    original_verify = auth._verify_password

    def replace_while_verifying(password, hashed):
        success = original_verify(password, hashed)
        auth._delete_user("same")
        auth._create_user("same", "new-password", "user")
        return success

    monkeypatch.setattr(auth, "_verify_password", replace_while_verifying)
    try:
        response = auth.login(LoginRequest(username="same", password="old-password"))
    except HTTPException as error:
        assert error.status_code == 401
    else:
        assert_unauthorized(response.access_token)


def test_new_account_does_not_inherit_orphans_from_older_deletions():
    # Simulate an account removed by a version which did not clear history.
    seed_owned_data("orphan")
    auth._create_user("orphan", "new-password", "user")
    assert all(not rows for table, rows in owned_rows("orphan").items() if table != "users")


def test_account_identity_is_private_and_current_role_comes_from_database():
    user = auth._create_user("alice", "password", "admin")
    token = token_for("alice")
    assert user._account_generation
    assert user.model_dump() == {"username": "alice", "role": "admin", "active": True}
    auth._update_user("alice", UserUpdateRequest(role="user"))
    assert auth._verify_token_and_get_user(token).role == "user"


def test_monitor_cannot_restore_old_data_or_charge_recreated_account(monkeypatch):
    from queue import Queue
    from threading import Event
    from types import SimpleNamespace
    import time
    from backend import solver_runs
    from backend.models import SolveRangeRequest

    old_user = auth._create_user("victim", "old-password", "user")
    old_generation = old_user._account_generation
    auth._delete_user("victim")
    auth._create_user("victim", "new-password", "user")
    solver_runs.create_run("reused-run-id", "victim", "2026-01-05", "2026-01-05", {})
    queue = Queue()
    queue.put({"type": "result", "data": {
        "assignments": [], "notes": [], "debugInfo": {"agent": {
            "model": "claude-sonnet-5", "input_tokens": 1_000_000,
        }},
    }})
    process = SimpleNamespace(is_alive=lambda: False, join=lambda **_: None)
    handle = solver._RunHandle(
        run_id="reused-run-id", username="victim", mode="agent", exclusive=False,
        process=process, progress_queue=queue, mp_cancel_event=Event(),
        heartbeat_value=SimpleNamespace(value=0), started_at=time.time(),
        account_generation=old_generation,
    )
    emitted = []
    monkeypatch.setattr(solver, "_broadcast_solver_progress", lambda *args: emitted.append(args))
    solver._emit_run_progress(handle, "solution", {"private": "old-account-plan"})
    solver._monitor_solver_job(handle, SolveRangeRequest(startISO="2026-01-05"))
    assert not emitted
    assert owned_rows("victim")["agent_spend"] == []
    assert solver_runs.get_run("reused-run-id", "victim")["status"] == "running"


def test_stale_authenticated_admission_is_rejected_after_replacement_or_reset(monkeypatch):
    from backend.models import SolveRangeRequest
    user = auth._create_user("victim", "password", "user")
    dispatched = []
    monkeypatch.setattr(solver, "_start_solver_job_locked", lambda *args: dispatched.append(args))
    auth._update_user("victim", UserUpdateRequest(password="new-password"))
    with pytest.raises(HTTPException) as error:
        solver._start_solver_job("victim", SolveRangeRequest(startISO="2026-01-05"), "run",
                                 account_generation=user._account_generation, token_version=user._token_version)
    assert error.value.status_code == 401
    auth._delete_user("victim")
    auth._create_user("victim", "replacement-password", "user")
    with pytest.raises(HTTPException) as error:
        solver._start_solver_job("victim", SolveRangeRequest(startISO="2026-01-05"), "run",
                                 account_generation=user._account_generation, token_version=user._token_version)
    assert error.value.status_code == 401
    assert dispatched == []


def test_delete_stops_a_live_solver_process_and_prevents_new_account_artifacts(tmp_path, monkeypatch):
    import time
    from backend.models import SolveRangeRequest
    from backend.state import _save_state
    from .conftest import make_app_state

    monkeypatch.setenv("SCHEDULE_DB_PATH", db.DB_PATH)
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    script = tmp_path / "slow-model.json"
    script.write_text(json.dumps([{"text": "still working", "delay_ms": 3000}] * 3))
    monkeypatch.setenv("AGENT_MOCK_SCRIPT", str(script))
    user = auth._create_user("victim", "password", "user")
    _save_state(make_app_state(), "victim")
    solver._start_solver_job("victim", SolveRangeRequest(startISO="2026-01-05", endISO="2026-01-05",
                             solver_mode="agent", timeout_seconds=30), "deleted-running-plan",
                             account_generation=user._account_generation, token_version=user._token_version)
    handle = solver._active_runs["victim"]
    try:
        assert handle.process.is_alive()
        auth._delete_user("victim")
        auth._create_user("victim", "replacement-password", "user")
        handle.process.join(timeout=5)
        assert not handle.process.is_alive()
        assert handle.account_deleted.is_set()
        assert "victim" not in solver._active_runs
        # Allow the monitor to consume process termination and take its
        # guarded error/salvage path after replacement.
        time.sleep(0.25)
        assert all(not rows for table, rows in owned_rows("victim").items() if table != "users")
    finally:
        if handle.process.is_alive():
            handle.process.kill()
            handle.process.join(timeout=5)


@pytest.mark.parametrize("operation", [
    "read_state", "save_state", "list_snapshots", "create_snapshot", "restore_snapshot",
    "rename_snapshot", "delete_snapshot", "apply_run",
])
def test_stale_authenticated_request_cannot_access_replacement_data(operation):
    from backend import snapshots, solver_runs, state_routes
    from backend.run_apply import apply_stored_run, planning_fingerprint
    from backend.state import _save_state
    from .conftest import make_app_state

    old_user = auth._create_user("same", "old-password", "user")
    auth._delete_user("same")
    current_user = auth._create_user("same", "new-password", "user")
    state = make_app_state()
    _save_state(state, "same")
    meta = snapshots.create_snapshot(snapshots.SnapshotCreateRequest(name="new-generation", state=state), current_user)
    solver_runs.create_run("new-run", "same", "2026-01-05", "2026-01-05", {},
                           input_fingerprint=planning_fingerprint(state))
    solver_runs.finish_run("new-run", "finished", result={"assignments": [], "notes": []})
    before = owned_rows("same")
    calls = {
        "read_state": lambda: state_routes.get_state(old_user),
        "save_state": lambda: state_routes.set_state(state, old_user),
        "list_snapshots": lambda: snapshots.list_snapshots(old_user),
        "create_snapshot": lambda: snapshots.create_snapshot(
            snapshots.SnapshotCreateRequest(name="stale", state=state), old_user),
        "restore_snapshot": lambda: snapshots.restore_snapshot(
            meta.id, snapshots.SnapshotRestoreRequest(), old_user),
        "rename_snapshot": lambda: snapshots.rename_snapshot(
            meta.id, snapshots.SnapshotRenameRequest(name="stale"), old_user),
        "delete_snapshot": lambda: snapshots.delete_snapshot(meta.id, old_user),
        "apply_run": lambda: apply_stored_run("same", "new-run", force=True, allow_partial=True, account_user=old_user),
    }
    with pytest.raises(HTTPException) as error:
        calls[operation]()
    assert error.value.status_code == 401
    assert owned_rows("same") == before


def test_save_authenticated_before_deletion_rechecks_identity_after_preparation(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from backend import state_routes
    from backend.state import _save_state
    from .conftest import make_app_state

    old_user = auth._create_user("same", "old-password", "user")
    state = make_app_state()
    _save_state(state, "same")
    entered, proceed = Event(), Event()
    original_normalize = state_routes._normalize_state

    def slow_prepare(payload):
        entered.set()
        assert proceed.wait(5)
        return original_normalize(payload)

    monkeypatch.setattr(state_routes, "_normalize_state", slow_prepare)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(state_routes.set_state, state, old_user)
        try:
            assert entered.wait(5)
            auth._delete_user("same")
            auth._create_user("same", "new-password", "user")
            _save_state(make_app_state(), "same")
            before = owned_rows("same")
        finally:
            proceed.set()
        with pytest.raises(HTTPException) as error:
            pending.result(timeout=5)
        assert error.value.status_code == 401
    assert owned_rows("same") == before
