"""
Phase 2: Coarse Planning (Location + Pattern per Day)

This phase decides for each clinician on each day:
- Whether they work (OFF vs working)
- At which location (if same-location-per-day is enforced)
- Which time bands they cover (Early, Late, Afternoon)

Algorithm:
1. For each day in the planning horizon:
   a. Calculate demand per location per band (unfilled positions)
   b. For each available clinician (not on vacation, not rest day):
      - Determine which bands they're qualified for at each location
      - Calculate best pattern based on demand and preferences
      - Assign location and pattern
2. Prefer continuous patterns (FS, SA, FSA) over gaps (FA)
3. Load balance based on hours target
"""

from typing import Callable, Dict, List, Optional, Set, Tuple

from ..models import (
    Band,
    ClinicianDayState,
    EligibilityInfo,
    Pattern,
    Position,
    SlotInstance,
    PATTERN_BANDS,
    bands_to_pattern,
    get_pattern_bands,
)
from ...models import Clinician, SolverSettings


def phase_coarse_planning(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinicians: List[Clinician],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    target_day_isos: List[str],
    solver_settings: SolverSettings,
    on_progress: Optional[Callable[[str, str, int, int], None]] = None,
) -> Dict[Tuple[str, str], ClinicianDayState]:
    """Assign daily patterns and locations to clinicians.

    Args:
        positions: All positions (read-only in this phase)
        slot_instances_by_id: Lookup map for slot instances
        clinicians: List of all clinicians
        clinician_day_states: Current state per clinician/day (modified in place)
        target_day_isos: List of dates in the solve range
        solver_settings: Solver configuration
        on_progress: Optional callback for progress updates

    Returns:
        Updated clinician_day_states
    """
    enforce_same_location = solver_settings.enforceSameLocationPerDay

    for day_idx, date_iso in enumerate(target_day_isos):
        # Calculate demand per location per band for this day
        demand = _calculate_day_demand(
            positions,
            slot_instances_by_id,
            date_iso,
        )

        # Skip if no demand
        if not demand:
            if on_progress:
                on_progress("coarse_planning", f"Day {day_idx + 1}/{len(target_day_isos)} (no demand)",
                           day_idx + 1, len(target_day_isos))
            continue

        # Get available clinicians for this day
        available_clinicians = []
        for clinician in clinicians:
            key = (clinician.id, date_iso)
            state = clinician_day_states.get(key)

            # Skip if on vacation or rest day
            if state and (state.is_on_vacation or state.is_rest_day):
                continue

            # Skip if already has a night pattern (assigned in phase 1)
            if state and state.pattern == Pattern.N:
                continue

            available_clinicians.append(clinician)

        # Sort clinicians by hours deficit (those below target get priority)
        available_clinicians.sort(
            key=lambda c: _get_hours_deficit(c, clinician_day_states, target_day_isos),
            reverse=True,  # Highest deficit first
        )

        # Assign patterns and locations
        for clinician in available_clinicians:
            key = (clinician.id, date_iso)
            state = clinician_day_states.get(key)

            # If already has a pattern (from manual assignment), skip
            if state and state.pattern != Pattern.OFF:
                continue

            # Find best location and pattern for this clinician
            best_location, best_pattern, best_score = _find_best_assignment(
                clinician,
                demand,
                slot_instances_by_id,
                clinician_day_states,
                date_iso,
                enforce_same_location,
            )

            if best_location and best_pattern != Pattern.OFF:
                # Create or update state
                if key not in clinician_day_states:
                    clinician_day_states[key] = ClinicianDayState(
                        clinician_id=clinician.id,
                        date_iso=date_iso,
                    )

                state = clinician_day_states[key]
                state.pattern = best_pattern
                state.location_id = best_location

                # Reduce demand for assigned bands
                for band in get_pattern_bands(best_pattern):
                    loc_demand = demand.get(best_location, {})
                    if band in loc_demand and loc_demand[band] > 0:
                        loc_demand[band] -= 1

        if on_progress:
            on_progress("coarse_planning", f"Day {day_idx + 1}/{len(target_day_isos)}",
                       day_idx + 1, len(target_day_isos))

    return clinician_day_states


