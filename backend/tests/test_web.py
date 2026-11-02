"""Tests for public web API endpoints.

These tests verify that the web API correctly:
- Returns published: false for unpublished weeks
- Returns schedule data for published weeks
- Returns 404 for invalid tokens
- Handles ETag caching
"""

import json
from typing import Any, Dict

import pytest
from fastapi.testclient import TestClient

from backend.db import _get_connection
from backend.main import app
from backend.state import _save_state

from .conftest import make_app_state, make_clinician


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


@pytest.fixture
def setup_web_publication():
    """Set up a web publication with test data."""
    username = "test_web_user"
    token = "test_token_web_123"

    # Create app state
    state = make_app_state(
        clinicians=[make_clinician()],
        published_week_start_isos=["2026-01-05"],
    )
    _save_state(state, username)

    # Create web publication
    conn = _get_connection()
    conn.execute(
        """
        INSERT OR REPLACE INTO web_publications (username, token, created_at, updated_at)
        VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        """,
        (username, token),
    )
    conn.commit()
    conn.close()

    yield {"username": username, "token": token, "state": state}

    # Cleanup
    conn = _get_connection()
    conn.execute("DELETE FROM web_publications WHERE username = ?", (username,))
    conn.execute("DELETE FROM app_state WHERE id = ?", (username,))
    conn.commit()
    conn.close()


