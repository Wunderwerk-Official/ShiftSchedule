"""Why a required slot stayed open, for the run's closing report.

For every still-open slot: how many qualified people are not on it (and
how many already are), how many of them could be added directly (normally
none after the final audit) and how many each hard rule blocks. The check
is the final audit's own (``_direct_addition_codes``), so right after the
audit it mostly reads cached results; without a finished audit every check
is a full validation, so callers pass a smaller budget there. Bounded by
slot count, time and the run's stop: a large range never waits on its
closing report, and slots past a bound are left out, never guessed.
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Dict, List, Optional

# Display order doubles as the tie-break for a slot's main reason; the
# frontend (src/lib/solverOutcome.ts) uses the same labels and order.
RULE_LABELS = {
    "WEEKLY_HOURS": "weekly-hours limit",
    "VACATION": "vacation",
    "REST_DAY": "rest day",
    "OVERLAP": "overlapping shift",
    "SAME_LOCATION_PER_DAY": "other location that day",
    "SPLIT_SHIFT": "split shift",
    "ON_CALL_REST": "on-call rest",
    "MANDATORY_WINDOW": "mandatory working time",
    "SOLVER_RULE": "shift rule",
    "CAPACITY_EXCEEDED": "slot full",
    "QUALIFICATION": "not qualified",
}
# Main reason when no qualified person is left to add: nobody is qualified,
# or everyone qualified already works this slot.
NO_QUALIFIED = "NO_QUALIFIED"
MAX_SLOTS = 40
MAX_SECONDS = 10.0
# Without a finished final audit the cache is cold (one full validation per
# check): only the slots the readable notes show, briefly.
COLD_SLOTS = 12
COLD_SECONDS = 2.0


# A person away that day is away whatever else would block them: the
# absence is their reason, not their weekly hours (a hand-placed rest day
# often follows a heavy week, so both apply).
ABSENCES = ("VACATION", "REST_DAY")


def rule_label(code: str) -> str:
    return RULE_LABELS.get(code, code.lower().replace("_", " "))


def _rank(code: str) -> int:
    order = list(RULE_LABELS)
    return order.index(code) if code in order else len(order)


def _primary_reasons(codes) -> List[str]:
    """The rules a blocked person counts under for the main reason: an
    absent person only under the absence (vacation before rest day), anyone
    else under every rule that blocks them."""
    absent = [code for code in codes if code in ABSENCES]
    if absent:
        return [min(absent, key=lambda code: (_rank(code), code))]
    return sorted(set(codes))


def _main_reason(qualified: int, addable: int, primary: Counter) -> Optional[str]:
    """The rule most qualified people are blocked by (an absent person
    counts only under the absence, see _primary_reasons); ties in the
    RULE_LABELS order."""
    if addable:
        return None  # not a rule problem: someone can still be added
    if not qualified:
        return NO_QUALIFIED
    return min(primary, key=lambda code: (-primary[code], _rank(code), code), default=None)


def open_slot_blockers(executor, gaps, *, max_slots: int = MAX_SLOTS,
                       max_seconds: float = MAX_SECONDS,
                       deadline: Optional[float] = None,
                       cancel_event=None) -> Dict[str, dict]:
    """Blocking rules per open slot (``OpenSlot`` list), keyed by slot_key.

    The executor's working copy must be the returned plan. Slots beyond
    ``max_slots``, past the time limit or after a stop are left out.
    """
    stop = time.time() + max_seconds
    if deadline is not None:
        stop = min(stop, deadline)
    out: Dict[str, dict] = {}
    for gap in gaps[:max_slots]:
        qualified = addable = on_slot = 0
        blocked: Counter = Counter()
        primary: Counter = Counter()
        for clinician in executor.state.clinicians:
            if gap.section_id not in (clinician.qualifiedClassIds or []):
                continue
            key = (gap.slot_id, gap.dateISO, clinician.id)
            if key in executor.current or key in executor.fixed_identity:
                on_slot += 1
                continue
            if time.time() > stop or (cancel_event is not None and cancel_event.is_set()):
                return out
            qualified += 1
            codes = executor._direct_addition_codes(gap.slot_id, gap.dateISO, clinician.id)
            if not codes:
                addable += 1
                continue
            blocked.update(codes)
            primary.update(_primary_reasons(codes))
        out[gap.slot_key] = {
            "qualified": qualified,
            "on_slot": on_slot,
            "addable": addable,
            # Every rule that blocks someone, most people first (one person
            # may count for several rules); ties in the RULE_LABELS order.
            "blocked_by": dict(sorted(blocked.items(), key=lambda kv: (-kv[1], _rank(kv[0]), kv[0]))),
            "main": _main_reason(qualified, addable, primary),
        }
    return out


def blocker_text(blockers: dict) -> str:
    """'6 qualified; blocked by weekly-hours limit 4, vacation 1'."""
    if not blockers["qualified"]:
        on_slot = blockers.get("on_slot", 0)
        return (f"no other qualified person ({on_slot} already on it)" if on_slot
                else "nobody is qualified")
    parts: List[str] = [f"{blockers['qualified']} qualified"]
    if blockers["addable"]:
        parts.append(f"{blockers['addable']} could be added directly")
    if blockers["blocked_by"]:
        parts.append("blocked by " + ", ".join(
            f"{rule_label(code)} {count}" for code, count in blockers["blocked_by"].items()))
    return "; ".join(parts)
