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
from ..scoring import build_scoring_context, open_slots, plan_stats, score_plan
from ..validation import validate_solver_rules
from .config import AgentConfig
from .prompts import SYSTEM_PROMPT, build_problem_digest
from .provider import ChatMessage, LLMProvider, ToolSpec, get_provider
from .tools import TOOL_SPECS_RAW, PlanToolExecutor

# LLM loops need more wall clock than the CP-SAT default of 60s.
DEFAULT_AGENT_TIMEOUT_SECONDS = 300.0
# Leave this many seconds of headroom before the deadline for finalization.
DEADLINE_HEADROOM_SECONDS = 5.0
MAX_PER_CALL_TIMEOUT_SECONDS = 180.0

TOOL_SPECS = [
    ToolSpec(t["name"], t["description"], t["input_schema"]) for t in TOOL_SPECS_RAW
]


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
    emit_agent("stage", {"stage": "seed"})
    executor = PlanToolExecutor(
        state,
        ctx,
        seed_assignments,
        on_improvement=emit_solution,
        on_activity=emit_agent,
    )
    emit_solution(executor.seed_score, seed_assignments)

    def finalize(status: str, extra_notes: List[str]) -> dict:
        emit_agent("stage", {"stage": "finalize"})
        best = executor.best_assignments
        notes = [
            f"Agent solver: seed by heuristic v2, {iterations_done} LLM iteration(s), "
            f"{executor.moves_accepted} move(s) accepted, {executor.moves_rejected} rejected.",
        ]
        if executor.best_score < executor.seed_score:
            notes.append(
                f"Score improved from {executor.seed_score:.0f} to {executor.best_score:.0f}."
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
                    "iterations": iterations_done,
                    "moves_accepted": executor.moves_accepted,
                    "moves_rejected": executor.moves_rejected,
                    "input_tokens": total_input_tokens,
                    "output_tokens": total_output_tokens,
                    "seed_score": executor.seed_score,
                    "best_score": executor.best_score,
                },
            },
        }

    # ------------------------------------------------------------------
    # Phase 2: LLM repair loop
    # ------------------------------------------------------------------
    if config is None:
        config = AgentConfig.from_env()
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

    seed_stats = plan_stats(ctx, seed_assignments)
    seed_score = score_plan(ctx, seed_assignments)
    seed_open = open_slots(ctx, seed_assignments)
    soft_count = len(
        validate_solver_rules(state, executor.fixed_assignments + seed_assignments)
    )
    digest = build_problem_digest(
        state,
        ctx,
        seed_score,
        seed_stats,
        seed_open,
        new_hard_violation_count=0,  # seed violations ARE the baseline
        soft_violation_count=soft_count,
        max_iterations=config.max_iterations,
        clinician_aliases=executor.alias_by_id,
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
        if response.text:
            emit_agent("thought", {"text": response.text.strip()[:280]})

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
