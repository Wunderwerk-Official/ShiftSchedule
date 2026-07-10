"""Provider-neutral LLM protocol for the planning agent.

The harness talks to LLM backends exclusively through these dataclasses and
the :class:`LLMProvider` interface — no SDK types leak into the loop. Adding a
new backend (OpenAI, a local model via Ollama, ...) means writing one adapter
that maps this protocol onto that SDK and registering it in
:func:`get_provider`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

from .config import AgentConfig


@dataclass
class ToolSpec:
    """A tool the model may call. ``input_schema`` is JSON Schema."""

    name: str
    description: str
    input_schema: dict


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class ToolResult:
    tool_call_id: str
    content: str  # compact JSON string
    is_error: bool = False


@dataclass
class ChatMessage:
    """One conversation turn.

    - role "user": plain text in ``content``
    - role "assistant": optional ``content`` text plus ``tool_calls``
    - role "tool": ``tool_results`` answering the preceding assistant turn

    ``raw_content`` is an opaque, provider-specific copy of the assistant
    turn's content blocks (e.g. Anthropic thinking blocks). Providers that
    produced it replay it verbatim; other providers ignore it. Without it,
    thinking blocks would be stripped from replayed assistant turns, which
    the Anthropic API rejects with a 400 on the next request.
    """

    role: Literal["user", "assistant", "tool"]
    content: Optional[str] = None
    tool_calls: List[ToolCall] = field(default_factory=list)
    tool_results: List[ToolResult] = field(default_factory=list)
    raw_content: Optional[List[dict]] = None


@dataclass
class ProviderResponse:
    text: Optional[str]
    tool_calls: List[ToolCall]
    # "tool_use" | "end_turn" | "max_tokens" | "refusal" | "error"
    stop_reason: str
    usage: Dict[str, int] = field(default_factory=dict)  # input_tokens/output_tokens
    error: Optional[str] = None  # set when stop_reason == "error"
    # Chain of thought of reasoning models (Anthropic thinking blocks, vLLM
    # reasoning_content, LiteLLM reasoning) when it accompanies answer text.
    # When a turn has ONLY reasoning, adapters put it into ``text`` instead so
    # the run summary and feed never end up empty.
    reasoning: Optional[str] = None
    # What to REPLAY as the assistant turn's content in the next request:
    # the true answer content only, never promoted reasoning (feeding chains
    # of thought back in balloons the context — ~25k input tokens/turn on
    # self-hosted reasoning models — and Qwen explicitly advises against it).
    replay_text: Optional[str] = None
    # Opaque provider content blocks for replaying this assistant turn
    # verbatim (see ChatMessage.raw_content).
    raw_content: Optional[List[dict]] = None


class LLMProvider(ABC):
    """One request/response exchange with an LLM backend.

    Implementations must be safe to construct and use inside the solver
    subprocess (no shared state with the parent process) and must NEVER raise
    from :meth:`complete` for API-level failures — map them to
    ``ProviderResponse(stop_reason="error", error=...)`` so the harness has a
    single failure path.
    """

    @abstractmethod
    def complete(
        self,
        *,
        system: str,
        messages: List[ChatMessage],
        tools: List[ToolSpec],
        timeout_seconds: float,
    ) -> ProviderResponse: ...


def get_provider(config: AgentConfig) -> LLMProvider:
    """Resolve the configured provider. Raises ValueError for unknown names
    and RuntimeError when the provider cannot be constructed (e.g. missing
    API key) — callers degrade to the seed plan on failure."""
    if config.provider == "anthropic":
        from .anthropic_provider import AnthropicProvider

        return AnthropicProvider(config)
    if config.provider == "openai":
        from .openai_provider import OpenAICompatibleProvider

        return OpenAICompatibleProvider(config)
    if config.provider == "mock":
        from .mock_provider import MockProvider

        return MockProvider.from_config(config)
    raise ValueError(f"Unknown AGENT_PROVIDER: {config.provider!r}")
