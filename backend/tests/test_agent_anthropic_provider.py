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
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model="claude-sonnet-5"))
    provider._client.close()
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **_: response))
    client.with_options = lambda **_: client
    provider._client = client

    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.tool_calls[0].id == "broken"
    assert result.tool_calls[0].argument_error == "Tool arguments must be a JSON object."
    assert result.raw_content == [raw]
    assert result.usage["input_tokens"] == 7


def _provider_with_fake_create(create, model="claude-sonnet-5", beta_create=None):
    """Both namespaces call `create` unless the test tells them apart."""
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model=model))
    provider._client.close()
    client = SimpleNamespace(
        messages=SimpleNamespace(create=create),
        beta=SimpleNamespace(messages=SimpleNamespace(create=beta_create or create)),
    )
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
        # Opus 5.5 binds thinking blocks to the conversation: see below.
        ("claude-opus-5-5", {"type": "adaptive", "display": "summarized",
                             "block_binding": {"prefix_mismatch_behavior": "drop_block"}}),
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


def _capture_paths(model):
    calls = {"messages": [], "beta": []}
    provider = _provider_with_fake_create(
        lambda **kwargs: calls["messages"].append(kwargs) or _empty_response(),
        model=model,
        beta_create=lambda **kwargs: calls["beta"].append(kwargs) or _empty_response(),
    )
    provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    return calls


def test_opus_55_requests_effort_drop_block_and_the_refusal_fallback():
    calls = _capture_paths("claude-opus-5-5")
    assert calls["messages"] == []
    (request,) = calls["beta"]
    assert request["betas"] == ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"]
    # Opus 5.5 defaults to "medium": set explicitly.
    assert request["output_config"] == {"effort": "medium"}
    assert request["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    assert request["extra_body"] == {"fallbacks": "default"}
    assert "temperature" not in request and "tool_choice" not in request


@pytest.mark.parametrize("model", ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"])
def test_other_models_keep_the_plain_request(model):
    calls = _capture_paths(model)
    assert calls["beta"] == []
    (request,) = calls["messages"]
    for key in ("betas", "output_config", "extra_body"):
        assert key not in request
    assert "block_binding" not in (request.get("thinking") or {})


def _fallback_response(content, iterations=None, model="claude-opus-5"):
    usage = SimpleNamespace(input_tokens=5, output_tokens=2, iterations=iterations)
    return SimpleNamespace(content=content, usage=usage, stop_reason="end_turn", model=model)


def test_refusal_fallback_block_is_not_replayed_and_the_feed_names_the_serving_model():
    marker = {"type": "fallback", "from_": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-5"}}
    text = {"type": "text", "text": "Monday is full."}
    blocks = [SimpleNamespace(**raw, model_dump=lambda raw=raw, **_: raw) for raw in (marker, text)]
    provider = _provider_with_fake_create(lambda **_: _fallback_response(blocks), model="claude-opus-5-5")
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.raw_content == [text]
    assert result.text == "Monday is full."
    assert result.reasoning == "Note: claude-opus-5-5 declined this turn (safety classifier); claude-opus-5 answered it."
    # The run keeps the chosen (priced) model: no model switch is reported.
    assert result.model is None


def test_sticky_fallback_turn_is_detected_from_the_usage_iterations():
    text = {"type": "text", "text": "Done."}
    block = SimpleNamespace(**text, model_dump=lambda **_: text)
    iterations = [SimpleNamespace(type="fallback_message")]
    provider = _provider_with_fake_create(
        lambda **_: _fallback_response([block], iterations), model="claude-opus-5-5"
    )
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    # Sticky routing: the requested model did not run this turn.
    assert result.reasoning == (
        "Note: answered by claude-opus-5; the refusal fallback for claude-opus-5-5 "
        "is still active for this conversation."
    )


def test_a_normal_turn_reports_no_model_switch():
    text = {"type": "text", "text": "Done."}
    block = SimpleNamespace(**text, model_dump=lambda **_: text)
    provider = _provider_with_fake_create(
        lambda **_: _fallback_response([block], [SimpleNamespace(type="message")], model="claude-opus-5-5"),
        model="claude-opus-5-5",
    )
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.reasoning is None
    assert result.model is None


def _refusal_response(content, category, iterations=None, model="claude-opus-5"):
    usage = SimpleNamespace(input_tokens=5, output_tokens=0, iterations=iterations)
    return SimpleNamespace(content=content, usage=usage, stop_reason="refusal", model=model,
                           stop_details=SimpleNamespace(category=category))


def test_a_refusal_names_its_category_for_the_run_note():
    provider = _provider_with_fake_create(lambda **_: _refusal_response([], "bio"), model="claude-opus-5-5")
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.stop_reason == "refusal"
    assert result.error == "declined, category: bio"
    assert result.reasoning is None and result.text is None


def test_a_refusal_of_the_whole_fallback_chain_never_claims_an_answer():
    marker = {"type": "fallback", "from_": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}}
    block = SimpleNamespace(**marker, model_dump=lambda **_: marker)
    provider = _provider_with_fake_create(
        lambda **_: _refusal_response([block], "cyber", model="claude-opus-4-8"), model="claude-opus-5-5"
    )
    result = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert result.error == "declined, category: cyber; the fallback model claude-opus-4-8 declined too"
    assert result.text is None and result.reasoning is None
    assert result.raw_content is None


def test_a_fallback_turn_counts_the_tokens_of_every_attempt():
    text = {"type": "text", "text": "Done."}
    block = SimpleNamespace(**text, model_dump=lambda **_: text)
    attempt = dict(cache_read_input_tokens=0, cache_creation_input_tokens=0)
    iterations = [
        SimpleNamespace(type="message", input_tokens=100, output_tokens=0, **attempt),
        SimpleNamespace(type="fallback_message", input_tokens=120, output_tokens=40,
                        cache_read_input_tokens=10, cache_creation_input_tokens=5),
    ]
    provider = _provider_with_fake_create(
        lambda **_: _fallback_response([block], iterations), model="claude-opus-5-5"
    )
    usage = provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10).usage
    assert usage == {"input_tokens": 220, "output_tokens": 40,
                     "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5}


@pytest.mark.parametrize("model, bound", [("claude-opus-5-5", True), ("claude-sonnet-5", False)])
def test_only_conversation_bound_models_ask_for_thinking_stripping(model, bound):
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model=model))
    provider._client.close()
    assert provider.binds_thinking_to_conversation is bound


