"""OpenAI-compatible provider: message/tool conversion and response mapping.

No server involved — the conversion helpers are pure, and ``complete`` is
exercised against a stub client that mimics the SDK response objects.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.agent.config import AgentConfig
from backend.agent.openai_provider import (
    OpenAICompatibleProvider,
    _parse_arguments,
    to_openai_messages,
    to_openai_tools,
)
from backend.agent.provider import ChatMessage, ToolCall, ToolResult, ToolSpec


def test_parse_arguments_is_defensive():
    assert _parse_arguments('{"a": 1}') == {"a": 1}
    assert _parse_arguments({"a": 1}) == {"a": 1}  # server pre-parsed
    assert _parse_arguments("{broken json") == {}
    assert _parse_arguments('["not", "a", "dict"]') == {}
    assert _parse_arguments(None) == {}
    assert _parse_arguments("") == {}


def test_message_conversion_shapes():
    messages = [
        ChatMessage(role="user", content="digest"),
        ChatMessage(
            role="assistant",
            content="thinking out loud",
            tool_calls=[ToolCall(id="c1", name="get_plan_overview", arguments={"x": 1})],
        ),
        ChatMessage(
            role="tool",
            tool_results=[
                ToolResult("c1", '{"ok":true}'),
                ToolResult("c2", '{"ok":false}', is_error=True),
            ],
        ),
        ChatMessage(role="assistant", content=None, tool_calls=[]),  # edge: empty turn
    ]
    out = to_openai_messages("SYSTEM", messages)
    assert out[0] == {"role": "system", "content": "SYSTEM"}
    assert out[1] == {"role": "user", "content": "digest"}
    assistant = out[2]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == "thinking out loud"
    call = assistant["tool_calls"][0]
    assert call["id"] == "c1" and call["type"] == "function"
    assert call["function"]["name"] == "get_plan_overview"
    assert json.loads(call["function"]["arguments"]) == {"x": 1}
    # ONE tool message per result (Anthropic packs them into one user turn)
    assert out[3] == {"role": "tool", "tool_call_id": "c1", "content": '{"ok":true}'}
    assert out[4] == {"role": "tool", "tool_call_id": "c2", "content": '{"ok":false}'}
    # empty assistant turn still carries non-null content
    assert out[5]["content"] == " "


def test_tool_conversion_wraps_function_schema():
    tools = [ToolSpec("t1", "does things", {"type": "object", "properties": {}})]
    converted = to_openai_tools(tools)
    assert converted[0]["type"] == "function"
    assert converted[0]["function"]["name"] == "t1"
    assert converted[0]["function"]["parameters"] == {"type": "object", "properties": {}}


def test_constructor_requires_base_url():
    with pytest.raises(RuntimeError, match="base URL"):
        OpenAICompatibleProvider(AgentConfig(provider="openai", openai_base_url=None))


class _StubClient:
    """Mimics client.with_options(...).chat.completions.create(...)."""

    def __init__(self, response):
        self._response = response
        self.last_kwargs = None

    def with_options(self, **_kwargs):
        return self

    @property
    def chat(self):
        outer = self

        class _Completions:
            @staticmethod
            def create(**kwargs):
                outer.last_kwargs = kwargs
                return outer._response

        return SimpleNamespace(completions=_Completions())


def _provider_with(response) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(
        AgentConfig(provider="openai", model="my-local-model",
                    openai_base_url="http://127.0.0.1:9/v1")
    )
    provider._client = _StubClient(response)
    return provider


def _completion(*, content=None, tool_calls=None, finish_reason="stop", usage=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], usage=usage)


def test_complete_maps_tool_calls_even_on_finish_stop():
    # Some open models report finish_reason "stop" although they made calls.
    tool_call = SimpleNamespace(
        id="call_1",
        function=SimpleNamespace(name="list_open_slots", arguments='{"limit": 5}'),
    )
    usage = SimpleNamespace(
        prompt_tokens=100, completion_tokens=20,
        prompt_tokens_details=SimpleNamespace(cached_tokens=60),
    )
    provider = _provider_with(
        _completion(content="checking", tool_calls=[tool_call],
                    finish_reason="stop", usage=usage)
    )
    response = provider.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[ToolSpec("list_open_slots", "d", {"type": "object"})],
        timeout_seconds=10,
    )
    assert response.stop_reason == "tool_use"
    assert response.tool_calls[0].name == "list_open_slots"
    assert response.tool_calls[0].arguments == {"limit": 5}
    assert response.usage["input_tokens"] == 100
    assert response.usage["output_tokens"] == 20
    assert response.usage["cache_read_input_tokens"] == 60
    assert response.raw_content is None  # no replay requirement


def test_complete_maps_length_and_broken_arguments():
    tool_call = SimpleNamespace(
        id="call_1",
        function=SimpleNamespace(name="apply_moves", arguments="{oops"),
    )
    provider = _provider_with(
        _completion(tool_calls=[tool_call], finish_reason="length", usage=None)
    )
    response = provider.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[], timeout_seconds=10,
    )
    # Broken JSON degrades to {} (the executor then reports a usable error);
    # tool calls still win over the finish_reason.
    assert response.tool_calls[0].arguments == {}
    assert response.stop_reason == "tool_use"
    # Plain chat calls (tools=[]) omit the parameter — some servers reject
    # an empty tools array.
    assert "tools" not in provider._client.last_kwargs

    provider2 = _provider_with(_completion(content="done", finish_reason="length"))
    response2 = provider2.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[], timeout_seconds=10,
    )
    assert response2.stop_reason == "max_tokens"
    assert response2.text == "done"


def test_reasoning_content_surfaces_when_no_answer_text():
    # Reasoning models (Qwen3 via vLLM --reasoning-parser) put thoughts into
    # reasoning_content; on tool-call turns content is often empty. The feed
    # should still show what the model is thinking.
    tool_call = SimpleNamespace(
        id="call_1",
        function=SimpleNamespace(name="get_plan_overview", arguments="{}"),
    )
    message = SimpleNamespace(
        content=None, tool_calls=[tool_call],
        reasoning_content="Let me inspect the open slots first.",
    )
    choice = SimpleNamespace(message=message, finish_reason="tool_calls")
    provider = _provider_with(SimpleNamespace(choices=[choice], usage=None))
    response = provider.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[], timeout_seconds=10,
    )
    assert response.text == "Let me inspect the open slots first."
    assert response.stop_reason == "tool_use"

    # LiteLLM proxies name the field "reasoning" instead (their convention
    # for reasoning models) — both spellings must surface.
    message_lite = SimpleNamespace(
        content=None, tool_calls=[tool_call],
        reasoning="LiteLLM-style chain of thought.",
    )
    choice_lite = SimpleNamespace(message=message_lite, finish_reason="tool_calls")
    provider_lite = _provider_with(SimpleNamespace(choices=[choice_lite], usage=None))
    response_lite = provider_lite.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[], timeout_seconds=10,
    )
    assert response_lite.text == "LiteLLM-style chain of thought."

    # When there IS answer text, it wins — and the chain of thought comes
    # along separately for the live feed / run log.
    message2 = SimpleNamespace(
        content="final answer", tool_calls=None, reasoning_content="hidden thoughts",
    )
    choice2 = SimpleNamespace(message=message2, finish_reason="stop")
    provider2 = _provider_with(SimpleNamespace(choices=[choice2], usage=None))
    response2 = provider2.complete(
        system="s", messages=[ChatMessage(role="user", content="hi")],
        tools=[], timeout_seconds=10,
    )
    assert response2.text == "final answer"
    assert response2.reasoning == "hidden thoughts"


def test_verify_tls_off_builds_client_with_unverified_http_client():
    provider = OpenAICompatibleProvider(
        AgentConfig(provider="openai", model="m",
                    openai_base_url="https://134.130.13.43:4000/v1",
                    openai_verify_tls=False)
    )
    # The SDK client was constructed with a custom httpx client; enough to
    # assert construction succeeded and the base_url stuck.
    assert str(provider._client.base_url).startswith("https://134.130.13.43:4000/v1")