def _calculate_day_demand(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
    date_iso: str,
) -> Dict[str, Dict[Band, int]]:
    """Calculate unfilled demand per location per band for a day.

    Returns:
        Dict mapping location_id -> band -> count of unfilled positions
    """
    demand: Dict[str, Dict[Band, int]] = {}

    for position in positions:
        # Skip already filled positions
        if position.assigned_clinician_id is not None:
            continue

        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst or slot_inst.date_iso != date_iso:
            continue

        # Skip night band (handled in phase 1)
        if slot_inst.band == Band.NIGHT:
            continue

        # Only count required positions
        if slot_inst.required_count <= 0:
            continue

        loc = slot_inst.location_id
        band = slot_inst.band

        if loc not in demand:
            demand[loc] = {}
        demand[loc][band] = demand[loc].get(band, 0) + 1

    return demand


def _find_best_assignment(
    clinician: Clinician,
    demand: Dict[str, Dict[Band, int]],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    date_iso: str,
    enforce_same_location: bool,
) -> Tuple[Optional[str], Pattern, int]:
    """Find the best location and pattern for a clinician.

    Returns:
        Tuple of (location_id, pattern, score) or (None, OFF, 0) if none found
    """
    best_location: Optional[str] = None
    best_pattern: Pattern = Pattern.OFF
    best_score: int = -1

    qualified_sections = set(clinician.qualifiedClassIds)

    for loc_id, band_demand in demand.items():
        # Check if clinician is qualified for any section at this location
        # We need to check the actual slot instances to know the sections
        qualified_bands: Set[Band] = set()

        for slot_inst in slot_instances_by_id.values():
            if slot_inst.location_id != loc_id:
                continue
            if slot_inst.date_iso != date_iso:
                continue
            if slot_inst.section_id in qualified_sections:
                qualified_bands.add(slot_inst.band)

        # Remove night band (handled separately)
        qualified_bands.discard(Band.NIGHT)

        if not qualified_bands:
            continue

        # Calculate score for this location
        # Score = sum of demand for bands the clinician is qualified for
        score = 0
        for band in qualified_bands:
            score += band_demand.get(band, 0)

        if score <= 0:
            continue

        # Determine pattern based on qualified bands and demand
        pattern = _determine_pattern(qualified_bands, band_demand)

        if pattern == Pattern.OFF:
            continue

        if score > best_score:
            best_score = score
            best_location = loc_id
            best_pattern = pattern

    return best_location, best_pattern, best_score


def _determine_pattern(
    qualified_bands: Set[Band],
    band_demand: Dict[Band, int],
) -> Pattern:
    """Determine the best pattern based on qualified bands and demand.

    Prefers continuous patterns (FS, SA, FSA) over patterns with gaps.
    """
    # Filter to bands with actual demand
    demanded_bands = {b for b in qualified_bands if band_demand.get(b, 0) > 0}

    if not demanded_bands:
        return Pattern.OFF

    # Check for continuous patterns first (preferred)
    if Band.EARLY in demanded_bands and Band.LATE in demanded_bands and Band.AFTERNOON in demanded_bands:
        return Pattern.FSA
    if Band.EARLY in demanded_bands and Band.LATE in demanded_bands:
        return Pattern.FS
    if Band.LATE in demanded_bands and Band.AFTERNOON in demanded_bands:
        return Pattern.SA

    # Single bands
    if Band.EARLY in demanded_bands:
        return Pattern.F
    if Band.LATE in demanded_bands:
        return Pattern.S
    if Band.AFTERNOON in demanded_bands:
        return Pattern.A

    # Fallback: try to cover most demand
    return bands_to_pattern(demanded_bands)


def _get_hours_deficit(
    clinician: Clinician,
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    target_day_isos: List[str],
) -> float:
    """Calculate hours deficit (target - assigned) for a clinician.

    Returns positive if under target, negative if over target.
    """
    if not clinician.workingHoursPerWeek:
        return 0.0

    # Calculate expected hours for the period
    weeks = len(target_day_isos) / 7.0
    target_hours = clinician.workingHoursPerWeek * weeks

    # Calculate assigned hours
    assigned_hours = 0.0
    for date_iso in target_day_isos:
        state = clinician_day_states.get((clinician.id, date_iso))
        if state:
            assigned_hours += state.hours_assigned

    return target_hours - assigned_hours
