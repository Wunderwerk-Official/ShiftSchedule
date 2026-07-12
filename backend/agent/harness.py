"""The propose -> verify -> repair loop.

``agent_solve_range`` has the same contract as the two existing solvers:
``(payload, state, cancel_event, on_progress, start_time) -> dict`` shaped
like ``SolveRangeResponse``. It runs inside the existing solver subprocess,
so cancel/abort, the heartbeat watchdog, and the SSE progress pipeline are
inherited from ``solver.py``.

Failure philosophy: once the heuristic seed exists, nothing the LLM does (or
fails to do) can surface as an error — API failures, refusals, missing keys,
and budget exhaustion all degrade to returning the best plan so far (at worst
the seed), with an explanatory note.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..heuristic.solver_v2 import heuristic_solve_range_v2
from ..models import Assignment, SolveRangeRequest, AppState
from ..scoring import build_scoring_context, open_slots, plan_stats
from ..validation import validate_solver_rules
from .config import AgentConfig
from .prompts import (
    DAY_SYSTEM_PROMPT,
    DEFAULT_AGENT_INSTRUCTIONS,
    DUTY_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_day_digest,
    build_duty_digest,
    build_problem_digest,
)
from .provider import ChatMessage, LLMProvider, ToolSpec, get_provider
from .tools import DAY_ONLY_TOOL_NAMES, TOOL_SPECS_RAW, PlanToolExecutor

# History compaction: once the tool results in the conversation exceed this
# budget, everything but the most recent exchanges is replaced by a stub in
# ONE go. Chunked (not per-iteration) so the prompt-cache prefix stays
# byte-stable between compactions — trimming one message per round would
# invalidate the cache on every call.
TOOL_HISTORY_BUDGET_CHARS = 60_000
TOOL_HISTORY_KEEP_RECENT = 4
TOOL_RESULT_STUB = '{"trimmed":"stale tool result removed - re-query if needed"}'


def _compact_tool_history(messages) -> None:
    """Replace old tool-result payloads with a stub when the history is big.

    The model re-reads the whole conversation every iteration; ancient
    candidate lists and overviews are outdated anyway (the working copy moved
    on) and only cost tokens. Assistant turns are never touched — the API
    requires them to be replayed verbatim (thinking blocks).
    """
    tool_messages = [m for m in messages if m.role == "tool"]
    total = sum(
        len(r.content or "") for m in tool_messages for r in m.tool_results
    )
    if total <= TOOL_HISTORY_BUDGET_CHARS:
        return
    for message in tool_messages[:-TOOL_HISTORY_KEEP_RECENT]:
        for result in message.tool_results:
            if result.content != TOOL_RESULT_STUB:
                result.content = TOOL_RESULT_STUB
# Leave this many seconds of headroom before the deadline for finalization.
DEADLINE_HEADROOM_SECONDS = 5.0
# Cap for a single LLM request. Sized for slow self-hosted reasoning models
# (a 100B+ model can spend several minutes thinking through the first digest);
# the run's own wall-clock deadline still bounds the total via min().
MAX_PER_CALL_TIMEOUT_SECONDS = 600.0
# Per-event cap for thought/reasoning text in the live feed. Generous — the
# admin wants to read chains of thought in FULL (the UI opens them in a
# dedicated dialog) — but bounded so a runaway model cannot bloat the SSE
# stream. Texts that do exceed it get an explicit truncation marker.
MAX_FEED_TEXT_CHARS = 24000


def _feed_text(text: str) -> str:
    if len(text) <= MAX_FEED_TEXT_CHARS:
        return text
    return text[:MAX_FEED_TEXT_CHARS] + "\n… [truncated]"

# Repair strategy: the pre-strategy tool set, byte-identical (comparability
# and prompt-cache stability). Day-by-day additionally gets the two
# day-construction helpers.
TOOL_SPECS = [
    ToolSpec(t["name"], t["description"], t["input_schema"])
    for t in TOOL_SPECS_RAW
    if t["name"] not in DAY_ONLY_TOOL_NAMES
]
DAY_TOOL_SPECS = [
    ToolSpec(t["name"], t["description"], t["input_schema"]) for t in TOOL_SPECS_RAW
]


def _quality_improvement_note(seed_q, best_q) -> str:
    """Human-readable summary of which quality tiers the agent improved.

    Mirrors the lexicographic tuple in ``PlanToolExecutor._quality``; only
    components that actually changed are mentioned.
    """
    parts: List[str] = []
    for label, idx in (
        ("hard-rule violations", 0),
        ("open required slots", 1),
        ("short work days", 2),
        ("soft-rule violations", 3),
    ):
        if seed_q[idx] != best_q[idx]:
            parts.append(f"{label} {seed_q[idx]} -> {best_q[idx]}")
    if seed_q[4] != best_q[4]:
        parts.append(f"weekly-hours deviation {seed_q[4]} -> {best_q[4]} min")
    if seed_q[5] != best_q[5]:
        parts.append(f"preference/load bonus {-seed_q[5]} -> {-best_q[5]}")
    return ", ".join(parts)


def agent_solve_range(
    payload: SolveRangeRequest,
    state: AppState,
    cancel_event,
    on_progress: Callable[[str, Dict[str, Any]], None],
    start_time: float,
    *,
    provider: Optional[LLMProvider] = None,
    config: Optional[AgentConfig] = None,
) -> dict:
    # No wall-clock limit unless the caller requests one (admin decision
    # 2026-07: runs end when the iteration budget — slots x 10 — is spent
    # or the plan is done; abort stays available). All downstream deadline
    # math (day shares, per-call timeouts, tool guards) is inf-safe; the
    # per-LLM-call cap keeps single hung requests bounded either way.
    timeout = payload.timeout_seconds
    deadline = start_time + timeout if timeout else float("inf")

    # Replan semantics: assignments a previous SOLVER run left inside the
    # solve range are replaceable, not fixed — only manual ones are
    # untouchable (the UI deletes in-range solver assignments when applying
    # a new plan anyway). Leaving them in `state` made the seed heuristic
    # double-book fully pre-planned days (observed on real practice data:
    # 29 duplicate drafts, 30 hard violations on a single day) and welded
    # the executor's fixed set shut. Out-of-range solver assignments stay:
    # they are context for rest/overlap checks at the boundaries.
    from datetime import date as _date, timedelta as _timedelta

    range_start = _date.fromisoformat(payload.startISO)
    range_end = _date.fromisoformat(payload.endISO or payload.startISO)
    target_days = {
        (range_start + _timedelta(days=i)).isoformat()
        for i in range((range_end - range_start).days + 1)
    }
    replaced = [
        a
        for a in state.assignments
        if a.dateISO in target_days
        and getattr(a, "source", "manual") == "solver"
        and not a.rowId.startswith("pool-")
    ]
    if replaced:
        state = state.model_copy(deep=False)
        state.assignments = [a for a in state.assignments if a not in replaced]

    # ------------------------------------------------------------------
    # Phase 1: seed plan
    # ------------------------------------------------------------------
    # Strategy: "day_by_day" (the STANDARD since v1.38) builds the range
    # from scratch, one day per conversation, the way a human planner works.
    # "repair" (heuristic seed + LLM improvement) is deactivated in the UI
    # and kept only for the arena benchmarks and explicit API calls.
    strategy = (
        "repair"
        if getattr(payload, "agent_strategy", None) == "repair"
        else "day_by_day"
    )

    def muted_progress(event_type: str, data: dict) -> None:
        # Forward the heuristic's phase updates so the overlay stays alive,
        # but suppress its per-day solution events: the agent emits its own
        # solution stream on a consistent objective scale.
        if event_type == "phase":
            on_progress(event_type, data)

    def heuristic_fallback(extra_notes: List[str]) -> dict:
        """Day-by-day has no draft to fall back on — whenever the run would
        otherwise return an EMPTY range (LLM unavailable, first-call error,
        no time for a single call), return a fresh heuristic plan instead:
        applying an empty result would wipe the range's previous plan. The
        status is AGENT_FALLBACK_SEED so the frontend surfaces it exactly
        like the repair strategy's fallback."""
        result = heuristic_solve_range_v2(
            payload, state, cancel_event, muted_progress, start_time
        )
        result["notes"] = list(result.get("notes") or []) + list(extra_notes)
        debug = result.get("debugInfo")
        if isinstance(debug, dict):
            debug["solver_status"] = "AGENT_FALLBACK_SEED"
        return result

    if strategy == "repair":
        on_progress(
            "phase",
            {"phase": "agent_seed", "label": "Agent (1/3): Building seed plan with heuristic..."},
        )
        seed_result = heuristic_solve_range_v2(
            payload, state, cancel_event, muted_progress, start_time
        )
        seed_notes = list(seed_result.get("notes") or [])
        if cancel_event.is_set():
            return seed_result
        try:
            seed_assignments = [
                Assignment.model_validate(a) for a in seed_result.get("assignments") or []
            ]
        except Exception:
            # A malformed seed means the heuristic already returned an error
            # response — pass it through unchanged.
            return seed_result
    else:
        on_progress(
            "phase",
            {"phase": "agent_seed", "label": "Agent (1/3): Preparing day-by-day planning..."},
        )
        seed_notes = []
        seed_assignments = []

    ctx = build_scoring_context(
        state,
        payload.startISO,
        payload.endISO,
        only_fill_required=payload.only_fill_required,
    )

    solution_counter = {"n": 0}

    def emit_solution(objective: float, assignments: List[Assignment]) -> None:
        solution_counter["n"] += 1
        on_progress(
            "solution",
            {
                "solution_num": solution_counter["n"],
                "time_ms": (time.time() - start_time) * 1000.0,
                "objective": objective,
                "assignments": [a.model_dump() for a in assignments],
            },
        )

    iterations_done = 0
    total_input_tokens = 0
    total_output_tokens = 0
    total_cache_read_tokens = 0
    total_cache_creation_tokens = 0

    def emit_agent(kind: str, payload: Optional[dict] = None) -> None:
        """Dedicated SSE event type for the live agent panel. Older frontends
        ignore unknown event types, so this is backward-safe."""
        data = dict(payload or {})
        data["kind"] = kind
        data.setdefault("iteration", iterations_done)
        data["max_iterations"] = config.max_iterations if config else None
        data["moves_accepted"] = executor.moves_accepted if executor is not None else 0
        data["time_ms"] = (time.time() - start_time) * 1000.0
        on_progress("agent", data)

    executor: Optional[PlanToolExecutor] = None
    final_summary: Optional[str] = None
    # Every text the model produced, in order — surfaced in the copyable run
    # log so the admin can trace the agent's reasoning after the fact.
    thought_log: List[str] = []
    emit_agent("stage", {"stage": "seed"})
    executor = PlanToolExecutor(
        state,
        ctx,
        seed_assignments,
        on_improvement=emit_solution,
        on_activity=emit_agent,
    )
    # The harness checks the wall clock only BETWEEN LLM rounds; expensive
    # tool loops (rescue/balance gate validations) check this themselves so
    # a single tool call can never push the run past its budget (observed
    # in production: a run overshot its 600s budget inside a tool until the
    # HTTP connection was cut and the result was lost).
    executor.wall_deadline = deadline
    emit_solution(executor.seed_score, seed_assignments)
    # Computed before finalize() can run: the provider-init failure path
    # finalizes before the LLM phase would otherwise compute these.
    seed_stats = plan_stats(ctx, seed_assignments)
    seed_open = open_slots(ctx, seed_assignments)

    def _fmt_plan_line(a: Assignment, origin: str) -> str:
        inst = ctx.instances.get(f"{a.rowId}__{a.dateISO}")
        if inst is not None:
            time_part = (
                f"{inst.start // 60:02d}:{inst.start % 60:02d}"
                f"-{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}"
            )
            section = executor.section_names.get(inst.section_id, inst.section_id)
        else:
            time_part, section = "?", a.rowId
        clinician = executor.clinicians_by_id.get(a.clinicianId)
        name = clinician.name if clinician else a.clinicianId
        return f"{a.dateISO}|{section}|{time_part}|{name}|{origin}"

    def _log_extras(best: List[Assignment]) -> dict:
        """Diagnostic payload for the copyable run log: what was open, what
        the final plan looks like, and every violation the validator sees
        (flagged new vs pre-existing). Real names — browser-only data."""
        full = executor.fixed_assignments + best
        plan_lines = sorted(
            [
                _fmt_plan_line(a, "fixed")
                for a in executor.fixed_assignments
                if a.dateISO in ctx.target_date_set and not a.rowId.startswith("pool-")
            ]
            + [
                _fmt_plan_line(a, "agent" if a.id.startswith("agent-") else "seed")
                for a in best
            ]
        )
        # NEW violations first, then in-range ones — an old plan full of
        # pre-existing issues (e.g. a year of stale qualification mismatches)
        # must not truncate away the lines that explain THIS week.
        hard_all = executor._hard_violations(full)
        in_range = lambda v: bool(v.date_iso) and v.date_iso in ctx.target_date_set  # noqa: E731
        hard_all.sort(
            key=lambda v: (not executor._is_new_hard(v), not in_range(v), v.date_iso or "")
        )
        soft_all = validate_solver_rules(state, full)
        violation_lines: List[str] = [
            f"summary|hard {len(hard_all)} total"
            f" (new {sum(1 for v in hard_all if executor._is_new_hard(v))},"
            f" in solve range {sum(1 for v in hard_all if in_range(v))})"
            f"|soft {len(soft_all)}"
        ]
        for v in hard_all[:60]:
            clinician = executor.clinicians_by_id.get(v.clinician_id or "")
            violation_lines.append(
                f"hard|{v.code}|{'NEW' if executor._is_new_hard(v) else 'pre-existing'}"
                f"|{v.date_iso or '-'}|{clinician.name if clinician else v.clinician_id or '-'}"
                f"|{v.slot_id or '-'}"
            )
        if len(hard_all) > 60:
            violation_lines.append(
                f"... and {len(hard_all) - 60} more pre-existing hard violations "
                "outside the solve range"
            )
        for v in soft_all[:20]:
            clinician = executor.clinicians_by_id.get(v.clinician_id or "")
            violation_lines.append(
                f"soft|{v.code}|{v.date_iso or '-'}"
                f"|{clinician.name if clinician else v.clinician_id or '-'}"
                f"|{executor.unscrub_text(v.message)[:160]}"
            )
        remaining_open = open_slots(ctx, best)
        fmt_open = lambda g: f"{g.dateISO}|{g.section_id}|{g.start}-{g.end}|missing {g.missing}"  # noqa: E731
        # The plan BEFORE any agent change (fixed + heuristic seed): together
        # with the ordered moves list this makes every intermediate state
        # reconstructable when auditing what the agent did.
        seed_plan_lines = sorted(
            [
                _fmt_plan_line(a, "fixed")
                for a in executor.fixed_assignments
                if a.dateISO in ctx.target_date_set and not a.rowId.startswith("pool-")
            ]
            + [_fmt_plan_line(a, "seed") for a in seed_assignments]
        )
        return {
            # 200, not 80: a from-scratch day-by-day run starts with EVERY
            # required position "open" (127+ on the real 5-day cases), and a
            # truncated list made the arena report undercount the seed side.
            "open_slots_seed": [fmt_open(g) for g in seed_open[:200]],
            "open_slots_final": [fmt_open(g) for g in remaining_open[:200]],
            "seed_plan": seed_plan_lines[:300],
            "final_plan": plan_lines[:300],
            "violations_final": violation_lines[:90],
            # Full reasoning chains belong in the copyable log — cap only as
            # a guard against a runaway model, not as a display truncation.
            "thoughts": [_feed_text(t) for t in thought_log[:80]],
        }

    def _unsolved_overview(best: List[Assignment]) -> Tuple[List[str], dict]:
        """The admin's closing report: everything the run could NOT solve —
        open required slots, short days, over-long days — as human-readable
        note lines (they end up in the run log and the run inbox) plus a
        structured block for debugInfo. Real names: browser-only data."""
        remaining_open = open_slots(ctx, best)
        open_entries = [
            {
                "dateISO": g.dateISO,
                "section": executor.section_names.get(g.section_id, g.section_id),
                "time": f"{g.start}-{g.end}",
                "missing": g.missing,
            }
            for g in remaining_open
        ]

        minutes: Dict[Tuple[str, str], int] = {}
        for a in executor.fixed_assignments + list(best):
            if a.dateISO not in ctx.target_date_set or a.rowId.startswith("pool-"):
                continue
            inst = ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is not None:
                duration = inst.end - inst.start
            else:
                interval = ctx.all_slot_intervals.get(a.rowId)
                if interval is None:
                    continue
                duration = interval[1] - interval[0]
            key = (a.clinicianId, a.dateISO)
            minutes[key] = minutes.get(key, 0) + max(0, duration)

        short_days: List[dict] = []
        overlong_days: List[dict] = []
        for (cid, date_iso), mins in sorted(minutes.items(), key=lambda kv: kv[0][1]):
            clinician = executor.clinicians_by_id.get(cid)
            if clinician is None or mins <= 0:
                continue
            daily_min = executor._daily_min_minutes(cid, date_iso)
            if daily_min is not None and mins < daily_min:
                short_days.append(
                    {
                        "clinician": clinician.name,
                        "dateISO": date_iso,
                        "hours": round(mins / 60.0, 1),
                        "min_hours": round(daily_min / 60.0, 1),
                    }
                )
            comfort = executor._daily_target_minutes(cid, date_iso) + 60
            if mins > comfort:
                overlong_days.append(
                    {
                        "clinician": clinician.name,
                        "dateISO": date_iso,
                        "hours": round(mins / 60.0, 1),
                        "comfort_hours": round(comfort / 60.0, 1),
                    }
                )

        # Placements the run made OUTSIDE someone's preferred working time
        # (the per-clinician wish; mandatory windows can never be violated).
        outside_preferred: List[dict] = []
        for a in best:
            if a.dateISO not in ctx.target_date_set or a.rowId.startswith("pool-"):
                continue
            window = ctx.window_by_clinician_date.get((a.clinicianId, a.dateISO))
            if window is None or window[0] != "preference":
                continue
            inst = ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is None:
                continue
            if inst.start >= window[1] and inst.end <= window[2]:
                continue
            clinician = executor.clinicians_by_id.get(a.clinicianId)
            outside_preferred.append(
                {
                    "clinician": clinician.name if clinician else a.clinicianId,
                    "dateISO": a.dateISO,
                    "time": f"{inst.start // 60:02d}:{inst.start % 60:02d}-"
                    f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}",
                    "preferred": f"{window[1] // 60:02d}:{window[1] % 60:02d}-"
                    f"{(window[2] % 1440) // 60:02d}:{window[2] % 60:02d}",
                }
            )

        unsolved = {
            "open_slots": open_entries,
            "short_days": short_days,
            "overlong_days": overlong_days,
            "outside_preferred_times": outside_preferred,
        }
        if (
            not open_entries
            and not short_days
            and not overlong_days
            and not outside_preferred
        ):
            return (
                [
                    "No unresolved issues: every required slot is filled, "
                    "no short days, no over-long days, all preferred "
                    "working times respected."
                ],
                unsolved,
            )

        lines = [
            "Unresolved after this run: "
            f"{len(open_entries)} open slot(s), {len(short_days)} short "
            f"day(s), {len(overlong_days)} over-long day(s), "
            f"{len(outside_preferred)} placement(s) outside preferred "
            "working times."
        ]
        for entry in open_entries[:12]:
            lines.append(
                f"- open: {entry['dateISO']} {entry['section']} "
                f"{entry['time']} ({entry['missing']} missing)"
            )
        if len(open_entries) > 12:
            lines.append(f"- ... and {len(open_entries) - 12} more open slots")
        for entry in short_days[:12]:
            lines.append(
                f"- short day: {entry['clinician']} {entry['dateISO']}: "
                f"{entry['hours']}h (minimum {entry['min_hours']}h)"
            )
        if len(short_days) > 12:
            lines.append(f"- ... and {len(short_days) - 12} more short days")
        for entry in overlong_days[:12]:
            lines.append(
                f"- over-long day: {entry['clinician']} {entry['dateISO']}: "
                f"{entry['hours']}h (comfortable up to {entry['comfort_hours']}h)"
            )
        if len(overlong_days) > 12:
            lines.append(
                f"- ... and {len(overlong_days) - 12} more over-long days"
            )
        for entry in outside_preferred[:12]:
            lines.append(
                f"- outside preferred time: {entry['clinician']} "
                f"{entry['dateISO']} {entry['time']} "
                f"(prefers {entry['preferred']})"
            )
        if len(outside_preferred) > 12:
            lines.append(
                f"- ... and {len(outside_preferred) - 12} more placements "
                "outside preferred working times"
            )
        return lines, unsolved

    def finalize(status: str, extra_notes: List[str]) -> dict:
        if (
            strategy == "day_by_day"
            and executor.moves_accepted == 0
            and not cancel_event.is_set()
        ):
            # Nothing was placed (no time for a single call, first-call LLM
            # error, refusal, ...): an empty result must never reach the
            # client — applying it would wipe the range's previous solver
            # plan. Return a heuristic draft instead, like the repair
            # strategy's seed would be.
            return heuristic_fallback(
                list(extra_notes)
                + [
                    "The day-by-day agent could not apply any changes; "
                    "the heuristic draft plan was returned instead."
                ]
            )
        emit_agent("stage", {"stage": "finalize"})
        best = executor.best_assignments
        notes = [
            (
                f"Agent solver (day-by-day): built from scratch, "
                if strategy == "day_by_day"
                else "Agent solver: seed by heuristic v2, "
            )
            + f"{iterations_done} LLM iteration(s), "
            f"{executor.moves_accepted} move(s) accepted, {executor.moves_rejected} rejected.",
        ]
        if executor.best_quality < executor.seed_quality:
            notes.append(
                "Plan improved over the seed: "
                + _quality_improvement_note(executor.seed_quality, executor.best_quality)
                + "."
            )
        elif executor.moves_accepted:
            notes.append(
                "Quality metrics unchanged; kept the agent's adjustments "
                "(preference/fairness swaps at equal quality)."
            )
        elif strategy == "day_by_day":
            notes.append(
                "No assignments could be placed; returning an empty plan "
                "for the range."
            )
        else:
            notes.append("No improvement over the heuristic seed; returning the seed plan.")
        notes.extend(extra_notes)
        notes.extend(n for n in seed_notes if "WARNING" in n or "warning" in n)
        # Closing report (admin request): what stays unsolved — open slots,
        # short days, over-long days — right in the notes so the run log
        # and the run inbox show it without digging through thoughts.
        unsolved_notes, unsolved = _unsolved_overview(best)
        notes.extend(unsolved_notes)
        return {
            "startISO": ctx.start_iso,
            "endISO": ctx.end_iso,
            "assignments": [a.model_dump() for a in best],
            "notes": notes,
            "debugInfo": {
                "timing": {"total_ms": (time.time() - start_time) * 1000.0},
                "solver_status": status,
                "num_days": len(ctx.target_day_isos),
                "num_slots": len(ctx.instances),
                "num_assignments": len(best),
                "agent": {
                    "model": config.model if config is not None else None,
                    "strategy": strategy,
                    "iterations": iterations_done,
                    "moves_accepted": executor.moves_accepted,
                    "moves_rejected": executor.moves_rejected,
                    "input_tokens": total_input_tokens,
                    "output_tokens": total_output_tokens,
                    "cache_read_input_tokens": total_cache_read_tokens,
                    "cache_creation_input_tokens": total_cache_creation_tokens,
                    "seed_score": executor.seed_score,
                    "best_score": executor.best_score,
                    # Post-run review: the model's own closing summary (real
                    # names restored) and every accepted change.
                    "summary": final_summary[:2000] if final_summary else None,
                    "moves": executor.accepted_move_log[:200],
                    # Structured closing report of what stays unsolved.
                    "unsolved": unsolved,
                    # Diagnostics for the copyable run log (real names).
                    **_log_extras(best),
                },
            },
        }

    # ------------------------------------------------------------------
    # Phase 2: LLM repair loop
    # ------------------------------------------------------------------
    if config is None:
        config = AgentConfig.from_env()
    # The model is a GLOBAL admin setting, injected server-side into the
    # payload by the solve endpoint (see agent_budget). It overrides the
    # AGENT_MODEL env default; per-user solverSettings.agentModel is ignored.
    if isinstance(payload.agent_model, str) and payload.agent_model.strip():
        config.model = payload.agent_model.strip()
    # Admin rule: the iteration budget scales with the problem — 10 rounds
    # per slot instance in the range, filled or not. A flat cap either
    # starved big ranges (100 pre-v1.33) or was meaningless on small ones;
    # AGENT_MAX_ITERATIONS is superseded by this formula.
    config.max_iterations = max(10, len(ctx.instances) * 10)
    # Per-user spending cap, also decided server-side: once used up, the run
    # ends at the heuristic draft instead of starting the LLM.
    budget_note = (
        "Agent LLM unavailable — the AI agent could not start: this "
        "account's AI budget is used up. The heuristic draft plan was "
        "returned instead. An administrator can raise the budget in "
        "Settings → Solver."
    )
    if payload.agent_budget_exhausted:
        if strategy == "day_by_day":
            return heuristic_fallback([budget_note])
        return finalize("AGENT_FALLBACK_SEED", [budget_note])
    if provider is None:
        try:
            provider = get_provider(config)
        except Exception as exc:
            # Phrasing matters: the frontend surfaces notes containing
            # "could not" as a warning toast, and matches "Agent LLM
            # unavailable" to show a persistent error in the planning panel.
            unavailable_note = (
                f"Agent LLM unavailable — the AI agent could not start: {exc} "
                "The heuristic draft plan was returned instead."
            )
            if strategy == "day_by_day":
                return heuristic_fallback([unavailable_note])
            return finalize("AGENT_FALLBACK_SEED", [unavailable_note])

    # Free-text guidance from the admin (Settings -> "AI agent instructions").
    # None/absent falls back to the default; an explicitly emptied field
    # means "no instructions". Shared by both strategies.
    admin_instructions = (state.solverSettings or {}).get("agentInstructions")
    if not isinstance(admin_instructions, str):
        admin_instructions = DEFAULT_AGENT_INSTRUCTIONS
    admin_instructions = admin_instructions.strip()[:2000]
    admin_block = (
        "\n\nADMIN INSTRUCTIONS (soft goals from the planning admin; never "
        "override hard constraints or fixed assignments):\n"
        + executor.scrub_text(admin_instructions)
        if admin_instructions
        else ""
    )

    def absorb_response(response) -> None:
        """Token accounting + thought/summary feed emission — identical for
        the repair loop and the day-by-day loop."""
        nonlocal total_input_tokens, total_output_tokens
        nonlocal total_cache_read_tokens, total_cache_creation_tokens, final_summary
        total_input_tokens += response.usage.get("input_tokens", 0)
        total_output_tokens += response.usage.get("output_tokens", 0)
        total_cache_read_tokens += response.usage.get("cache_read_input_tokens", 0)
        total_cache_creation_tokens += response.usage.get("cache_creation_input_tokens", 0)
        if response.reasoning:
            # Chain of thought of reasoning models — shown expandable in the
            # live feed and kept in the run log. Aliases restored like text.
            reasoning_full = executor.unscrub_text(response.reasoning.strip())
            if reasoning_full:
                thought_log.append(
                    f"[iteration {iterations_done}] (reasoning) {reasoning_full}"
                )
                emit_agent(
                    "thought",
                    {"text": _feed_text(reasoning_full), "reasoning": True},
                )
        if response.text:
            # The model writes aliases; restore real names for the
            # user-facing feed and remember the latest text as the run summary.
            final_summary = executor.unscrub_text(response.text.strip())
            thought_log.append(f"[iteration {iterations_done}] {final_summary}")
            emit_agent("thought", {"text": _feed_text(final_summary)})

    def day_by_day_loop() -> dict:
        """One fresh LLM conversation per day, mirroring the human procedure:
        scarcest slots first, each clinician placed with a contiguous block
        (suggest_day_blocks), iterate until the day is full. The executor
        (working copy, guardrails, best snapshot) is shared across days, so
        cross-day rules — weekly hours, rest days — stay enforced."""
        nonlocal iterations_done
        extra_notes: List[str] = []
        emit_agent("stage", {"stage": "improve"})
        total_days = len(ctx.target_day_isos)
        previous_day_lines: List[str] = []
        aborted = False

        # ---- Duty pre-pass ------------------------------------------------
        # On-call/duty slots are staffed FIRST across the WHOLE range: they
        # bind rest days and weekly-hours budgets, and building the days
        # chronologically spent those budgets on ordinary day work first —
        # observed in production as a weekend whose on-call stayed empty.
        on_call_class = (
            ctx.settings.onCallRestClassId
            if getattr(ctx.settings, "onCallRestEnabled", False)
            else None
        )

        def open_duty_state() -> Tuple[List[str], int]:
            counts = executor._counts_by_instance(executor._working_list())
            lines: List[str] = []
            positions = 0
            for inst in sorted(
                (i for i in ctx.instances.values() if i.section_id == on_call_class),
                key=lambda i: (i.date_iso, i.start),
            ):
                missing = max(0, inst.target - counts.get(inst.slot_key, 0))
                if missing > 0:
                    positions += missing
                    lines.append(
                        f"- {executor._alias_slot_key(inst.slot_key)}"
                        f"|{executor.section_names.get(inst.section_id, inst.section_id)}"
                        f"|{inst.date_iso}"
                        f"|{inst.start // 60:02d}:{inst.start % 60:02d}-"
                        f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}"
                        f"|{missing}"
                    )
            return lines, positions

        duty_lines, duty_positions = (
            open_duty_state() if on_call_class else ([], 0)
        )
        if duty_lines:
            remaining = deadline - time.time()
            duty_deadline = time.time() + remaining / (total_days + 1)
            duty_rounds = max(6, 3 * duty_positions)
            rounds_end = min(iterations_done + duty_rounds, config.max_iterations)
            digest = (
                build_duty_digest(
                    state,
                    ctx,
                    duty_lines,
                    duty_rounds,
                    executor.alias_by_id,
                    ytd_worked_pct_by_id={
                        c.id: executor.ytd_completion_pct(c.id, ctx.start_iso)
                        for c in state.clinicians
                    },
                )
                + admin_block
            )
            messages = [ChatMessage(role="user", content=digest)]
            truncation_nudges = 0
            on_progress(
                "phase",
                {
                    "phase": "agent_loop",
                    "label": (
                        f"Agent (2/3): duty pre-pass, {duty_positions} "
                        "on-call position(s)..."
                    ),
                },
            )
            while iterations_done < rounds_end:
                if cancel_event.is_set():
                    return finalize(
                        "ABORTED",
                        extra_notes
                        + ["Agent run aborted by user; best plan so far returned."],
                    )
                global_left = deadline - time.time()
                if global_left <= max(DEADLINE_HEADROOM_SECONDS, 30.0):
                    break
                if duty_deadline - time.time() <= 0:
                    break  # the pass's time share is spent — start the days
                per_call_timeout = max(
                    10.0,
                    min(
                        max(duty_deadline - time.time(), 30.0),
                        global_left - DEADLINE_HEADROOM_SECONDS,
                        MAX_PER_CALL_TIMEOUT_SECONDS,
                    ),
                )
                _compact_tool_history(messages)
                executor.current_iteration = iterations_done + 1
                emit_agent("iteration", {"iteration": iterations_done + 1})
                response = provider.complete(
                    system=DUTY_SYSTEM_PROMPT,
                    messages=messages,
                    tools=DAY_TOOL_SPECS,
                    timeout_seconds=per_call_timeout,
                )
                iterations_done += 1
                absorb_response(response)
                if response.stop_reason in ("error", "refusal"):
                    kind = "error" if response.stop_reason == "error" else "refusal"
                    detail = f" ({response.error})" if response.error else ""
                    extra_notes.append(
                        f"LLM {kind} in the duty pre-pass after iteration "
                        f"{iterations_done}{detail}; best plan so far returned."
                    )
                    aborted = True
                    break
                if response.stop_reason == "tool_use" and response.tool_calls:
                    assistant = ChatMessage(
                        role="assistant",
                        content=response.replay_text,
                        tool_calls=response.tool_calls,
                        raw_content=response.raw_content,
                    )
                    results = []
                    for call in response.tool_calls:
                        if cancel_event.is_set():
                            return finalize(
                                "ABORTED",
                                extra_notes
                                + [
                                    "Agent run aborted by user; best plan so far returned."
                                ],
                            )
                        results.append(
                            executor.execute(call.name, call.arguments, call.id)
                        )
                    emit_agent(
                        "tool_use", {"tools": [c.name for c in response.tool_calls]}
                    )
                    messages.append(assistant)
                    messages.append(ChatMessage(role="tool", tool_results=results))
                    if not open_duty_state()[0]:
                        break  # every duty staffed — nothing left to discuss
                    continue
                if response.stop_reason == "max_tokens":
                    if truncation_nudges < 2:
                        truncation_nudges += 1
                        messages.append(
                            ChatMessage(
                                role="assistant",
                                content=response.replay_text or "(truncated)",
                                tool_calls=response.tool_calls,
                                raw_content=response.raw_content,
                            )
                        )
                        if response.tool_calls:
                            messages.append(
                                ChatMessage(
                                    role="tool",
                                    tool_results=[
                                        executor.execute(c.name, c.arguments, c.id)
                                        for c in response.tool_calls
                                    ],
                                )
                            )
                        messages.append(
                            ChatMessage(
                                role="user",
                                content=(
                                    "Your reply was truncated. Respond with tool "
                                    "calls only, or finish the duty pass with a "
                                    "one-sentence summary."
                                ),
                            )
                        )
                        continue
                    extra_notes.append(
                        "LLM output repeatedly truncated in the duty pre-pass; "
                        "moved on to day planning."
                    )
                    break
                break  # end_turn: the model declared the duty pass done
            still_open_positions = open_duty_state()[1]
            previous_day_lines.append(
                f"- duty pre-pass: {duty_positions - still_open_positions} of "
                f"{duty_positions} on-call/duty positions staffed"
            )

        for day_index, date_iso in enumerate(ctx.target_day_isos):
            if aborted:
                break
            if cancel_event.is_set():
                return finalize(
                    "ABORTED",
                    extra_notes
                    + ["Agent run aborted by user; best plan so far returned."],
                )
            remaining = deadline - time.time()
            days_left = total_days - day_index
            if remaining <= max(DEADLINE_HEADROOM_SECONDS, 30.0):
                extra_notes.append(
                    f"Agent time budget exhausted before {date_iso}; "
                    "remaining day(s) were left unplanned."
                )
                break
            if iterations_done >= config.max_iterations:
                extra_notes.append(
                    f"Agent iteration budget exhausted before {date_iso}; "
                    "remaining day(s) were left unplanned."
                )
                break
            # Fair share of what is left; a day that finishes early donates
            # its surplus to the later days.
            day_deadline = time.time() + remaining / days_left
            day_rounds = max(6, (config.max_iterations - iterations_done) // days_left)
            rounds_end = min(iterations_done + day_rounds, config.max_iterations)

            counts = executor._counts_by_instance(executor._working_list())
            on_call_class = (
                ctx.settings.onCallRestClassId
                if getattr(ctx.settings, "onCallRestEnabled", False)
                else None
            )
            day_slot_lines: List[str] = []
            open_positions = 0
            # Same processing order the tools use (minus eligibility, which
            # is not known yet): on-call duties first, then slot priority,
            # then start time — NOT chronological.
            for inst in sorted(
                (i for i in ctx.instances.values() if i.date_iso == date_iso),
                key=lambda i: (
                    i.section_id != on_call_class,
                    -i.order_weight,
                    i.start,
                    i.slot_key,
                ),
            ):
                missing = max(0, inst.target - counts.get(inst.slot_key, 0))
                open_positions += missing
                day_slot_lines.append(
                    f"- {executor._alias_slot_key(inst.slot_key)}"
                    f"|{executor.section_names.get(inst.section_id, inst.section_id)}"
                    f"|{inst.start // 60:02d}:{inst.start % 60:02d}-"
                    f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}"
                    f"|{missing}"
                    f"|prio {inst.order_weight}"
                    + ("|ON-CALL" if inst.section_id == on_call_class else "")
                )
            if ctx.only_fill_required and open_positions == 0:
                # Nothing to do (e.g. the duty pre-pass covered the whole
                # day, or fixed assignments already fill it): starting a
                # conversation just burns 2-3 rounds confirming emptiness.
                previous_day_lines.append(
                    f"- {date_iso}: already fully staffed, skipped"
                )
                continue
            fixed_anchor_lines = sorted(
                {
                    f"- {executor._alias(a.clinicianId)}"
                    for a in executor.fixed_assignments
                    if a.dateISO == date_iso and not a.rowId.startswith("pool-")
                }
            )
            digest = build_day_digest(
                state,
                ctx,
                date_iso,
                day_index,
                total_days,
                open_positions,
                day_slot_lines,
                fixed_anchor_lines,
                previous_day_lines,
                day_rounds,
                executor.alias_by_id,
                # As-of-this-day fairness numbers including the working copy:
                # what got placed on earlier days must steer later days.
                ytd_worked_pct_by_id={
                    c.id: executor.ytd_completion_pct(c.id, date_iso)
                    for c in state.clinicians
                },
                distribute_all=not ctx.only_fill_required,
            ) + admin_block
            messages: List[ChatMessage] = [ChatMessage(role="user", content=digest)]
            truncation_nudges = 0
            on_progress(
                "phase",
                {
                    "phase": "agent_loop",
                    "label": (
                        f"Agent (2/3): day {day_index + 1}/{total_days} "
                        f"({date_iso}), {open_positions} open positions..."
                    ),
                },
            )

            out_of_time = False
            while iterations_done < rounds_end:
                if cancel_event.is_set():
                    return finalize(
                        "ABORTED",
                        extra_notes
                        + ["Agent run aborted by user; best plan so far returned."],
                    )
                global_left = deadline - time.time()
                if global_left <= max(DEADLINE_HEADROOM_SECONDS, 30.0):
                    out_of_time = True  # whole run out of wall clock
                    break
                day_left = day_deadline - time.time()
                if day_left <= 0:
                    break  # this day's share is spent — move to the next day
                # The 30s usefulness floor applies to the GLOBAL deadline
                # only: a day's share may be smaller (short timeouts, many
                # days), so the last call of a day may overrun its share
                # rather than shrink into a guaranteed timeout.
                per_call_timeout = max(
                    10.0,
                    min(
                        max(day_left, 30.0),
                        global_left - DEADLINE_HEADROOM_SECONDS,
                        MAX_PER_CALL_TIMEOUT_SECONDS,
                    ),
                )
                _compact_tool_history(messages)
                executor.current_iteration = iterations_done + 1
                emit_agent("iteration", {"iteration": iterations_done + 1})
                response = provider.complete(
                    system=DAY_SYSTEM_PROMPT,
                    messages=messages,
                    tools=DAY_TOOL_SPECS,
                    timeout_seconds=per_call_timeout,
                )
                iterations_done += 1
                absorb_response(response)
                if response.stop_reason in ("error", "refusal"):
                    kind = "error" if response.stop_reason == "error" else "refusal"
                    detail = f" ({response.error})" if response.error else ""
                    extra_notes.append(
                        f"LLM {kind} on {date_iso} after iteration "
                        f"{iterations_done}{detail}; best plan so far returned."
                    )
                    aborted = True
                    break
                if response.stop_reason == "tool_use" and response.tool_calls:
                    assistant = ChatMessage(
                        role="assistant",
                        content=response.replay_text,
                        tool_calls=response.tool_calls,
                        raw_content=response.raw_content,
                    )
                    results = []
                    for call in response.tool_calls:
                        if cancel_event.is_set():
                            return finalize(
                                "ABORTED",
                                extra_notes
                                + ["Agent run aborted by user; best plan so far returned."],
                            )
                        results.append(executor.execute(call.name, call.arguments, call.id))
                    emit_agent("tool_use", {"tools": [c.name for c in response.tool_calls]})
                    messages.append(assistant)
                    messages.append(ChatMessage(role="tool", tool_results=results))
                    on_progress(
                        "phase",
                        {
                            "phase": "agent_loop",
                            "label": (
                                f"Agent (2/3): day {day_index + 1}/{total_days} "
                                f"({date_iso}), iteration {iterations_done}, "
                                f"{executor.moves_accepted} move(s) accepted..."
                            ),
                        },
                    )
                    continue
                if response.stop_reason == "max_tokens":
                    if truncation_nudges < 2:
                        truncation_nudges += 1
                        messages.append(
                            ChatMessage(
                                role="assistant",
                                content=response.replay_text or "(truncated)",
                                tool_calls=response.tool_calls,
                                raw_content=response.raw_content,
                            )
                        )
                        if response.tool_calls:
                            messages.append(
                                ChatMessage(
                                    role="tool",
                                    tool_results=[
                                        executor.execute(c.name, c.arguments, c.id)
                                        for c in response.tool_calls
                                    ],
                                )
                            )
                        messages.append(
                            ChatMessage(
                                role="user",
                                content=(
                                    "Your reply was truncated. Respond with tool "
                                    "calls only, or finish the day with a "
                                    "one-sentence summary."
                                ),
                            )
                        )
                        continue
                    extra_notes.append(
                        f"LLM output repeatedly truncated on {date_iso}; "
                        "moved on to the next day."
                    )
                    break
                break  # end_turn: the model declared the day done

            if out_of_time:
                extra_notes.append(
                    "Agent time budget exhausted; best plan so far returned."
                )
                break

            counts_after = executor._counts_by_instance(executor._working_list())
            still_open = sum(
                max(0, i.target - counts_after.get(i.slot_key, 0))
                for i in ctx.instances.values()
                if i.date_iso == date_iso
            )
            previous_day_lines.append(
                f"- {date_iso}: {max(0, open_positions - still_open)} filled, "
                f"{still_open} left open"
            )
        if (
            iterations_done >= config.max_iterations
            and not aborted
            and not any("iteration budget" in n for n in extra_notes)
        ):
            extra_notes.append(
                "Agent iteration budget exhausted; best plan so far returned."
            )
        on_progress(
            "phase",
            {"phase": "agent_finalize", "label": "Agent (3/3): Finalizing best plan..."},
        )
        return finalize("AGENT_COMPLETE", extra_notes)

    if strategy == "day_by_day":
        return day_by_day_loop()

    on_progress(
        "phase",
        {"phase": "agent_loop", "label": "Agent (2/3): LLM reviewing and improving the plan..."},
    )

    soft_count = len(
        validate_solver_rules(state, executor.fixed_assignments + seed_assignments)
    )
    digest = build_problem_digest(
        state,
        ctx,
        seed_stats,
        seed_open,
        new_hard_violation_count=0,  # seed violations ARE the baseline
        soft_violation_count=soft_count,
        max_iterations=config.max_iterations,
        clinician_aliases=executor.alias_by_id,
        alias_slot_key=executor._alias_slot_key,
        seed_hard_violation_count=executor.seed_quality[0],
        seed_hard_violation_lines=executor.seed_repairable_violation_lines,
    )
    digest += admin_block
    messages: List[ChatMessage] = [ChatMessage(role="user", content=digest)]
    extra_notes: List[str] = []
    truncation_nudges = 0
    emit_agent("stage", {"stage": "improve"})

    while iterations_done < config.max_iterations:
        if cancel_event.is_set():
            return finalize("ABORTED", ["Agent run aborted by user; best plan so far returned."])
        remaining = deadline - time.time()
        # Below ~30s a call cannot finish anything useful on slow self-hosted
        # models — it just dies in a timeout and pollutes the notes with
        # "endpoint unreachable". Finalize cleanly instead.
        if remaining <= max(DEADLINE_HEADROOM_SECONDS, 30.0):
            extra_notes.append("Agent time budget exhausted; best plan so far returned.")
            break

        per_call_timeout = min(
            max(remaining - DEADLINE_HEADROOM_SECONDS, 10.0), MAX_PER_CALL_TIMEOUT_SECONDS
        )
        _compact_tool_history(messages)
        executor.current_iteration = iterations_done + 1
        emit_agent("iteration", {"iteration": iterations_done + 1})
        response = provider.complete(
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOL_SPECS,
            timeout_seconds=per_call_timeout,
        )
        iterations_done += 1
        absorb_response(response)

        if response.stop_reason == "error":
            extra_notes.append(
                f"LLM error after iteration {iterations_done} "
                f"({response.error}); best plan so far returned."
            )
            break
        if response.stop_reason == "refusal":
            extra_notes.append("LLM declined the request; best plan so far returned.")
            break
        if response.stop_reason == "tool_use" and response.tool_calls:
            # replay_text is the TRUE assistant content: reasoning promoted
            # into .text for the feed must NOT be replayed into the history —
            # it ballooned self-hosted runs to ~25k input tokens per turn.
            assistant = ChatMessage(
                role="assistant",
                content=response.replay_text,
                tool_calls=response.tool_calls,
                raw_content=response.raw_content,
            )
            results = []
            for call in response.tool_calls:
                if cancel_event.is_set():
                    return finalize(
                        "ABORTED", ["Agent run aborted by user; best plan so far returned."]
                    )
                results.append(executor.execute(call.name, call.arguments, call.id))
            # Inspection-only rounds were invisible in the live feed, which
            # made slow runs look hung — surface what the agent looked at.
            emit_agent("tool_use", {"tools": [c.name for c in response.tool_calls]})
            messages.append(assistant)
            messages.append(ChatMessage(role="tool", tool_results=results))
            on_progress(
                "phase",
                {
                    "phase": "agent_loop",
                    "label": (
                        f"Agent (2/3): iteration {iterations_done}/{config.max_iterations}, "
                        f"{executor.moves_accepted} move(s) accepted..."
                    ),
                },
            )
            continue
        if response.stop_reason == "max_tokens":
            if truncation_nudges < 2:
                truncation_nudges += 1
                messages.append(
                    ChatMessage(
                        role="assistant",
                        content=response.replay_text or "(truncated)",
                        tool_calls=response.tool_calls,
                        raw_content=response.raw_content,
                    )
                )
                if response.tool_calls:
                    # A truncated tool_use turn still needs results before the
                    # next user message.
                    messages.append(
                        ChatMessage(
                            role="tool",
                            tool_results=[
                                executor.execute(c.name, c.arguments, c.id)
                                for c in response.tool_calls
                            ],
                        )
                    )
                messages.append(
                    ChatMessage(
                        role="user",
                        content=(
                            "Your reply was truncated. Respond with tool calls only, "
                            "or finish with a one-sentence summary."
                        ),
                    )
                )
                continue
            extra_notes.append("LLM output repeatedly truncated; best plan so far returned.")
            break
        # end_turn (or anything else): the model is done
        break
    else:
        extra_notes.append("Agent iteration budget exhausted; best plan so far returned.")

    # ------------------------------------------------------------------
    # Phase 3: finalize
    # ------------------------------------------------------------------
    on_progress(
        "phase", {"phase": "agent_finalize", "label": "Agent (3/3): Finalizing best plan..."}
    )
    return finalize("AGENT_COMPLETE", extra_notes)
