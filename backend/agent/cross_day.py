"""Cross-day coverage repair: the step day-by-day planning cannot make.

Weekly hours (contract + tolerance per ISO week), rest days and work patterns
couple the days of a range, but the day loop staffs one day at a time and its
rescue/balance searches only rearrange that day. A person whose weekly hours
went to a long low-priority shift on Thursday then cannot cover Friday's slot
that only they are qualified for, and no tool ever undoes the Thursday choice
(observed in production, week 2026-W45: "Because both days are in the same
week, moving work between them doesn't free any weekly hours").

This module asks the CP-SAT model (backend/solver.py, the same hard rules the
gate checks) for the plan with the fewest missing required positions that
changes the agent's plan as little as possible (repair mode), then applies
the difference through the executor like any other proposal: the full gate
must accept it AND the active quality tuple must improve, so a repair never
trades away coverage, fixed entries or rule compliance.

The section order is binding (Settings: "If not every slot can be filled,
sections higher in this list are staffed first"): a repair may move a gap
to a lower-ranked section, never to a higher one. The CP-SAT model bounds
this per tier, and the result is checked again here before it is applied.
Among plans that fill as many positions, the model prefers the one whose
open positions sit lower in the list. A section ranks by its first entry in
that list, so its days and sub-shifts never outrank each other.
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional, Set, Tuple

from ..models import SolveRangeRequest

# Upper bound on changed assignments in one repair: enough for chains across
# a week (free a person on Monday, cover their Monday slot by someone else,
# give the freed hours to Friday), small enough to keep the agent's plan.
MAX_CHANGES = 60
# Below this, CP-SAT rarely improves a hinted plan; skip instead.
MIN_SECONDS = 5.0
# solver_status values of a returned solution (backend/solver.py).
SOLVED_STATUSES = {"OPTIMAL", "FEASIBLE", "GAP_CONVERGED"}


def repair_seconds(day_count: int) -> float:
    """Wall-clock budget for one repair over ``day_count`` days."""
    return float(min(120, 20 + 10 * max(1, int(day_count))))


def open_positions(executor) -> int:
    counts = executor._counts_by_instance(executor._working_list())
    return sum(max(0, inst.target - counts.get(inst.slot_key, 0))
               for inst in executor.ctx.instances.values())


def missing_by_tier(executor, working, tier_by_slot_id: Dict[str, int]) -> Dict[int, int]:
    """Missing required positions per section tier (0 = top of the list)."""
    counts = executor._counts_by_instance(working)
    lowest = max(tier_by_slot_id.values(), default=-1) + 1
    out: Dict[int, int] = {}
    for inst in executor.ctx.instances.values():
        missing = inst.target - counts.get(inst.slot_key, 0)
        if missing > 0:
            tier = tier_by_slot_id.get(inst.slot_id, lowest)
            out[tier] = out.get(tier, 0) + missing
    return out


def priority_trade_down(before: Dict[int, int], after: Dict[int, int]) -> Optional[int]:
    """The highest-ranked tier at which the repaired plan has more missing
    positions in that tier and all higher ones than before, None when the
    repair never trades a higher-ranked position for lower-ranked ones."""
    running_before = running_after = 0
    for tier in sorted(set(before) | set(after)):
        running_before += before.get(tier, 0)
        running_after += after.get(tier, 0)
        if running_after > running_before:
            return tier
    return None


def coverage_repair(executor, *, cancel_event, time_limit: float,
                    max_changes: int = MAX_CHANGES) -> dict:
    """Fill more required positions by changing assignments across days.

    Returns a report: status ("applied", "complete", "no_improvement",
    "rejected", "no_time", "error"), open positions before/after, the number
    of changed assignments and the seconds used. Never raises.
    """
    ex = executor
    ctx = ex.ctx
    began = time.time()
    working = ex._working_list()
    before = open_positions(ex)
    report: Dict[str, object] = {"open_before": before, "open_after": before, "changes": 0,
                                 "applied": False, "seconds": 0.0,
                                 # The best plan's quality tiers before the repair: the
                                 # arena compares the model's own plan with these.
                                 "quality_before": ex.quality_dict(ex.best_quality)}

    def done(status: str, **extra) -> dict:
        return {**report, **extra, "status": status, "seconds": round(time.time() - began, 1)}

    if before == 0:
        return done("complete")
    if cancel_event.is_set() or time_limit < MIN_SECONDS:
        return done("no_time")

    from ..solver import _solve_range_impl, section_tier_by_slot_id

    reference: Set[Tuple[str, str, str]] = {(a.rowId, a.dateISO, a.clinicianId) for a in working}
    payload = SolveRangeRequest(
        startISO=ctx.start_iso,
        endISO=ctx.end_iso,
        only_fill_required=ctx.only_fill_required,
        timeout_seconds=time_limit,
        solver_mode="cpsat",
    )
    try:
        result = _solve_range_impl(
            payload,
            None,
            cancel_event=cancel_event,
            on_progress=lambda *_args: None,
            start_time=time.time(),
            # The executor's state holds only the fixed context: protected
            # in-range entries and everything outside the range.
            state_override=ex.state,
            repair_reference=reference,
            repair_max_changes=max_changes,
        )
    except Exception as exc:  # pragma: no cover - defensive: never break a run
        return done("error", error=str(exc)[:300])
    if cancel_event.is_set():
        return done("no_time")
    status = getattr(getattr(result, "debugInfo", None), "solver_status", None)
    if status not in SOLVED_STATUSES:
        # No solution within the budget: keep the plan as it is.
        return done("no_improvement", solver_status=status)

    proposed = {(a.rowId, a.dateISO, a.clinicianId) for a in result.assignments
                if a.dateISO in ctx.target_date_set}
    removed = sorted(reference - proposed)
    added = sorted(proposed - reference)
    if not removed and not added:
        return done("no_improvement", solver_status=status)
    moves: List[dict] = (
        [{"action": "unassign", "slot_key": f"{slot}__{day}", "clinicianId": cid} for slot, day, cid in removed]
        + [{"action": "assign", "slot_key": f"{slot}__{day}", "clinicianId": cid} for slot, day, cid in added]
    )
    preview = ex._tool_apply_moves({"moves": moves, "dry_run": True})
    if not preview.get("valid") or not preview.get("improves_best"):
        reason = "invalid" if not preview.get("valid") else "not an improvement"
        rejected = preview.get("rejected") or preview.get("new_hard_violations") or []
        return done("rejected", reason=reason, solver_status=status, changes_proposed=len(moves),
                    sample=[str(item)[:160] for item in rejected[:3]])
    # The CP-SAT model is not the authority on the section order either.
    tiers = section_tier_by_slot_id(ex.state)
    after_plan = [ex._make_assignment(slot, day, cid) for slot, day, cid in proposed]
    trade_down = priority_trade_down(missing_by_tier(ex, working, tiers),
                                     missing_by_tier(ex, after_plan, tiers))
    if trade_down is not None:
        return done("rejected", reason="higher-ranked section left open", solver_status=status,
                    changes_proposed=len(moves), section=_tier_section(ex, trade_down))
    proposal = ex.workflow.propose(moves, next_tool=None, next_args={}, preview=preview)
    applied = ex.workflow.apply({"proposal_id": proposal.get("proposal_id")}) if proposal else {}
    if not applied.get("applied"):
        return done("rejected", reason="apply failed", solver_status=status, changes_proposed=len(moves))
    after = open_positions(ex)
    report.update(open_after=after, changes=len(moves), applied=True,
                  days=sorted({day for _slot, day, _cid in removed + added}),
                  quality_after=ex.quality_dict(ex.best_quality))
    return done("applied", solver_status=status)


def _tier_section(executor, tier: int) -> Optional[str]:
    blocks = (executor.state.weeklyTemplate.blocks or []) if executor.state.weeklyTemplate else []
    if not 0 <= tier < len(blocks):
        return None
    return executor.section_names.get(blocks[tier].sectionId, blocks[tier].sectionId)


def repair_note(report: Optional[dict]) -> Optional[str]:
    """One run-log sentence for an applied repair, None otherwise."""
    if not report or not report.get("applied"):
        return None
    gained = int(report["open_before"]) - int(report["open_after"])
    return (f"Cross-day repair filled {gained} more required position(s) by changing "
            f"{report['changes']} assignment(s) across days "
            f"({report['open_before']} -> {report['open_after']} open).")
