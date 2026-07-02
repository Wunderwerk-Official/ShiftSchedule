"""
Utility functions for the heuristic scheduler.

These functions handle:
- Slot expansion from weekly template to concrete dates
- Position expansion from requiredSlots
- Eligibility matrix building
- Time/band classification
"""

from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ..models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    SolverSettings,
    TemplateSlot,
)
from ..solver import (
    _build_date_context,
    _build_slot_interval,
    _collect_slot_contexts,
    _get_day_type,
    _get_weekday_key,
    _parse_time_to_minutes,
)
from .models import (
    Band,
    ClinicianDayState,
    EligibilityInfo,
    Pattern,
    Position,
    SlotInstance,
    pattern_contains_band,
)


def classify_time_to_band(start_minutes: int) -> Band:
    """Classify a start time (in minutes from midnight) to a band.

    Band boundaries (configurable, but defaults):
    - EARLY (F): 00:00 - 12:00
    - LATE (S): 12:00 - 14:00
    - AFTERNOON (A): 14:00 - 18:00
    - NIGHT (N): 18:00 - 24:00 (and cross-day)

    Args:
        start_minutes: Minutes from midnight (0-1440+)

    Returns:
        The appropriate Band enum value
    """
    # Normalize to within a day
    start_minutes = start_minutes % (24 * 60)

    if start_minutes < 12 * 60:  # Before 12:00
        return Band.EARLY
    elif start_minutes < 14 * 60:  # 12:00 - 14:00
        return Band.LATE
    elif start_minutes < 18 * 60:  # 14:00 - 18:00
        return Band.AFTERNOON
    else:  # 18:00+
        return Band.NIGHT


def expand_slots_to_instances(
    state: AppState,
    target_day_isos: List[str],
    holidays: List[Holiday],
) -> List[SlotInstance]:
    """Expand weekly template slots to concrete SlotInstances for each date.

    Uses the existing _collect_slot_contexts() function to get slot metadata,
    then creates SlotInstance objects for each date in the range.

    Args:
        state: The application state with weekly template
        target_day_isos: List of ISO date strings to expand for
        holidays: List of holidays for day type determination

    Returns:
        List of SlotInstance objects
    """
    slot_contexts = _collect_slot_contexts(state)
    instances: List[SlotInstance] = []

    for date_iso in target_day_isos:
        day_type = _get_day_type(date_iso, holidays)

        for ctx in slot_contexts:
            # Only include slots that match this day type
            if ctx.get("day_type") != day_type:
                continue

            slot: TemplateSlot = ctx["slot"]
            start, end, loc = _build_slot_interval(slot, ctx["location_id"])
            # _build_slot_interval returns an offset-INCLUSIVE end, but
            # SlotInstance expects the raw clock end plus a separate
            # end_day_offset (duration/overlap logic re-adds the offset).
            raw_offset = getattr(slot, "endDayOffset", 0)
            offset = max(0, min(3, raw_offset)) if isinstance(raw_offset, int) else 0
            end -= offset * 24 * 60

            # Classify the slot into a band based on start time
            band = classify_time_to_band(start)

            # Get required count (from slot, default to 0)
            required = getattr(slot, "requiredSlots", 0)
            if not isinstance(required, int) or required < 0:
                required = 0

            instances.append(SlotInstance(
                id=f"{slot.id}__{date_iso}",
                slot_id=slot.id,
                date_iso=date_iso,
                location_id=loc,
                section_id=ctx["section_id"],
                band=band,
                start_minutes=start,
                end_minutes=end,
                end_day_offset=offset,
                required_count=required,
            ))

    return instances


def expand_positions(
    slot_instances: List[SlotInstance],
) -> List[Position]:
    """Expand SlotInstances to Positions based on required_count.

    Each SlotInstance with required_count > 0 becomes multiple Position
    objects (one per required clinician). This makes matching cleaner.

    Args:
        slot_instances: List of SlotInstance objects

    Returns:
        List of Position objects
    """
    positions: List[Position] = []

    for inst in slot_instances:
        # Create one Position per required slot
        for idx in range(max(1, inst.required_count)):
            positions.append(Position(
                id=f"{inst.id}__pos{idx}",
                slot_instance_id=inst.id,
                position_index=idx,
                assigned_clinician_id=None,
                is_manual=False,
            ))

    return positions


