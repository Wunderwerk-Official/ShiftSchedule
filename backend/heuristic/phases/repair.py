"""
Phase 4: Repair Loops

This phase attempts to fill positions that couldn't be assigned in
the earlier phases. It uses various strategies:

1. Pattern Extension: Upgrade a clinician's pattern (OFF→F, F→FS, etc.)
2. Location Swap: Move clinicians between locations (if allowed)
3. Swap Chain: Swap assignments to free up qualified clinicians

Algorithm:
1. Find all unfilled required positions
2. For each unfilled position (sorted by scarcity):
   a. Try pattern extension for eligible clinicians
   b. Try swap with lower-priority positions
   c. If all fails, mark reason for unfilled
"""

from typing import Callable, Dict, List, Optional, Set, Tuple

from ..models import (
    Band,
    ClinicianDayState,
    EligibilityInfo,
    Pattern,
    Position,
    SlotInstance,
    UnfilledPosition,
    UnfilledReason,
    can_upgrade_pattern,
    get_pattern_bands,
    bands_to_pattern,
)
from ..utils import calculate_slot_duration_minutes, has_overlap_with_assigned
from ...models import Clinician, SolverSettings


def phase_repair(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    solver_settings: SolverSettings,
    max_iterations: int = 100,
    on_progress: Optional[Callable[[str, str, int, int], None]] = None,
) -> Tuple[List[Position], List[UnfilledPosition]]:
    """Attempt to repair unfilled positions.

    Args:
        positions: All positions (modified in place)
        slot_instances_by_id: Lookup map for slot instances
        eligibility_matrix: Pre-computed eligibility for each position
        clinician_day_states: Current state per clinician/day (modified in place)
        clinicians_by_id: Lookup map for clinicians
        solver_settings: Solver configuration
        max_iterations: Maximum repair iterations
        on_progress: Optional callback for progress updates

    Returns:
        Tuple of (positions, list of unfilled positions with reasons)
    """
    unfilled_reasons: List[UnfilledPosition] = []

    for iteration in range(max_iterations):
        # Find unfilled required positions
        unfilled = _get_unfilled_required(positions, slot_instances_by_id)

        if not unfilled:
            break

        # Sort by scarcity (fewer eligible = try first)
        unfilled.sort(key=lambda p: len(eligibility_matrix.get(p.id, [])))

        improved = False

        for position in unfilled:
            slot_inst = slot_instances_by_id.get(position.slot_instance_id)
            if not slot_inst:
                continue

            # Try strategy 1: Pattern extension
            assigned = _try_pattern_extension(
                position,
                slot_inst,
                eligibility_matrix,
                clinician_day_states,
                clinicians_by_id,
                solver_settings,
                positions,
                slot_instances_by_id,
            )

            if assigned:
                improved = True
                break

            # Try strategy 2: New assignment (clinician with OFF pattern)
            assigned = _try_new_assignment(
                position,
                slot_inst,
                eligibility_matrix,
                clinician_day_states,
                clinicians_by_id,
                solver_settings,
                positions,
                slot_instances_by_id,
            )

            if assigned:
                improved = True
                break

        if not improved:
            break

        if on_progress:
            remaining = len(_get_unfilled_required(positions, slot_instances_by_id))
            on_progress(
                "repair",
                f"Iteration {iteration + 1}, {remaining} unfilled",
                iteration + 1,
                max_iterations,
            )

    # Collect final unfilled positions with reasons
    final_unfilled = _get_unfilled_required(positions, slot_instances_by_id)
    for position in final_unfilled:
        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst:
            continue

        reason = _determine_unfilled_reason(
            position,
            slot_inst,
            eligibility_matrix,
            clinician_day_states,
        )

        unfilled_reasons.append(UnfilledPosition(
            position_id=position.id,
            slot_instance_id=position.slot_instance_id,
            date_iso=slot_inst.date_iso,
            section_id=slot_inst.section_id,
            location_id=slot_inst.location_id,
            reason=reason,
            eligible_count=len(eligibility_matrix.get(position.id, [])),
        ))

    return positions, unfilled_reasons


