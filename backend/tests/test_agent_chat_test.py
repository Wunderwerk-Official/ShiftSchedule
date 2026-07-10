"""Admin model connection test: POST /v1/agent/chat-test.

Uses the mock provider (via env, exactly like the solver subprocess would
resolve it) so no real endpoint is contacted.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.agent_budget import get_spend_usd
from backend.auth import _get_current_user
from backend.main import app
from backend.models import UserPublic


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "agent-chat-test.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    return db_path


@pytest.fixture
def mock_provider_env(tmp_path, monkeypatch):
    script = tmp_path / "chat-script.json"
    script.write_text(json.dumps([{"text": "Hello from the mock model."}]))
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    monkeypatch.setenv("AGENT_MOCK_SCRIPT", str(script))


def _client_as(role: str, username: str = "chat-admin") -> TestClient:
    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=username, role=role, active=True
    )
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_overrides():
    yield
    app.dependency_overrides.pop(_get_current_user, None)


def test_chat_test_is_admin_only(temp_db, mock_provider_env):
    client = _client_as("user")
    res = client.post(
        "/v1/agent/chat-test", json={"messages": [{"role": "user", "content": "hi"}]}
    )
    assert res.status_code == 403


def test_chat_test_returns_text_and_metrics(temp_db, mock_provider_env):
    client = _client_as("admin")
    res = client.post(
        "/v1/agent/chat-test", json={"messages": [{"role": "user", "content": "hi"}]}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "mock"
    assert data["text"] == "Hello from the mock model."
    assert data["error"] is None
    assert data["duration_seconds"] >= 0
    assert data["input_tokens"] == 0 and data["output_tokens"] == 0
    # Mock reports zero tokens -> no throughput claim, and no cost metering
    # outside the anthropic provider.
    assert data["tokens_per_second"] is None
    assert data["cost_usd"] is None
    assert get_spend_usd("chat-admin") == 0.0


def test_chat_test_validates_messages(temp_db, mock_provider_env):
    client = _client_as("admin")
    assert (
        client.post("/v1/agent/chat-test", json={"messages": []}).status_code == 400
    )
    assert (
        client.post(
            "/v1/agent/chat-test",
            json={"messages": [{"role": "system", "content": "x"}]},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/v1/agent/chat-test",
            json={"messages": [{"role": "user", "content": "   "}]},
        ).status_code
        == 400
    )


def test_chat_test_meters_anthropic_spend(temp_db, monkeypatch):
    # A stub provider standing in for Anthropic: fixed usage numbers so the
    # cost math and the spend recording can be asserted deterministically.
    from backend import agent_budget
    from backend.agent.provider import ProviderResponse

    class _StubProvider:
        def complete(self, **_kwargs):
            return ProviderResponse(
                text="pong",
                tool_calls=[],
                stop_reason="end_turn",
                usage={"input_tokens": 1_000_000, "output_tokens": 0},
            )

    monkeypatch.setenv("AGENT_PROVIDER", "anthropic")
    monkeypatch.setenv("AGENT_MODEL", "claude-sonnet-5")
    monkeypatch.setattr(
        "backend.agent.provider.get_provider", lambda config: _StubProvider()
    )
    # The endpoint imports get_provider lazily from backend.agent.provider —
    # patching the source module covers it.
    client = _client_as("admin", username="metered-admin")
    res = client.post(
        "/v1/agent/chat-test", json={"messages": [{"role": "user", "content": "ping"}]}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["text"] == "pong"
    # 1M input tokens on sonnet-5 = $3.00, recorded against the admin.
    assert data["cost_usd"] == pytest.approx(3.0)
    assert agent_budget.get_spend_usd("metered-admin") == pytest.approx(3.0)
