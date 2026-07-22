"""Named calendar snapshots: CRUD, cap, auto-backup slot, full-blob restore."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _get_current_user
from backend.main import app
from backend.models import UserPublic
from backend.snapshots import (
    AUTO_BACKUP_NAME,
    MAX_NAMED_SNAPSHOTS_PER_USER,
    SNAPSHOT_NAME_MAX_CHARS,
)
from backend.state import _save_state

from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot

MON = "2026-01-05"
USER = "snapshot-user"


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "snapshots.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    return db_path


def _client_as(username: str = USER, role: str = "admin") -> TestClient:
    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=username, role=role, active=True
    )
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_overrides():
    yield
    app.dependency_overrides.pop(_get_current_user, None)


def _state_with_assignment(clinician_id: str = "clin-1"):
    state = make_app_state(
        clinicians=[make_clinician(clinician_id, "Alice")],
        assignments=[make_assignment("a1", "slot-a__mon", MON, clinician_id)],
    )
    return state


def _create(client, name: str, state) -> dict:
    res = client.post(
        "/v1/state/snapshots", json={"name": name, "state": state.model_dump()}
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_and_list_returns_metadata_only(temp_db):
    client = _client_as()
    meta = _create(client, "Before test", _state_with_assignment())
    assert meta["name"] == "Before test"
    assert meta["kind"] == "named"
    assert meta["size_bytes"] > 0
    assert "data" not in meta

    listed = client.get("/v1/state/snapshots").json()
    assert [s["id"] for s in listed] == [meta["id"]]
    assert all("data" not in s for s in listed)


def test_cap_rejects_creation_with_clear_message(temp_db):
    client = _client_as()
    state = _state_with_assignment()
    for i in range(MAX_NAMED_SNAPSHOTS_PER_USER):
        _create(client, f"v{i}", state)
    res = client.post(
        "/v1/state/snapshots", json={"name": "one too many", "state": state.model_dump()}
    )
    assert res.status_code == 409
    assert f"Snapshot limit reached ({MAX_NAMED_SNAPSHOTS_PER_USER})" in res.json()["detail"]


def test_name_validation(temp_db):
    client = _client_as()
    state = _state_with_assignment()
    res = client.post(
        "/v1/state/snapshots", json={"name": "   ", "state": state.model_dump()}
    )
    assert res.status_code == 400

    long_name = "x" * 150
    meta = _create(client, long_name, state)
    assert len(meta["name"]) == SNAPSHOT_NAME_MAX_CHARS


def test_restore_round_trip_and_auto_backup(temp_db):
    client = _client_as()
    state_a = _state_with_assignment("clin-1")
    meta = _create(client, "state A", state_a)

    # Live state moves on to B (different clinician, no assignment).
    state_b = make_app_state(clinicians=[make_clinician("clin-2", "Bob")])
    _save_state(state_b, USER)

    res = client.post(
        f"/v1/state/snapshots/{meta['id']}/restore",
        json={"currentState": state_b.model_dump()},
    )
    assert res.status_code == 200, res.text
    restored = res.json()
    assert [c["name"] for c in restored["clinicians"]] == ["Alice"]

    live = client.get("/v1/state").json()
    assert [c["name"] for c in live["clinicians"]] == ["Alice"]
    assert [a["id"] for a in live["assignments"]] == ["a1"]

    listed = client.get("/v1/state/snapshots").json()
    backups = [s for s in listed if s["kind"] == "auto_backup"]
    assert len(backups) == 1
    assert backups[0]["name"] == AUTO_BACKUP_NAME

    # The auto-backup holds B — restoring it brings Bob back.
    res2 = client.post(
        f"/v1/state/snapshots/{backups[0]['id']}/restore", json={}
    )
    assert res2.status_code == 200
    assert [c["name"] for c in res2.json()["clinicians"]] == ["Bob"]


def test_second_restore_overwrites_auto_backup(temp_db):
    client = _client_as()
    state = _state_with_assignment()
    meta = _create(client, "v1", state)
    for _ in range(2):
        res = client.post(
            f"/v1/state/snapshots/{meta['id']}/restore",
            json={"currentState": state.model_dump()},
        )
        assert res.status_code == 200
    listed = client.get("/v1/state/snapshots").json()
    assert len([s for s in listed if s["kind"] == "auto_backup"]) == 1


def test_rename_and_auto_backup_rename_rejected(temp_db):
    client = _client_as()
    state = _state_with_assignment()
    meta = _create(client, "old name", state)
    res = client.patch(
        f"/v1/state/snapshots/{meta['id']}", json={"name": "new name"}
    )
    assert res.status_code == 200
    assert res.json()["name"] == "new name"

    client.post(
        f"/v1/state/snapshots/{meta['id']}/restore",
        json={"currentState": state.model_dump()},
    )
    backup = [
        s for s in client.get("/v1/state/snapshots").json() if s["kind"] == "auto_backup"
    ][0]
    res2 = client.patch(
        f"/v1/state/snapshots/{backup['id']}", json={"name": "sneaky"}
    )
    assert res2.status_code == 400


def test_delete_with_confirmation_of_absence(temp_db):
    client = _client_as()
    meta = _create(client, "doomed", _state_with_assignment())
    assert client.delete(f"/v1/state/snapshots/{meta['id']}").status_code == 204
    assert client.get("/v1/state/snapshots").json() == []
    assert client.delete(f"/v1/state/snapshots/{meta['id']}").status_code == 404


def test_cross_user_isolation(temp_db):
    client_x = _client_as("user-x")
    meta = _create(client_x, "x's snapshot", _state_with_assignment())

    client_y = _client_as("user-y")
    assert client_y.get("/v1/state/snapshots").json() == []
    assert (
        client_y.post(f"/v1/state/snapshots/{meta['id']}/restore", json={}).status_code
        == 404
    )
    assert (
        client_y.patch(
            f"/v1/state/snapshots/{meta['id']}", json={"name": "stolen"}
        ).status_code
        == 404
    )
    assert client_y.delete(f"/v1/state/snapshots/{meta['id']}").status_code == 404


def test_restore_survives_template_change(temp_db):
    """THE regression test for the full-blob requirement: assignments in a
    snapshot must come back even after the live template dropped their slot
    (normalizing assignments against a DIFFERENT template deletes them —
    the flaw of the old client-side snapshot export)."""
    client = _client_as()
    state_t1 = _state_with_assignment()
    meta = _create(client, "with T1 slots", state_t1)

    # Live state: the template loses the slot the assignment points to.
    state_t2 = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=[make_template_slot(slot_id="slot-b__tue", col_band_id="col-tue-1")],
    )
    _save_state(state_t2, USER)
    live = client.get("/v1/state").json()
    assert live["assignments"] == []  # T1 assignment is gone under T2

    res = client.post(
        f"/v1/state/snapshots/{meta['id']}/restore",
        json={"currentState": state_t2.model_dump()},
    )
    assert res.status_code == 200
    restored = res.json()
    assert [a["id"] for a in restored["assignments"]] == ["a1"]
    assert [a["rowId"] for a in restored["assignments"]] == ["slot-a__mon"]
