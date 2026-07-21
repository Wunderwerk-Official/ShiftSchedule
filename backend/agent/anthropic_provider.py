"""Anthropic (Claude) adapter for the planning agent.

Maps the provider-neutral protocol in ``provider.py`` onto the official
``anthropic`` SDK:

- tools map 1:1 to the Messages API tool format
- two ``cache_control`` breakpoints: one on the system prompt (system + tools
  render first and are byte-stable across the loop) and one on the last
  message, so iterations 2..N also read the growing conversation history —
  digest plus all tool results — from the cache instead of re-billing it at
  full input price every round
- adaptive thinking is enabled only on models that support it (Opus 4.6+,
  Sonnet 4.6+, Sonnet 5, Fable/Mythos 5). Haiku and unknown models get no
  ``thinking`` parameter — sending ``{"type": "adaptive"}`` to them is a 400
  ("adaptive thinking is not supported"). No sampling parameters — current
  Opus models reject them.
- API failures never raise: typed SDK errors are mapped to
  ``ProviderResponse(stop_reason="error")`` with ``retryable`` classifying
  transient failures (429/5xx/connection). SDK retries are disabled
  (``max_retries=0``) — the harness retries deadline-aware instead.
"""

from __future__ import annotations

import os
from typing import List

from .config import AgentConfig
from .provider import (
    ChatMessage,
    LLMProvider,
    ProviderResponse,
    ToolCall,
    ToolSpec,
    is_retryable_status,
)

# Model families that accept ``thinking: {"type": "adaptive"}``. Anything else
# (Haiku 4.5, older Sonnet/Opus, unknown ids) runs without a thinking param —
# that is valid on every model, while adaptive on an unsupported model 400s.
_ADAPTIVE_THINKING_PREFIXES = (
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-fable",
    "claude-mythos",
)


def supports_adaptive_thinking(model: str) -> bool:
    return (model or "").lower().startswith(_ADAPTIVE_THINKING_PREFIXES)


class AnthropicProvider(LLMProvider):
    def __init__(self, config: AgentConfig):
        # Admin-configured key (Settings → Solver) wins over the server .env.
        api_key = config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "No Anthropic API key configured; set it in Settings → Solver "
                "(admin) or via ANTHROPIC_API_KEY in the server .env "
                "(or set AGENT_PROVIDER=mock for tests)."
            )
        import anthropic  # imported lazily: optional unless agent mode is used

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=api_key)
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
            # max_retries=0: the harness sizes timeout_seconds to the remaining
            # wall-clock budget; SDK retries (2 by default, full timeout each)
            # could otherwise block ~3x past the solve deadline. Transient
            # failures degrade to the best-plan-so-far path instead.
            request_kwargs = {}
            if supports_adaptive_thinking(self._config.model):
                request_kwargs["thinking"] = {"type": "adaptive"}
            if tools:
                # Omitted entirely for plain chat calls (admin connection
                # test) — an empty tools array is pointless on the wire.
                request_kwargs["tools"] = [
                    {
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    }
                    for t in tools
                ]
            response = self._client.with_options(
                timeout=timeout_seconds, max_retries=0
            ).messages.create(
                model=self._config.model,
                max_tokens=self._config.max_tokens,
                **request_kwargs,
                system=[
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=self._convert_messages(messages),
            )
        except anthropic.APIStatusError as exc:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"Anthropic API error {exc.status_code}: {exc.message}",
                error_status=exc.status_code,
                retryable=is_retryable_status(exc.status_code),
            )
        except anthropic.APIConnectionError as exc:
            # Includes APITimeoutError — both are transient by nature.
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"Anthropic connection error: {exc}",
                retryable=True,
            )

        text_parts: List[str] = []
        reasoning_parts: List[str] = []
        tool_calls: List[ToolCall] = []
        raw_content: List[dict] = []
        for block in response.content:
            # Keep EVERY block (thinking included) for verbatim replay: the
            # API requires thinking blocks to be echoed back unchanged when
            # continuing the conversation; stripping them 400s the next call.
            raw_content.append(block.model_dump(exclude_none=True))
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "thinking":
                # Surface the chain of thought for the live feed / run log.
                thinking_text = getattr(block, "thinking", None)
                if isinstance(thinking_text, str) and thinking_text.strip():
                    reasoning_parts.append(thinking_text.strip())
            elif block.type == "tool_use":
                # block.input is an already-parsed dict — never string-match it
                tool_calls.append(
                    ToolCall(id=block.id, name=block.name, arguments=dict(block.input))
                )
        usage = {
            "input_tokens": getattr(response.usage, "input_tokens", 0) or 0,
            "output_tokens": getattr(response.usage, "output_tokens", 0) or 0,
            # Cached tokens are billed separately (~0.1x reads, 1.25x writes)
            # and excluded from input_tokens — track them for cost estimates.
            "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
            "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
        }
        stop_reason = response.stop_reason or "end_turn"
        if stop_reason not in ("tool_use", "end_turn", "max_tokens", "refusal"):
            stop_reason = "end_turn"
        text = "\n".join(text_parts) or None
        reasoning = "\n".join(reasoning_parts) or None
        if text is None and reasoning is not None:
            # Reasoning-only turn: promote it to text so the run summary and
            # feed never end up empty (matches the OpenAI adapter's contract).
            text, reasoning = reasoning, None
        return ProviderResponse(
            text=text,
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            usage=usage,
            reasoning=reasoning,
            # raw_content wins on replay (thinking blocks must be echoed
            # verbatim); replay_text is the fallback for consistency.
            replay_text=text,
            raw_content=raw_content,
        )

    @staticmethod
    def _convert_messages(messages: List[ChatMessage]) -> List[dict]:
        out: List[dict] = []
        for msg in messages:
            if msg.role == "user":
                out.append(
                    {
                        "role": "user",
                        # block form (not bare string) so a cache breakpoint
                        # can attach; the API rejects empty text blocks.
                        "content": [{"type": "text", "text": msg.content or " "}],
                    }
                )
            elif msg.role == "assistant":
                if msg.raw_content is not None:
                    # Replay the turn exactly as the API returned it —
                    # thinking blocks included (required for adaptive
                    # thinking + tool use).
                    out.append({"role": "assistant", "content": msg.raw_content})
                    continue
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
        # Cache breakpoint on the last content block: iterations 2..N then
        # read the whole prior conversation (digest + all tool results) from
        # the prompt cache at ~0.1x instead of re-billing it at full input
        # price every round — on long runs the history dominates the cost.
        # (Second breakpoint next to the one on the system block; max is 4.)
        if out:
            last_content = out[-1]["content"]
            if isinstance(last_content, list) and last_content:
                last_block = last_content[-1]
                if isinstance(last_block, dict):
                    last_block["cache_control"] = {"type": "ephemeral"}
        return out