def mark_manual_assignments(
    positions: List[Position],
    assignments: List[Assignment],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> None:
    """Mark positions that have existing manual assignments.

    Modifies positions in place to set is_manual=True and
    assigned_clinician_id for positions with existing assignments.

    Args:
        positions: List of Position objects (modified in place)
        assignments: List of existing Assignment objects
        slot_instances_by_id: Lookup map for slot instances
    """
    # Build assignment lookup: (slot_id, date_iso) -> list of clinician_ids
    assignments_by_slot_date: Dict[Tuple[str, str], List[str]] = {}
    for assignment in assignments:
        # Skip pool assignments
        if assignment.rowId.startswith("pool-"):
            continue

        # Find the matching slot instance
        for inst_id, inst in slot_instances_by_id.items():
            if inst.slot_id == assignment.rowId and inst.date_iso == assignment.dateISO:
                key = (inst_id,)
                assignments_by_slot_date.setdefault(inst_id, []).append(
                    assignment.clinicianId
                )
                break

    # Mark positions with manual assignments
    for position in positions:
        assigned_list = assignments_by_slot_date.get(position.slot_instance_id, [])
        if position.position_index < len(assigned_list):
            position.assigned_clinician_id = assigned_list[position.position_index]
            position.is_manual = True
            position.assignment_source = "manual"


def initialize_clinician_day_states(
    clinicians: List[Clinician],
    target_day_isos: List[str],
    assignments: List[Assignment],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> Dict[Tuple[str, str], ClinicianDayState]:
    """Initialize ClinicianDayState for all clinicians and dates.

    Creates state objects and marks vacation days and existing assignments.

    Args:
        clinicians: List of Clinician objects
        target_day_isos: List of ISO date strings
        assignments: List of existing Assignment objects
        slot_instances_by_id: Lookup map for slot instances

    Returns:
        Dictionary mapping (clinician_id, date_iso) to ClinicianDayState
    """
    states: Dict[Tuple[str, str], ClinicianDayState] = {}

    for clinician in clinicians:
        # Build vacation lookup for this clinician
        vacation_dates: Set[str] = set()
        for vac in clinician.vacations:
            start = date.fromisoformat(vac.startISO)
            end = date.fromisoformat(vac.endISO)
            current = start
            while current <= end:
                vacation_dates.add(current.isoformat())
                current += timedelta(days=1)

        for date_iso in target_day_isos:
            key = (clinician.id, date_iso)
            states[key] = ClinicianDayState(
                clinician_id=clinician.id,
                date_iso=date_iso,
                pattern=Pattern.OFF,
                location_id=None,
                assigned_positions=[],
                is_on_vacation=date_iso in vacation_dates,
                is_rest_day=False,
                hours_assigned=0.0,
            )

    # Update states based on existing assignments
    for assignment in assignments:
        if assignment.rowId.startswith("pool-"):
            continue

        # Find the slot instance
        for inst_id, inst in slot_instances_by_id.items():
            if inst.slot_id == assignment.rowId and inst.date_iso == assignment.dateISO:
                key = (assignment.clinicianId, assignment.dateISO)
                if key in states:
                    state = states[key]
                    state.location_id = inst.location_id
                    # Calculate hours
                    hours = (inst.end_minutes - inst.start_minutes) / 60.0
                    if inst.end_day_offset > 0:
                        hours += inst.end_day_offset * 24
                    state.hours_assigned += max(0, hours)
                break

    return states


def build_eligibility_matrix(
    positions: List[Position],
    clinicians: List[Clinician],
    slot_instances_by_id: Dict[str, SlotInstance],
    clinician_day_states: Dict[Tuple[str, str], ClinicianDayState],
    solver_settings: SolverSettings,
) -> Dict[str, List[EligibilityInfo]]:
    """Build eligibility lists for each position.

    For each position, creates a sorted list of eligible clinicians
    based on qualifications, availability, and preferences.

    Args:
        positions: List of Position objects
        clinicians: List of Clinician objects
        slot_instances_by_id: Lookup map for slot instances
        clinician_day_states: Current state of clinicians per day
        solver_settings: Solver configuration

    Returns:
        Dictionary mapping position_id to sorted list of EligibilityInfo
    """
    eligibility_by_position: Dict[str, List[EligibilityInfo]] = {}

    # Build clinician lookup
    clinicians_by_id = {c.id: c for c in clinicians}

    for position in positions:
        # Skip already assigned positions
        if position.is_manual:
            eligibility_by_position[position.id] = []
            continue

        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst:
            eligibility_by_position[position.id] = []
            continue

        eligible: List[EligibilityInfo] = []

        for clinician in clinicians:
            # Check qualification
            is_qualified = slot_inst.section_id in clinician.qualifiedClassIds
            if not is_qualified:
                continue

            # Check vacation
            key = (clinician.id, slot_inst.date_iso)
            day_state = clinician_day_states.get(key)
            if day_state and day_state.is_on_vacation:
                continue

            # Check rest day
            if day_state and day_state.is_rest_day:
                continue

            # Calculate preference rank
            try:
                pref_rank = clinician.preferredClassIds.index(slot_inst.section_id)
            except ValueError:
                pref_rank = 999

            # Check location conflict
            would_violate_location = False
            if solver_settings.enforceSameLocationPerDay and day_state:
                if day_state.location_id and day_state.location_id != slot_inst.location_id:
                    would_violate_location = True

            # Check if would create gap in pattern
            would_create_gap = False
            if day_state and day_state.pattern != Pattern.OFF:
                current_bands = set()
                if pattern_contains_band(day_state.pattern, Band.EARLY):
                    current_bands.add(Band.EARLY)
                if pattern_contains_band(day_state.pattern, Band.LATE):
                    current_bands.add(Band.LATE)
                if pattern_contains_band(day_state.pattern, Band.AFTERNOON):
                    current_bands.add(Band.AFTERNOON)

                new_band = slot_inst.band
                if new_band not in current_bands and new_band != Band.NIGHT:
                    # Check if adding this band creates a gap
                    test_bands = current_bands | {new_band}
                    if Band.EARLY in test_bands and Band.AFTERNOON in test_bands:
                        if Band.LATE not in test_bands:
                            would_create_gap = True

            # Check time window preferences
            fits_time_window = True
            weekday_key = _get_weekday_key(slot_inst.date_iso)
            pref_times = getattr(clinician, "preferredWorkingTimes", {})
            if pref_times and weekday_key in pref_times:
                pref = pref_times[weekday_key]
                if hasattr(pref, "requirement") and pref.requirement == "mandatory":
                    start_pref = _parse_time_to_minutes(getattr(pref, "startTime", None))
                    end_pref = _parse_time_to_minutes(getattr(pref, "endTime", None))
                    if start_pref is not None and end_pref is not None:
                        # Check if slot fits within preference window
                        if slot_inst.start_minutes < start_pref or slot_inst.end_minutes > end_pref:
                            fits_time_window = False
                            continue  # Skip if mandatory window violated

            eligible.append(EligibilityInfo(
                clinician_id=clinician.id,
                position_id=position.id,
                is_qualified=True,
                is_preferred=pref_rank < 999,
                preference_rank=pref_rank,
                fits_time_window=fits_time_window,
                would_violate_location=would_violate_location,
                would_create_gap=would_create_gap,
            ))

        # Sort by score (lower is better)
        eligible.sort(key=lambda e: e.score())
        eligibility_by_position[position.id] = eligible

    return eligibility_by_position


def calculate_slot_duration_minutes(slot_inst: SlotInstance) -> int:
    """Calculate the duration of a slot in minutes."""
    base_duration = slot_inst.end_minutes - slot_inst.start_minutes
    if slot_inst.end_day_offset > 0:
        base_duration += slot_inst.end_day_offset * 24 * 60
    return max(0, base_duration)


def is_night_or_oncall(
    slot_inst: SlotInstance,
    on_call_section_id: Optional[str],
) -> bool:
    """Check if a slot instance is a night shift or on-call."""
    if slot_inst.band == Band.NIGHT:
        return True
    if on_call_section_id and slot_inst.section_id == on_call_section_id:
        return True
    return False


def get_blocked_dates_for_rest(
    date_iso: str,
    days_before: int,
    days_after: int,
) -> Set[str]:
    """Calculate the dates that should be blocked for rest.

    Args:
        date_iso: The on-call date
        days_before: Number of rest days before
        days_after: Number of rest days after

    Returns:
        Set of ISO date strings that should be blocked
    """
    blocked: Set[str] = set()
    base_date = date.fromisoformat(date_iso)

    for offset in range(1, days_before + 1):
        blocked.add((base_date - timedelta(days=offset)).isoformat())

    for offset in range(1, days_after + 1):
        blocked.add((base_date + timedelta(days=offset)).isoformat())

    return blocked


def count_filled_positions(positions: List[Position]) -> int:
    """Count how many positions have been filled."""
    return sum(1 for p in positions if p.assigned_clinician_id is not None)


def count_required_positions(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> int:
    """Count how many positions are for required slots."""
    count = 0
    for p in positions:
        inst = slot_instances_by_id.get(p.slot_instance_id)
        if inst and inst.required_count > 0:
            count += 1
    return count


def intervals_overlap(
    start1: int, end1: int,
    start2: int, end2: int,
) -> bool:
    """Check if two time intervals overlap.

    Assumes end > start for both intervals.
    Uses half-open intervals: [start, end)
    """
    return not (end1 <= start2 or end2 <= start1)


def has_overlap_with_assigned(
    clinician_id: str,
    date_iso: str,
    new_slot: "SlotInstance",
    clinician_day_states: dict,
    positions: list,
    slot_instances_by_id: dict,
) -> bool:
    """Check if assigning a clinician to a slot would cause a time overlap.

    Checks both:
    1. Same-day slots that overlap
    2. Overnight slots from the previous day that extend into today

    Args:
        clinician_id: The clinician to check
        date_iso: The date of the assignment
        new_slot: The slot instance to potentially assign
        clinician_day_states: Dict of (clinician_id, date_iso) -> ClinicianDayState
        positions: All positions
        slot_instances_by_id: Lookup for slot instances

    Returns:
        True if there would be an overlap conflict
    """
    # Build positions lookup for efficiency
    positions_by_id = {p.id: p for p in positions}

    new_start = new_slot.start_minutes
    new_end = new_slot.end_minutes

    # Handle overnight slots (end < start means it goes past midnight)
    if new_end <= new_start:
        new_end += 24 * 60  # Add 24 hours

    # Check 1: Same-day assignments
    key = (clinician_id, date_iso)
    state = clinician_day_states.get(key)

    if state and state.assigned_positions:
        for pos_id in state.assigned_positions:
            assigned_pos = positions_by_id.get(pos_id)
            if not assigned_pos:
                continue

            assigned_slot = slot_instances_by_id.get(assigned_pos.slot_instance_id)
            if not assigned_slot:
                continue

            # Only check same-day slots here
            if assigned_slot.date_iso != date_iso:
                continue

            assigned_start = assigned_slot.start_minutes
            assigned_end = assigned_slot.end_minutes

            # Handle overnight slots
            if assigned_end <= assigned_start:
                assigned_end += 24 * 60

            if intervals_overlap(new_start, new_end, assigned_start, assigned_end):
                print(f"[OVERLAP] {clinician_id} on {date_iso}: "
                      f"existing {assigned_start}-{assigned_end} overlaps with new {new_start}-{new_end}")
                return True

    # Check 2: Overnight shifts from previous day that extend into today
    prev_date = (date.fromisoformat(date_iso) - timedelta(days=1)).isoformat()
    prev_key = (clinician_id, prev_date)
    prev_state = clinician_day_states.get(prev_key)

    if prev_state and prev_state.assigned_positions:
        for pos_id in prev_state.assigned_positions:
            assigned_pos = positions_by_id.get(pos_id)
            if not assigned_pos:
                continue

            assigned_slot = slot_instances_by_id.get(assigned_pos.slot_instance_id)
            if not assigned_slot:
                continue

            # Check if this is an overnight slot (ends after midnight)
            if assigned_slot.end_day_offset > 0 or assigned_slot.end_minutes <= assigned_slot.start_minutes:
                # This slot extends into today
                # The portion on today is from 00:00 to end_minutes
                overnight_end_today = assigned_slot.end_minutes

                # Check if the new slot overlaps with the overnight portion
                # The overnight portion on today is [0, overnight_end_today)
                if intervals_overlap(new_start, new_end, 0, overnight_end_today):
                    print(f"[OVERLAP] {clinician_id} on {date_iso}: "
                          f"overnight from {prev_date} (ends at {overnight_end_today}) overlaps with new {new_start}-{new_end}")
                    return True

    return False
