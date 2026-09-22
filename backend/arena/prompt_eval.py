"""Isolated prompt experiments. Shipped over stdin; never changes saved settings.

The ordinary deployed harness, tools and fixture remain the experimental
control. Only the named prompt variant changes inside this Python process.
"""
import argparse
from collections import Counter
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import threading
import time

from backend.agent import harness, tools as agent_tools
from backend.agent.config import AgentConfig
from backend.agent.provider import LLMProvider, get_provider
from backend.agent.tools import PlanToolExecutor
from backend.agent_budget import resolve_agent_runtime_config
from backend.arena.run import FIXTURE, apply_scenario, load_state
from backend.models import Assignment, SolveRangeRequest
from backend.scoring import plan_stats


QUALITY_GUIDANCE = """
QUALITY CHECK FOR OPTIONAL HANDOVERS:
Legal is different from better. A pre-validated balance offer guarantees
hard-rule legality, NOT improvement of the snapshot that will be returned.
The strict priority order is: repairable hard violations, open required
positions, short days, soft if/then rules, weekly-hours deviation, then
preferences. Lower tiers never compensate for a worse higher tier.
Before an OPTIONAL balance or fairness swap, use apply_moves(dry_run=true)
once and compare quality_after with quality_of_best_snapshot from your
latest verification. Apply if it improves the first differing tier, or
ties every tier and serves a specific admin wish or fairness goal. Do not
dry-run ordinary construction blocks that fill open positions.
If an applied batch warns WORSE than the best snapshot, undo that batch
(inverse moves together) before choosing another option. Do not repeat a
transfer you already rejected or reversed in this conversation. When the
remaining offers only worsen the saved plan, report that reason and stop
reviewing; do not keep cycling until no legal offers exist.
"""

PIPELINE_GUIDANCE = """
TOOL-CALL EXAMPLE (two actual calls in ONE assistant response):
If the latest suggestion offers clinician D1 a block [K1, K2], your next
response contains these calls in order, using the actual returned names
and slot keys instead of these placeholders:
  apply_moves({"moves":[{"action":"assign","slot_key":"K1","clinicianId":"D1"},
                         {"action":"assign","slot_key":"K2","clinicianId":"D1"}]})
  suggest_day_blocks({"dateISO":"the current date"})
The harness executes them sequentially, so the second sees the first's
result. Submit both calls together; do not wait a separate model turn to
request the next suggestion. If multiple calls are unavailable, apply the
whole block first and request the next suggestion on the following turn.
Do not add prose restating candidate lists or narrating the next action.
"""


