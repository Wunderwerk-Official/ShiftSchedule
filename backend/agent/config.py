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
# Keep in sync with agent_budget.DEFAULT_AGENT_MODEL and the frontend default
# in src/lib/llmPricing.ts.
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_MAX_ITERATIONS = 100
DEFAULT_MAX_TOKENS = 16000


@dataclass
class AgentConfig:
    provider: str = DEFAULT_PROVIDER
    model: str = DEFAULT_MODEL
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    max_tokens: int = DEFAULT_MAX_TOKENS
    mock_script_path: Optional[str] = None
    # Credentials / endpoints. None = fall back to the environment. These are
    # SECRETS when set from the admin settings: never put them into payloads,
    # debug dumps, or API responses.
    anthropic_api_key: Optional[str] = None
    openai_base_url: Optional[str] = None
    openai_api_key: Optional[str] = None
    # False = accept self-signed certificates on the OpenAI-compatible
    # endpoint (e.g. an internal vLLM/LiteLLM server on a trusted network).
    openai_verify_tls: bool = True

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
            openai_base_url=(os.environ.get("OPENAI_BASE_URL") or "").strip() or None,
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
            openai_verify_tls=(
                (os.environ.get("OPENAI_VERIFY_TLS") or "true").strip().lower()
                not in ("0", "false", "no")
            ),
        )
