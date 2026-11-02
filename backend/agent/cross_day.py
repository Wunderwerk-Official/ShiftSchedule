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

The section order is strict (Settings: "If not every slot can be filled,
sections higher in this list are staffed first"; v1.81): one open position
in a higher section is worse than any number lower down, also when more
positions stay open in total. The CP-SAT search optimizes the open
positions section by section from the top, then the number of changes, and
the gate's quality tuple compares the same section vector first, so the
plan is applied only when it is better in that order. A section ranks by its
first entry in that list, so its days and sub-shifts never outrank each
other.
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


def first_difference(before, after) -> Optional[int]:
    """Index of the first entry where two section vectors differ, None when
    they are equal: that entry decides which plan is better."""
    return next((i for i, (a, b) in enumerate(zip(before, after)) if a != b), None)


def coverage_repair(executor, *, cancel_event, time_limit: float,
                    max_changes: int = MAX_CHANGES) -> dict:
    """Staff more required positions, higher sections first (strictly), by
    changing assignments across days.

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

    from ..solver import _solve_range_impl

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
    if not preview.get("valid"):
        rejected = preview.get("rejected") or preview.get("new_hard_violations") or []
        return done("rejected", reason="invalid", solver_status=status, changes_proposed=len(moves),
                    sample=[str(item)[:160] for item in rejected[:3]])
    if not preview.get("improves_best"):
        # The CP-SAT model is not the authority on the section order: the
        # gate's tuple compares the same section vector first.
        before_vector = ex.quality_dict(ex.best_quality)["open_by_section_order"]
        after_vector = preview["quality_after"]["open_by_section_order"]
        index = first_difference(before_vector, after_vector)
        if index is not None and after_vector[index] > before_vector[index]:
            return done("rejected", reason="higher-ranked section left open", solver_status=status,
                        changes_proposed=len(moves), section=ex.section_order[index])
        return done("rejected", reason="not an improvement", solver_status=status, changes_proposed=len(moves))
    by_section_before = list(ex._open_by_section_order(working))
    proposal = ex.workflow.propose(moves, next_tool=None, next_args={}, preview=preview)
    applied = ex.workflow.apply({"proposal_id": proposal.get("proposal_id")}) if proposal else {}
    if not applied.get("applied"):
        return done("rejected", reason="apply failed", solver_status=status, changes_proposed=len(moves))
    after = open_positions(ex)
    by_section_after = list(ex._open_by_section_order(ex._working_list()))
    index = first_difference(by_section_before, by_section_after)
    report.update(open_after=after, changes=len(moves), applied=True,
                  days=sorted({day for _slot, day, _cid in removed + added}),
                  # The highest-ranked section the repair staffed better.
                  section=ex.section_order[index] if index is not None else None,
                  # [section, open before, open after], top first.
                  sections_changed=[[ex.section_order[i], b, a]
                                    for i, (b, a) in enumerate(zip(by_section_before, by_section_after)) if b != a],
                  quality_after=ex.quality_dict(ex.best_quality))
    return done("applied", solver_status=status)


def repair_note(report: Optional[dict]) -> Optional[str]:
    """One run-log sentence for an applied repair, None otherwise."""
    if not report or not report.get("applied"):
        return None
    before, after = int(report["open_before"]), int(report["open_after"])
    sections = report.get("sections_changed") or []
    shown = ", ".join(f"{name} {old} -> {new}" for name, old, new in sections[:4])
    if len(sections) > 4:
        shown += f" and {len(sections) - 4} more section(s)"
    detail = f"{before} -> {after} open" + (f"; {shown}" if shown else "")
    if after < before:
        return (f"Cross-day repair filled {before - after} more required position(s) by changing "
                f"{report['changes']} assignment(s) across days ({detail}).")
    # Strict section order: higher sections staffed, even if more stay open.
    return (f"Cross-day repair changed {report['changes']} assignment(s) across days to staff "
            f"higher sections first ({detail}).")
