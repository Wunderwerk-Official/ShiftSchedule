"""Publication credentials must remain bound to the account they came from."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Event

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from backend import auth, db, ical_routes, web
from backend.main import app
from backend.state import _save_state
from .conftest import make_app_state, make_assignment, make_clinician

MON = "2026-01-05"
REQUEST = Request({"type": "http", "scheme": "http", "server": ("testserver", 80),
                   "path": "/", "root_path": "", "headers": []})


@pytest.fixture(autouse=True)
def accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "publications.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)


def seed(name):
    user = auth._create_user("same", "password", "user")
    _save_state(make_app_state(
        clinicians=[make_clinician(name=name)],
        assignments=[make_assignment("saved", "slot-a__mon", MON)],
        published_week_start_isos=[MON],
    ), "same")
    web_status = web.publish_web(user)
    ical_status = ical_routes.publish_ical(REQUEST, user)
    return user, web_status, ical_status


def publication_rows():
    with closing(db._get_connection()) as conn:
        return {table: [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]
                for table in ("app_state", "web_publications", "ical_publications",
                              "ical_clinician_publications")}


@pytest.mark.parametrize("kind", ["web", "ical", "clinician_ical"])
def test_inflight_old_public_token_never_reads_recreated_account(monkeypatch, kind):
    _, web_status, ical_status = seed("Original Doctor")
    # WAL allows account replacement to commit while the read transaction is
    # still open. The default rollback journal also protects the snapshot by
    # holding the writer until this reader finishes.
    with closing(db._get_connection()) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
    if kind == "web":
        module, helper = web, "_get_web_publication_by_token"
        token = web_status.token
        call = lambda: web.get_public_web_week(token, MON, None, None)
    else:
        module = ical_routes
        helper = "_get_publication_by_token" if kind == "ical" else "_get_clinician_publication_by_token"
        link = ical_status.all if kind == "ical" else ical_status.clinicians[0]
        token = link.subscribeUrl.rsplit("/", 1)[-1].removesuffix(".ics")
        call = lambda: ical_routes.download_ical(token, REQUEST, None, None)
    looked_up, continue_read = Event(), Event()
    original_lookup = getattr(module, helper)

    def pause_after_lookup(value, **kwargs):
        row = original_lookup(value, **kwargs)
        looked_up.set()
        assert continue_read.wait(5), "reader was not released"
        return row

    monkeypatch.setattr(module, helper, pause_after_lookup)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(call)
        try:
            assert looked_up.wait(5), "token lookup did not begin"
            auth._delete_user("same")
            seed("Replacement Secret Doctor")
        finally:
            continue_read.set()
        response = future.result(timeout=5)
    assert response.status_code == 200
    assert b"Replacement Secret Doctor" not in response.body
    assert b"Original Doctor" in response.body
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == 404


@pytest.mark.parametrize("kind", ["web", "ical"])
@pytest.mark.parametrize("action", ["status", "publish", "rotate", "unpublish"])
def test_stale_authenticated_publication_management_cannot_touch_replacement(kind, action):
    stale, _, _ = seed("Original Doctor")
    auth._delete_user("same")
    seed("Replacement Secret Doctor")
    before = publication_rows()
    if kind == "web":
        funcs = {"status": web.get_web_publication_status, "publish": web.publish_web,
                 "rotate": web.rotate_web, "unpublish": web.unpublish_web}
        call = lambda: funcs[action](stale)
    else:
        funcs = {"status": ical_routes.get_ical_publication_status, "publish": ical_routes.publish_ical,
                 "rotate": ical_routes.rotate_ical, "unpublish": ical_routes.unpublish_ical}
        call = lambda: funcs[action](stale) if action == "unpublish" else funcs[action](REQUEST, stale)
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == 401
    assert publication_rows() == before


@pytest.mark.parametrize("kind", ["web", "ical"])
def test_current_account_can_manage_links_and_rotation_revokes_old_token(kind):
    user, _, _ = seed("Current Doctor")
    client = TestClient(app)
    headers = {"Authorization": "Bearer " + auth._create_access_token(user)}
    route = f"/v1/{kind}/publish"
    status = client.get(route, headers=headers)
    assert status.status_code == 200
    initial = status.json()
    assert client.post(route, headers=headers).json() == initial
    rotated = client.post(route + "/rotate", headers=headers)
    assert rotated.status_code == 200 and rotated.json() != initial
    if kind == "web":
        old_url = f'/v1/web/{initial["token"]}/week?start={MON}'
        new_url = f'/v1/web/{rotated.json()["token"]}/week?start={MON}'
    else:
        old_url, new_url = initial["all"]["subscribeUrl"], rotated.json()["all"]["subscribeUrl"]
    assert client.get(old_url).status_code == 404
    assert client.get(new_url).status_code == 200
    assert client.delete(route, headers=headers).status_code == 204
    assert client.get(new_url).status_code == 404
    assert client.get(route, headers=headers).json()["published"] is False
