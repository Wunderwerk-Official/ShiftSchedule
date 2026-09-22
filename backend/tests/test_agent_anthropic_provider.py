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
