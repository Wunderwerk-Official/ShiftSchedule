"""
Phase 3: Fine Assignment (Section Matching per Band)

This phase assigns clinicians to specific positions (sections) within
the bands they've been assigned to in the coarse planning phase.

Algorithm:
1. For each band (Early, Late, Afternoon) in order:
   a. Collect all unfilled positions for this band
   b. For each position (sorted by priority/scarcity):
      - Get clinicians with matching pattern and location
      - Filter by qualification for this section
      - Match using greedy with preference ranking
"""

from typing import Callable, Dict, List, Optional, Tuple

from ..models import (
    Band,
    ClinicianDayState,
    EligibilityInfo,
    Pattern,
    Position,
    SlotInstance,
    pattern_contains_band,
)
from ..utils import calculate_slot_duration_minutes, has_overlap_with_assigned
from ...models import Clinician


def phase_fine_assignment(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    on_progress: Optional[Callable[[str, str, int, int], None]] = None,
) -> List[Position]:
    """Assign clinicians to specific positions within their assigned bands.

    Args:
        positions: All positions (modified in place)
        slot_instances_by_id: Lookup map for slot instances
        eligibility_matrix: Pre-computed eligibility for each position
        clinician_day_states: Current state per clinician/day (modified in place)
        clinicians_by_id: Lookup map for clinicians
        on_progress: Optional callback for progress updates

    Returns:
        Modified positions list
    """
    # Process bands in order: Early, Late, Afternoon
    # (Night is handled in phase 1)
    bands_order = [Band.EARLY, Band.LATE, Band.AFTERNOON]

    total_assigned = 0
    total_positions = sum(
        1 for p in positions
        if not p.is_manual
        and p.assigned_clinician_id is None
        and slot_instances_by_id.get(p.slot_instance_id)
        and slot_instances_by_id[p.slot_instance_id].band in bands_order
    )

    for band in bands_order:
        assigned_in_band = _assign_band_positions(
            band,
            positions,
            slot_instances_by_id,
            eligibility_matrix,
            clinician_day_states,
            clinicians_by_id,
        )
        total_assigned += assigned_in_band

        if on_progress:
            on_progress(
                "fine_assignment",
                f"Band {band.value}: {assigned_in_band} assigned",
                total_assigned,
                total_positions,
            )

    return positions


def _assign_band_positions(
    band: Band,
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
) -> int:
    """Assign positions for a specific band.

    Returns:
        Number of positions assigned
    """
    # Collect unfilled positions for this band
    band_positions = []
    for position in positions:
        if position.is_manual or position.assigned_clinician_id is not None:
            continue

        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst or slot_inst.band != band:
            continue

        # Only include required positions
        if slot_inst.required_count <= 0:
            continue

        band_positions.append(position)

    if not band_positions:
        return 0

    # Sort by scarcity (fewer eligible candidates = higher priority)
    def sort_key(p: Position) -> Tuple[int, str]:
        eligible_count = len(eligibility_matrix.get(p.id, []))
        slot_inst = slot_instances_by_id.get(p.slot_instance_id)
        date_iso = slot_inst.date_iso if slot_inst else "9999-99-99"
        return (eligible_count, date_iso)

    band_positions.sort(key=sort_key)

    assigned_count = 0

    for position in band_positions:
        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst:
            continue

        # Get eligible clinicians
        eligible = eligibility_matrix.get(position.id, [])

        # Filter to clinicians with matching pattern and location
        matching = []
        for e in eligible:
            key = (e.clinician_id, slot_inst.date_iso)
            state = clinician_day_states.get(key)

            if not state:
                continue

            # Pattern must include this band
            if not pattern_contains_band(state.pattern, band):
                continue

            # Location must match
            if state.location_id != slot_inst.location_id:
                continue

            # Check if already has too many assignments (max 3 per day as reasonable limit)
            if len(state.assigned_positions) >= 3:
                continue

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

            matching.append(e)

        if not matching:
            continue

        # Sort by score (already sorted in eligibility, but re-sort for safety)
        matching.sort(key=lambda e: e.score())

        # Choose the best candidate
        chosen = matching[0]

        # Assign the position
        position.assigned_clinician_id = chosen.clinician_id
        position.assignment_source = "solver"

        # Update clinician day state
        key = (chosen.clinician_id, slot_inst.date_iso)
        state = clinician_day_states[key]
        state.assigned_positions.append(position.id)
        state.hours_assigned += calculate_slot_duration_minutes(slot_inst) / 60.0

        assigned_count += 1

    return assigned_count
