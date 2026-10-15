"""Per-user UI preferences: defaults, round trip, validation, isolation, deletion."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend import auth, solver
from backend.auth import _get_current_user, _create_user, _get_user_by_username, _user_row_to_public
from backend.main import app
from backend.models import MAX_SAVED_VIEWS, UserPreferences
from backend.preferences import MAX_PREFERENCES_BYTES

URL = "/v1/me/preferences"
USER = "prefs-user"


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "preferences.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    yield
    app.dependency_overrides.pop(_get_current_user, None)


def _client_as(username: str = USER) -> TestClient:
    row = _get_user_by_username(username)
    user = _user_row_to_public(row) if row else _create_user(username, "prefs-test-password", "user")
    app.dependency_overrides[_get_current_user] = lambda: user
    return TestClient(app)


def _view(view_id: str = "v1", name: str = "My week", **overrides) -> dict:
    return {"id": view_id, "name": name, "scope": "me", "range": "week",
            "orientation": "left", "colorBy": "section", **overrides}


FULL = {
    "version": 1,
    "clinicianId": "clin-1",
    "orientationByRange": {"day": "left", "week": "top", "month": "left"},
    "myPlanRange": "month",
    "teamColorBy": "person",
    "savedViews": [_view()],
    "startViewDesktop": {"scope": "me", "range": "week", "orientation": "top", "colorBy": "section"},
    "startViewMobile": {"scope": "me", "range": "day", "orientation": "left", "colorBy": "section"},
}


def test_get_returns_defaults_when_nothing_stored():
    res = _client_as().get(URL)
    assert res.status_code == 200, res.text
    assert res.json() == UserPreferences().model_dump() == {
        "version": 1,
        "clinicianId": None,
        "orientationByRange": {"day": "top", "week": "top", "month": "top"},
        "myPlanRange": "week",
        "teamColorBy": "section",
        "savedViews": [],
        "startViewDesktop": None,
        "startViewMobile": None,
    }


def test_put_then_get_round_trips_the_stored_object():
    client = _client_as()
    res = client.put(URL, json=FULL)
    assert res.status_code == 200, res.text
    assert res.json() == FULL
    assert client.get(URL).json() == FULL


def test_partial_input_is_completed_with_defaults_and_unknown_fields_ignored():
    client = _client_as()
    res = client.put(URL, json={"orientationByRange": {"week": "left"}, "clinicianId": "  ",
                                "futureField": True})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["orientationByRange"] == {"day": "top", "week": "left", "month": "top"}
    assert body["clinicianId"] is None
    assert "futureField" not in body
    assert client.get(URL).json() == body


@pytest.mark.parametrize("payload", [
    {"myPlanRange": "year"},
    {"teamColorBy": "rainbow"},
    {"orientationByRange": {"week": "diagonal"}},
    {"startViewDesktop": {"scope": "everyone"}},
    {"savedViews": [_view(f"v{i}") for i in range(MAX_SAVED_VIEWS + 1)]},
    {"savedViews": [_view(name="x" * 61)]},
    {"savedViews": [_view(name="   ")]},
    {"savedViews": [_view(view_id="")]},
    {"savedViews": [_view("same"), _view("same", name="Other")]},
    {"clinicianId": "c" * 201},
    {"version": 0},
])
def test_invalid_preferences_are_rejected_and_nothing_is_stored(payload):
    client = _client_as()
    res = client.put(URL, json=payload)
    assert res.status_code == 422, res.text
    assert client.get(URL).json() == UserPreferences().model_dump()


def test_saved_view_names_are_trimmed_and_the_cap_is_inclusive():
    views = [_view(f"v{i}", name=f"  View {i}  ") for i in range(MAX_SAVED_VIEWS)]
    res = _client_as().put(URL, json={"savedViews": views})
    assert res.status_code == 200, res.text
    assert [v["name"] for v in res.json()["savedViews"]] == [f"View {i}" for i in range(MAX_SAVED_VIEWS)]


def test_oversized_body_is_rejected_with_413():
    client = _client_as()
    padded = {**FULL, "padding": "x" * MAX_PREFERENCES_BYTES}
    res = client.put(URL, json=padded)
    assert res.status_code == 413, res.text
    assert client.get(URL).json() == UserPreferences().model_dump()


def test_oversized_body_without_token_is_unauthorized_not_413():
    padded = {**FULL, "padding": "x" * MAX_PREFERENCES_BYTES}
    assert TestClient(app).put(URL, json=padded).status_code == 401


def test_preferences_are_isolated_per_user():
    _client_as("alice").put(URL, json={**FULL, "clinicianId": "alice-clin"})
    bob = _client_as("bob")
    assert bob.get(URL).json()["clinicianId"] is None
    bob.put(URL, json={"clinicianId": "bob-clin"})
    assert _client_as("alice").get(URL).json()["clinicianId"] == "alice-clin"
    assert _client_as("bob").get(URL).json()["clinicianId"] == "bob-clin"


def test_preferences_are_deleted_with_the_account(monkeypatch):
    monkeypatch.setattr(solver, "stop_account_work", lambda _username: None, raising=False)
    _client_as().put(URL, json=FULL)
    auth._delete_user(USER)
    with db._get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM user_preferences").fetchone()[0] == 0
    # A recreated account with the same name starts from the defaults.
    assert _client_as().get(URL).json() == UserPreferences().model_dump()


def test_unreadable_stored_row_falls_back_to_defaults():
    client = _client_as()
    with db._get_connection() as conn:
        conn.execute("INSERT INTO user_preferences VALUES (?, ?, ?)",
                     (USER, '{"myPlanRange": "fortnight"}', "2026-01-01T00:00:00+00:00"))
    assert client.get(URL).json() == UserPreferences().model_dump()


def test_schema_init_adds_the_table_to_a_database_from_before_the_feature(monkeypatch):
    _create_user(USER, "prefs-test-password", "user")
    with db._get_connection() as conn:
        conn.execute("DROP TABLE user_preferences")
    for _ in range(2):  # re-running the init is a no-op
        monkeypatch.setattr(db, "_SCHEMA_READY", False)
        with db._get_connection() as conn:
            tables = {row["name"] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "user_preferences" in tables
    # The existing account starts from the defaults and can save.
    client = _client_as()
    assert client.get(URL).json() == UserPreferences().model_dump()
    assert client.put(URL, json=FULL).json() == FULL


def test_requests_without_token_are_unauthorized():
    client = TestClient(app)
    assert client.get(URL).status_code == 401
    assert client.put(URL, json=FULL).status_code == 401


def test_real_token_reaches_own_preferences():
    _create_user(USER, "prefs-test-password", "user")
    token = auth._create_access_token(_user_row_to_public(_get_user_by_username(USER)))
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.put(URL, json=FULL, headers=headers).status_code == 200
    assert client.get(URL, headers=headers).json() == FULL
