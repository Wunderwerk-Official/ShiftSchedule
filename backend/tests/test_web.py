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
