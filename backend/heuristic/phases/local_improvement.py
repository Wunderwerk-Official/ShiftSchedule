"""
Phase 5: Local Improvement

This phase optimizes the solution through local swaps after coverage
is established. Goals:
- Balance working hours across clinicians
- Improve preference satisfaction
- Reduce continuity violations (gaps in patterns)

Algorithm:
1. Calculate current solution cost
2. Try pairwise swaps of assignments on the same day
3. Accept swaps that reduce cost
4. Repeat until no improvement or max iterations
"""

from typing import Callable, Dict, List, Optional, Tuple

from ..models import (
    Band,
    ClinicianDayState,
    Pattern,
    Position,
    SlotInstance,
    HeuristicSolverStats,
)
from ..utils import calculate_slot_duration_minutes
from ...models import Clinician


def phase_local_improvement(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    target_day_isos: List[str],
    max_iterations: int = 50,
    on_progress: Optional[Callable[[str, str, int, int], None]] = None,
) -> Tuple[List[Position], int]:
    """Improve solution through local swaps.

    Args:
        positions: All positions (modified in place)
        slot_instances_by_id: Lookup map for slot instances
        clinician_day_states: Current state per clinician/day (modified in place)
        clinicians_by_id: Lookup map for clinicians
        target_day_isos: List of dates in the solve range
        max_iterations: Maximum improvement iterations
        on_progress: Optional callback for progress updates

    Returns:
        Tuple of (positions, number of swaps made)
    """
    total_swaps = 0

    for iteration in range(max_iterations):
        # Calculate current cost
        current_cost = _calculate_solution_cost(
            positions,
            slot_instances_by_id,
            clinician_day_states,
            clinicians_by_id,
            target_day_isos,
        )

        # Try to find an improving swap
        swap_found = False

        # Get all assigned positions (non-manual)
        assigned = [
            p for p in positions
            if p.assigned_clinician_id is not None
            and not p.is_manual
        ]

        # Try pairwise swaps on the same day
        for i, pos_a in enumerate(assigned):
            if swap_found:
                break

            inst_a = slot_instances_by_id.get(pos_a.slot_instance_id)
            if not inst_a:
                continue

            for pos_b in assigned[i + 1:]:
                inst_b = slot_instances_by_id.get(pos_b.slot_instance_id)
                if not inst_b:
                    continue

                # Only swap on the same day
                if inst_a.date_iso != inst_b.date_iso:
                    continue

                # Skip if same clinician
                if pos_a.assigned_clinician_id == pos_b.assigned_clinician_id:
                    continue

                # Check if swap is valid (both clinicians qualified)
                clin_a = clinicians_by_id.get(pos_a.assigned_clinician_id)
                clin_b = clinicians_by_id.get(pos_b.assigned_clinician_id)

                if not clin_a or not clin_b:
                    continue

                # Check qualifications
                if inst_b.section_id not in clin_a.qualifiedClassIds:
                    continue
                if inst_a.section_id not in clin_b.qualifiedClassIds:
                    continue

                # Check location constraints
                state_a = clinician_day_states.get((pos_a.assigned_clinician_id, inst_a.date_iso))
                state_b = clinician_day_states.get((pos_b.assigned_clinician_id, inst_b.date_iso))

                if state_a and state_a.location_id and state_a.location_id != inst_b.location_id:
                    continue
                if state_b and state_b.location_id and state_b.location_id != inst_a.location_id:
                    continue

                # Perform swap temporarily
                pos_a.assigned_clinician_id, pos_b.assigned_clinician_id = \
                    pos_b.assigned_clinician_id, pos_a.assigned_clinician_id

                # Calculate new cost
                new_cost = _calculate_solution_cost(
                    positions,
                    slot_instances_by_id,
                    clinician_day_states,
                    clinicians_by_id,
                    target_day_isos,
                )

                if new_cost < current_cost:
                    # Accept the swap
                    swap_found = True
                    total_swaps += 1

                    # Update day states (simplified - just update assignment lists)
                    _update_states_after_swap(
                        pos_a, pos_b, inst_a, inst_b,
                        clinician_day_states,
                    )
                    break
                else:
                    # Revert the swap
                    pos_a.assigned_clinician_id, pos_b.assigned_clinician_id = \
                        pos_b.assigned_clinician_id, pos_a.assigned_clinician_id

        if not swap_found:
            break

        if on_progress:
            on_progress(
                "local_improvement",
                f"Iteration {iteration + 1}, {total_swaps} swaps",
                iteration + 1,
                max_iterations,
            )

    return positions, total_swaps


