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
from typing import Any, Callable, Dict, List, Optional

from ..heuristic.solver_v2 import heuristic_solve_range_v2
from ..models import Assignment, SolveRangeRequest, AppState
from ..scoring import build_scoring_context, open_slots, plan_stats
from ..validation import validate_solver_rules
from .config import AgentConfig
from .prompts import DEFAULT_AGENT_INSTRUCTIONS, SYSTEM_PROMPT, build_problem_digest
from .provider import ChatMessage, LLMProvider, ToolSpec, get_provider
from .tools import TOOL_SPECS_RAW, PlanToolExecutor

# LLM loops need more wall clock than the CP-SAT default of 60s.
DEFAULT_AGENT_TIMEOUT_SECONDS = 300.0

# History compaction: once the tool results in the conversation exceed this
# budget, everything but the most recent exchanges is replaced by a stub in
# ONE go. Chunked (not per-iteration) so the prompt-cache prefix stays
# byte-stable between compactions — trimming one message per round would
# invalidate the cache on every call.
TOOL_HISTORY_BUDGET_CHARS = 120_000
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
MAX_PER_CALL_TIMEOUT_SECONDS = 180.0

TOOL_SPECS = [
    ToolSpec(t["name"], t["description"], t["input_schema"]) for t in TOOL_SPECS_RAW
]


def _quality_improvement_note(seed_q, best_q) -> str:
    """Human-readable summary of which quality tiers the agent improved.

    Mirrors the lexicographic tuple in ``PlanToolExecutor._quality``; only
    components that actually changed are mentioned.
    """
    parts: List[str] = []
    for label, idx in (
        ("open required slots", 0),
        ("short work days", 1),
        ("soft-rule violations", 2),
    ):
        if seed_q[idx] != best_q[idx]:
            parts.append(f"{label} {seed_q[idx]} -> {best_q[idx]}")
    if seed_q[3] != best_q[3]:
        parts.append(f"weekly-hours deviation {seed_q[3]} -> {best_q[3]} min")
    if seed_q[4] != best_q[4]:
        parts.append(f"preference/load bonus {-seed_q[4]} -> {-best_q[4]}")
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
    timeout = payload.timeout_seconds or DEFAULT_AGENT_TIMEOUT_SECONDS
    deadline = start_time + timeout

    # ------------------------------------------------------------------
    # Phase 1: seed plan from the heuristic
    # ------------------------------------------------------------------
    on_progress(
        "phase",
        {"phase": "agent_seed", "label": "Agent (1/3): Building seed plan with heuristic..."},
    )

    def muted_progress(event_type: str, data: dict) -> None:
        # Forward the heuristic's phase updates so the overlay stays alive,
        # but suppress its per-day solution events: the agent emits its own
        # solution stream on a consistent objective scale.
        if event_type == "phase":
            on_progress(event_type, data)

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
        return {
            "open_slots_seed": [fmt_open(g) for g in seed_open[:80]],
            "open_slots_final": [fmt_open(g) for g in remaining_open[:80]],
            "final_plan": plan_lines[:300],
            "violations_final": violation_lines[:90],
            "thoughts": [t[:800] for t in thought_log[:60]],
        }

    def finalize(status: str, extra_notes: List[str]) -> dict:
        emit_agent("stage", {"stage": "finalize"})
        best = executor.best_assignments
        notes = [
            f"Agent solver: seed by heuristic v2, {iterations_done} LLM iteration(s), "
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
        else:
            notes.append("No improvement over the heuristic seed; returning the seed plan.")
        notes.extend(extra_notes)
        notes.extend(n for n in seed_notes if "WARNING" in n or "warning" in n)
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
    # The model can be chosen per workspace in the app settings; a value there
    # overrides the AGENT_MODEL env default. solverSettings is a plain dict on
    # AppState.
    settings_model = (state.solverSettings or {}).get("agentModel")
    if isinstance(settings_model, str) and settings_model.strip():
        config.model = settings_model.strip()
    if provider is None:
        try:
            provider = get_provider(config)
        except Exception as exc:
            # Phrasing matters: the frontend surfaces notes containing
            # "could not" as a warning toast, and matches "Agent LLM
            # unavailable" to show a persistent error in the planning panel.
            return finalize(
                "AGENT_FALLBACK_SEED",
                [
                    f"Agent LLM unavailable — the AI agent could not start: {exc} "
                    "The heuristic draft plan was returned instead."
                ],
            )

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
    )
    # Free-text guidance from the admin (Settings -> "AI agent instructions").
    # The admin writes real clinician names; scrub_text swaps them for the
    # aliases before anything leaves the backend. None/absent falls back to
    # the default; an explicitly emptied field means "no instructions".
    admin_instructions = (state.solverSettings or {}).get("agentInstructions")
    if not isinstance(admin_instructions, str):
        admin_instructions = DEFAULT_AGENT_INSTRUCTIONS
    admin_instructions = admin_instructions.strip()[:2000]
    if admin_instructions:
        digest += (
            "\n\nADMIN INSTRUCTIONS (soft goals from the planning admin; never "
            "override hard constraints or fixed assignments):\n"
            + executor.scrub_text(admin_instructions)
        )
    messages: List[ChatMessage] = [ChatMessage(role="user", content=digest)]
    extra_notes: List[str] = []
    nudged_on_truncation = False
    emit_agent("stage", {"stage": "improve"})

    while iterations_done < config.max_iterations:
        if cancel_event.is_set():
            return finalize("ABORTED", ["Agent run aborted by user; best plan so far returned."])
        remaining = deadline - time.time()
        if remaining <= DEADLINE_HEADROOM_SECONDS:
            extra_notes.append("Agent time budget exhausted; best plan so far returned.")
            break

        per_call_timeout = min(
            max(remaining - DEADLINE_HEADROOM_SECONDS, 10.0), MAX_PER_CALL_TIMEOUT_SECONDS
        )
        _compact_tool_history(messages)
        emit_agent("iteration", {"iteration": iterations_done + 1})
        response = provider.complete(
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOL_SPECS,
            timeout_seconds=per_call_timeout,
        )
        iterations_done += 1
        total_input_tokens += response.usage.get("input_tokens", 0)
        total_output_tokens += response.usage.get("output_tokens", 0)
        total_cache_read_tokens += response.usage.get("cache_read_input_tokens", 0)
        total_cache_creation_tokens += response.usage.get("cache_creation_input_tokens", 0)
        if response.text:
            # The model writes aliases (D1, ...); restore real names for the
            # user-facing feed and remember the latest text as the run summary.
            final_summary = executor.unscrub_text(response.text.strip())
            thought_log.append(f"[iteration {iterations_done}] {final_summary}")
            emit_agent("thought", {"text": final_summary[:280]})

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
            assistant = ChatMessage(
                role="assistant",
                content=response.text,
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
            if not nudged_on_truncation:
                nudged_on_truncation = True
                messages.append(
                    ChatMessage(
                        role="assistant",
                        content=response.text or "(truncated)",
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
