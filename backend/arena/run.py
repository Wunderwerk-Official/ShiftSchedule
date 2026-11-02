"""Agent test arena: run the agent solver against a hard, realistic state
and print comparable metrics.

Fixture synthetic-v3 generates 24 fictitious clinicians and calendars around
a retained scheduling structure: 35 rows (33 sections and two pools), 163
weekly template slots and four locations. No original personnel data is used.

Runs IN-PROCESS against whatever provider the environment / admin settings
resolve to (same path as the real solver), so executing it inside the
production backend container benchmarks the actual self-hosted model:

    python -m backend.arena.run --start 2026-02-02 --days 1 --timeout 600

No HTTP, no writes: state comes from the fixture, results go to stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
import time
from datetime import date, timedelta
from multiprocessing import Event
from pathlib import Path

from ..agent.anthropic_provider import effective_effort, supports_adaptive_thinking
from ..agent.config import ANTHROPIC_EFFORTS, AgentConfig
from ..agent.harness import agent_solve_range
from ..agent_budget import estimate_cost_usd, model_price, resolve_agent_runtime_config
from ..models import AppState, SolveRangeRequest

FIXTURE = Path(__file__).with_name("fixture_complex.json")


def load_state() -> AppState:
    return AppState.model_validate(json.loads(FIXTURE.read_text())["state"])


def _add_vacation(state: AppState, clinician_id: str, start_iso: str, end_iso: str) -> None:
    from ..models import VacationRange

    for c in state.clinicians:
        if c.id == clinician_id:
            c.vacations = list(c.vacations or []) + [
                VacationRange(id=f"arena-vac-{clinician_id}", startISO=start_iso, endISO=end_iso)
            ]


def apply_scenario(state: AppState, scenario: str, start_iso: str, end_iso: str) -> str:
    """Deterministically transform the fixture into a harder case. Returns a
    human-readable description of what was changed."""
    if scenario == "base":
        return "synthetic-v3 roster, generated history and vacations; unchanged calendar structure"

    # Stable clinician order so the scenario is reproducible.
    ids = [c.id for c in state.clinicians]

    if scenario == "fixed-patterns":
        # Same saved duties, now explicitly fixed despite solver provenance.
        # No real user's preferences or calendar are changed by arena fixtures.
        from ..models import WorkPattern
        on_call = state.solverSettings.get("onCallRestClassId")
        blocks = {b.id for b in state.weeklyTemplate.blocks if b.sectionId == on_call}
        slots = {s.id for loc in state.weeklyTemplate.locations for s in loc.slots if s.blockId in blocks}
        count = 0
        for a in state.assignments:
            if a.rowId in slots:
                a.source, a.locked = "solver", True
                count += 1
        for c in state.clinicians:
            hours = c.workingHoursPerWeek
            if hours and hours > 0:
                days = 2.5 if hours <= 24 else 5
                c.workPattern = WorkPattern(daysPerWeek=days, dailyHours=hours/days, dailyHoursTolerance=1)
        return f"{count} existing duties explicitly fixed; synthetic fractional/full-time work-pattern preferences"

    if scenario == "vacation-wave":
        # Five clinicians (every 4th) on vacation across the whole range:
        # forces the agent to re-cover their slots with a thinner roster.
        hit = ids[::4][:5]
        for cid in hit:
            _add_vacation(state, cid, start_iso, end_iso)
        # A scenario absence cancels that person's bookings in the range;
        # leaving locked duties would inject an unrepairable contradiction.
        state.assignments = [a for a in state.assignments
                             if not (a.clinicianId in hit and start_iso <= a.dateISO <= end_iso)]
        return f"{len(hit)} clinicians on vacation for the whole range"

    if scenario == "understaffed":
        # Drop the four clinicians with the most qualifications (the most
        # flexible ones) — simulates several key people calling in sick, so
        # scarce sections lose their usual cover.
        ranked = sorted(
            state.clinicians, key=lambda c: len(c.qualifiedClassIds or []), reverse=True
        )
        drop = {c.id for c in ranked[:4]}
        names = [c.name for c in ranked[:4]]
        state.clinicians = [c for c in state.clinicians if c.id not in drop]
        state.assignments = [a for a in state.assignments if a.clinicianId not in drop]
        return f"removed 4 most-flexible clinicians: {', '.join(names)}"

    if scenario == "crunch":
        # Sick calls on TOP of whatever vacations the range already has: the
        # two most-flexible clinicians who are NOT on vacation drop out for
        # the whole range. The generated scarcity week (start 2026-02-16)
        # has nine synthetic clinicians on vacation before this transform.
        def on_vacation(c) -> bool:
            return any(
                v.startISO <= end_iso and v.endISO >= start_iso
                for v in (c.vacations or [])
            )

        available = sorted(
            (
                c
                for c in state.clinicians
                if (c.qualifiedClassIds or []) and not on_vacation(c)
            ),
            key=lambda c: len(c.qualifiedClassIds or []),
            reverse=True,
        )
        drop = {c.id for c in available[:2]}
        names = [c.name for c in available[:2]]
        state.clinicians = [c for c in state.clinicians if c.id not in drop]
        state.assignments = [a for a in state.assignments if a.clinicianId not in drop]
        return (
            "2 most-flexible clinicians NOT on vacation are sick for the "
            f"whole range: {', '.join(names)}"
        )

    if scenario == "oncall":
        # The base template keeps on-call at requiredSlots=0 with generated
        # fixed duty cover. This scenario makes it the agent's job:
        # every on-call template slot requires 1 person, and the range's
        # existing on-call assignments are cleared so nothing is pre-covered.
        # Hard because of the rest-day rule: each on-call consumes the
        # clinician's neighbouring days too.
        on_call_class = (state.solverSettings or {}).get("onCallRestClassId")
        if not on_call_class:
            raise SystemExit("fixture has no onCallRestClassId configured")
        on_call_blocks = {
            b.id for b in state.weeklyTemplate.blocks if b.sectionId == on_call_class
        }
        on_call_slot_ids = set()
        for location in state.weeklyTemplate.locations:
            for slot in location.slots:
                if slot.blockId in on_call_blocks:
                    slot.requiredSlots = 1
                    on_call_slot_ids.add(slot.id)
        state.assignments = [
            a
            for a in state.assignments
            if not (a.rowId in on_call_slot_ids and start_iso <= a.dateISO <= end_iso)
        ]
        # Synthetic fixed duties use a dated +1 target while the base
        # template stays optional. Do not double that target when the
        # scenario makes the template itself require one clinician.
        state.slotOverridesByKey = {
            key: value for key, value in state.slotOverridesByKey.items()
            if not (key.rsplit("__", 1)[0] in on_call_slot_ids
                    and start_iso <= key.rsplit("__", 1)[-1] <= end_iso)
        }
        return (
            f"on-call duty is required (1 person, {len(on_call_slot_ids)} "
            "template slots); in-range on-call assignments cleared"
        )

    if scenario == "pinned":
        # Immutable anchor bookings: on each day of the range the two
        # most-flexible AVAILABLE clinicians are pre-booked (manual, fixed)
        # on the day's two lowest-priority required slots — the "the boss
        # has an evening meeting" situation. The agent must plan around the
        # anchors and extend their days instead of colliding with them.
        from ..models import Assignment
        from ..scoring import build_scoring_context
        from ..validation import validate_assignments

        ctx = build_scoring_context(state, start_iso, end_iso, only_fill_required=True)

        def on_vacation_day(c, date_iso: str) -> bool:
            return any(
                v.startISO <= date_iso <= v.endISO for v in (c.vacations or [])
            )

        pins = []
        for date_iso in ctx.target_day_isos:
            day_insts = sorted(
                (
                    i
                    for i in ctx.instances.values()
                    if i.date_iso == date_iso and i.target > 0
                ),
                key=lambda i: (i.order_weight, i.start),
            )
            used: set = set()
            pinned_here = 0
            for inst in day_insts:
                if pinned_here >= 2:
                    break
                candidates = sorted(
                    (
                        c
                        for c in state.clinicians
                        if c.id not in used
                        and inst.section_id in (c.qualifiedClassIds or [])
                        and not on_vacation_day(c, date_iso)
                    ),
                    key=lambda c: len(c.qualifiedClassIds or []),
                    reverse=True,
                )
                if not candidates:
                    continue
                for candidate in candidates:
                    pin = Assignment(
                        id=f"arena-pin-{inst.slot_id}-{date_iso}",
                        rowId=inst.slot_id,
                        dateISO=date_iso,
                        clinicianId=candidate.id,
                        source="manual",
                    )
                    if validate_assignments(state, list(state.assignments) + pins + [pin]).is_valid:
                        pins.append(pin)
                        used.add(candidate.id)
                        pinned_here += 1
                        break
        state.assignments = list(state.assignments) + pins
        return (
            f"{len(pins)} immutable anchor bookings: most-flexible available "
            "clinicians pre-booked on each day's lowest-priority slots"
        )

    if scenario == "daynight":
        # The production trap: the weekend on-call is ONE day duty
        # 08:00-20:00 plus ONE night duty 20:00-08:00(+1) on the same day —
        # and a naive solver put the SAME person on both (a 24h shift).
        # Builds on the oncall scenario (all duties required, in-range
        # cover cleared), then splits the weekend/holiday duty in two.
        import copy

        desc = apply_scenario(state, "oncall", start_iso, end_iso)
        on_call_class = (state.solverSettings or {}).get("onCallRestClassId")
        on_call_blocks = {
            b.id for b in state.weeklyTemplate.blocks if b.sectionId == on_call_class
        }
        added = 0
        for location in state.weeklyTemplate.locations:
            night_slots = []
            for slot in location.slots:
                # Weekend/holiday duties carry no times in the template
                # (all-day); give them the real day-duty times and clone a
                # night duty next to each.
                if slot.blockId in on_call_blocks and not slot.startTime:
                    slot.startTime, slot.endTime, slot.endDayOffset = (
                        "08:00",
                        "20:00",
                        0,
                    )
                    night = copy.deepcopy(slot)
                    night.id = f"{slot.id}-night"
                    night.startTime, night.endTime, night.endDayOffset = (
                        "20:00",
                        "08:00",
                        1,
                    )
                    night_slots.append(night)
                    added += 1
            location.slots.extend(night_slots)
        return desc + f"; weekend on-call split into day+night duty ({added} night slots added)"

    raise SystemExit(f"unknown scenario: {scenario!r}")


PROVIDER_CHOICES = ("configured", "openai", "anthropic")


def resolve_arena_config(provider="configured"):
    """The saved runtime config, optionally for the other saved provider
    (its own key and model); the saved settings stay unchanged."""
    override = None if provider in (None, "configured") else provider
    return resolve_agent_runtime_config(AgentConfig.from_env(), provider_override=override)


def apply_llm_overrides(config, *, model=None, effort=None, reasoning_effort=None):
    """Arena-only model/effort overrides of the resolved config. One effort
    flag serves both providers: low/medium/high are also Claude effort
    levels; xhigh/max exist on Claude only. An effort the request would not
    carry is refused, so a report never names an effort that was not sent."""
    if model:
        config.model = model
    if config.provider == "anthropic":
        requested = effort or reasoning_effort
        if requested and not supports_adaptive_thinking(config.model):
            raise SystemExit(f"{config.model} takes no effort setting; leave the effort empty")
        config.anthropic_effort = requested
        config.reasoning_effort = None
    else:
        if effort in ("xhigh", "max"):
            raise SystemExit(f"effort {effort} exists on Claude only; "
                             "the self-hosted model takes low, medium or high")
        config.reasoning_effort = effort or reasoning_effort
    return config


def reported_effort(config):
    """The effort the run's requests carry (Claude: the override or the
    model's explicit default, e.g. Opus 5.5 medium; None = API/endpoint default)."""
    if config.provider == "anthropic":
        return effective_effort(config.model, config.anthropic_effort)
    return config.reasoning_effort