@pytest.mark.parametrize("model, path", [("claude-opus-5-5", "beta"), ("claude-opus-4-8", "messages")])
def test_a_configured_effort_overrides_the_model_default(model, path):
    calls = {"messages": [], "beta": []}
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model=model, anthropic_effort="low"))
    provider._client.close()
    client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: calls["messages"].append(kw) or _empty_response()),
        beta=SimpleNamespace(messages=SimpleNamespace(
            create=lambda **kw: calls["beta"].append(kw) or _empty_response())),
    )
    client.with_options = lambda **_: client
    provider._client = client
    provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    (request,) = calls[path]
    assert request["output_config"] == {"effort": "low"}


def test_a_configured_effort_is_not_sent_to_a_model_without_adaptive_thinking():
    calls = []
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model="claude-haiku-4-5",
                                             anthropic_effort="high"))
    provider._client.close()
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: calls.append(kw) or _empty_response()))
    client.with_options = lambda **_: client
    provider._client = client
    provider.complete(system="plan", messages=[], tools=[], timeout_seconds=10)
    assert "output_config" not in calls[0]


@pytest.mark.parametrize("model, budget", [
    ("claude-opus-5-5", 600_000), ("claude-sonnet-5-5", 600_000), ("claude-haiku-4-5", None),
])
def test_claude_models_get_a_long_tool_history_and_literal_texts(model, budget):
    provider = AnthropicProvider(AgentConfig(anthropic_api_key="local-test", model=model))
    provider._client.close()
    assert provider.tool_history_budget_chars == budget
    assert provider.follows_tool_texts_literally is True


def test_fallback_turns_are_flagged_and_normal_turns_are_not():
    text = {"type": "text", "text": "Done."}
    block = SimpleNamespace(**text, model_dump=lambda **_: text)
    switched = _provider_with_fake_create(
        lambda **_: _fallback_response([block], [SimpleNamespace(type="fallback_message")]),
        model="claude-opus-5-5",
    )
    assert switched.complete(system="plan", messages=[], tools=[], timeout_seconds=10).fallback_turn is True
    normal = _provider_with_fake_create(
        lambda **_: _fallback_response([block], [SimpleNamespace(type="message")], model="claude-opus-5-5"),
        model="claude-opus-5-5",
    )
    assert normal.complete(system="plan", messages=[], tools=[], timeout_seconds=10).fallback_turn is False


def test_effective_effort_is_the_single_source_for_requests_and_reports():
    from backend.agent.anthropic_provider import effective_effort

    assert effective_effort("claude-opus-5-5") == "medium"
    assert effective_effort("claude-opus-5-5", "xhigh") == "xhigh"
    assert effective_effort("claude-sonnet-5") is None
    assert effective_effort("claude-sonnet-5", "low") == "low"
    assert effective_effort("claude-haiku-4-5", "high") is None
