"""Transient-failure handling: retryability classification, mock failure
scripting, and the harness's deadline-aware retry loop.

Born from a production incident: a multi-month day-by-day run hit ONE
transient LLM error near the end of the range and abandoned every remaining
day — the last week came back empty."""

from __future__ import annotations

import time

import backend.agent.harness as harness
from backend.agent.harness import _complete_with_retry
from backend.agent.mock_provider import MockProvider
from backend.agent.provider import is_retryable_status

from .test_agent_harness import (
    MON,
    MockCancelEvent,
    ProgressRecorder,
    _config,
    _payload,
    _two_clinician_state,
)


def _complete(provider):
    return provider.complete(system="s", messages=[], tools=[], timeout_seconds=1.0)


def test_retryable_status_classification():
    for status in (408, 409, 429, 500, 502, 503, 529, 599):
        assert is_retryable_status(status)
    for status in (400, 401, 403, 404, 422):
        assert not is_retryable_status(status)
    assert not is_retryable_status(None)


def test_mock_error_turns_carry_retryability():
    provider = MockProvider([
        {"error": "overloaded", "status": 529},
        {"error": "bad request", "status": 400},
        {"error": "conn reset", "retryable": True},
        {"stop_reason": "refusal", "text": "I cannot do that."},
    ])
    overloaded = _complete(provider)
    assert overloaded.stop_reason == "error"
    assert overloaded.error == "overloaded"
    assert overloaded.error_status == 529
    assert overloaded.retryable

    bad_request = _complete(provider)
    assert bad_request.stop_reason == "error"
    assert not bad_request.retryable

    conn_reset = _complete(provider)
    assert conn_reset.stop_reason == "error"
    assert conn_reset.error_status is None
    assert conn_reset.retryable

    refusal = _complete(provider)
    assert refusal.stop_reason == "refusal"
    assert not refusal.retryable

    # Script exhausted afterwards -> plain end_turn, as before.
    assert _complete(provider).stop_reason == "end_turn"


# ---------------------------------------------------------------------------
# _complete_with_retry — the harness-level retry loop
# ---------------------------------------------------------------------------


def _retry(provider, *, deadline=float("inf"), cancel_event=None, on_retry=None):
    return _complete_with_retry(
        provider,
        system="s",
        messages=[],
        tools=[],
        compute_timeout=lambda: 10.0,
        deadline=deadline,
        cancel_event=cancel_event or MockCancelEvent(),
        on_retry=on_retry or (lambda attempt, response: None),
    )


def test_transient_error_is_retried_until_success(monkeypatch):
    monkeypatch.setattr(harness, "RETRY_BACKOFF_SECONDS", (0.0, 0.0))
    provider = MockProvider([
        {"error": "overloaded", "status": 529},
        {"text": "recovered"},
    ])
    retries = []
    response = _retry(provider, on_retry=lambda a, r: retries.append((a, r.error)))
    assert response.stop_reason == "end_turn"
    assert response.text == "recovered"
    assert retries == [(1, "overloaded")]


def test_non_retryable_error_returns_immediately():
    provider = MockProvider([
        {"error": "bad request", "status": 400},
        {"text": "must never be consumed"},
    ])
    response = _retry(provider)
    assert response.stop_reason == "error"
    assert provider.turn == 1  # no second attempt


def test_refusal_is_never_retried():
    provider = MockProvider([
        {"stop_reason": "refusal"},
        {"text": "must never be consumed"},
    ])
    response = _retry(provider)
    assert response.stop_reason == "refusal"
    assert provider.turn == 1


def test_retries_exhausted_return_the_last_error(monkeypatch):
    monkeypatch.setattr(harness, "RETRY_BACKOFF_SECONDS", (0.0, 0.0))
    provider = MockProvider(
        [{"error": f"e{i}", "status": 529} for i in range(5)]
    )
    retries = []
    response = _retry(provider, on_retry=lambda a, r: retries.append(a))
    assert response.stop_reason == "error"
    assert response.error == "e2"  # 3 total attempts: e0, e1, e2
    assert provider.turn == 3
    assert retries == [1, 2]


def test_retry_gives_up_when_deadline_is_too_close():
    # Backoff 2s + a useful 10s call would overshoot a deadline 1s away.
    provider = MockProvider([
        {"error": "overloaded", "status": 529},
        {"text": "must never be consumed"},
    ])
    retries = []
    response = _retry(
        provider,
        deadline=time.time() + 1.0,
        on_retry=lambda a, r: retries.append(a),
    )
    assert response.stop_reason == "error"
    assert provider.turn == 1
    assert retries == []


def test_cancel_stops_retrying():
    cancel = MockCancelEvent()
    cancel.set()
    provider = MockProvider([
        {"error": "overloaded", "status": 529},
        {"text": "must never be consumed"},
    ])
    response = _retry(provider, cancel_event=cancel)
    assert response.stop_reason == "error"
    assert provider.turn == 1


def test_day_by_day_run_recovers_from_transient_error(monkeypatch):
    """End-to-end through agent_solve_range: a 529 on the first call of the
    day is retried and the run completes normally - no error note, no
    abandoned days."""
    monkeypatch.setattr(harness, "RETRY_BACKOFF_SECONDS", (0.0, 0.0))
    state = _two_clinician_state()
    script = [
        {"error": "simulated overload", "status": 529},
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Alice"}]}}]},
        {"text": "Day complete."},
    ]
    payload = _payload()
    payload.agent_strategy = "day_by_day"
    provider = MockProvider(script)
    result = harness.agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert result["debugInfo"]["agent"]["retriesUsed"] == 1
    assert len(result["assignments"]) == 1
    assert provider.turn == 3  # error turn + both real turns consumed
    assert not any("LLM error" in n for n in result["notes"])
