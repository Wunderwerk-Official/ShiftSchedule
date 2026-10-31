"""Arena plumbing for Claude comparisons: provider/effort overrides, cost
and the comparison gate (no saved settings are touched)."""
from __future__ import annotations

import pytest

import threading

from backend.agent.config import AgentConfig
from backend.arena.run import (
    RunGuard,
    apply_llm_overrides,
    clamp_call_timeout,
    comparison_problems,
    cost_report,
    reported_effort,
)


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


def test_an_effort_the_request_would_not_carry_is_refused():
    # Haiku 4.5 has no adaptive thinking: the API takes no effort for it.
    with pytest.raises(SystemExit):
        apply_llm_overrides(AgentConfig(provider="anthropic", model="claude-haiku-4-5"), effort="low")
    # xhigh/max are Claude-only; the self-hosted endpoint knows low/medium/high.
    with pytest.raises(SystemExit):
        apply_llm_overrides(AgentConfig(provider="openai", model="Qwen/Qwen3.5-122B"), effort="max")
    plain = apply_llm_overrides(AgentConfig(provider="anthropic", model="claude-haiku-4-5"))
    assert plain.anthropic_effort is None
    # low/medium/high via --effort reach the self-hosted endpoint as well.
    qwen = apply_llm_overrides(AgentConfig(provider="openai", model="Qwen/Qwen3.5-122B"), effort="high")
    assert qwen.reasoning_effort == "high"


def test_the_report_names_the_effort_that_is_sent():
    # Opus 5.5 without an override still sends its explicit "medium".
    assert reported_effort(AgentConfig(provider="anthropic", model="claude-opus-5-5")) == "medium"
    assert reported_effort(AgentConfig(provider="anthropic", model="claude-opus-5-5",
                                       anthropic_effort="low")) == "low"
    assert reported_effort(AgentConfig(provider="anthropic", model="claude-sonnet-5")) is None
    assert reported_effort(AgentConfig(provider="openai", reasoning_effort="high",
                                       anthropic_effort="max")) == "high"


def test_a_day_the_model_skipped_makes_the_run_invalid_even_when_the_audit_filled_it():
    clean = {"result_producer": "agent", "model": "m", "daysSkipped": [], "modelDaysSkipped": []}
    assert comparison_problems(clean, "m") == []
    filled = {**clean, "modelDaysSkipped": ["2026-02-03"]}
    assert comparison_problems(filled, "m") == [
        "days the model skipped (filled by the final audit): 2026-02-03"
    ]
    # A day still skipped is named once, under daysSkipped.
    still = {**clean, "daysSkipped": ["2026-02-03"], "modelDaysSkipped": ["2026-02-03"]}
    assert comparison_problems(still, "m") == ["daysSkipped: 2026-02-03"]


def test_the_run_guard_aborts_on_a_deployment_drain(tmp_path):
    marker = tmp_path / ".planning-drain"
    cancel = threading.Event()
    with RunGuard(cancel, marker=marker, poll_seconds=0.01) as guard:
        assert not cancel.wait(0.05)
        marker.touch()
        assert cancel.wait(2)
    assert "deployment" in guard.reason


def test_the_run_guard_aborts_at_the_hard_limit_and_stays_quiet_otherwise(tmp_path):
    cancel = threading.Event()
    with RunGuard(cancel, hard_limit_seconds=0.05, poll_seconds=0.01) as guard:
        assert cancel.wait(2)
    assert "hard limit" in guard.reason
    quiet = threading.Event()
    with RunGuard(quiet, marker=tmp_path / "absent", hard_limit_seconds=60, poll_seconds=0.01) as guard:
        pass
    assert not quiet.is_set() and guard.reason is None


def test_a_model_call_near_the_hard_limit_ends_within_the_grace():
    assert clamp_call_timeout(1200.0, None, 0.0, 60.0) == 1200.0
    assert clamp_call_timeout(1200.0, 10_000.0, 0.0, 60.0) == 1200.0
    # 5 minutes before the limit: the call may run 5 minutes + grace.
    assert clamp_call_timeout(1200.0, 10_000.0, 9_700.0, 60.0) == 360.0
    # Past the limit (the abort is pending): a short floor, never negative.
    assert clamp_call_timeout(1200.0, 10_000.0, 10_100.0, 60.0) == 10.0