def _get_unfilled_required(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> List[Position]:
    """Get all unfilled required positions."""
    unfilled = []
    for p in positions:
        if p.assigned_clinician_id is not None:
            continue
        if p.is_manual:
            continue
        slot_inst = slot_instances_by_id.get(p.slot_instance_id)
        if slot_inst and slot_inst.required_count > 0:
            unfilled.append(p)
    return unfilled


def _try_pattern_extension(
    position: Position,
    slot_inst: SlotInstance,
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    solver_settings: SolverSettings,
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> bool:
    """Try to extend a clinician's pattern to cover this position.

    Returns True if assignment was made.
    """
    eligible = eligibility_matrix.get(position.id, [])

    for e in eligible:
        key = (e.clinician_id, slot_inst.date_iso)
        state = clinician_day_states.get(key)

        if not state:
            continue

        # Skip if on vacation or rest day
        if state.is_on_vacation or state.is_rest_day:
            continue

        # Skip if wrong location (and location enforcement is on)
        if solver_settings.enforceSameLocationPerDay:
            if state.location_id and state.location_id != slot_inst.location_id:
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

        # Check if pattern can be upgraded to include this band
        target_band = slot_inst.band
        new_pattern = can_upgrade_pattern(state.pattern, target_band)

        if new_pattern:
            # Upgrade the pattern
            state.pattern = new_pattern
            if not state.location_id:
                state.location_id = slot_inst.location_id

            # Assign the position
            position.assigned_clinician_id = e.clinician_id
            position.assignment_source = "solver"
            state.assigned_positions.append(position.id)
            state.hours_assigned += calculate_slot_duration_minutes(slot_inst) / 60.0

            return True

    return False


def _try_new_assignment(
    position: Position,
    slot_inst: SlotInstance,
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    solver_settings: SolverSettings,
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> bool:
    """Try to assign a clinician who currently has OFF pattern.

    Returns True if assignment was made.
    """
    eligible = eligibility_matrix.get(position.id, [])

    for e in eligible:
        key = (e.clinician_id, slot_inst.date_iso)
        state = clinician_day_states.get(key)

        # Create state if it doesn't exist
        if not state:
            clinician_day_states[key] = ClinicianDayState(
                clinician_id=e.clinician_id,
                date_iso=slot_inst.date_iso,
            )
            state = clinician_day_states[key]

        # Skip if on vacation or rest day
        if state.is_on_vacation or state.is_rest_day:
            continue

        # Only consider clinicians with OFF pattern
        if state.pattern != Pattern.OFF:
            continue

        # CRITICAL: Check for time overlap (shouldn't happen for OFF pattern, but be safe)
        if has_overlap_with_assigned(
            e.clinician_id,
            slot_inst.date_iso,
            slot_inst,
            clinician_day_states,
            positions,
            slot_instances_by_id,
        ):
            continue

        # Assign new pattern based on the band
        state.pattern = bands_to_pattern({slot_inst.band})
        state.location_id = slot_inst.location_id

        # Assign the position
        position.assigned_clinician_id = e.clinician_id
        position.assignment_source = "solver"
        state.assigned_positions.append(position.id)
        state.hours_assigned += calculate_slot_duration_minutes(slot_inst) / 60.0

        return True

    return False


def _determine_unfilled_reason(
    position: Position,
    slot_inst: SlotInstance,
    eligibility_matrix: Dict[str, List[EligibilityInfo]],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
) -> UnfilledReason:
    """Determine why a position couldn't be filled."""
    eligible = eligibility_matrix.get(position.id, [])

    if not eligible:
        return UnfilledReason.NO_ELIGIBLE

    # Check reasons for each eligible clinician
    all_on_vacation = True
    all_rest_day = True
    all_location_conflict = True

    for e in eligible:
        key = (e.clinician_id, slot_inst.date_iso)
        state = clinician_day_states.get(key)

        if not state:
            all_on_vacation = False
            all_rest_day = False
            all_location_conflict = False
            continue

        if not state.is_on_vacation:
            all_on_vacation = False
        if not state.is_rest_day:
            all_rest_day = False
        if not e.would_violate_location:
            all_location_conflict = False

    if all_on_vacation:
        return UnfilledReason.ALL_ON_VACATION
    if all_rest_day:
        return UnfilledReason.REST_DAY_BLOCKED
    if all_location_conflict:
        return UnfilledReason.LOCATION_CONFLICT

    return UnfilledReason.REPAIR_FAILED
