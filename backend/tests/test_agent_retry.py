"""Transient-failure handling: retryability classification, mock failure
scripting, and the harness's deadline-aware retry loop.

Born from a production incident: a multi-month day-by-day run hit ONE
transient LLM error near the end of the range and abandoned every remaining
day — the last week came back empty."""

from __future__ import annotations

from backend.agent.mock_provider import MockProvider
from backend.agent.provider import is_retryable_status


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
