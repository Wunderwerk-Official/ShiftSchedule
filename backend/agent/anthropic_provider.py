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
  Sonnet 4.6+, Haiku 5.x, Fable/Mythos 5). Haiku 4.5 and unknown models get no
  ``thinking`` parameter — sending ``{"type": "adaptive"}`` to them is a 400
  ("adaptive thinking is not supported"). ``display: "summarized"`` is sent
  where the model default is ``"omitted"`` (Opus 4.7+, Sonnet 5+, Haiku 5.x,
  Fable/Mythos)
  so the reasoning feed / run log is not silently empty. No sampling
  parameters — current Opus models reject them.
- Claude Opus 5.5 gets three request additions (beta namespace, see
  ``_request_extras``): an explicit effort (its default is "medium",
  one level below Sonnet 5 / Opus 4.8), ``drop_block`` for thinking blocks
  bound to an edited history (the harness stubs old tool results; accounts
  created on or after 2026-08-31 would otherwise get a 400), and the
  server-side refusal fallback. A ``fallback`` block in the reply is not
  replayed; a note in the reasoning feed names the model that answered (a
  refusal of the whole chain names its category in ``error`` instead). The
  run keeps reporting the chosen model, so its cost is priced from the
  pricing table at that model's rates, with the tokens of every attempt of a
  fallback turn counted (fallback models bill at their own Opus rates, and
  sticky routing keeps a conversation on them for about an hour).
- Conversation-bound models (``binds_thinking_to_conversation``) let the
  harness strip thinking blocks that a history compaction invalidated, so
  ``drop_block`` does not keep dropping every later block.
- Claude traits for the harness: 1M-context models compact the tool history
  only past ``LONG_CONTEXT_TOOL_HISTORY_CHARS`` (the 60k default was sized
  for self-hosted models; each compaction resets the cache and, on Opus 5.5,
  drops earlier thinking), and every Claude model gets the tool/prompt
  wording without the self-hosted-era contradictions.
- ``config.anthropic_effort`` overrides the effort (arena sweeps) on every
  model that takes one.
- API failures never raise: SDK errors are mapped to
  ``ProviderResponse(stop_reason="error")`` with ``retryable`` classifying
  transient failures (429/5xx/connection); any other ``AnthropicError`` is a
  non-retryable error response. SDK retries are disabled
  (``max_retries=0``) — the harness retries deadline-aware instead.
