"""OpenAI-compatible adapter for the planning agent (vLLM, llama.cpp, TGI,
LM Studio, or the OpenAI API itself).

Maps the provider-neutral protocol in ``provider.py`` onto the Chat
Completions API via the official ``openai`` SDK with a custom ``base_url``.
Differences from the Anthropic adapter, handled here so the harness stays
provider-agnostic:

- Tool calls arrive with ``arguments`` as a JSON STRING (Anthropic: parsed
  dict). Self-hosted models sometimes emit broken JSON — that degrades to an
  empty-arguments call, and the tool executor's own validation produces a
  readable error the model can react to, instead of crashing the run.
- Tool results are one ``role="tool"`` message PER result with a
  ``tool_call_id`` (Anthropic: one user message containing all results).
- No ``cache_control`` / prompt-caching parameters — vLLM does automatic
  prefix caching server-side; cached token counts are read from
  ``usage.prompt_tokens_details.cached_tokens`` when the server reports them.
- No ``thinking`` parameter and no raw-content replay requirement: assistant
  turns are reconstructed from text + tool calls.
- ``finish_reason`` mapping: ``tool_calls``->``tool_use``, ``length``->
  ``max_tokens``, ``content_filter``->``refusal``, ``stop``->``end_turn`` —
  except that a ``stop`` WITH tool calls (some open models do this) is
  treated as ``tool_use`` so the calls still execute.
- API failures never raise: SDK errors map to
  ``ProviderResponse(stop_reason="error")``, and the run degrades to the
  best plan so far. A vLLM server without ``--enable-auto-tool-choice``
  rejects the tools parameter — that surfaces here as a clear error note.
"""

from __future__ import annotations

import json
from typing import List, Optional

from .config import AgentConfig
from .provider import ChatMessage, LLMProvider, ProviderResponse, ToolCall, ToolSpec


def _parse_arguments(raw: object) -> dict:
    """Tool-call arguments defensively parsed. The API contract says JSON
    string, but self-hosted models occasionally emit malformed JSON or the
    server pre-parses it — accept both, degrade to {} instead of raising."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def to_openai_tools(tools: List[ToolSpec]) -> List[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            },
        }
        for t in tools
    ]


def to_openai_messages(system: str, messages: List[ChatMessage]) -> List[dict]:
    out: List[dict] = [{"role": "system", "content": system}]
    for msg in messages:
        if msg.role == "user":
            out.append({"role": "user", "content": msg.content or " "})
        elif msg.role == "assistant":
            entry: dict = {"role": "assistant", "content": msg.content or None}
            if msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": json.dumps(call.arguments),
                        },
                    }
                    for call in msg.tool_calls
                ]
            # The API rejects an assistant turn with neither text nor calls.
            if entry["content"] is None and not msg.tool_calls:
                entry["content"] = " "
            out.append(entry)
        else:  # "tool" — ONE message per result, keyed by tool_call_id
            for result in msg.tool_results:
                out.append(
                    {
                        "role": "tool",
                        "tool_call_id": result.tool_call_id,
                        "content": result.content or "",
                    }
                )
    return out


class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, config: AgentConfig):
        base_url = (config.openai_base_url or "").strip()
        if not base_url:
            raise RuntimeError(
                "No OpenAI-compatible endpoint configured. Set the base URL "
                "(e.g. http://host:8000/v1 for vLLM) in Settings → Solver "
                "(admin) or via the OPENAI_BASE_URL environment variable."
            )
        import openai  # imported lazily: optional unless this provider is used

        self._openai = openai
        client_kwargs: dict = {
            "base_url": base_url,
            # vLLM and friends usually don't check the key, but the SDK
            # requires a non-empty value.
            "api_key": (config.openai_api_key or "not-needed"),
        }
        if not config.openai_verify_tls:
            # Self-signed certificate on an internal endpoint (e.g. a LiteLLM
            # or vLLM server inside the clinic network). Opt-in only.
            import httpx

            client_kwargs["http_client"] = httpx.Client(verify=False)
        self._client = openai.OpenAI(**client_kwargs)
        self._config = config

    def complete(
        self,
        *,
        system: str,
        messages: List[ChatMessage],
        tools: List[ToolSpec],
        timeout_seconds: float,
    ) -> ProviderResponse:
        openai = self._openai
        try:
            # max_retries=0 for the same reason as the Anthropic adapter: the
            # harness sizes timeout_seconds to the remaining wall clock.
            request_kwargs: dict = {
                "model": self._config.model,
                "max_tokens": self._config.max_tokens,
                "messages": to_openai_messages(system, messages),
            }
            if tools:
                # Some servers reject an empty tools array — omit it for
                # plain chat calls (e.g. the admin connection test).
                request_kwargs["tools"] = to_openai_tools(tools)
            response = self._client.with_options(
                timeout=timeout_seconds, max_retries=0
            ).chat.completions.create(**request_kwargs)
        except openai.APIStatusError as exc:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"OpenAI-compatible API error {exc.status_code}: {exc.message}",
            )
        except openai.OpenAIError as exc:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error=f"OpenAI-compatible endpoint unreachable: {exc}",
            )

        if not response.choices:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                error="OpenAI-compatible endpoint returned no choices.",
            )
        choice = response.choices[0]
        message = choice.message
        tool_calls: List[ToolCall] = []
        for call in message.tool_calls or []:
            function = getattr(call, "function", None)
            if function is None or not getattr(function, "name", None):
                continue
            tool_calls.append(
                ToolCall(
                    id=call.id or f"call_{len(tool_calls)}",
                    name=function.name,
                    arguments=_parse_arguments(getattr(function, "arguments", None)),
                )
            )

        usage = {"input_tokens": 0, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        if response.usage is not None:
            usage["input_tokens"] = getattr(response.usage, "prompt_tokens", 0) or 0
            usage["output_tokens"] = getattr(response.usage, "completion_tokens", 0) or 0
            details = getattr(response.usage, "prompt_tokens_details", None)
            cached = getattr(details, "cached_tokens", 0) if details is not None else 0
            usage["cache_read_input_tokens"] = cached or 0

        finish = (choice.finish_reason or "stop").lower()
        if tool_calls:
            # Some open models report finish_reason "stop" although they made
            # tool calls — execute them anyway or the loop stalls.
            stop_reason = "tool_use"
        elif finish == "length":
            stop_reason = "max_tokens"
        elif finish == "content_filter":
            stop_reason = "refusal"
        else:
            stop_reason = "end_turn"

        # Reasoning models put their thoughts into a separate field and only
        # the final answer into content — vLLM's reasoning parsers call it
        # "reasoning_content", LiteLLM proxies call it "reasoning". Surface
        # the chain of thought alongside the answer; a reasoning-only turn
        # (typical for tool calls) promotes the thoughts to text so the live
        # feed and run summary never end up empty.
        text = message.content or None
        reasoning: Optional[str] = None
        for field in ("reasoning_content", "reasoning"):
            candidate = getattr(message, field, None)
            if isinstance(candidate, str) and candidate.strip():
                reasoning = candidate.strip()
                break
        if not text and reasoning:
            text, reasoning = reasoning, None

        return ProviderResponse(
            text=text,
            tool_calls=tool_calls,
            stop_reason=stop_reason,
            usage=usage,
            reasoning=reasoning,
            raw_content=None,  # no replay requirement on this API
        )
