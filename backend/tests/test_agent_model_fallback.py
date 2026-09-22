"""Model availability fallback: local SDK stubs, no endpoint or discovery calls."""

from collections import deque
from copy import deepcopy
from threading import Event
from types import SimpleNamespace

import httpx
import openai
import pytest

import backend.agent.openai_provider as adapter
from backend.agent.config import AgentConfig
from backend.agent.model_fallback import QWEN_MODEL_ORDER, model_fallback_order
from backend.agent.provider import ChatMessage, ToolCall, ToolResult, ToolSpec


FLASH, QWEN_27B, LAST_MODEL = QWEN_MODEL_ORDER


def _api_error(status, message, *, code=None):
    request = httpx.Request("POST", "https://local.test/v1/chat/completions")
    body = {"error": {"message": message, "type": "server_error", "code": code}}
    response = httpx.Response(status, request=request, json=body)
    return openai.APIStatusError(message, response=response, body=body)


def _unavailable(model, status=400):
    return _api_error(status, f"Invalid model name passed in model={model}", code="model_not_found")


def _completion(*, content="ready", call_id=None, arguments='{"dateISO":"2026-02-02"}',
                finish_reason="stop"):
    calls = [] if call_id is None else [SimpleNamespace(
        id=call_id, function=SimpleNamespace(name="list_open_slots", arguments=arguments))]
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=calls),
                                 finish_reason=finish_reason)],
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=3, prompt_tokens_details=None),
    )


class _ScriptedClient:
    def __init__(self, steps):
        self.steps = deque(steps)
        self.calls = []
        self.options = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    @property
    def models(self):
        raise AssertionError("Planning must not perform model discovery")

    def with_options(self, **kwargs):
        self.options = deepcopy(kwargs)
        return self

    def create(self, **kwargs):
        self.calls.append({"request": deepcopy(kwargs), "options": self.options})
        assert self.steps, "Unexpected retry or fallback request"
        step = self.steps.popleft()
        if callable(step):
            step = step()
        if isinstance(step, Exception):
            raise step
        return step


