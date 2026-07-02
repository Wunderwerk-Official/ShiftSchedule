"""Anthropic (Claude) adapter for the planning agent.

Maps the provider-neutral protocol in ``provider.py`` onto the official
``anthropic`` SDK:

- tools map 1:1 to the Messages API tool format
- the system prompt gets a ``cache_control`` breakpoint so iterations 2..N of
  the repair loop hit the prompt cache (system + tools render first and are
  byte-stable across the loop)
- adaptive thinking is enabled (supported on Claude 4.6+ models; the default
  ``AGENT_MODEL`` is claude-opus-4-8). No sampling parameters — current Opus
  models reject them.
- API failures never raise: typed SDK errors are mapped to
  ``ProviderResponse(stop_reason="error")`` after the SDK's built-in retries
  (2 by default for 429/5xx/connection errors).
"""

from __future__ import annotations

import os
from typing import List

from .config import AgentConfig
from .provider import ChatMessage, LLMProvider, ProviderResponse, ToolCall, ToolSpec


class AnthropicProvider(LLMProvider):
    def __init__(self, config: AgentConfig):
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set; the agent solver needs it "
                "(or set AGENT_PROVIDER=mock for tests)."
            )
        import anthropic  # imported lazily: optional unless agent mode is used

        self._anthropic = anthropic
        self._client = anthropic.Anthropic()
        self._config = config

    def complete(
        self,
        *,
        system: str,
        messages: List[ChatMessage],
        tools: List[ToolSpec],
        timeout_seconds: float,
    ) -> ProviderResponse:
        anthropic = self._anthropic
        try:
            response = self._client.with_options(timeout=timeout_seconds).messages.create(
                model=self._config.model,
                max_tokens=self._config.max_tokens,
                thinking={"type": "adaptive"},
                system=[
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                tools=[
                    {
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    }
                    for t in tools
                ],
                messages=self._convert_messages(messages),
            )
        except anthropic.APIStatusError as exc:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"Anthropic API error {exc.status_code}: {exc.message}",
            )
        except anthropic.APIConnectionError as exc:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"Anthropic connection error: {exc}",
            )

        text_parts: List[str] = []
        tool_calls: List[ToolCall] = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                # block.input is an already-parsed dict — never string-match it
                tool_calls.append(
                    ToolCall(id=block.id, name=block.name, arguments=dict(block.input))
                )
        usage = {
            "input_tokens": getattr(response.usage, "input_tokens", 0) or 0,
            "output_tokens": getattr(response.usage, "output_tokens", 0) or 0,
        }
        stop_reason = response.stop_reason or "end_turn"
        if stop_reason not in ("tool_use", "end_turn", "max_tokens", "refusal"):
            stop_reason = "end_turn"
        return ProviderResponse(
            text="\n".join(text_parts) or None,
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            usage=usage,
        )

    @staticmethod
    def _convert_messages(messages: List[ChatMessage]) -> List[dict]:
        out: List[dict] = []
        for msg in messages:
            if msg.role == "user":
                out.append({"role": "user", "content": msg.content or ""})
            elif msg.role == "assistant":
                blocks: List[dict] = []
                if msg.content:
                    blocks.append({"type": "text", "text": msg.content})
                for call in msg.tool_calls:
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": call.id,
                            "name": call.name,
                            "input": call.arguments,
                        }
                    )
                out.append({"role": "assistant", "content": blocks})
            else:  # "tool" — all results of one assistant turn in ONE user message
                out.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": r.tool_call_id,
                                "content": r.content,
                                "is_error": r.is_error,
                            }
                            for r in msg.tool_results
                        ],
                    }
                )
        return out