def clamp_call_timeout(timeout_seconds, hard_deadline, now, grace_seconds):
    """A model call may not outlive the hard limit by more than the grace:
    the harness only sees the abort once the running call returns."""
    if hard_deadline is None:
        return timeout_seconds
    return max(10.0, min(timeout_seconds, hard_deadline + grace_seconds - now))


def drain_marker() -> Path:
    """The marker a deployment creates while it waits for planning to end."""
    return Path(os.environ.get("SCHEDULE_DB_PATH", "schedule.db")).with_name(".planning-drain")


class RunGuard:
    """Ends an arena run through the harness's abort path when a deployment
    drain starts or a hard wall-clock limit passes. The deploy waits for
    arena processes too (scripts/count_planning_processes.py), so a run of
    several hours would otherwise keep planning closed and fail the deploy.
    A guarded abort makes the run invalid for comparisons (``reason``)."""

    def __init__(self, cancel_event, *, marker=None, hard_limit_seconds=None, poll_seconds=10.0):
        self.cancel_event = cancel_event
        self.marker = marker
        self.hard_limit_seconds = hard_limit_seconds
        self.poll_seconds = poll_seconds
        self.reason = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._watch, daemon=True)

    def __enter__(self):
        self._started = time.monotonic()
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._thread.join(timeout=5)

    def _watch(self):
        while not self._stop.wait(self.poll_seconds):
            if self.marker is not None and self.marker.exists():
                self.reason = "a deployment started; the run was aborted"
            elif (self.hard_limit_seconds
                  and time.monotonic() - self._started >= self.hard_limit_seconds):
                self.reason = f"hard limit of {self.hard_limit_seconds:.0f} s reached; the run was aborted"
            else:
                continue
            self.cancel_event.set()
            return


