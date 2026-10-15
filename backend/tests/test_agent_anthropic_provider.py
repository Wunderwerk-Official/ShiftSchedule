"""Malformed provider inputs keep their call IDs and remain repairable."""
from types import SimpleNamespace

import pytest

from backend.agent.anthropic_provider import AnthropicProvider
from backend.agent.config import AgentConfig


@pytest.mark.parametrize("arguments", [None, [], "false"])
def test_non_object_tool_input_is_reported_without_crashing(arguments):
    raw = {"type": "tool_use", "id": "broken", "name": "apply_moves", "input": arguments}
    block = SimpleNamespace(**raw, model_dump=lambda **_: raw)
    response = SimpleNamespace(content=[block], usage=SimpleNamespace(input_tokens=7, output_tokens=3),
                               stop_reason="tool_use")
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test"))
    provider._client.close()
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **_: response))
    client.with_options = lambda **_: client
    provider._client = client

    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.tool_calls[0].id == "broken"
    assert result.tool_calls[0].argument_error == "Tool arguments must be a JSON object."
    assert result.raw_content == [raw]
    assert result.usage["input_tokens"] == 7


def _provider_with_fake_create(create, model="claude-sonnet-5"):
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model=model))
    provider._client.close()
    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    client.with_options = lambda **_: client
    provider._client = client
    return provider


def _empty_response(content=()):
    return SimpleNamespace(content=list(content), usage=SimpleNamespace(input_tokens=1, output_tokens=1),
                           stop_reason="end_turn")


def test_empty_end_turn_yields_no_raw_content():
    provider = _provider_with_fake_create(lambda **_: _empty_response())
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.raw_content is None
    assert result.text is None


def test_empty_raw_content_replays_fallback_text():
    from backend.agent.provider import ChatMessage

    out = AnthropicProvider._convert_messages([
        ChatMessage(role="user", content="go"),
        ChatMessage(role="assistant", content="(day ended)", raw_content=[]),
        ChatMessage(role="user", content="continue"),
    ])
    assert out[1] == {"role": "assistant", "content": [{"type": "text", "text": "(day ended)"}]}


def test_assistant_without_content_or_tool_calls_gets_non_empty_text_block():
    from backend.agent.provider import ChatMessage

    out = AnthropicProvider._convert_messages([
        ChatMessage(role="user", content="go"),
        ChatMessage(role="assistant", content=None),
        ChatMessage(role="user", content="continue"),
    ])
    assert out[1]["content"] == [{"type": "text", "text": "(no reply)"}]


def test_empty_user_content_gets_non_whitespace_text_block():
    from backend.agent.provider import ChatMessage

    out = AnthropicProvider._convert_messages([ChatMessage(role="user", content="")])
    assert out[0]["content"][0]["text"] == "(empty)"


@pytest.mark.parametrize(
    "model, expected",
    [
        ("claude-sonnet-5", {"type": "adaptive", "display": "summarized"}),
        ("claude-opus-4-8", {"type": "adaptive", "display": "summarized"}),
        ("claude-opus-5-5", {"type": "adaptive", "display": "summarized"}),
        ("claude-haiku-5-5", {"type": "adaptive", "display": "summarized"}),
        ("claude-fable-5", {"type": "adaptive", "display": "summarized"}),
        ("claude-sonnet-4-6", {"type": "adaptive"}),
        ("claude-opus-4-6", {"type": "adaptive"}),
        ("claude-haiku-4-5", None),
    ],
)
def test_thinking_display_requested_where_default_is_omitted(model, expected):
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return _empty_response()

    provider = _provider_with_fake_create(create, model=model)
    provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert captured.get("thinking") == expected


def test_summarized_thinking_only_turn_is_promoted_to_text():
    raw = {"type": "thinking", "thinking": "Check Monday first.", "signature": "sig"}
    block = SimpleNamespace(**raw, model_dump=lambda **_: raw)
    provider = _provider_with_fake_create(lambda **_: _empty_response([block]))
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    # Reasoning-only turn: promoted to text.
    assert result.text == "Check Monday first."
    assert result.raw_content == [raw]


def test_summarized_thinking_next_to_text_reaches_the_reasoning_feed():
    thinking = {"type": "thinking", "thinking": "Check Monday first.", "signature": "sig"}
    text = {"type": "text", "text": "Monday is full."}
    blocks = [SimpleNamespace(**raw, model_dump=lambda raw=raw, **_: raw) for raw in (thinking, text)]
    provider = _provider_with_fake_create(lambda **_: _empty_response(blocks))
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.reasoning == "Check Monday first."
    assert result.text == "Monday is full."


def test_other_sdk_errors_become_non_retryable_error_response():
    import anthropic

    def create(**_):
        raise anthropic.AnthropicError("unexpected payload")

    provider = _provider_with_fake_create(create)
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.stop_reason == "error"
    assert result.retryable is False
    assert "unexpected payload" in result.error
