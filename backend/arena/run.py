"""Agent test arena: run the agent solver against a hard, realistic state
and print comparable metrics.

The fixture is an anonymized export of a large radiology practice (24
clinicians, 35 sections, 163 weekly template slots, 4 locations) — the
kind of case the agent must eventually handle well.

Runs IN-PROCESS against whatever provider the environment / admin settings
resolve to (same path as the real solver), so executing it inside the
production backend container benchmarks the actual self-hosted model:

    python -m backend.arena.run --start 2026-02-02 --days 1 --timeout 600

No HTTP, no writes: state comes from the fixture, results go to stdout.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date, timedelta
from multiprocessing import Event
from pathlib import Path

from ..agent.config import AgentConfig
from ..agent.harness import agent_solve_range
from ..agent_budget import resolve_agent_runtime_config
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
        return "unchanged practice data"

    # Stable clinician order so the scenario is reproducible.
    ids = [c.id for c in state.clinicians]

    if scenario == "vacation-wave":
        # Five clinicians (every 4th) on vacation across the whole range:
        # forces the agent to re-cover their slots with a thinner roster.
        hit = ids[::4][:5]
        for cid in hit:
            _add_vacation(state, cid, start_iso, end_iso)
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
        # the whole range. Pointed at the fixture's real school-holiday week
        # (start 2026-02-16: nine clinicians on vacation) this is the
        # nightmare case every practice knows — holidays plus sick calls.
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
        # The real practice keeps the overnight on-call at requiredSlots=0
        # and staffs it by hand. This scenario makes it the agent's job:
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
                pins.append(
                    Assignment(
                        id=f"arena-pin-{inst.slot_id}-{date_iso}",
                        rowId=inst.slot_id,
                        dateISO=date_iso,
                        clinicianId=candidates[0].id,
                        source="manual",
                    )
                )
                used.add(candidates[0].id)
                pinned_here += 1
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-02-02")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--max-iterations", type=int, default=None)
    parser.add_argument("--model", default=None, help="override the configured model")
    parser.add_argument(
        "--scenario", default="base",
        choices=[
            "base", "vacation-wave", "understaffed", "crunch", "oncall",
            "pinned", "daynight",
        ],
        help="transform the fixture into a harder case",
    )
    parser.add_argument(
        "--strategy", default="repair",
        choices=["repair", "day_by_day"],
        help="agent approach: repair the heuristic draft, or build day by day",
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
    config = resolve_agent_runtime_config(AgentConfig.from_env())
    if args.model:
        config.model = args.model
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
    result = agent_solve_range(
        payload, state, Event(), on_progress, started, config=config,
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
        "case": f"complex-practice {args.start} +{args.days}d",
        "scenario": args.scenario,
        "scenario_desc": scenario_desc,
        "strategy": args.strategy,
        "model": agent.get("model"),
        "duration_seconds": round(duration, 1),
        "iterations": agent.get("iterations"),
        "moves_accepted": agent.get("moves_accepted"),
        "moves_rejected": agent.get("moves_rejected"),
        "input_tokens": agent.get("input_tokens"),
        "output_tokens": agent.get("output_tokens"),
        "open_slots_seed": len(agent.get("open_slots_seed") or []),
        "open_slots_final": len(agent.get("open_slots_final") or []),
        "improvement": improvement,
        # First line of violations_final is the "summary|hard N (...)|soft M"
        # tally — a compact final-quality fingerprint.
        "violations_summary": (agent.get("violations_final") or ["?"])[0],
        "notes": result.get("notes"),
        "assignments": len(result.get("assignments") or []),
    }
    print("ARENA_REPORT " + json.dumps(report, ensure_ascii=False))
    # Reasoning tail for qualitative review (what did the model struggle with)
    for t in (agent.get("thoughts") or [])[-3:]:
        print("--- thought ---")
        print(t[:1500])


if __name__ == "__main__":
    main()