def cost_report(model, agent: dict) -> dict:
    """Estimated LLM cost of the run (cache tokens included) and the turns a
    refusal fallback model answered. cost_usd is None for unpriced models
    (self-hosted)."""
    priced = model_price(model) is not None
    return {
        "cost_usd": round(estimate_cost_usd(model, agent), 4) if priced else None,
        "cache_read_input_tokens": agent.get("cache_read_input_tokens"),
        "cache_creation_input_tokens": agent.get("cache_creation_input_tokens"),
        "fallback_turns": agent.get("fallback_turns", 0),
    }


def comparison_problems(agent: dict, requested_model) -> list:
    """Why a run must not count in a model/prompt comparison (empty = valid)."""
    problems = []
    if agent.get("result_producer") != "agent":
        problems.append("the returned plan came from the heuristic, not the model")
    if agent.get("fallback"):
        problems.append(f"heuristic fallback: {agent.get('fallback')}")
    if agent.get("fallback_turns"):
        problems.append(f"a refusal fallback model answered {agent['fallback_turns']} turn(s)")
    if agent.get("model") not in (None, requested_model) or any(
        model != requested_model for model in (agent.get("model_usage") or {})
    ):
        problems.append("model selection changed")
    for key in ("daysSkipped", "daysIncomplete"):
        if agent.get(key):
            problems.append(f"{key}: {', '.join(agent[key])}")
    # A day the model gave up on (refusal, error) that the cross-day repair
    # (v1.80) or the final audit filled leaves daysSkipped; the plan is then
    # partly not the model's.
    audit_filled = sorted(set(agent.get("modelDaysSkipped") or []) - set(agent.get("daysSkipped") or []))
    if audit_filled:
        problems.append("days the model skipped (filled by the cross-day repair or the final audit): "
                        f"{', '.join(audit_filled)}")
    # A day the model left incomplete that the cross-day repair (v1.80)
    # completed: the repair can fill up to 60 places, so a run where the model
    # barely planned would otherwise look like the model's plan. (A few final
    # audit repairs of a model-incomplete day stay allowed, as before v1.80.)
    repaired = set((agent.get("cross_day_repair") or {}).get("days") or [])
    repair_completed = sorted((set(agent.get("modelDaysIncomplete") or []) & repaired)
                              - set(agent.get("daysIncomplete") or []))
    if repair_completed:
        problems.append("days the model left incomplete (completed by the cross-day repair): "
                        f"{', '.join(repair_completed)}")
    return problems


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-02-02")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=600.0,
                        help="wall-clock budget in seconds; 0 = unlimited (like production)")
    parser.add_argument("--max-iterations", type=int, default=None)
    parser.add_argument("--model", default=None, help="override the configured model")
    parser.add_argument("--provider", default="configured", choices=PROVIDER_CHOICES,
                        help="override the saved provider for this run (settings stay unchanged)")
    parser.add_argument("--effort", default=None, choices=ANTHROPIC_EFFORTS,
                        help="Claude effort level (output_config.effort)")
    parser.add_argument(
        "--scenario", default="base",
        choices=[
            "base", "vacation-wave", "understaffed", "crunch", "oncall",
            "pinned", "daynight", "fixed-patterns",
        ],
        help="transform the fixture into a harder case",
    )
    parser.add_argument(
        "--strategy", default="day_by_day",
        choices=["repair", "day_by_day"],
        help="agent approach: build day by day (the standard), or repair "
             "the heuristic draft (kept for benchmarks)",
    )
    parser.add_argument(
        "--reasoning-effort", default=None,
        choices=["low", "medium", "high"],
        help="reasoning-effort hint for the model (fewer thinking tokens = "
             "faster); passed to the OpenAI-compatible endpoint",
    )
    args = parser.parse_args()

    end = date.fromisoformat(args.start) + timedelta(days=args.days - 1)
    state = load_state()
    scenario_desc = apply_scenario(state, args.scenario, args.start, end.isoformat())
    payload = SolveRangeRequest(
        startISO=args.start,
        endISO=end.isoformat(),
        only_fill_required=True,
        timeout_seconds=args.timeout,
        solver_mode="agent",
        agent_strategy=args.strategy,
    )
    config = resolve_arena_config(args.provider)
    config.allow_model_fallback = False
    apply_llm_overrides(config, model=args.model,
                        effort=args.effort, reasoning_effort=args.reasoning_effort)
    if args.max_iterations:
        config.max_iterations = args.max_iterations

    def on_progress(kind: str, data: dict) -> None:
        # One line per iteration: progress for the human AND keepalive
        # traffic for the SSH channel (slow models are silent for minutes,
        # which killed a 122B run after 20 idle minutes).
        if kind == "agent" and data.get("kind") == "iteration":
            print(
                f"[arena] iteration {data.get('iteration')} "
                f"moves={data.get('moves_accepted')}",
                flush=True,
            )

    started = time.time()
    cancel = Event()
    with RunGuard(cancel, marker=drain_marker()) as guard:
        result = agent_solve_range(
            payload, state, cancel, on_progress, started, config=config,
        )
    duration = time.time() - started

    debug = result.get("debug_info") or result.get("debugInfo") or {}
    agent = debug.get("agent") or {}
    # The improvement note (index 1 of notes) already reads
    # "Plan improved over the seed: ...tier deltas..." — surface it directly.
    improvement = next(
        (n for n in (result.get("notes") or []) if "improved over the seed" in n),
        None,
    )
    report = {
        "case": f"synthetic-complex {args.start} +{args.days}d",
        "fixture_version": json.loads(FIXTURE.read_text()).get("fixtureVersion", "legacy-export-v1"),
        "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
        "scenario": args.scenario,
        "scenario_desc": scenario_desc,
        "strategy": args.strategy,
        "provider": config.provider,
        "model": agent.get("model"),
        "requested_model": config.model,
        "effort": reported_effort(config),
        "model_selection": agent.get("model_selection"),
        "model_usage": agent.get("model_usage"),
        "result_producer": agent.get("result_producer"),
        "fallback": agent.get("fallback"),
        "stats": agent.get("stats"),
        "quality": agent.get("quality"),
        "duration_seconds": round(duration, 1),
        "iterations": agent.get("iterations"),
        "moves_accepted": agent.get("moves_accepted"),
        "moves_rejected": agent.get("moves_rejected"),
        "input_tokens": agent.get("input_tokens"),
        "output_tokens": agent.get("output_tokens"),
        "tok_per_s": agent.get("output_tokens_per_second"),
        "open_slots_seed": len(agent.get("open_slots_seed") or []),
        "open_slots_final": len(agent.get("open_slots_final") or []),
        "improvement": improvement,
        # First line of violations_final is the "summary|hard N (...)|soft M"
        # tally — a compact final-quality fingerprint.
        "violations_summary": (agent.get("violations_final") or ["?"])[0],
        "notes": result.get("notes"),
        "assignments": len(result.get("assignments") or []),
        **cost_report(config.model, agent),
    }
    problems = comparison_problems(agent, config.model)
    if guard.reason:
        problems.append(guard.reason)
    report["valid_for_comparison"] = not problems
    report["comparison_problems"] = problems
    print("ARENA_REPORT " + json.dumps(report, ensure_ascii=False))
    # Reasoning tail for qualitative review (what did the model struggle with)
    for t in (agent.get("thoughts") or [])[-3:]:
        print("--- thought ---")
        print(t[:1500])
    if (agent.get("model") not in (None, config.model)
            or any(model != config.model for model in (agent.get("model_usage") or {}))):
        raise SystemExit("Model selection changed; do not count this as a comparison of the requested model")


if __name__ == "__main__":
    main()