def _calculate_solution_cost(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    clinicians_by_id: Dict[str, Clinician],
    target_day_isos: List[str],
) -> float:
    """Calculate the cost of the current solution (lower is better).

    Components:
    - Unfilled required positions (very high weight)
    - Preference violations (medium weight)
    - Hours imbalance (low weight)
    """
    cost = 0.0

    # Cost for unfilled required positions
    for p in positions:
        if p.assigned_clinician_id is not None:
            continue
        inst = slot_instances_by_id.get(p.slot_instance_id)
        if inst and inst.required_count > 0:
            cost += 10000  # Very high penalty

    # Cost for preference violations
    for p in positions:
        if not p.assigned_clinician_id:
            continue
        inst = slot_instances_by_id.get(p.slot_instance_id)
        if not inst:
            continue

        clin = clinicians_by_id.get(p.assigned_clinician_id)
        if not clin:
            continue

        # Check if section is preferred
        if inst.section_id not in clin.preferredClassIds[:3]:
            cost += 10  # Small penalty for non-preferred

    # Cost for hours imbalance
    hours_by_clinician = _calculate_hours_by_clinician(
        positions, slot_instances_by_id, clinicians_by_id
    )

    for clin_id, hours in hours_by_clinician.items():
        clin = clinicians_by_id.get(clin_id)
        if not clin or not clin.workingHoursPerWeek:
            continue

        # Calculate expected hours for the period
        weeks = len(target_day_isos) / 7.0
        target_hours = clin.workingHoursPerWeek * weeks

        # Penalty for deviation
        diff = abs(hours - target_hours)
        tolerance = (clin.workingHoursToleranceHours or 5) * weeks
        if diff > tolerance:
            cost += (diff - tolerance) * 0.5

    return cost


def _calculate_hours_by_clinician(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinicians_by_id: Dict[str, Clinician],
) -> Dict[str, float]:
    """Calculate total assigned hours per clinician."""
    hours: Dict[str, float] = {cid: 0.0 for cid in clinicians_by_id.keys()}

    for p in positions:
        if not p.assigned_clinician_id:
            continue
        inst = slot_instances_by_id.get(p.slot_instance_id)
        if not inst:
            continue

        duration_hours = calculate_slot_duration_minutes(inst) / 60.0
        hours[p.assigned_clinician_id] = hours.get(p.assigned_clinician_id, 0) + duration_hours

    return hours


def _update_states_after_swap(
    pos_a: Position,
    pos_b: Position,
    inst_a: SlotInstance,
    inst_b: SlotInstance,
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
) -> None:
    """Update clinician day states after a swap."""
    # Note: After the swap, pos_a now has pos_b's original clinician and vice versa
    # This is a simplified update - a full implementation would recalculate patterns

    # Update assignment lists
    # Remove old assignments
    old_clin_a = pos_b.assigned_clinician_id  # After swap, B has A's original
    old_clin_b = pos_a.assigned_clinician_id  # After swap, A has B's original

    state_old_a = clinician_day_states.get((old_clin_a, inst_a.date_iso))
    state_old_b = clinician_day_states.get((old_clin_b, inst_b.date_iso))

    if state_old_a and pos_a.id in state_old_a.assigned_positions:
        state_old_a.assigned_positions.remove(pos_a.id)
    if state_old_b and pos_b.id in state_old_b.assigned_positions:
        state_old_b.assigned_positions.remove(pos_b.id)

    # Add new assignments
    new_clin_a = pos_a.assigned_clinician_id  # Current value after swap
    new_clin_b = pos_b.assigned_clinician_id  # Current value after swap

    state_new_a = clinician_day_states.get((new_clin_a, inst_a.date_iso))
    state_new_b = clinician_day_states.get((new_clin_b, inst_b.date_iso))

    if state_new_a:
        state_new_a.assigned_positions.append(pos_a.id)
    if state_new_b:
        state_new_b.assigned_positions.append(pos_b.id)
