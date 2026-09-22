"""Shared baseline comparison for agent proposals and persisted draft application."""
from typing import Mapping, Tuple
from .validation import (
    Violation, VIOLATION_WEEKLY_HOURS, VIOLATION_SPLIT_SHIFT,
    VIOLATION_SAME_LOCATION, VIOLATION_OVERLAP, VIOLATION_ON_CALL_REST,
    VIOLATION_CAPACITY,
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
