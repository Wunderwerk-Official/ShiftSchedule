"""Deterministic scripted provider for tests.

A script is a list of turns. Each turn is a dict:

    {"text": "optional text",
     "tool_calls": [{"name": "get_violations", "arguments": {...}}, ...]}

A turn with tool_calls yields ``stop_reason="tool_use"``; a turn without
yields ``end_turn``. When the script runs out, ``end_turn`` is returned so a
too-short script terminates the loop instead of hanging it. An optional
``"delay_ms"`` per turn (capped at 3000) simulates LLM latency so the live UI
can be demoed/screenshotted; CI scripts simply omit it.

Failure turns, for testing the harness's retry/skip behavior:

    {"error": "simulated overload", "status": 529}   # retryable (via status)
    {"error": "bad request", "status": 400}          # not retryable
    {"error": "conn reset", "retryable": true}       # explicit, no status
    {"stop_reason": "refusal"}                       # scripted refusal

Without an explicit ``"retryable"``, retryability derives from ``"status"``
through :func:`provider.is_retryable_status`. The script is strictly
sequential: a harness RETRY consumes the NEXT turn — interleave error and
success turns deliberately when scripting recovery scenarios.

Injection paths:
- in-process (unit tests): ``MockProvider(script=[...])`` passed straight to
  ``agent_solve_range(provider=...)``
- cross-process (integration tests through POST /v1/solve/range):
  ``AGENT_PROVIDER=mock`` + ``AGENT_MOCK_SCRIPT=/path/to/script.json`` — env
  vars are inherited by the spawned solver subprocess. Without a script file
  the default behaviour is a single ``get_plan_overview`` call followed by
  ``end_turn`` (i.e. "accept the seed"), so the endpoint works
  deterministically without any file.
"""

from __future__ import annotations

import json
import time
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

DEFAULT_SCRIPT = [
    {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
    {"text": "Seed plan accepted."},
]


class MockProvider(LLMProvider):
    def __init__(self, script: Optional[List[dict]] = None):
        self.script = script if script is not None else DEFAULT_SCRIPT
        self.turn = 0

    @classmethod
    def from_config(cls, config: AgentConfig) -> "MockProvider":
        if config.mock_script_path:
            with open(config.mock_script_path, "r", encoding="utf-8") as fh:
                return cls(json.load(fh))
        return cls()

    def complete(
        self,
        *,
        system: str,
        messages: List[ChatMessage],
        tools: List[ToolSpec],
        timeout_seconds: float,
    ) -> ProviderResponse:
        if self.turn >= len(self.script):
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="end_turn",
                usage={"input_tokens": 0, "output_tokens": 0},
            )
        entry = self.script[self.turn]
        self.turn += 1
        delay_ms = entry.get("delay_ms")
        if isinstance(delay_ms, (int, float)) and delay_ms > 0:
            time.sleep(min(delay_ms, 3000) / 1000.0)
        if "error" in entry:
            status = entry.get("status")
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error",
                usage={"input_tokens": 0, "output_tokens": 0},
                error=str(entry["error"]),
                error_status=status,
                retryable=bool(entry.get("retryable", is_retryable_status(status))),
            )
        if entry.get("stop_reason") == "refusal":
            return ProviderResponse(
                text=entry.get("text"), tool_calls=[], stop_reason="refusal",
                usage={"input_tokens": 0, "output_tokens": 0},
            )
        calls = [
            ToolCall(
                id=f"mock-call-{self.turn}-{idx}",
                name=c["name"],
                arguments=c.get("arguments", {}),
            )
            for idx, c in enumerate(entry.get("tool_calls", []))
        ]
        return ProviderResponse(
            text=entry.get("text"),
            tool_calls=calls,
            stop_reason="tool_use" if calls else "end_turn",
            usage={"input_tokens": 0, "output_tokens": 0},
            replay_text=entry.get("text"),
        )
