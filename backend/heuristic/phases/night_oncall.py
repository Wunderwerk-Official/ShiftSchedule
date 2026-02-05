"""
Phase 1: Night and On-Call Assignment

This phase handles night shifts and on-call duties first because they
have the most constraints:
- They span multiple days (cross-day)
- They require rest days before and after
- They're typically the scarcest resource

Algorithm:
1. Filter all night/on-call positions
2. Sort by date (earliest first) and scarcity (fewest eligible first)
3. For each position:
   a. Get eligible clinicians (not blocked by rest, not on vacation)
   b. Score candidates by hours balance, preference, recent assignments
   c. Assign the best candidate
   d. Block rest days for that clinician
"""

from datetime import date, timedelta
from typing import Callable, Dict, List, Optional, Set, Tuple

from ..models import (
    Band,
    ClinicianDayState,
    EligibilityInfo,
    Pattern,
    Position,
    SlotInstance,
)
from ..utils import (
    calculate_slot_duration_minutes,
    get_blocked_dates_for_rest,
    has_overlap_with_assigned,
    is_night_or_oncall,
)


def phase_night_oncall(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    on_call_section_id: Optional[str],
    rest_days_before: int,
    rest_days_after: int,
    target_day_isos: List[str],
    on_progress: Optional[Callable[[str, str, int, int], None]] = None,
) -> Tuple[List[Position], Dict[Tuple[str, str], ClinicianDayState]]:
    """Assign night and on-call shifts first.

    Args:
        positions: All positions (modified in place)
        slot_instances_by_id: Lookup map for slot instances
        eligibility_matrix: Pre-computed eligibility for each position
        clinician_day_states: Current state per clinician/day (modified in place)
        on_call_section_id: The section ID for on-call shifts
        rest_days_before: Number of rest days required before on-call
        rest_days_after: Number of rest days required after on-call
        target_day_isos: List of dates in the solve range
        on_progress: Optional callback for progress updates

    Returns:
        Tuple of (positions, clinician_day_states) - both modified
    """
    # Track blocked dates per clinician due to rest requirements
    blocked_dates_by_clinician: Dict[str, Set[str]] = {}

    # Filter to night/on-call positions
    night_positions = [
        p for p in positions
        if not p.is_manual
        and p.assigned_clinician_id is None
        and is_night_or_oncall(
            slot_instances_by_id.get(p.slot_instance_id),
            on_call_section_id
        )
        if slot_instances_by_id.get(p.slot_instance_id) is not None
    ]

    if not night_positions:
        return positions, clinician_day_states

    # Sort by:
    # 1. Date (earliest first)
    # 2. Eligibility count (scarcest first - fewer options = higher priority)
    def sort_key(p: Position) -> Tuple[str, int]:
        inst = slot_instances_by_id.get(p.slot_instance_id)
        date_iso = inst.date_iso if inst else "9999-99-99"
        eligible_count = len(eligibility_matrix.get(p.id, []))
        return (date_iso, eligible_count)

    night_positions.sort(key=sort_key)

    assigned_count = 0
    total_count = len(night_positions)

    for idx, position in enumerate(night_positions):
        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst:
            continue

        # Get eligible clinicians
        eligible = eligibility_matrix.get(position.id, [])

        # Filter out clinicians blocked by rest days
        available = []
        for e in eligible:
            blocked_dates = blocked_dates_by_clinician.get(e.clinician_id, set())
            if slot_inst.date_iso in blocked_dates:
                continue

            # Check if already assigned to this day
            day_state = clinician_day_states.get((e.clinician_id, slot_inst.date_iso))
            if day_state and day_state.pattern == Pattern.N:
                continue  # Already has a night shift

            # CRITICAL: Check for time overlap with existing assignments
            if has_overlap_with_assigned(
                e.clinician_id,
                slot_inst.date_iso,
                slot_inst,
                clinician_day_states,
                positions,
                slot_instances_by_id,
            ):
                continue

            available.append(e)

        if not available:
            continue

        # Score candidates
        # Prefer: lower hours deficit, not recently on-call, better preference
        scored = []
        for e in available:
            score = e.score()

            # Add bonus for clinicians with fewer night hours (load balancing)
            # This is a simple heuristic - could be more sophisticated
            recent_nights = _count_recent_assignments(
                e.clinician_id,
                slot_inst.date_iso,
                clinician_day_states,
                days_back=14,
            )
            score += recent_nights * 50  # Penalty for recent night work

            scored.append((score, e))

        scored.sort(key=lambda x: x[0])
        chosen = scored[0][1]

        # Assign the position
        position.assigned_clinician_id = chosen.clinician_id
        position.assignment_source = "solver"

        # Update clinician day state
        key = (chosen.clinician_id, slot_inst.date_iso)
        if key not in clinician_day_states:
            clinician_day_states[key] = ClinicianDayState(
                clinician_id=chosen.clinician_id,
                date_iso=slot_inst.date_iso,
            )

        state = clinician_day_states[key]
        state.pattern = Pattern.N
        state.location_id = slot_inst.location_id
        state.assigned_positions.append(position.id)
        state.hours_assigned += calculate_slot_duration_minutes(slot_inst) / 60.0

        # Block rest days if this is an on-call shift
        if on_call_section_id and slot_inst.section_id == on_call_section_id:
            blocked = get_blocked_dates_for_rest(
                slot_inst.date_iso,
                rest_days_before,
                rest_days_after,
            )
            blocked_dates_by_clinician.setdefault(chosen.clinician_id, set()).update(blocked)

            # Also mark these days as rest days in clinician_day_states
            for blocked_date in blocked:
                if blocked_date in target_day_isos:
                    rest_key = (chosen.clinician_id, blocked_date)
                    if rest_key not in clinician_day_states:
                        clinician_day_states[rest_key] = ClinicianDayState(
                            clinician_id=chosen.clinician_id,
                            date_iso=blocked_date,
                        )
                    clinician_day_states[rest_key].is_rest_day = True

        assigned_count += 1

        if on_progress:
            on_progress("night_oncall", f"Assigned {assigned_count}/{total_count}",
                       assigned_count, total_count)

    return positions, clinician_day_states


def _count_recent_assignments(
    clinician_id: str,
    reference_date_iso: str,
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    days_back: int = 14,
) -> int:
    """Count how many night shifts a clinician has in recent days."""
    count = 0
    ref_date = date.fromisoformat(reference_date_iso)

    for offset in range(1, days_back + 1):
        check_date = (ref_date - timedelta(days=offset)).isoformat()
        state = clinician_day_states.get((clinician_id, check_date))
        if state and state.pattern == Pattern.N:
            count += 1

    return count