class TestWebWeekEndpoint:
    """Tests for GET /v1/web/{token}/week endpoint."""

    def test_invalid_token_returns_404(self, client: TestClient) -> None:
        """Invalid token should return 404."""
        response = client.get("/v1/web/invalid_token_xyz/week?start=2026-01-05")
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_public_roster_excludes_private_planning_data(self, client, setup_web_publication):
        from backend.models import VacationRange

        state = setup_web_publication["state"]
        clinician = state.clinicians[0]
        clinician.planningWishes = "Private personal circumstances"
        clinician.workingHoursPerWeek = 32
        clinician.vacations = [
            VacationRange(id="overlap", startISO="2026-01-01", endISO="2026-01-07"),
            VacationRange(id="future", startISO="2026-08-01", endISO="2026-08-15"),
        ]
        state.solverSettings["agentUserInstructions"] = "Private planning instructions"
        state.solverRules = [{"id": "private-rule", "type": "note", "text": "Private rule"}]
        _save_state(state, setup_web_publication["username"])

        response = client.get(f"/v1/web/{setup_web_publication['token']}/week?start=2026-01-05")
        assert response.status_code == 200
        payload = response.json()
        public = payload["clinicians"][0]
        assert set(public) == {"id", "name", "qualifiedClassIds", "vacations"}
        assert public["vacations"] == [{"id": "overlap", "startISO": "2026-01-05", "endISO": "2026-01-07"}]
        assert "agentUserInstructions" not in payload["solverSettings"]
        assert payload.get("solverRules", []) == []
        assert "Private" not in response.text

    def test_unpublished_week_returns_not_published(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Unpublished week should return published: false."""
        token = setup_web_publication["token"]

        # Request an unpublished week (2026-01-12)
        response = client.get(f"/v1/web/{token}/week?start=2026-01-12")

        assert response.status_code == 200
        data = response.json()
        assert data["published"] is False
        assert data["weekStartISO"] == "2026-01-12"

    def test_published_week_returns_schedule_data(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Published week should return full schedule data."""
        token = setup_web_publication["token"]

        # Request the published week (2026-01-05)
        response = client.get(f"/v1/web/{token}/week?start=2026-01-05")

        assert response.status_code == 200
        data = response.json()
        assert data["published"] is True
        assert data["weekStartISO"] == "2026-01-05"
        assert "rows" in data
        assert "clinicians" in data
        assert "assignments" in data

    def test_normalizes_week_start(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Date in the middle of the week should be normalized to week start."""
        token = setup_web_publication["token"]

        # Request using a date in the middle of the week (Wednesday 2026-01-07)
        response = client.get(f"/v1/web/{token}/week?start=2026-01-07")

        assert response.status_code == 200
        data = response.json()
        # Should normalize to Monday 2026-01-05
        assert data["weekStartISO"] == "2026-01-05"

    def test_missing_start_param_returns_400(self, client: TestClient) -> None:
        """Missing start parameter should return 400."""
        response = client.get("/v1/web/some_token/week")
        assert response.status_code == 422  # FastAPI validation error


class TestWebEtagCaching:
    """Tests for ETag caching behavior."""

    def test_returns_etag_header(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Response should include ETag header."""
        token = setup_web_publication["token"]
        response = client.get(f"/v1/web/{token}/week?start=2026-01-05")

        assert response.status_code == 200
        assert "ETag" in response.headers

    def test_returns_last_modified_header(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Response should include Last-Modified header."""
        token = setup_web_publication["token"]
        response = client.get(f"/v1/web/{token}/week?start=2026-01-05")

        assert response.status_code == 200
        assert "Last-Modified" in response.headers

    def test_conditional_get_returns_304(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Conditional GET with matching ETag should return 304."""
        token = setup_web_publication["token"]

        # First request to get ETag
        response1 = client.get(f"/v1/web/{token}/week?start=2026-01-05")
        etag = response1.headers.get("ETag")
        assert etag

        # Second request with If-None-Match
        response2 = client.get(
            f"/v1/web/{token}/week?start=2026-01-05",
            headers={"If-None-Match": etag},
        )

        assert response2.status_code == 304

    def test_conditional_get_with_wrong_etag_returns_200(
        self, client: TestClient, setup_web_publication
    ) -> None:
        """Conditional GET with non-matching ETag should return 200."""
        token = setup_web_publication["token"]

        response = client.get(
            f"/v1/web/{token}/week?start=2026-01-05",
            headers={"If-None-Match": '"wrong-etag"'},
        )

        assert response.status_code == 200


class TestWebSlotOverrides:
    def test_overrides_are_clamped_to_week_by_last_separator(self, client, setup_web_publication):
        state = setup_web_publication["state"]
        # Slot ids contain "__" themselves; the date is after the LAST separator.
        state.slotOverridesByKey = {"slot-a__mon__2026-01-04": 2, "slot-a__mon__2026-01-05": 3}
        _save_state(state, setup_web_publication["username"])
        response = client.get(f"/v1/web/{setup_web_publication['token']}/week?start=2026-01-05")
        assert response.status_code == 200
        assert response.json()["slotOverridesByKey"] == {"slot-a__mon__2026-01-05": 3}


class TestWebVacationFiltering:
    """Tests for vacation day filtering in web API."""

    @pytest.fixture
    def setup_vacation_state(self):
        """Set up state with vacation data."""
        from backend.models import VacationRange

        username = "test_vacation_user"
        token = "test_token_vacation_123"

        # Create clinician with vacation
        clinician = make_clinician()
        clinician.vacations = [
            VacationRange(id="v1", startISO="2026-01-05", endISO="2026-01-10")
        ]

        state = make_app_state(
            clinicians=[clinician],
            published_week_start_isos=["2026-01-05"],
        )
        # Add assignment during vacation
        from backend.models import Assignment

        state.assignments = [
            Assignment(
                id="a1",
                rowId="slot-a__mon",
                dateISO="2026-01-07",  # During vacation
                clinicianId="clin-1",
            )
        ]
        _save_state(state, username)

        conn = _get_connection()
        conn.execute(
            """
            INSERT OR REPLACE INTO web_publications (username, token, created_at, updated_at)
            VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
            """,
            (username, token),
        )
        conn.commit()
        conn.close()

        yield {"username": username, "token": token}

        conn = _get_connection()
        conn.execute("DELETE FROM web_publications WHERE username = ?", (username,))
        conn.execute("DELETE FROM app_state WHERE id = ?", (username,))
        conn.commit()
        conn.close()

    def test_vacation_assignments_filtered_out(
        self, client: TestClient, setup_vacation_state
    ) -> None:
        """Assignments during vacation should not appear in response."""
        token = setup_vacation_state["token"]

        response = client.get(f"/v1/web/{token}/week?start=2026-01-05")

        assert response.status_code == 200
        data = response.json()
        # Assignments should be empty (vacation filters them out)
        assert len(data["assignments"]) == 0


class TestWebTokenRotation:
    """Tests for token rotation behavior."""

    @pytest.fixture
    def setup_rotation_state(self):
        """Set up state for rotation testing."""
        username = "test_rotation_user"
        old_token = "old_token_123"
        new_token = "new_token_456"

        state = make_app_state(published_week_start_isos=["2026-01-05"])
        _save_state(state, username)

        conn = _get_connection()
        conn.execute(
            """
            INSERT OR REPLACE INTO web_publications (username, token, created_at, updated_at)
            VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
            """,
            (username, old_token),
        )
        conn.commit()
        conn.close()

        yield {"username": username, "old_token": old_token, "new_token": new_token}

        conn = _get_connection()
        conn.execute("DELETE FROM web_publications WHERE username = ?", (username,))
        conn.execute("DELETE FROM app_state WHERE id = ?", (username,))
        conn.commit()
        conn.close()

    def test_old_token_works_before_rotation(
        self, client: TestClient, setup_rotation_state
    ) -> None:
        """Old token should work before rotation."""
        old_token = setup_rotation_state["old_token"]

        response = client.get(f"/v1/web/{old_token}/week?start=2026-01-05")
        assert response.status_code == 200

    def test_old_token_fails_after_rotation(
        self, client: TestClient, setup_rotation_state
    ) -> None:
        """Old token should fail after rotation."""
        username = setup_rotation_state["username"]
        old_token = setup_rotation_state["old_token"]
        new_token = setup_rotation_state["new_token"]

        # Simulate rotation by updating the token
        conn = _get_connection()
        conn.execute(
            "UPDATE web_publications SET token = ? WHERE username = ?",
            (new_token, username),
        )
        conn.commit()
        conn.close()

        # Old token should now fail
        response = client.get(f"/v1/web/{old_token}/week?start=2026-01-05")
        assert response.status_code == 404

    def test_new_token_works_after_rotation(
        self, client: TestClient, setup_rotation_state
    ) -> None:
        """New token should work after rotation."""
        username = setup_rotation_state["username"]
        new_token = setup_rotation_state["new_token"]

        # Simulate rotation
        conn = _get_connection()
        conn.execute(
            "UPDATE web_publications SET token = ? WHERE username = ?",
            (new_token, username),
        )
        conn.commit()
        conn.close()

        response = client.get(f"/v1/web/{new_token}/week?start=2026-01-05")
        assert response.status_code == 200


def _publish(username: str, token: str) -> None:
    conn = _get_connection()
    conn.execute(
        """
        INSERT OR REPLACE INTO web_publications (username, token, created_at, updated_at)
        VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        """,
        (username, token),
    )
    conn.commit()
    conn.close()


def _unpublish(username: str) -> None:
    conn = _get_connection()
    conn.execute("DELETE FROM web_publications WHERE username = ?", (username,))
    conn.execute("DELETE FROM app_state WHERE id = ?", (username,))
    conn.execute("DELETE FROM user_preferences WHERE username = ?", (username,))
    conn.commit()
    conn.close()


class TestWebRestDayContext:
    """On-call shifts just outside the published week put rest days into it
    (Mon after a Sunday night, Sun before a Monday night). The payload carries
    them, reduced to clinician/date/slot, so the public Rest Day row matches
    the admin's."""

    USER = "test_rest_context_user"
    TOKEN = "test_token_rest_context"

    def _state(self, days_before: int = 1, days_after: int = 1, enabled: bool = True):
        from backend.models import Assignment, TemplateBlock, TemplateRowBand, VacationRange
        from backend.state import _normalize_state

        from .conftest import make_pool_row, make_template_slot, make_workplace_row

        sections = ["section-a", "section-n"]
        night = dict(block_id="block-n", row_band_id="row-2", start_time="20:00",
                     end_time="08:00", end_day_offset=1)
        state = make_app_state(
            clinicians=[
                make_clinician("clin-1", "Samir Amlal", sections),
                make_clinician("clin-2", "Tom Finck", sections),
                make_clinician("clin-3", "Vera Holm", sections, vacations=[
                    VacationRange(id="v1", startISO="2026-01-02", endISO="2026-01-04"),
                ]),
            ],
            rows=[
                make_workplace_row(),
                make_workplace_row("section-n", "Night"),
                make_pool_row("pool-rest-day", "Rest Day"),
                make_pool_row("pool-vacation", "Vacation"),
            ],
            slots=[
                make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
                make_template_slot("slot-a__sun", col_band_id="col-sun-1"),
                make_template_slot("slot-n__sat", col_band_id="col-sat-1", **night),
                make_template_slot("slot-n__sun", col_band_id="col-sun-1", **night),
                make_template_slot("slot-n__mon", col_band_id="col-mon-1", **night),
            ],
            solver_settings={
                "enforceSameLocationPerDay": False,
                "onCallRestEnabled": enabled,
                "onCallRestClassId": "section-n",
                "onCallRestDaysBefore": days_before,
                "onCallRestDaysAfter": days_after,
            },
            published_week_start_isos=["2026-01-05"],
        )
        state.weeklyTemplate.blocks.append(
            TemplateBlock(id="block-n", sectionId="section-n", requiredSlots=0)
        )
        state.weeklyTemplate.locations[0].rowBands.append(
            TemplateRowBand(id="row-2", label="Night", order=2)
        )
        state.assignments = [
            # Outside the week, on-call: Sat and Sun before, Mon after.
            Assignment(id="n-sat", rowId="slot-n__sat", dateISO="2026-01-03", clinicianId="clin-2"),
            Assignment(id="n-sun", rowId="slot-n__sun", dateISO="2026-01-04", clinicianId="clin-1"),
            Assignment(id="n-next", rowId="slot-n__mon", dateISO="2026-01-12", clinicianId="clin-2"),
            # On vacation that day: no rest day follows (as in the admin view).
            Assignment(id="n-vac", rowId="slot-n__sun", dateISO="2026-01-04", clinicianId="clin-3"),
            # Outside the week, not on-call: never part of the payload.
            Assignment(id="d-sun", rowId="slot-a__sun", dateISO="2026-01-04", clinicianId="clin-2"),
            Assignment(id="d-next", rowId="slot-a__mon", dateISO="2026-01-12", clinicianId="clin-1"),
            # Inside the week.
            Assignment(id="d-mon", rowId="slot-a__mon", dateISO="2026-01-05", clinicianId="clin-2"),
        ]
        normalized, _ = _normalize_state(state)
        assert len(normalized.assignments) == len(state.assignments)
        return normalized

    @pytest.fixture(autouse=True)
    def _cleanup(self):
        yield
        _unpublish(self.USER)

    def _week(self, client: TestClient, **settings) -> Dict[str, Any]:
        _save_state(self._state(**settings), self.USER)
        _publish(self.USER, self.TOKEN)
        response = client.get(f"/v1/web/{self.TOKEN}/week?start=2026-01-05")
        assert response.status_code == 200
        return response.json()

    def test_neighbouring_on_call_shifts_are_sent_reduced(self, client: TestClient) -> None:
        payload = self._week(client)
        assert payload["restContextAssignments"] == [
            {"clinicianId": "clin-1", "dateISO": "2026-01-04", "rowId": "slot-n__sun"},
            {"clinicianId": "clin-2", "dateISO": "2026-01-12", "rowId": "slot-n__mon"},
        ]
        # Shifts are still limited to the week; nothing else from the
        # neighbouring weeks is exposed.
        assert [a["id"] for a in payload["assignments"]] == ["d-mon"]
        for hidden in ("n-sat", "n-sun", "n-next", "n-vac", "d-sun", "d-next", "2026-01-03"):
            assert hidden not in json.dumps(payload["assignments"])
        assert "n-sun" not in json.dumps(payload)

    def test_window_follows_days_before_and_after(self, client: TestClient) -> None:
        # Two rest days after a night reach back to Saturday; none before.
        payload = self._week(client, days_before=0, days_after=2)
        assert payload["restContextAssignments"] == [
            {"clinicianId": "clin-2", "dateISO": "2026-01-03", "rowId": "slot-n__sat"},
            {"clinicianId": "clin-1", "dateISO": "2026-01-04", "rowId": "slot-n__sun"},
        ]

    def test_no_context_when_the_rest_rule_is_off(self, client: TestClient) -> None:
        payload = self._week(client, enabled=False)
        assert payload["restContextAssignments"] == []


class TestWebTimeLayout:
    """The owner's Times choice (side by side / stacked) travels with the week."""

    USER = "test_time_layout_user"
    TOKEN = "test_token_time_layout"

    @pytest.fixture(autouse=True)
    def _setup(self):
        _save_state(make_app_state(published_week_start_isos=["2026-01-05"]), self.USER)
        _publish(self.USER, self.TOKEN)
        yield
        _unpublish(self.USER)

    def _store_layout(self, layout: str) -> None:
        conn = _get_connection()
        conn.execute(
            "INSERT OR REPLACE INTO user_preferences (username, data, updated_at) VALUES (?, ?, ?)",
            (self.USER, json.dumps({"teamTimeLayout": layout, "clinicianId": "private"}),
             "2026-01-02T00:00:00Z"),
        )
        conn.commit()
        conn.close()

    def test_owner_default_is_stacked(self, client: TestClient) -> None:
        payload = client.get(f"/v1/web/{self.TOKEN}/week?start=2026-01-05").json()
        assert payload["teamTimeLayout"] == "stacked"

    def test_follows_the_owner_choice_and_changes_the_etag(self, client: TestClient) -> None:
        first = client.get(f"/v1/web/{self.TOKEN}/week?start=2026-01-05")
        self._store_layout("columns")
        second = client.get(
            f"/v1/web/{self.TOKEN}/week?start=2026-01-05",
            headers={"If-None-Match": first.headers["ETag"]},
        )
        assert second.status_code == 200
        assert second.json()["teamTimeLayout"] == "columns"
        # Only the layout leaves the owner's preferences.
        assert "private" not in second.text

    def test_unpublished_week_has_no_layout(self, client: TestClient) -> None:
        payload = client.get(f"/v1/web/{self.TOKEN}/week?start=2026-01-12").json()
        assert payload == {"published": False, "weekStartISO": "2026-01-12", "weekEndISO": "2026-01-18"}
