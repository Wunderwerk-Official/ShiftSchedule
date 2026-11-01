"""Why a required slot stayed open, for the run's closing report.

For every still-open slot: how many qualified people are not on it, how
many of them could be added directly (normally none after the final audit)
and how many each hard rule blocks. The check is the final audit's own
(``_direct_addition_codes``), so right after the audit it mostly reads
cached results. Bounded by slot count and time: a large range never waits
on its closing report.
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Dict, List, Optional

# Display order doubles as the tie-break for a slot's main reason.
RULE_LABELS = {
    "WEEKLY_HOURS": "weekly-hours limit",
    "VACATION": "vacation",
    "OVERLAP": "overlapping shift",
    "SAME_LOCATION_PER_DAY": "other site that day",
    "SPLIT_SHIFT": "split shift",
    "ON_CALL_REST": "on-call rest",
    "MANDATORY_WINDOW": "mandatory working time",
    "SOLVER_RULE": "shift rule",
    "CAPACITY_EXCEEDED": "slot full",
    "QUALIFICATION": "not qualified",
}
NO_QUALIFIED = "NO_QUALIFIED"
MAX_SLOTS = 40
MAX_SECONDS = 10.0


def rule_label(code: str) -> str:
    return RULE_LABELS.get(code, code.lower().replace("_", " "))


def _main_reason(qualified: int, addable: int, blocked: Counter) -> Optional[str]:
    if addable:
        return None  # not a rule problem: someone can still be added
    if not qualified:
        return NO_QUALIFIED
    order = list(RULE_LABELS)
    return min(blocked, key=lambda code: (-blocked[code], order.index(code) if code in order else len(order), code),
               default=None)


def open_slot_blockers(executor, gaps, *, max_slots: int = MAX_SLOTS,
                       max_seconds: float = MAX_SECONDS,
                       deadline: Optional[float] = None) -> Dict[str, dict]:
    """Blocking rules per open slot (``OpenSlot`` list), keyed by slot_key.

    The executor's working copy must be the returned plan. Slots beyond
    ``max_slots`` or past the time limit are left out, never guessed.
    """
    stop = time.time() + max_seconds
    if deadline is not None:
        stop = min(stop, deadline)
    out: Dict[str, dict] = {}
    for gap in gaps[:max_slots]:
        qualified = addable = 0
        blocked: Counter = Counter()
        for clinician in executor.state.clinicians:
            if gap.section_id not in (clinician.qualifiedClassIds or []):
                continue
            key = (gap.slot_id, gap.dateISO, clinician.id)
            if key in executor.current or key in executor.fixed_identity:
                continue
            if time.time() > stop:
                return out
            qualified += 1
            codes = executor._direct_addition_codes(gap.slot_id, gap.dateISO, clinician.id)
            if not codes:
                addable += 1
            blocked.update(codes)
        out[gap.slot_key] = {
            "qualified": qualified,
            "addable": addable,
            "blocked_by": dict(sorted(blocked.items(), key=lambda kv: (-kv[1], kv[0]))),
            "main": _main_reason(qualified, addable, blocked),
        }
    return out


def blocker_text(blockers: dict) -> str:
    """'6 qualified; blocked by weekly-hours limit 4, vacation 1'."""
    if not blockers["qualified"]:
        return "nobody qualified is available"
    parts: List[str] = [f"{blockers['qualified']} qualified"]
    if blockers["addable"]:
        parts.append(f"{blockers['addable']} could be added directly")
    if blockers["blocked_by"]:
        parts.append("blocked by " + ", ".join(
            f"{rule_label(code)} {count}" for code, count in blockers["blocked_by"].items()))
    return "; ".join(parts)
