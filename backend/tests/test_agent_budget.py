"""Admin agent settings (global model) and per-user AI budget enforcement."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import backend.db as db
from backend.agent_budget import (
    DEFAULT_AGENT_MODEL,
    DEFAULT_BUDGET_USD,
    add_spend_usd,
    estimate_cost_usd,
    get_agent_admin_settings,
    get_spend_usd,
)
from backend.auth import _get_current_user
from backend.main import app
from backend.models import UserPublic
from backend.state import _save_state

from .conftest import make_app_state, make_clinician

MON = "2026-01-05"


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "agent-budget.db")
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    monkeypatch.setenv("SCHEDULE_DB_PATH", db_path)
    return db_path


def _client_as(role: str, username: str = "budget-user") -> TestClient:
    app.dependency_overrides[_get_current_user] = lambda: UserPublic(
        username=username, role=role, active=True
    )
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_overrides():
    yield
    app.dependency_overrides.pop(_get_current_user, None)


def test_defaults_are_sonnet_and_five_dollars(temp_db):
    settings = get_agent_admin_settings()
    assert settings["model"] == DEFAULT_AGENT_MODEL == "claude-sonnet-5"
    assert settings["budget_usd"] == DEFAULT_BUDGET_USD == 5.0


def test_settings_endpoint_shows_own_spend(temp_db):
    add_spend_usd("budget-user", 1.25)
    client = _client_as("user")
    data = client.get("/v1/agent/settings").json()
    assert data["model"] == "claude-sonnet-5"
    assert data["budget_usd"] == 5.0
    assert data["spent_usd"] == 1.25
    assert data["remaining_usd"] == 3.75
    assert "usage" not in data  # per-user breakdown is admin-only


def test_admin_can_update_model_and_budget(temp_db):
    client = _client_as("admin")
    res = client.put(
        "/v1/agent/settings",
        json={"model": "claude-opus-4-8", "budget_usd": 12.5},
    )
    assert res.status_code == 200
    settings = get_agent_admin_settings()
    assert settings["model"] == "claude-opus-4-8"
    assert settings["budget_usd"] == 12.5
    # Unknown models are refused (the env override remains the escape hatch)
    assert client.put("/v1/agent/settings", json={"model": "gpt-9"}).status_code == 400
    # Admin sees the per-user breakdown
    add_spend_usd("someone", 0.5)
    assert any(
        u["username"] == "someone" for u in client.get("/v1/agent/settings").json()["usage"]
    )


def test_provider_settings_roundtrip_and_key_masking(temp_db):
    client = _client_as("admin")
    res = client.put(
        "/v1/agent/settings",
        json={
            "provider": "openai",
            "openai_base_url": "http://10.0.0.5:8000/v1",
            "openai_model": "meta-llama/Llama-3.3-70B-Instruct",
            "openai_api_key": "sk-super-secret-vllm",
            "anthropic_api_key": "sk-ant-super-secret",
        },
    )
    assert res.status_code == 200
    # The stored secrets NEVER appear in any response — not even for admins.
    assert "sk-super-secret-vllm" not in res.text
    assert "sk-ant-super-secret" not in res.text
    data = client.get("/v1/agent/settings").json()
    assert "sk-super-secret-vllm" not in json.dumps(data)
    assert data["provider"] == "openai"
    assert data["effective_model"] == "meta-llama/Llama-3.3-70B-Instruct"
    assert data["openai_base_url"] == "http://10.0.0.5:8000/v1"
    assert data["anthropic_api_key_set"] is True
    assert data["openai_api_key_set"] is True
    # Validation: bad provider / bad base URL
    assert client.put("/v1/agent/settings", json={"provider": "gemini"}).status_code == 400
    assert (
        client.put("/v1/agent/settings", json={"openai_base_url": "ftp://x"}).status_code == 400
    )
    # Empty string clears a stored key (env fallback)
    client.put("/v1/agent/settings", json={"anthropic_api_key": ""})
    assert client.get("/v1/agent/settings").json()["anthropic_api_key_set"] is False
    # Non-admins never see the provider internals
    user_view = _client_as("user").get("/v1/agent/settings").json()
    assert "openai_base_url" not in user_view
    assert "anthropic_api_key_set" not in user_view
    assert user_view["effective_model"] == "meta-llama/Llama-3.3-70B-Instruct"


def test_runtime_config_overlay_preserves_env_when_unset(temp_db):
    from backend.agent.config import AgentConfig
    from backend.agent_budget import resolve_agent_runtime_config

    # Nothing stored -> the env config (e.g. mock in tests) is untouched.
    base = AgentConfig(provider="mock")
    assert resolve_agent_runtime_config(base).provider == "mock"

    client = _client_as("admin")
    client.put(
        "/v1/agent/settings",
        json={"provider": "openai", "openai_base_url": "http://h:8000/v1",
              "openai_api_key": "k1", "anthropic_api_key": "k2"},
    )
    overlaid = resolve_agent_runtime_config(AgentConfig(provider="mock"))
    assert overlaid.provider == "openai"
    assert overlaid.openai_base_url == "http://h:8000/v1"
    assert overlaid.openai_api_key == "k1"
    assert overlaid.anthropic_api_key == "k2"


def test_runtime_config_overlay_resolves_provider_specific_model(temp_db):
    """The chat test calls providers straight from this config: with a
    self-hosted provider it must carry the admin's openai_model, never the
    Anthropic id (a vLLM/LiteLLM server 400s on model=claude-...)."""
    from backend.agent.config import AgentConfig
    from backend.agent_budget import resolve_agent_runtime_config

    client = _client_as("admin")
    client.put(
        "/v1/agent/settings",
        json={"provider": "openai", "openai_base_url": "http://h:8000/v1",
              "openai_model": "Qwen/Qwen3.5-122B", "model": "claude-opus-4-8"},
    )
    overlaid = resolve_agent_runtime_config(AgentConfig(model="claude-sonnet-5"))
    assert overlaid.model == "Qwen/Qwen3.5-122B"

    # Back on Anthropic, the admin's Claude choice wins again.
    client.put("/v1/agent/settings", json={"provider": "anthropic"})
    overlaid2 = resolve_agent_runtime_config(AgentConfig(model="claude-sonnet-5"))
    assert overlaid2.model == "claude-opus-4-8"

    # A cleared openai_model leaves the env model untouched (the escape
    # hatch for AGENT_MODEL-driven setups).
    client.put("/v1/agent/settings", json={"provider": "openai", "openai_model": ""})
    overlaid3 = resolve_agent_runtime_config(AgentConfig(model="m0"))
    assert overlaid3.model == "m0"


def test_non_admin_cannot_update_settings(temp_db):
    client = _client_as("user")
    res = client.put("/v1/agent/settings", json={"model": "claude-haiku-4-5"})
    assert res.status_code == 403
    assert get_agent_admin_settings()["model"] == "claude-sonnet-5"


def test_spend_accumulates(temp_db):
    assert get_spend_usd("nobody") == 0.0
    add_spend_usd("clin-admin", 0.75)
    add_spend_usd("clin-admin", 0.25)
    assert get_spend_usd("clin-admin") == pytest.approx(1.0)
    add_spend_usd("clin-admin", 0)  # no-op
    assert get_spend_usd("clin-admin") == pytest.approx(1.0)


def test_estimate_cost_matches_pricing_table():
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_read_input_tokens": 1_000_000,
        "cache_creation_input_tokens": 1_000_000,
    }
    # Sonnet 5: 3 in + 15 out + 0.3 cache read + 3.75 cache write
    assert estimate_cost_usd("claude-sonnet-5", usage) == pytest.approx(22.05)
    assert estimate_cost_usd("unknown-model", usage) == 0.0
    assert estimate_cost_usd("claude-sonnet-5", None) == 0.0


def test_exhausted_budget_falls_back_to_draft(temp_db, monkeypatch):
    """Through the REAL endpoint + subprocess: a user over budget still gets
    the heuristic draft, with a clear note, and the LLM is never started."""
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    monkeypatch.delenv("AGENT_MOCK_SCRIPT", raising=False)
    username = "over-budget-user"
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    _save_state(state, username)
    add_spend_usd(username, 99.0)  # way past the default $5

    client = _client_as("user", username=username)
    res = client.post(
        "/v1/solve/range",
        json={"startISO": MON, "endISO": MON, "solver_mode": "agent",
              "only_fill_required": True, "timeout_seconds": 60},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("AI budget" in n for n in body["notes"])
    # The seed plan is still returned
    assert isinstance(body["assignments"], list)


def test_budget_does_not_block_self_hosted_provider(temp_db, monkeypatch):
    """A user over the Anthropic budget can still plan on a self-hosted
    endpoint: the enforcement flag is skipped for provider=openai. (The
    unreachable endpoint here fails the LLM loop, but the run must NOT be
    stopped by the budget note.)"""
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    monkeypatch.delenv("AGENT_MOCK_SCRIPT", raising=False)
    username = "self-hosted-user"
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    _save_state(state, username)
    add_spend_usd(username, 99.0)

    admin = _client_as("admin", username="the-admin")
    admin.put(
        "/v1/agent/settings",
        json={"provider": "openai", "openai_base_url": "http://127.0.0.1:1/v1",
              "openai_model": "local-model"},
    )
    client = _client_as("user", username=username)
    res = client.post(
        "/v1/solve/range",
        json={"startISO": MON, "endISO": MON, "solver_mode": "agent",
              "only_fill_required": True, "timeout_seconds": 60},
    )
    assert res.status_code == 200
    body = res.json()
    assert not any("AI budget" in n for n in body["notes"])
    # The self-hosted model name reached the run (server-injected)
    assert body["debugInfo"]["agent"]["model"] == "local-model"


def test_client_cannot_smuggle_model_or_budget_flags(temp_db, monkeypatch):
    """agent_model / agent_budget_exhausted in the request body are server-
    injected: whatever the client sends is overwritten by the endpoint."""
    monkeypatch.setenv("AGENT_PROVIDER", "mock")
    monkeypatch.delenv("AGENT_MOCK_SCRIPT", raising=False)
    username = "smuggler"
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    _save_state(state, username)

    client = _client_as("user", username=username)
    res = client.post(
        "/v1/solve/range",
        json={"startISO": MON, "endISO": MON, "solver_mode": "agent",
              "only_fill_required": True, "timeout_seconds": 60,
              # Lies: pretend to pick an expensive model and an exhausted flag
              "agent_model": "claude-opus-4-8", "agent_budget_exhausted": True},
    )
    assert res.status_code == 200
    body = res.json()
    # Budget is NOT exhausted for this fresh user -> the (mock) agent ran and
    # reports the admin-chosen default model, not the client's wish.
    assert body["debugInfo"]["solver_status"] != "AGENT_FALLBACK_SEED"
    assert body["debugInfo"]["agent"]["model"] == "claude-sonnet-5"


def test_verify_tls_setting_roundtrip_and_overlay(temp_db):
    from backend.agent.config import AgentConfig
    from backend.agent_budget import resolve_agent_runtime_config

    client = _client_as("admin")
    # Default: verification on
    assert client.get("/v1/agent/settings").json().get("openai_verify_tls") is True
    client.put("/v1/agent/settings", json={"openai_verify_tls": False})
    assert client.get("/v1/agent/settings").json()["openai_verify_tls"] is False
    overlaid = resolve_agent_runtime_config(AgentConfig(provider="mock"))
    assert overlaid.openai_verify_tls is False
    client.put("/v1/agent/settings", json={"openai_verify_tls": True})
    assert resolve_agent_runtime_config(AgentConfig(provider="mock")).openai_verify_tls is True