"""

from __future__ import annotations

import os
from typing import List, Optional

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
    "claude-opus-5",  # also matches claude-opus-5-5
    "claude-sonnet-4-6",
    "claude-sonnet-5",  # also matches claude-sonnet-5-5
    "claude-haiku-5",  # Haiku 5.x only; Haiku 4.5 has no adaptive thinking
    "claude-fable",
    "claude-mythos",
)


# Adaptive-thinking models whose ``thinking.display`` already defaults to
# "summarized"; every other adaptive model defaults to "omitted" (empty
# thinking text), so we ask for "summarized" explicitly there.
_SUMMARIZED_BY_DEFAULT_PREFIXES = ("claude-opus-4-6", "claude-sonnet-4-6")


def supports_adaptive_thinking(model: str) -> bool:
    return (model or "").lower().startswith(_ADAPTIVE_THINKING_PREFIXES)


# Every adaptive-thinking model above has a 1M-token context: compact the
# tool history only past ~200k tokens, so a day conversation normally never
# compacts (peak about 120-170k tokens measured offline for a 7-day run).
LONG_CONTEXT_TOOL_HISTORY_CHARS = 600_000


# Models whose effort default is below the "high" the planner was tuned on:
# set it explicitly. Opus 5.5 at "medium" matches Opus 5 at "high" (Anthropic's
# guidance is to start there).
_EXPLICIT_EFFORT = {"claude-opus-5-5": "medium"}
# Models that bind thinking blocks to the conversation prefix ("preserved
# thinking"); of these only Opus 5.5 is selectable (agent_budget), the others
# can come in through AGENT_MODEL. _compact_tool_history (harness) replaces
# old tool results with a stub, which invalidates every later thinking block:
# the harness strips those blocks once (binds_thinking_to_conversation), and
# drop_block makes the API drop any other invalid block (unbilled) instead of
# rejecting the request. A stale block left in the history would make the API
# drop it and every block after it on every later request.
_CONVERSATION_BOUND_MODELS = frozenset(
    {"claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"}
)


def binds_thinking_to_conversation(model: str) -> bool:
    return (model or "").lower() in _CONVERSATION_BOUND_MODELS
_THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"
# Server-side refusal fallback: a classifier decline (cyber/bio/...) is re-run
# on the model Anthropic recommends for that category inside the same call,
# instead of skipping the planning day.
_SERVER_FALLBACK_MODELS = frozenset({"claude-opus-5-5"})
_SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def effective_effort(model: Optional[str], override: Optional[str] = None) -> Optional[str]:
    """The effort a request for ``model`` carries: the override on models
    with adaptive thinking (Haiku 4.5 rejects effort), else the per-model
    explicit default; None = the API default."""
    model = (model or "").lower()
    return (override if supports_adaptive_thinking(model) else None) or _EXPLICIT_EFFORT.get(model)


def _request_extras(model: str, thinking, effort_override=None):
    """Betas, request kwargs and extra body: the Opus 5.5 request surface,
    plus an explicit effort (``effort_override`` on any model that takes one).
    Empty for every other model without an override (unchanged requests)."""
    model = (model or "").lower()
    betas: List[str] = []
    kwargs: dict = {}
    extra_body: dict = {}
    if thinking is not None and model in _CONVERSATION_BOUND_MODELS:
        thinking["block_binding"] = {"prefix_mismatch_behavior": "drop_block"}
        betas.append(_THINKING_BINDING_BETA)
    effort = effective_effort(model, effort_override)
    if effort:
        kwargs["output_config"] = {"effort": effort}
    if model in _SERVER_FALLBACK_MODELS:
        betas.append(_SERVER_FALLBACK_BETA)
        # The installed SDK types only the array form of `fallbacks`.
        extra_body["fallbacks"] = "default"
    return betas, kwargs, extra_body


def _fallback_kind(response):
    """"switch" when the requested model declined this turn and a fallback
    model ran, "sticky" when a fallback model served the turn directly (sticky
    routing after an earlier decline), else None."""
    if any(getattr(block, "type", None) == "fallback" for block in response.content):
        return "switch"
    iterations = getattr(response.usage, "iterations", None) or []
    if any(getattr(entry, "type", None) == "fallback_message" for entry in iterations):
        return "sticky"
    return None


_USAGE_KEYS = (
    "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"
)


def _token_usage(response, fallback_kind) -> dict:
    """Top-level usage covers only the attempt that produced the reply; on a
    fallback turn the per-attempt ``usage.iterations`` hold every attempt."""
    iterations = getattr(response.usage, "iterations", None) or []
    source = iterations if fallback_kind and iterations else [response.usage]
    return {
        key: sum(getattr(entry, key, 0) or 0 for entry in source) for key in _USAGE_KEYS
    }


class AnthropicProvider(LLMProvider):
    def __init__(self, config: AgentConfig):
        self.binds_thinking_to_conversation = binds_thinking_to_conversation(config.model)
        if supports_adaptive_thinking(config.model):
            self.tool_history_budget_chars = LONG_CONTEXT_TOOL_HISTORY_CHARS
        self.follows_tool_texts_literally = True
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
            thinking = None
            if supports_adaptive_thinking(self._config.model):
                thinking = {"type": "adaptive"}
                if not (self._config.model or "").lower().startswith(
                    _SUMMARIZED_BY_DEFAULT_PREFIXES
                ):
                    thinking["display"] = "summarized"
                request_kwargs["thinking"] = thinking
            betas, extra_kwargs, extra_body = _request_extras(
                self._config.model, thinking, self._config.anthropic_effort
            )
            request_kwargs.update(extra_kwargs)
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
            client = self._client.with_options(timeout=timeout_seconds, max_retries=0)
            if betas:
                create = client.beta.messages.create
                request_kwargs["betas"] = betas
                if extra_body:
                    request_kwargs["extra_body"] = extra_body
            else:
                create = client.messages.create
            response = create(
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
        except anthropic.AnthropicError as exc:
            # Anything else from the SDK (e.g. APIResponseValidationError):
            # honour the never-raise contract, but do not retry blindly.
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"Anthropic API error: {exc}",
                retryable=False,
            )

        text_parts: List[str] = []
        reasoning_parts: List[str] = []
        tool_calls: List[ToolCall] = []
        raw_content: List[dict] = []
        for block in response.content:
            if block.type == "fallback":
                # Audit marker of a refusal fallback (may be kept or dropped
                # on replay): dropped, its alias field would not round-trip.
                continue
            # Keep EVERY other block (thinking included) for verbatim replay:
            # the API requires thinking blocks to be echoed back unchanged
            # when continuing the conversation; stripping them 400s the next
            # call.
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
                    ToolCall(id=block.id, name=block.name,
                             arguments=block.input if isinstance(block.input, dict) else {},
                             argument_error=None if isinstance(block.input, dict) else "Tool arguments must be a JSON object.")
                )
        fallback_kind = _fallback_kind(response)
        # Cached tokens are billed separately (cache reads/writes at their own
        # rates) and excluded from input_tokens — tracked for cost estimates.
        usage = _token_usage(response, fallback_kind)
        stop_reason = response.stop_reason or "end_turn"
        if stop_reason not in ("tool_use", "end_turn", "max_tokens", "refusal"):
            stop_reason = "end_turn"
        served = getattr(response, "model", None) or "a fallback model"
        refusal_detail = None
        if stop_reason == "refusal":
            # The harness adds this to its "LLM refusal ..." run note.
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) or "unspecified"
            refusal_detail = f"declined, category: {category}"
            if fallback_kind:
                refusal_detail += f"; the fallback model {served} declined too"
        elif fallback_kind:
            # A note, not the run's model: reporting the fallback model would
            # leave the run unpriced (agent_budget.MODEL_PRICES).
            reasoning_parts.insert(
                0,
                f"Note: {self._config.model} declined this turn (safety classifier); {served} answered it."
                if fallback_kind == "switch"
                else f"Note: answered by {served}; the refusal fallback for {self._config.model} "
                "is still active for this conversation.",
            )
        text = "\n".join(text_parts) or None
        reasoning = "\n".join(reasoning_parts) or None
        if text is None and reasoning is not None:
            # Reasoning-only turn (typical for tool_use turns): promote it to
            # text so the run summary and feed never end up empty. Intended —
            # same contract as the OpenAI adapter; replay uses raw_content.
            text, reasoning = reasoning, None
        return ProviderResponse(
            text=text,
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            error=refusal_detail,
            usage=usage,
            reasoning=reasoning,
            # raw_content wins on replay (thinking blocks must be echoed
            # verbatim); replay_text is the fallback for consistency. An
            # empty content list (end_turn without blocks) becomes None so the
            # replay never sends an empty assistant message (API 400).
            replay_text=text,
            raw_content=raw_content or None,
            output_truncated=stop_reason == "max_tokens",
            fallback_turn=fallback_kind is not None,
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
                        # can attach; the API rejects empty and
                        # whitespace-only text blocks.
                        "content": [{"type": "text", "text": msg.content or "(empty)"}],
                    }
                )
            elif msg.role == "assistant":
                if msg.raw_content:
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
                if not blocks:
                    # The API rejects empty (and whitespace-only) assistant
                    # content on any non-final message.
                    blocks.append({"type": "text", "text": "(no reply)"})
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
