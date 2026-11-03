"""Named calendar snapshots: CRUD, cap, auto-backup slot, full-blob restore."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.auth import _get_current_user, _create_user, _get_user_by_username, _user_row_to_public
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
    row = _get_user_by_username(username)
    user = _user_row_to_public(row) if row else _create_user(username, "snapshot-test-password", role)
    app.dependency_overrides[_get_current_user] = lambda: user
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
        json={"currentState": client.get("/v1/state").json()},
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
            json={"currentState": client.get("/v1/state").json()},
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
        json={"currentState": client.get("/v1/state").json()},
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
        json={"currentState": live},
    )
    assert res.status_code == 200
    restored = res.json()
    assert [a["id"] for a in restored["assignments"]] == ["a1"]
    assert [a["rowId"] for a in restored["assignments"]] == ["slot-a__mon"]


def test_restore_rejects_stale_browser_state_without_changing_backup(temp_db):
    client = _client_as()
    original = _state_with_assignment()
    meta = _create(client, "original", original)
    _save_state(original, USER)
    stale = client.get("/v1/state").json()
    newer = make_app_state(clinicians=[make_clinician("clin-2", "Bob")])
    _save_state(newer, USER)

    response = client.post(f"/v1/state/snapshots/{meta['id']}/restore",
                           json={"currentState": stale})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "state_changed"
    assert client.get("/v1/state").json()["clinicians"][0]["name"] == "Bob"
    assert not any(s["kind"] == "auto_backup" for s in client.get("/v1/state/snapshots").json())


def test_restore_rolls_back_backup_when_state_write_fails(temp_db, monkeypatch):
    import backend.snapshots as snapshots

    client = _client_as()
    meta = _create(client, "original", _state_with_assignment())
    current = make_app_state(clinicians=[make_clinician("clin-2", "Bob")])
    _save_state(current, USER)

    def fail_save(*args, **kwargs):
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(snapshots, "_save_state", fail_save)
    with pytest.raises(RuntimeError, match="simulated write failure"):
        client.post(f"/v1/state/snapshots/{meta['id']}/restore", json={})
    assert client.get("/v1/state").json()["clinicians"][0]["name"] == "Bob"
    assert not any(s["kind"] == "auto_backup" for s in client.get("/v1/state/snapshots").json())


def test_import_backup_saves_the_shown_calendar_outside_the_named_limit(temp_db):
    from backend.snapshots import IMPORT_BACKUP_NAME

    client = _client_as()
    shown = _state_with_assignment("clin-1")
    res = client.post("/v1/state/snapshots/import-backup", json={"state": shown.model_dump()})
    assert res.status_code == 201, res.text
    assert res.json()["kind"] == "auto_backup"
    assert res.json()["name"] == IMPORT_BACKUP_NAME
    listed = client.get("/v1/state/snapshots").json()
    assert [(s["kind"], s["name"]) for s in listed] == [("auto_backup", IMPORT_BACKUP_NAME)]

    # The backup restores the calendar as it was shown before the import.
    _save_state(make_app_state(clinicians=[make_clinician("clin-2", "Bob")]), USER)
    restored = client.post(f"/v1/state/snapshots/{res.json()['id']}/restore", json={})
    assert restored.status_code == 200
    assert [c["name"] for c in restored.json()["clinicians"]] == ["Alice"]


def test_import_backup_works_at_the_named_snapshot_limit(temp_db):
    client = _client_as()
    state = _state_with_assignment()
    for index in range(MAX_NAMED_SNAPSHOTS_PER_USER):
        _create(client, f"named {index}", state)
    res = client.post("/v1/state/snapshots/import-backup", json={"state": state.model_dump()})
    assert res.status_code == 201, res.text


def test_import_backup_before_a_holiday_change_is_named_after_it(temp_db):
    from backend.snapshots import HOLIDAY_CHANGE_BACKUP_NAME, IMPORT_BACKUP_NAME

    client = _client_as()
    shown = _state_with_assignment("clin-1").model_dump()
    res = client.post(
        "/v1/state/snapshots/import-backup", json={"state": shown, "reason": "holiday_change"}
    )
    assert res.status_code == 201, res.text
    assert res.json()["name"] == HOLIDAY_CHANGE_BACKUP_NAME == "Auto-backup before holiday change"
    # Still the one reserved slot: a later import backup replaces it.
    res = client.post("/v1/state/snapshots/import-backup", json={"state": shown})
    assert [(s["kind"], s["name"]) for s in client.get("/v1/state/snapshots").json()] == [
        ("auto_backup", IMPORT_BACKUP_NAME)
    ]
    # Only the known reasons name a backup.
    res = client.post(
        "/v1/state/snapshots/import-backup", json={"state": shown, "reason": "anything"}
    )
    assert res.status_code == 422


def test_restore_of_a_snapshot_stored_with_impossible_dates_drops_them(temp_db):
    import json

    client = _client_as()
    meta = _create(client, "old", _state_with_assignment("clin-1"))
    # Snapshots saved before dates were checked can hold impossible ones.
    conn = db._get_connection()
    blob = json.loads(conn.execute(
        "SELECT data FROM calendar_snapshots WHERE id = ?", (meta["id"],)
    ).fetchone()["data"])
    blob["assignments"].append(
        {"id": "bad", "rowId": "pool-rest-day", "dateISO": "2026-02-30", "clinicianId": "clin-1"}
    )
    blob["holidays"].append({"dateISO": "garbage", "name": "Broken"})
    conn.execute("UPDATE calendar_snapshots SET data = ? WHERE id = ?", (json.dumps(blob), meta["id"]))
    conn.commit()
    conn.close()

    res = client.post(f"/v1/state/snapshots/{meta['id']}/restore", json={})
    assert res.status_code == 200, res.text
    assert [a["id"] for a in res.json()["assignments"]] == ["a1"]
    assert all(h["name"] != "Broken" for h in res.json()["holidays"])


def test_import_backup_refuses_a_stale_revision_without_touching_the_backup(temp_db):
    from backend.snapshots import IMPORT_BACKUP_NAME

    client = _client_as()
    _save_state(_state_with_assignment("clin-1"), USER)
    stale = client.get("/v1/state").json()
    # Another tab saves a newer calendar and restores a snapshot: the
    # auto-backup now holds that newer calendar.
    newer = make_app_state(clinicians=[make_clinician("clin-2", "Bob")])
    _save_state(newer, USER)
    meta = _create(client, "X", make_app_state(clinicians=[make_clinician("clin-3", "Xena")]))
    client.post(f"/v1/state/snapshots/{meta['id']}/restore",
                json={"currentState": client.get("/v1/state").json()})
    backup_before = [s for s in client.get("/v1/state/snapshots").json() if s["kind"] == "auto_backup"]

    res = client.post("/v1/state/snapshots/import-backup",
                      json={"state": stale, "expectedRevision": stale["revision"]})
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "state_changed"
    assert [s for s in client.get("/v1/state/snapshots").json() if s["kind"] == "auto_backup"] == backup_before
    restored = client.post(f"/v1/state/snapshots/{backup_before[0]['id']}/restore", json={}).json()
    assert [c["name"] for c in restored["clinicians"]] == ["Bob"]

    # With the live revision the backup is written as before.
    live = client.get("/v1/state").json()
    res = client.post("/v1/state/snapshots/import-backup",
                      json={"state": live, "expectedRevision": live["revision"]})
    assert res.status_code == 201, res.text
    assert res.json()["name"] == IMPORT_BACKUP_NAME


def test_backup_before_loading_a_copy_is_named_after_it(temp_db):
    from backend.snapshots import LOAD_COPY_BACKUP_NAME

    client = _client_as()
    live = client.get("/v1/state").json()
    res = client.post(
        "/v1/state/snapshots/import-backup",
        json={"state": live, "reason": "load_copy", "expectedRevision": live["revision"]},
    )
    assert res.status_code == 201, res.text
    assert res.json()["name"] == LOAD_COPY_BACKUP_NAME == "Auto-backup before loading a copy"
