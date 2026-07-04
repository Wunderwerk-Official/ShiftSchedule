"""Prompts for the planning agent.

The system prompt is static (cache-friendly: it renders right after the tool
definitions and stays byte-identical across loop iterations). The per-solve
problem digest goes into the first user message.
"""

from __future__ import annotations

from typing import Dict, List

from ..models import AppState
from ..scoring import PlanScore, PlanStats, OpenSlot, ScoringContext

# Applied when the admin has not written their own instructions (Settings ->
# Solver -> "AI agent instructions"). Keep in sync with the frontend copy in
# src/lib/agentSettings.ts, which pre-fills the settings textarea.
DEFAULT_AGENT_INSTRUCTIONS = (
    "Prefer long, continuous assignments. Never schedule someone for just one "
    "or two hours: it is better that one person covers a longer block (at "
    "least half a day) and another person stays completely off. Prefer "
    "keeping the same person on consecutive days over spreading short stints "
    "across many people."
)

SYSTEM_PROMPT = """You are an expert clinician shift-schedule repair agent.

A deterministic heuristic has produced a seed plan for the given date range.
Your job is to improve it: fill open slots, repair any rule violations, and
improve the soft objectives — using the provided tools on a working copy of
the plan. The harness always keeps the best plan you produce; you cannot make
the final result worse than the seed.

Hard constraints (violations of these block acceptance of a move batch):
- Qualification: clinicians only work sections they are qualified for.
- Vacation: no assignments while a clinician is on vacation.
- No overlapping shifts, including overnight shifts crossing midnight.
- Same location per day (when enforced by settings).
- Rest days before/after on-call shifts (when enforced by settings).
- Mandatory working-time windows must contain the whole shift.
- Weekly hours must stay within contract + tolerance per ISO week.
- No split shifts: one contiguous block per clinician per day (when enforced).
- Capacity: a slot instance never takes more people than required (+headroom
  in distribute-all mode).
- Fixed assignments (made by humans or previous runs) are immutable.

Soft objectives, in rough order of weight (the score is minimized):
1. Coverage: fill required slots; open slots are the biggest penalty.
2. Balanced weekly hours: keep everyone near contract hours.
3. Custom if/then rules (SOLVER_RULE, severity "soft"): fix when possible.
4. Year-to-date fairness: every candidate carries ytd_worked_pct — the
   percent of their year-to-date target hours already worked up to the
   slot's day (100 = on target, lower = behind). Prefer the clinician with
   the LOWEST ytd_worked_pct among equally suitable candidates; the goal is
   that everyone converges to the same percentage of their contract.
   list_candidates_for_slot sorts eligible candidates most-behind first;
   get_ytd_progress shows the whole roster at a glance.
5. Section preferences and preferred time windows.

Privacy: clinicians are referred to by anonymized ids (D1, D2, ...) — you
never see real names. Always use these ids in tool calls.

The problem digest may end with ADMIN INSTRUCTIONS written by the planning
admin. Treat them as important soft goals: follow them whenever possible, but
they never override the hard constraints or fixed assignments above.

Tool usage policy:
- Inspect before you move: list_candidates_for_slot tells you exactly which
  clinicians are legal for a slot and why others are not.
- Batch related moves in one apply_moves call (a swap = unassign + assign).
- A rejected batch returns the violations it would have created — adjust the
  plan instead of retrying the same moves.
- Only your own assignments can be unassigned; fixed assignments cannot.
- The plan may contain pre-existing violations from manual data; those are
  marked new=false and do not block you. Only NEW violations block.

Finish by replying WITHOUT tool calls when you find no further legal
improvement. Do not narrate every step; keep any text brief. Work within your
iteration budget: prefer high-impact fixes (open slots) first."""


def build_problem_digest(
    state: AppState,
    ctx: ScoringContext,
    seed_score: PlanScore,
    seed_stats: PlanStats,
    seed_open: List[OpenSlot],
    new_hard_violation_count: int,
    soft_violation_count: int,
    max_iterations: int,
    clinician_aliases: Dict[str, str],
) -> str:
    """Compact first user message. Deep data is fetched via tools.

    Clinicians appear only under their pseudonymous alias (see
    ``tools.build_clinician_aliases``): real names and real ids never reach
    the LLM, and the short aliases keep the roster table token-cheap.
    """
    sections = {r.id: r.name for r in state.rows if r.kind == "class"}
    lines: List[str] = []
    lines.append(
        f"Solve range: {ctx.start_iso} to {ctx.end_iso} "
        f"({len(ctx.target_day_isos)} days), mode: "
        + ("only-fill-required" if ctx.only_fill_required else "distribute-all")
    )
    lines.append("")
    lines.append("Sections: " + ", ".join(f"{sid}={name}" for sid, name in sections.items()))
    lines.append("")
    lines.append(
        "Roster (id|qualified|preferred|contract h/wk|ytd worked % of target, "
        "100=on target, lower=behind):"
    )
    for c in state.clinicians:
        deficit = ctx.ytd_deficit_pct.get(c.id)
        worked_pct = (100 - deficit) if deficit is not None else "-"
        lines.append(
            f"- {clinician_aliases.get(c.id, c.id)}|{','.join(c.qualifiedClassIds)}"
            f"|{','.join(c.preferredClassIds or []) or '-'}"
            f"|{c.workingHoursPerWeek if c.workingHoursPerWeek is not None else '-'}"
            f"|{worked_pct}"
        )
    lines.append("")
    lines.append(
        f"Seed plan: {seed_stats.filled_slots}/{seed_stats.total_required_slots} "
        f"required positions filled, {seed_stats.open_slots} open, "
        f"score {seed_score.total:.0f} (lower is better)."
    )
    lines.append(
        f"Violations: {new_hard_violation_count} new hard, "
        f"{soft_violation_count} soft rule violations."
    )
    if seed_open:
        lines.append("")
        lines.append("Top open slots (slot_key|section|time|missing):")
        for gap in seed_open[:15]:
            lines.append(
                f"- {gap.slot_key}|{gap.section_id}|{gap.start}-{gap.end}|{gap.missing}"
            )
        if len(seed_open) > 15:
            lines.append(f"... and {len(seed_open) - 15} more (list_open_slots).")
    lines.append("")
    lines.append(
        f"You have up to {max_iterations} tool-use rounds. Improve the plan, "
        "then finish with a brief summary of what you changed."
    )
    return "\n".join(lines)
