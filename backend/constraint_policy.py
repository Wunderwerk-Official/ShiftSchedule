"""Shared baseline comparison for agent proposals, persisted draft application and swaps."""
from typing import Dict, Iterable, List, Mapping, Optional, Tuple
from .models import AppState, Assignment
from .validation import (
    ValidationContext, Violation, VIOLATION_WEEKLY_HOURS, VIOLATION_SPLIT_SHIFT,
    VIOLATION_SAME_LOCATION, VIOLATION_OVERLAP, VIOLATION_ON_CALL_REST,
    VIOLATION_CAPACITY, validate_assignments,
)


def violation_key(v: Violation) -> Tuple:
    if v.code == VIOLATION_WEEKLY_HOURS and v.context:
        # Keyed by ISO week (not the first assignment date, which shifts when
        # earlier-in-week assignments change) so the baseline diff is stable.
        return (v.code, v.clinician_id, v.context.get("iso_year"), v.context.get("iso_week"))
    if v.code in (VIOLATION_SPLIT_SHIFT, VIOLATION_SAME_LOCATION):
        # These are clinician-day groups; the validator's sample slot can
        # change when a repair removes the first assignment.
        return (v.code, v.clinician_id, v.date_iso)
    if v.code == VIOLATION_OVERLAP and v.context:
        pair = sorted(((v.date_iso or "", v.slot_id or ""),
                       (v.context.get("other_date_iso", ""), v.context.get("other_slot_id", ""))))
        return (v.code, v.clinician_id, *pair)
    if v.code == VIOLATION_ON_CALL_REST and v.context:
        return (v.code, v.clinician_id, v.date_iso, v.slot_id,
                v.context.get("on_call_date"), v.context.get("on_call_slot_id"))
    return (v.code, v.clinician_id, v.date_iso, v.slot_id)



def is_new_or_worsened(violation: Violation, baseline: Mapping[Tuple, dict]) -> bool:
    key = violation_key(violation)
    if key not in baseline:
        return True
    before, after = baseline[key] or {}, violation.context or {}
    if violation.code == VIOLATION_SPLIT_SHIFT:
        return after.get("blocks", 0) > before.get("blocks", 0)
    if violation.code == VIOLATION_SAME_LOCATION:
        return not set(after.get("locations", [])).issubset(before.get("locations", []))
    metric = {VIOLATION_WEEKLY_HOURS: "assigned_minutes", VIOLATION_CAPACITY: "count"}.get(violation.code)
    if metric:
        return after.get(metric, 0) > before.get(metric, 0)
    return False


def baseline_index(violations: Iterable[Violation]) -> Dict[Tuple, dict]:
    return {violation_key(v): v.context for v in violations}


def resolved_violations(baseline: Iterable[Violation], candidate: Iterable[Violation]) -> List[Violation]:
    """The ``baseline`` violations that ``candidate`` no longer has, or has in a
    milder form: what reverting the change brings back without being new."""
    index = baseline_index(candidate)
    return [v for v in baseline if is_new_or_worsened(v, index)]


def classify_violations(
    state: AppState,
    baseline: List[Assignment],
    candidate: List[Assignment],
    *,
    only_fill_required: bool = False,
    skip_references: bool = False,
    context: Optional[ValidationContext] = None,
    baseline_violations: Optional[Iterable[Violation]] = None,
    own_rest_days: bool = False,
) -> Tuple[List[Violation], List[Violation]]:
    """(new_or_worse, carried_over): the violations of ``candidate``, split by
    the apply gate's rule. ``baseline_violations`` (already computed for
    ``baseline`` with the same flags) skips validating the baseline again.
    ``own_rest_days``: both lists are whole plans (or slices that hold the Rest
    Day entries of every person-day they check), so each counts only its own
    Rest Days and one the candidate moved away or removed no longer counts."""
    def check(plan: List[Assignment]) -> List[Violation]:
        return validate_assignments(state, plan, only_fill_required=only_fill_required,
                                    skip_references=skip_references, context=context,
                                    own_rest_days=own_rest_days).violations

    before = list(baseline_violations) if baseline_violations is not None else check(baseline)
    index = baseline_index(before)
    new: List[Violation] = []
    carried: List[Violation] = []
    for v in check(candidate):
        (new if is_new_or_worsened(v, index) else carried).append(v)
    return new, carried


def new_violations(
    state: AppState,
    baseline: List[Assignment],
    candidate: List[Assignment],
    *,
    only_fill_required: bool = False,
    skip_references: bool = False,
    context: Optional[ValidationContext] = None,
    baseline_violations: Optional[Iterable[Violation]] = None,
    own_rest_days: bool = False,
) -> List[Violation]:
    """Violations of ``candidate`` that are new or worse than in ``baseline``
    (the gate of run apply and swaps)."""
    return classify_violations(
        state, baseline, candidate, only_fill_required=only_fill_required,
        skip_references=skip_references, context=context, baseline_violations=baseline_violations,
        own_rest_days=own_rest_days,
    )[0]