def prompt_variant(name):
    day, review = harness.DAY_SYSTEM_PROMPT, harness.REVIEW_SYSTEM_PROMPT
    if name == "focused":
        # v1.54 promotes the pipeline example and skips duplicate orientation.
        # Keep this evaluator usable with both old and updated deployments.
        if "1. get_day_priorities ONCE" in day:
            begin = day.index("1. get_day_priorities ONCE")
            end = day.index("2. suggest_day_blocks", begin)
            day = day[:begin] + (
                "1. The initial digest already lists this day's priorities. Start\n"
                "   directly with step 2; do not spend an extra orientation round\n"
                "   re-reading those same priorities.\n"
            ) + day[end:]
        if "TOOL-CALL EXAMPLE" not in day:
            day += "\n" + PIPELINE_GUIDANCE
        day += "\n" + QUALITY_GUIDANCE
        review += "\n" + QUALITY_GUIDANCE
    return day, review


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-02-02")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=1200)
    parser.add_argument("--model", default="nvidia/Qwen3.8-Flash-Next-NVFP4")
    parser.add_argument("--scenario", choices=["base", "vacation-wave", "understaffed", "crunch", "oncall", "pinned", "daynight", "fixed-patterns"], default="base")
    parser.add_argument("--strategy", choices=["day_by_day", "repair"], default="day_by_day")
    parser.add_argument("--variant", choices=["baseline", "focused"], default="baseline")
    parser.add_argument("--reasoning-effort", choices=["low", "medium", "high"], default=None)
    parser.add_argument("--mock", action="store_true", help="Exercise tracing without an endpoint or settings access")
    parser.add_argument("--evaluation-ref", default="local")
    parser.add_argument("--quality-profile", choices=["classic", "balanced"], default="classic")
    parser.add_argument("--neighborhood", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.days <= 7 or not 1 <= args.timeout <= 3600:
        parser.error("Use 1–7 days and a 1–3600 second budget")

    config = AgentConfig(provider="mock") if args.mock else resolve_agent_runtime_config(AgentConfig.from_env())
    config.model = args.model
    # A named-model comparison must never silently measure a replacement.
    config.allow_model_fallback = False
    config.reasoning_effort = args.reasoning_effort  # None is the full/default control.
    if not args.mock and config.provider != "openai":
        raise SystemExit("The experiment requires the configured self-hosted provider")
    secrets = [v for v in (config.openai_api_key, config.anthropic_api_key) if v]

    def emit(kind, data):
        line = json.dumps(data, ensure_ascii=False)
        for secret in secrets:
            line = line.replace(secret, "[REDACTED]")
        print(f"PROMPT_EVAL_{kind} {line}", flush=True)

    state = load_state()
    state.solverSettings.update(agentQualityProfile=args.quality_profile,
                               agentNeighborhoodSearch=args.neighborhood)
    end = (date.fromisoformat(args.start) + timedelta(days=args.days - 1)).isoformat()
    scenario_desc = apply_scenario(state, args.scenario, args.start, end)
    day, review = prompt_variant(args.variant)
    hashes = {name: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
              for name, module in (("harness", harness), ("tools", agent_tools))}
    hashes["fixture"] = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    fixture_version = json.loads(FIXTURE.read_text()).get("fixtureVersion", "legacy-export-v1")
    hashes["day_prompt"] = hashlib.sha256(day.encode()).hexdigest()
    hashes["review_prompt"] = hashlib.sha256(review.encode()).hexdigest()
    emit("META", {"variant": args.variant, "evaluation_ref": args.evaluation_ref, "fixture_version": fixture_version,
                  "start": args.start, "days": args.days, "scenario": args.scenario,
                  "scenario_desc": scenario_desc, "model": config.model,
                  "allow_model_fallback": config.allow_model_fallback,
                  "reasoning": config.reasoning_effort or "endpoint-default/full",
                  "timeout": args.timeout, "hashes": hashes})

    started = time.monotonic()
    tool_counts = Counter()
    timings = Counter()
    top_level_tool_seconds = 0.0
    tool_depth = 0
    calls = []
    executors = []
    regressions = []
    inspection_streak = 0
    longest_inspection_streak = 0

    class TracedExecutor(PlanToolExecutor):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.fixed_before = [a.model_dump() for a in self.fixed_assignments]
            executors.append(self)

        def execute(self, name, arguments, call_id, **kwargs):
            nonlocal inspection_streak, longest_inspection_streak, top_level_tool_seconds, tool_depth
            before = time.monotonic()
            tool_depth += 1
            try:
                result = super().execute(name, arguments, call_id, **kwargs)
            finally:
                elapsed = time.monotonic() - before
                tool_depth -= 1
                if tool_depth == 0:
                    top_level_tool_seconds += elapsed
            tool_counts[name] += 1
            timings[name] += elapsed
            payload = json.loads(result.content)
            if name in ("apply_moves", "apply_proposal") and payload.get("applied"):
                inspection_streak = 0
                if "WORSE" in payload.get("note", ""):
                    regressions.append(self.current_iteration)
            else:
                inspection_streak += 1
                longest_inspection_streak = max(longest_inspection_streak, inspection_streak)
            emit("TOOL", {"iteration": self.current_iteration, "name": name,
                          "arguments": arguments, "seconds": round(elapsed, 3),
                          "best_quality": self.quality_dict(self.best_quality), "result": payload})
            return result

    class TracedProvider(LLMProvider):
        def __init__(self, delegate):
            self.delegate = delegate

        def complete(self, **kwargs):
            before = time.monotonic()
            self.delegate.cancel_event = self.cancel_event
            response = self.delegate.complete(**kwargs)
            row = {"call": len(calls) + 1, "phase": "day" if kwargs["system"] == day else "review" if kwargs["system"] == review else "duty_or_repair",
                   "seconds": round(time.monotonic() - before, 3),
                   "tools": [c.name for c in response.tool_calls], "stop_reason": response.stop_reason,
                   "usage": response.usage, "reply": response.replay_text, "error": response.error,
                   "model": getattr(response, "model", None),
                   "model_selection": getattr(response, "model_selection", None)}
            calls.append(row)
            emit("CALL", row)
            return response

    original = (harness.PlanToolExecutor, harness.DAY_SYSTEM_PROMPT, harness.REVIEW_SYSTEM_PROMPT)
    harness.PlanToolExecutor, harness.DAY_SYSTEM_PROMPT, harness.REVIEW_SYSTEM_PROMPT = TracedExecutor, day, review
    try:
        result = harness.agent_solve_range(
            SolveRangeRequest(startISO=args.start, endISO=end, only_fill_required=True,
                              timeout_seconds=args.timeout, solver_mode="agent", agent_strategy=args.strategy),
            state, threading.Event(), lambda *_: None, time.time(),
            provider=TracedProvider(get_provider(config)), config=config,
        )
    finally:
        harness.PlanToolExecutor, harness.DAY_SYSTEM_PROMPT, harness.REVIEW_SYSTEM_PROMPT = original
    agent = (result.get("debugInfo") or {}).get("agent") or {}
    executor = executors[-1] if executors else None
    returned = [Assignment.model_validate(a) for a in result.get("assignments") or []]
    stats = plan_stats(executor.ctx, returned).model_dump() if executor else None
    fallback = agent.get("fallback") or (result.get("debugInfo") or {}).get("solver_status") == "AGENT_FALLBACK_SEED"
    report = {"variant": args.variant, "start": args.start, "days": args.days,
              "fixture_version": fixture_version,
              "quality_version": agent.get("quality_version"), "completion": agent.get("completion"),
              "final_audit": agent.get("final_audit"),
              "quality_profile": args.quality_profile, "neighborhood": args.neighborhood,
              "scenario": args.scenario, "model": agent.get("model"), "requested_model": config.model,
              "model_selection": agent.get("model_selection"), "model_usage": agent.get("model_usage"),
              "duration_seconds": round(time.monotonic() - started, 1),
              "stop_reason": agent.get("stopReason"), "days_planned": agent.get("daysPlanned"),
              "result_producer": agent.get("result_producer"), "fallback": fallback or None,
              "days_incomplete": agent.get("daysIncomplete"), "days_skipped": agent.get("daysSkipped"),
              "iterations": agent.get("iterations"), "moves_accepted": agent.get("moves_accepted"),
              "moves_rejected": agent.get("moves_rejected"), "input_tokens": agent.get("input_tokens"),
              "output_tokens": agent.get("output_tokens"), "tok_per_s": agent.get("output_tokens_per_second"),
              "stats": stats, "best_quality": executor.quality_dict(executor._quality(returned)) if executor else None,
              "new_hard_violations": sum(executor._is_new_hard(v) for v in executor._hard_violations(executor._full_plan(returned))) if executor else None,
              "unsolved": agent.get("unsolved"), "violations_summary": (agent.get("violations_final") or ["unavailable"])[0],
              "tool_counts": dict(tool_counts), "tool_seconds": {k: round(v, 2) for k, v in timings.items()},
              "multi_tool_calls": sum(len(c["tools"]) > 1 for c in calls),
              "calls_by_phase": dict(Counter(c["phase"] for c in calls)),
              "quality_regression_iterations": regressions, "longest_inspection_streak": longest_inspection_streak,
              "notes": result.get("notes"), "hashes": hashes}
    report["top_level_tool_seconds"] = round(top_level_tool_seconds, 3)
    report["model_seconds"] = round(sum(c["seconds"] for c in calls), 3)
    report["fixed_unchanged"] = [a.model_dump() for a in executor.fixed_assignments] == executor.fixed_before if executor else None
    if executor and hasattr(getattr(executor, "workflow", None), "direct_checks"):
        report["candidate_validation_cache"] = {
            "hits": executor.workflow.direct_check_hits,
            "misses": executor.workflow.direct_check_misses,
        }
    emit("REPORT", report)
    emit("PLAN", {"assignments": result.get("assignments"), "start": args.start, "end": end})
    if not agent or fallback or any(c["stop_reason"] == "error" for c in calls):
        raise SystemExit("Model errors/fallback detected; do not count this as a successful prompt comparison")
    if (report["model"] != config.model
            or any(model != config.model for model in (report["model_usage"] or {}))):
        raise SystemExit("Model selection changed; do not count this as a comparison of the requested model")
    if report["new_hard_violations"] or not report["fixed_unchanged"]:
        raise SystemExit("Guardrail regression detected: new hard violations or modified fixed context")


if __name__ == "__main__":
    main()
