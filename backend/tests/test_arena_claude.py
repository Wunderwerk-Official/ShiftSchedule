"""Arena plumbing for Claude comparisons: provider/effort overrides, cost
and the comparison gate (no saved settings are touched)."""
from __future__ import annotations

import pytest

from backend.agent.config import AgentConfig
from backend.arena.run import apply_llm_overrides, comparison_problems, cost_report


@pytest.mark.parametrize("raw, expected", [
    ("medium", "medium"), (" XHIGH ", "xhigh"), ("", None), ("turbo", None), (None, None),
])
def test_claude_effort_comes_from_the_environment(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("AGENT_ANTHROPIC_EFFORT", raising=False)
    else:
        monkeypatch.setenv("AGENT_ANTHROPIC_EFFORT", raw)
    assert AgentConfig.from_env().anthropic_effort == expected


def test_one_effort_flag_serves_both_providers():
    claude = apply_llm_overrides(AgentConfig(provider="anthropic", model="claude-opus-5-5"),
                                 model="claude-sonnet-5-5", reasoning_effort="low")
    assert (claude.model, claude.anthropic_effort, claude.reasoning_effort) == ("claude-sonnet-5-5", "low", None)
    # --effort (xhigh/max) wins over --reasoning-effort on Claude.
    claude = apply_llm_overrides(AgentConfig(provider="anthropic"), effort="max", reasoning_effort="low")
    assert claude.anthropic_effort == "max"
    qwen = apply_llm_overrides(AgentConfig(provider="openai", model="Qwen/Qwen3.5-122B"),
                               model=None, reasoning_effort="high")
    assert (qwen.model, qwen.reasoning_effort, qwen.anthropic_effort) == ("Qwen/Qwen3.5-122B", "high", None)


def test_cost_report_prices_claude_runs_and_leaves_self_hosted_unpriced():
    agent = {"input_tokens": 1_000_000, "output_tokens": 100_000,
             "cache_read_input_tokens": 2_000_000, "cache_creation_input_tokens": 0, "fallback_turns": 1}
    report = cost_report("claude-opus-5-5", agent)
    # Opus 5.5: 4 in + 2 out + 2M cache reads at $0.20 = 0.4
    assert report["cost_usd"] == pytest.approx(6.4)
    assert report["fallback_turns"] == 1
    assert cost_report("claude-sonnet-5-5", agent)["cost_usd"] == pytest.approx(3.4)
    assert cost_report("Qwen/Qwen3.5-122B", agent)["cost_usd"] is None


def test_only_clean_model_runs_count_in_a_comparison():
    clean = {"result_producer": "agent", "model": "claude-opus-5-5",
             "model_usage": {"claude-opus-5-5": {}}, "fallback_turns": 0}
    assert comparison_problems(clean, "claude-opus-5-5") == []
    problems = comparison_problems(
        {**clean, "result_producer": "heuristic", "fallback": "budget", "fallback_turns": 2,
         "daysSkipped": ["2026-02-03"]},
        "claude-opus-5-5",
    )
    assert len(problems) == 4
    assert comparison_problems(clean, "claude-sonnet-5-5") == ["model selection changed"]