class _Clock:
    now = 100.0

    def monotonic(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _provider(monkeypatch, steps, *, model=FLASH, enabled=True):
    client = _ScriptedClient(steps)
    monkeypatch.setattr(openai, "OpenAI", lambda **_kwargs: client)
    config = AgentConfig(provider="openai", model=model, openai_base_url="https://local.test/v1",
                         allow_model_fallback=enabled)
    provider = adapter.OpenAICompatibleProvider(config)
    return provider, client


def _complete(provider, *, messages=None, timeout=30):
    return provider.complete(
        system="Plan the next safe change.", messages=messages or [],
        tools=[ToolSpec("list_open_slots", "Inspect open positions", {"type": "object"})],
        timeout_seconds=timeout,
    )


def _models(client):
    return [call["request"]["model"] for call in client.calls]


def test_model_order_is_known_suffix_only():
    assert QWEN_MODEL_ORDER[:2] == ("nvidia/Qwen3.8-Flash-Next-NVFP4", "Qwen/Qwen3.8-27B")
    assert len(set(QWEN_MODEL_ORDER)) == 3
    assert model_fallback_order(FLASH) == list(QWEN_MODEL_ORDER)
    assert model_fallback_order(QWEN_27B) == [QWEN_27B, LAST_MODEL]
    assert model_fallback_order(LAST_MODEL) == [LAST_MODEL]
    assert model_fallback_order("custom-clinic-model") == ["custom-clinic-model"]


def test_unavailable_flash_selects_27b_and_reports_model(monkeypatch):
    provider, client = _provider(monkeypatch, [_unavailable(FLASH), _completion()])

    response = _complete(provider)

    assert response.stop_reason == "end_turn"
    assert response.model == QWEN_27B
    assert _models(client) == [FLASH, QWEN_27B]
    selection = response.model_selection
    assert selection["requested_model"] == FLASH
    assert selection["selected_model"] == QWEN_27B
    assert [(a["model"], a["status"]) for a in selection["attempts"]] == [
        (FLASH, "unavailable"), (QWEN_27B, "selected")]
    assert selection["attempts"][0]["reason"] in {"model_unavailable", "requested_model_unavailable"}
    assert "Invalid model name" not in str(selection)
    assert response.usage["input_tokens"] == 12
    assert response.usage["output_tokens"] == 3
    assert all(call["options"]["max_retries"] == 0 for call in client.calls)


def test_vllm_missing_model_with_backticks_and_no_error_code_uses_fallback(monkeypatch):
    provider, client = _provider(monkeypatch, [
        _api_error(404, f"The model `{FLASH}` does not exist."), _completion(),
    ])

    response = _complete(provider)

    assert response.stop_reason == "end_turn"
    assert response.model == QWEN_27B
    assert _models(client) == [FLASH, QWEN_27B]


@pytest.mark.parametrize("deployment_message", [
    "No healthy deployment available", "No healthy deployments available",
])
def test_two_unavailable_models_reach_last_candidate(monkeypatch, deployment_message):
    provider, client = _provider(monkeypatch, [
        _api_error(503, f"{deployment_message} for model={FLASH}"),
        _unavailable(QWEN_27B, 404), _completion(),
    ])

    response = _complete(provider)

    assert response.stop_reason == "end_turn"
    assert response.model == LAST_MODEL
    assert _models(client) == list(QWEN_MODEL_ORDER)
    assert [(a["model"], a["status"]) for a in response.model_selection["attempts"]] == [
        (FLASH, "unavailable"), (QWEN_27B, "unavailable"), (LAST_MODEL, "selected")]


def test_starting_at_27b_never_retries_flash(monkeypatch):
    provider, client = _provider(monkeypatch, [_unavailable(QWEN_27B), _completion()], model=QWEN_27B)

    response = _complete(provider)

    assert _models(client) == [QWEN_27B, LAST_MODEL]
    assert response.model == LAST_MODEL
    assert response.model_selection["requested_model"] == QWEN_27B


def test_all_models_unavailable_stop_after_one_attempt_each(monkeypatch):
    # 503 normally is retryable; exhausting this model chain must be terminal.
    provider, client = _provider(monkeypatch, [_unavailable(model, 503) for model in QWEN_MODEL_ORDER])

    response = _complete(provider)

    assert response.stop_reason == "error"
    assert not response.retryable
    assert response.tool_calls == []
    assert _models(client) == list(QWEN_MODEL_ORDER)
    assert [a["status"] for a in response.model_selection["attempts"]] == ["unavailable"] * 3
    repeated = _complete(provider)
    assert repeated.stop_reason == "error"
    assert not repeated.retryable
    assert _models(client) == list(QWEN_MODEL_ORDER)


def test_selected_fallback_is_sticky_only_for_this_provider(monkeypatch):
    provider, client = _provider(monkeypatch, [_unavailable(FLASH), _completion(), _completion()])
    assert _complete(provider).model == QWEN_27B
    assert _complete(provider).model == QWEN_27B
    assert _models(client) == [FLASH, QWEN_27B, QWEN_27B]
    assert provider._config.model == FLASH

    fresh_provider, fresh_client = _provider(monkeypatch, [_completion()])
    assert _complete(fresh_provider).model == FLASH
    assert _models(fresh_client) == [FLASH]


def test_later_loss_of_selected_model_continues_forward_and_preserves_prior_report(monkeypatch):
    provider, client = _provider(monkeypatch, [
        _unavailable(FLASH), _completion(), _unavailable(QWEN_27B), _completion(),
    ])
    first = _complete(provider)
    first_selection = deepcopy(first.model_selection)

    second = _complete(provider)

    assert _models(client) == [FLASH, QWEN_27B, QWEN_27B, LAST_MODEL]
    assert second.model == LAST_MODEL
    assert second.model_selection["requested_model"] == FLASH
    assert second.model_selection["selected_model"] == LAST_MODEL
    assert first.model_selection == first_selection
    assert first.model == QWEN_27B


def test_disable_flag_keeps_requested_model(monkeypatch):
    provider, client = _provider(monkeypatch, [_unavailable(FLASH)], enabled=False)

    response = _complete(provider)

    assert response.stop_reason == "error"
    assert _models(client) == [FLASH]


def test_unknown_model_never_uses_qwen_chain(monkeypatch):
    provider, client = _provider(monkeypatch, [_unavailable("custom-clinic-model")], model="custom-clinic-model")

    assert _complete(provider).stop_reason == "error"
    assert _models(client) == ["custom-clinic-model"]


@pytest.mark.parametrize("status,message", [
    (401, "Incorrect API key"),
    (403, "Permission denied: model not found for this API key"),
    (404, "Unknown route /v1/chat/completions"),
    (400, "This model's maximum context length is 32768 tokens"),
    (400, "Tool choice requires enable-auto-tool-choice for this model"),
    (422, "Input validation failed for tools[0].function.parameters"),
    (429, "Rate limit exceeded"),
    (500, "Internal server error"),
    (503, "Service temporarily unavailable"),
])
def test_unrelated_api_errors_do_not_select_another_model(monkeypatch, status, message):
    provider, client = _provider(monkeypatch, [_api_error(status, message)])

    response = _complete(provider)

    assert response.stop_reason == "error"
    assert response.error_status == status
    assert _models(client) == [FLASH]


@pytest.mark.parametrize("error_type", [openai.APIConnectionError, openai.APITimeoutError])
def test_connection_errors_and_timeouts_stay_on_same_model(monkeypatch, error_type):
    error = error_type(request=httpx.Request("POST", "https://local.test/v1/chat/completions"))
    provider, client = _provider(monkeypatch, [error])

    response = _complete(provider)

    assert response.stop_reason == "error"
    assert response.retryable
    assert _models(client) == [FLASH]


def test_invalid_tool_json_is_repairable_without_model_switch(monkeypatch):
    provider, client = _provider(monkeypatch, [_completion(call_id="broken-call", arguments="{broken")])

    response = _complete(provider)

    assert response.stop_reason == "tool_use"
    assert response.tool_calls[0].argument_error
    assert response.tool_calls[0].id == "broken-call"
    assert _models(client) == [FLASH]


@pytest.mark.parametrize("finish_reason,expected", [("length", "max_tokens"), ("content_filter", "refusal")])
def test_output_limit_or_refusal_does_not_select_another_model(monkeypatch, finish_reason, expected):
    provider, client = _provider(monkeypatch, [_completion(finish_reason=finish_reason)])

    response = _complete(provider)

    assert response.stop_reason == expected
    assert _models(client) == [FLASH]


def test_fallback_preserves_tool_history_without_replaying_old_calls_as_new(monkeypatch):
    messages = [
        ChatMessage(role="user", content="Continue from the already applied move."),
        ChatMessage(role="assistant", tool_calls=[ToolCall("already-applied", "apply_moves", {
            "moves": [{"action": "assign", "slot_key": "slot-a__2026-02-02", "clinicianId": "c1"}]})]),
        ChatMessage(role="tool", tool_results=[ToolResult("already-applied", '{"applied":true}')]),
    ]
    snapshot = deepcopy(messages)
    provider, client = _provider(monkeypatch, [_unavailable(FLASH), _completion(call_id="new-inspection")])

    response = _complete(provider, messages=messages)

    assert messages == snapshot
    assert [call.id for call in response.tool_calls] == ["new-inspection"]
    first, second = [call["request"] for call in client.calls]
    assert first["messages"] == second["messages"]
    assert first["tools"] == second["tools"]
    assert [m["tool_call_id"] for m in second["messages"] if m["role"] == "tool"] == ["already-applied"]
    assert sum(len(m.get("tool_calls", [])) for m in second["messages"]) == 1


def test_fallback_uses_only_remaining_request_budget(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(adapter.time, "monotonic", clock.monotonic)

    def unavailable_after_work():
        clock.advance(4)
        return _unavailable(FLASH)

    provider, client = _provider(monkeypatch, [unavailable_after_work, _completion()])

    assert _complete(provider, timeout=10).model == QWEN_27B
    assert [call["options"]["timeout"] for call in client.calls] == pytest.approx([10, 6])


def test_exhausted_budget_does_not_start_fallback(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(adapter.time, "monotonic", clock.monotonic)

    def unavailable_after_deadline():
        clock.advance(11)
        return _unavailable(FLASH)

    provider, client = _provider(monkeypatch, [unavailable_after_deadline])

    response = _complete(provider, timeout=10)

    assert response.stop_reason == "error"
    assert _models(client) == [FLASH]


def test_zero_budget_does_not_make_request(monkeypatch):
    provider, client = _provider(monkeypatch, [])

    assert _complete(provider, timeout=0).stop_reason == "error"
    assert not client.calls


@pytest.mark.parametrize("cancel_before_first_request", [True, False])
def test_cancellation_prevents_starting_another_request(monkeypatch, cancel_before_first_request):
    cancelled = Event()

    def unavailable_then_cancel():
        cancelled.set()
        return _unavailable(FLASH)

    provider, client = _provider(monkeypatch, [unavailable_then_cancel])
    provider.cancel_event = cancelled
    if cancel_before_first_request:
        cancelled.set()

    response = _complete(provider)

    assert response.stop_reason == "error"
    assert _models(client) == ([] if cancel_before_first_request else [FLASH])
