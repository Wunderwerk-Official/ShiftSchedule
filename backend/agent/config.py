"""Agent configuration, read from environment variables at solve time.

Read env at call time (never at import): the solve runs in a spawned
subprocess that inherits ``os.environ``, and tests inject the mock provider
through these variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-opus-4-8"
DEFAULT_MAX_ITERATIONS = 20
DEFAULT_MAX_TOKENS = 8000


@dataclass
class AgentConfig:
    provider: str = DEFAULT_PROVIDER
    model: str = DEFAULT_MODEL
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    max_tokens: int = DEFAULT_MAX_TOKENS
    mock_script_path: Optional[str] = None

    @classmethod
    def from_env(cls) -> "AgentConfig":
        def _int(name: str, default: int) -> int:
            raw = os.environ.get(name)
            try:
                return int(raw) if raw else default
            except ValueError:
                return default

        return cls(
            provider=os.environ.get("AGENT_PROVIDER", DEFAULT_PROVIDER).strip().lower(),
            model=os.environ.get("AGENT_MODEL", DEFAULT_MODEL).strip(),
            max_iterations=_int("AGENT_MAX_ITERATIONS", DEFAULT_MAX_ITERATIONS),
            max_tokens=_int("AGENT_MAX_TOKENS", DEFAULT_MAX_TOKENS),
            mock_script_path=os.environ.get("AGENT_MOCK_SCRIPT") or None,
        )
