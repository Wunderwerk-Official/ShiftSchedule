"""
Human Heuristic Solver (v2) - Exact implementation of human-heuristic-solver.md

This module implements the greedy, day-by-day heuristic approach with backtracking
exactly as documented in /human-heuristic-solver.md.

Algorithm phases:
0. Initialization: Calculate YTD hours, mark manual assignments
1. Day-by-day iteration with retry logic
2. Slot criticality prioritization and doctor ranking
3. Consecutive slot filling at same location
4. Backtracking on failure

Key differences from v1 (band/pattern approach):
- Simpler: no bands, no patterns, no coarse planning
- Transparent: every decision follows documented priority rules
- Backtracking: retries failed days with alternative doctor choices
"""

import random
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ..models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    SolveRangeRequest,
    SolverSettings,
)
from ..solver import (
    _build_date_context,
    _build_slot_interval,
    _collect_slot_contexts,
    _get_day_type,
    _get_weekday_key,
    _parse_time_to_minutes,
    SolverTimer,
)


# Configuration
class HeuristicConfig:
    """Configuration parameters for the heuristic solver."""
    MAX_DAY_RETRIES: int = 5
    ENABLE_CONSECUTIVE_FILLING: bool = True
    RANDOM_SEED: int = 42
    RESPECT_MANUAL_ASSIGNMENTS: bool = True


class SlotInfo:
    """Information about a slot instance (template slot on a specific date)."""
    def __init__(
        self,
        slot_id: str,
        date_iso: str,
        location_id: str,
        section_id: str,
        start_minutes: int,
        end_minutes: int,
        end_day_offset: int,
        required_count: int,
    ):
        self.slot_id = slot_id
        self.date_iso = date_iso
        self.location_id = location_id
        self.section_id = section_id
        self.start_minutes = start_minutes
        self.end_minutes = end_minutes
        self.end_day_offset = end_day_offset
        self.required_count = required_count
        self.duration_minutes = self._calculate_duration()

    def _calculate_duration(self) -> int:
        """Calculate slot duration in minutes."""
        base = self.end_minutes - self.start_minutes
        if base < 0:  # Overnight slot
            base += 24 * 60
        if self.end_day_offset > 0:
            base += self.end_day_offset * 24 * 60
        return max(0, base)


class ClinicianState:
    """State for a single clinician across the solve range."""
    def __init__(self, clinician: Clinician, solve_start_date: date):
        self.clinician_id = clinician.id
        self.contract_hours = clinician.workingHoursPerWeek or 0
        self.tolerance_hours = clinician.workingHoursToleranceHours
        self.eligible_sections = clinician.qualifiedClassIds
        self.preferred_sections = clinician.preferredClassIds
        self.preferred_working_times = getattr(clinician, "preferredWorkingTimes", {})
        self.vacations = clinician.vacations

        # Calculate year-to-date hours and deficit
        self.ytd_hours = 0.0  # Will be calculated from assignments
        self.ytd_expected = self._calculate_ytd_expected(solve_start_date)
        self.ytd_deficit = self.ytd_expected - self.ytd_hours

        # Current week state (reset for each week)
        self.current_week_hours = 0.0

        # Per-day tracking
        self.assigned_slots_by_date: Dict[str, List[SlotInfo]] = {}
        self.location_by_date: Dict[str, str] = {}
        self.rest_days: Set[str] = set()  # Dates blocked due to on-call rest rules

    def _calculate_ytd_expected(self, current_date: date) -> float:
        """Calculate expected year-to-date hours based on contract."""
        if self.contract_hours == 0:
            return 0.0

        year_start = date(current_date.year, 1, 1)
        weeks_elapsed = (current_date - year_start).days / 7.0
        return weeks_elapsed * self.contract_hours

    def is_on_vacation(self, date_iso: str) -> bool:
        """Check if clinician is on vacation on this date."""
        for vac in self.vacations:
            start = date.fromisoformat(vac.startISO)
            end = date.fromisoformat(vac.endISO)
            current = date.fromisoformat(date_iso)
            if start <= current <= end:
                return True
        return False

    def has_time_overlap(self, date_iso: str, slot: SlotInfo) -> bool:
        """Check if adding this slot would create a time overlap."""
        assigned_slots = self.assigned_slots_by_date.get(date_iso, [])

        slot_start = slot.start_minutes
        slot_end = slot.end_minutes
        if slot.end_day_offset > 0 or slot_end < slot_start:
            slot_end = slot_start + slot.duration_minutes

        for existing in assigned_slots:
            existing_start = existing.start_minutes
            existing_end = existing.end_minutes
            if existing.end_day_offset > 0 or existing_end < existing_start:
                existing_end = existing_start + existing.duration_minutes

            # Check overlap (half-open intervals)
            if not (slot_end <= existing_start or existing_end <= slot_start):
                return True

        return False

    def would_exceed_hours(self, slot: SlotInfo) -> bool:
        """Check if adding this slot would exceed maximum allowed hours."""
        if self.contract_hours == 0:
            return False

        max_hours = self.contract_hours + self.tolerance_hours
        new_total = self.current_week_hours + (slot.duration_minutes / 60.0)
        return new_total > max_hours

    def fits_mandatory_time_window(self, slot: SlotInfo) -> bool:
        """Check if slot fits within mandatory time window (if set)."""
        weekday_key = _get_weekday_key(slot.date_iso)
        if weekday_key not in self.preferred_working_times:
            return True  # No window set, so it fits

        pref = self.preferred_working_times[weekday_key]
        if not hasattr(pref, "requirement") or pref.requirement != "mandatory":
            return True  # Not mandatory, so it fits

        start_pref = _parse_time_to_minutes(getattr(pref, "startTime", None))
        end_pref = _parse_time_to_minutes(getattr(pref, "endTime", None))

        if start_pref is None or end_pref is None:
            return True  # No valid window, so it fits

        # Slot must fall entirely within the window
        return slot.start_minutes >= start_pref and slot.end_minutes <= end_pref

    def has_location_conflict(self, date_iso: str, location_id: str) -> bool:
        """Check if assigning to this location would create a conflict."""
        existing_location = self.location_by_date.get(date_iso)
        if existing_location is None:
            return False  # No location assigned yet
        return existing_location != location_id


def heuristic_solve_range_v2(
    payload: SolveRangeRequest,
    state: AppState,
    cancel_event,
    on_progress: Callable[[str, Dict[str, Any]], None],
    start_time: float,
) -> dict:
    """
    Main entry point for the human heuristic solver (v2).

    Implements the algorithm from human-heuristic-solver.md exactly.
    """
    timer = SolverTimer()
    config = HeuristicConfig()

    # Set random seed for reproducibility
    random.seed(config.RANDOM_SEED)

    # Phase 0: Initialization
    on_progress("phase", {"phase": "init", "label": "Phase 0: Initialization..."})

    try:
        range_start, range_end, day_isos, target_day_isos, target_date_set, day_index_by_iso = \
            _build_date_context(payload)
    except ValueError as e:
        return _build_error_response(payload, str(e))

    holidays = state.holidays or []
    solver_settings = SolverSettings.model_validate(state.solverSettings or {})

    # Expand slots to instances
    slot_instances = _expand_slots_to_instances(state, target_day_isos, holidays)
    slots_by_id = {s.slot_id + "__" + s.date_iso: s for s in slot_instances}

    # Initialize clinician states
    clinician_states = {}
    for clinician in state.clinicians:
        clinician_states[clinician.id] = ClinicianState(clinician, range_start)

    # Mark manual assignments and calculate YTD hours
    manual_assignments_map = _mark_manual_assignments(
        state.assignments,
        slot_instances,
        clinician_states,
    )

    # Calculate on-call rest days if enabled
    if solver_settings.onCallRestEnabled and solver_settings.onCallRestClassId:
        _calculate_rest_days(
            clinician_states,
            solver_settings.onCallRestClassId,
            solver_settings.onCallRestDaysBefore,
            solver_settings.onCallRestDaysAfter,
        )

    timer.checkpoint("init")

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer)

    # Phase 1: Day-by-day iteration
    all_assignments = []
    warnings = []

    for day_iso in target_day_isos:
        on_progress("phase", {
            "phase": "solve_day",
            "label": f"Solving day {day_iso}..."
        })

        # Try to fill this day with retries
        day_assignments, day_warnings = _solve_single_day(
            day_iso,
            slot_instances,
            clinician_states,
            solver_settings,
            config,
            manual_assignments_map,
            cancel_event,
        )

        all_assignments.extend(day_assignments)
        warnings.extend(day_warnings)

        # Check for cancellation
        if cancel_event.is_set():
            return _build_abort_response(payload, timer, all_assignments)

        # Send progress update
        _send_solution_update(on_progress, timer, all_assignments)

    timer.checkpoint("solve")

    # Build result
    notes = _build_notes(timer, len(slot_instances), len(all_assignments), warnings)

    debug_info = {
        "timing": timer.to_dict(),
        "solver_status": "HEURISTIC_COMPLETE_V2",
        "num_days": len(target_day_isos),
        "num_slots": len(slot_instances),
        "num_assignments": len(all_assignments),
        "num_warnings": len(warnings),
    }

    return {
        "startISO": range_start.isoformat(),
        "endISO": range_end.isoformat(),
        "assignments": [a.model_dump() for a in all_assignments],
        "notes": notes,
        "debugInfo": debug_info,
    }


def _calculate_rest_days(
    clinician_states: Dict[str, ClinicianState],
    on_call_section_id: str,
    days_before: int,
    days_after: int,
) -> None:
    """
    Calculate rest days for clinicians based on on-call assignments.

    According to MD: Check if on-call assignments exist within the configured window
    (before/after), and mark those dates as rest days.
    """
    for clinician_id, state in clinician_states.items():
        # Find all on-call assignments for this clinician
        for date_iso, slots in state.assigned_slots_by_date.items():
            for slot in slots:
                if slot.section_id == on_call_section_id:
                    # This is an on-call assignment
                    # Block days before and after
                    base_date = date.fromisoformat(date_iso)

                    for offset in range(1, days_before + 1):
                        rest_date = (base_date - timedelta(days=offset)).isoformat()
                        state.rest_days.add(rest_date)

                    for offset in range(1, days_after + 1):
                        rest_date = (base_date + timedelta(days=offset)).isoformat()
                        state.rest_days.add(rest_date)


def _expand_slots_to_instances(
    state: AppState,
    target_day_isos: List[str],
    holidays: List[Holiday],
) -> List[SlotInfo]:
    """Expand weekly template slots to concrete SlotInfo objects."""
    slot_contexts = _collect_slot_contexts(state)
    instances = []

    for date_iso in target_day_isos:
        day_type = _get_day_type(date_iso, holidays)

        for ctx in slot_contexts:
            if ctx.get("day_type") != day_type:
                continue

            slot = ctx["slot"]
            start, end, loc = _build_slot_interval(slot, ctx["location_id"])

            required = getattr(slot, "requiredSlots", 0)
            if not isinstance(required, int) or required < 0:
                required = 0

            instances.append(SlotInfo(
                slot_id=slot.id,
                date_iso=date_iso,
                location_id=loc,
                section_id=ctx["section_id"],
                start_minutes=start,
                end_minutes=end,
                end_day_offset=getattr(slot, "endDayOffset", 0) or 0,
                required_count=required,
            ))

    return instances


def _mark_manual_assignments(
    assignments: List[Assignment],
    slot_instances: List[SlotInfo],
    clinician_states: Dict[str, ClinicianState],
) -> Dict[Tuple[str, str], List[Tuple[str, SlotInfo]]]:
    """
    Mark manual assignments in clinician states and calculate YTD hours.
    Returns dict mapping (date_iso, clinician_id) to list of (source, slot) tuples.
    This allows us to restore manual assignments during backtracking.
    """
    manual_assignments_by_clinician_date: Dict[Tuple[str, str], List[Tuple[str, SlotInfo]]] = {}

    # Build lookup
    slots_by_key = {}
    for slot in slot_instances:
        key = (slot.slot_id, slot.date_iso)
        if key not in slots_by_key:
            slots_by_key[key] = []
        slots_by_key[key].append(slot)

    for assignment in assignments:
        # Skip pool assignments
        if assignment.rowId.startswith("pool-"):
            continue

        # Find matching slot
        key = (assignment.rowId, assignment.dateISO)
        matching_slots = slots_by_key.get(key, [])

        for slot in matching_slots:
            clinician_state = clinician_states.get(assignment.clinicianId)
            if not clinician_state:
                continue

            # Determine source (manual vs solver)
            source = getattr(assignment, "source", "manual")
            if source != "solver":
                source = "manual"

            # Add to assigned slots
            if slot.date_iso not in clinician_state.assigned_slots_by_date:
                clinician_state.assigned_slots_by_date[slot.date_iso] = []
            clinician_state.assigned_slots_by_date[slot.date_iso].append(slot)

            # Set location for this day
            clinician_state.location_by_date[slot.date_iso] = slot.location_id

            # Update hours
            hours = slot.duration_minutes / 60.0
            clinician_state.current_week_hours += hours
            clinician_state.ytd_hours += hours

            # Track manual assignment for later restoration
            map_key = (slot.date_iso, assignment.clinicianId)
            if map_key not in manual_assignments_by_clinician_date:
                manual_assignments_by_clinician_date[map_key] = []
            manual_assignments_by_clinician_date[map_key].append((source, slot))

    # Recalculate YTD deficit after counting existing hours
    for state in clinician_states.values():
        state.ytd_deficit = state.ytd_expected - state.ytd_hours

    return manual_assignments_by_clinician_date


def _solve_single_day(
    day_iso: str,
    all_slot_instances: List[SlotInfo],
    clinician_states: Dict[str, ClinicianState],
    solver_settings: SolverSettings,
    config: HeuristicConfig,
    manual_assignments_map: Dict[Tuple[str, str], List[Tuple[str, SlotInfo]]],
    cancel_event,
) -> Tuple[List[Assignment], List[str]]:
    """
    Solve a single day with backtracking (TRY_FILL_DAY from MD).

    Returns: (assignments for this day, warnings)
    """
    # Get slots for this day
    day_slots = [s for s in all_slot_instances if s.date_iso == day_iso]

    warnings = []

    for retry_count in range(config.MAX_DAY_RETRIES):
        # Reset day to manual assignments only
        _reset_day_to_manual_only(day_iso, clinician_states, manual_assignments_map)

        # Try to fill the day
        success, day_assignments = _fill_day_with_prioritized_slots(
            day_iso,
            day_slots,
            clinician_states,
            solver_settings,
            config,
            retry_count,
            cancel_event,
        )

        if success:
            return day_assignments, warnings

        # Failed, will retry
        if retry_count < config.MAX_DAY_RETRIES - 1:
            warnings.append(f"Day {day_iso}: retry {retry_count + 1}/{config.MAX_DAY_RETRIES}")

    # All retries failed
    warnings.append(f"Day {day_iso}: Could not fully fill after {config.MAX_DAY_RETRIES} attempts")

    # Return partial solution
    return day_assignments, warnings


def _reset_day_to_manual_only(
    day_iso: str,
    clinician_states: Dict[str, ClinicianState],
    manual_assignments_map: Dict[Tuple[str, str], List[Tuple[str, SlotInfo]]],
) -> None:
    """
    Reset day to only include manual assignments.

    This implements the backtracking logic: before each retry, we clear
    solver-generated assignments and restore only manual ones.
    """
    # For each clinician, reset their state for this day
    for clinician_id, state in clinician_states.items():
        # Get manual assignments for this clinician on this day
        map_key = (day_iso, clinician_id)
        manual_slots = manual_assignments_map.get(map_key, [])

        # Filter to only manual assignments
        manual_slots_only = [slot for source, slot in manual_slots if source == "manual"]

        # Reset assigned slots for this day
        if manual_slots_only:
            state.assigned_slots_by_date[day_iso] = manual_slots_only
            # Set location from first manual slot
            state.location_by_date[day_iso] = manual_slots_only[0].location_id
        else:
            # No manual assignments, clear the day
            if day_iso in state.assigned_slots_by_date:
                del state.assigned_slots_by_date[day_iso]
            if day_iso in state.location_by_date:
                del state.location_by_date[day_iso]

        # Recalculate hours for this week
        # (This is a simplification - ideally we'd track hours per week properly)
        state.current_week_hours = 0.0
        for date_iso, slots in state.assigned_slots_by_date.items():
            for slot in slots:
                state.current_week_hours += slot.duration_minutes / 60.0


def _fill_day_with_prioritized_slots(
    day_iso: str,
    day_slots: List[SlotInfo],
    clinician_states: Dict[str, ClinicianState],
    solver_settings: SolverSettings,
    config: HeuristicConfig,
    retry_count: int,
    cancel_event,
) -> Tuple[bool, List[Assignment]]:
    """
    Fill slots for a single day using prioritized greedy approach.

    Returns: (success, assignments made)
    """
    assignments = []

    # Step 2.1: Identify unfilled slots (expand required counts)
    unfilled_slots = []
    for slot in day_slots:
        # Count how many are already filled
        filled_count = sum(
            1 for state in clinician_states.values()
            if any(s.slot_id == slot.slot_id for s in state.assigned_slots_by_date.get(day_iso, []))
        )

        needed = max(0, slot.required_count - filled_count)
        for _ in range(needed):
            unfilled_slots.append(slot)

    # Step 2.2: Prioritize by criticality (fewer eligible doctors = higher priority)
    slot_criticality = []
    for slot in unfilled_slots:
        eligible = _filter_eligible_doctors(slot, clinician_states, solver_settings)
        criticality = len(eligible)
        slot_criticality.append((slot, criticality, eligible))

    # Sort by criticality (ascending), then shuffle same-criticality slots
    slot_criticality.sort(key=lambda x: x[1])

    # Shuffle ties randomly
    i = 0
    while i < len(slot_criticality):
        j = i
        current_criticality = slot_criticality[i][1]
        while j < len(slot_criticality) and slot_criticality[j][1] == current_criticality:
            j += 1
        # Shuffle slots[i:j]
        if j - i > 1:
            group = slot_criticality[i:j]
            random.shuffle(group)
            slot_criticality[i:j] = group
        i = j

    # Step 2.3: Fill slots in priority order
    for slot, criticality, eligible_list in slot_criticality:
        if cancel_event.is_set():
            return False, assignments

        if not eligible_list:
            # No eligible doctors - FAILURE
            return False, assignments

        # Rank doctors
        ranked_doctors = _rank_doctors_by_deficit(eligible_list, slot, retry_count, clinician_states)

        if not ranked_doctors:
            return False, assignments

        # Assign top-ranked doctor
        chosen_doctor_id = ranked_doctors[0]
        chosen_state = clinician_states[chosen_doctor_id]

        # Make assignment
        _assign_doctor_to_slot(chosen_state, slot, assignments)

        # Try consecutive slot filling
        if config.ENABLE_CONSECUTIVE_FILLING:
            _fill_consecutive_slots(chosen_state, slot, day_slots, clinician_states, solver_settings, config, assignments)

    return True, assignments


def _filter_eligible_doctors(
    slot: SlotInfo,
    clinician_states: Dict[str, ClinicianState],
    solver_settings: SolverSettings,
) -> List[str]:
    """
    Filter eligible doctors for a slot (FILTER_ELIGIBLE_DOCTORS from MD).

    Criteria (from MD Section 3, Phase 2, Step 2.2):
    1. Qualification
    2. Vacation
    3. Time overlap
    4. Preferred working times (mandatory)
    5. On-call rest days
    6. Same location per day (if enabled)
    7. Hour limit
    """
    eligible = []

    for clinician_id, state in clinician_states.items():
        # 1. Qualification
        if slot.section_id not in state.eligible_sections:
            continue

        # 2. Vacation
        if state.is_on_vacation(slot.date_iso):
            continue

        # 3. Time overlap
        if state.has_time_overlap(slot.date_iso, slot):
            continue

        # 4. Mandatory time window
        if not state.fits_mandatory_time_window(slot):
            continue

        # 5. On-call rest days
        if slot.date_iso in state.rest_days:
            continue

        # 6. Same location per day
        if solver_settings.enforceSameLocationPerDay:
            if state.has_location_conflict(slot.date_iso, slot.location_id):
                continue

        # 7. Hour limit
        if state.would_exceed_hours(slot):
            continue

        eligible.append(clinician_id)

    return eligible


def _rank_doctors_by_deficit(
    eligible_doctors: List[str],
    slot: SlotInfo,
    retry_count: int,
    clinician_states: Dict[str, ClinicianState],
) -> List[str]:
    """
    Rank doctors by multi-criteria priority (RANK_DOCTORS_BY_DEFICIT from MD).

    Priority (from MD Section 3, Phase 2, Step 2.4):
    1. Current week % (lower is better)
    2. YTD deficit (higher is better)
    3. Section preference (lower index is better)
    4. Time preference bonus
    """
    ranked = []

    for doctor_id in eligible_doctors:
        state = clinician_states[doctor_id]

        # Primary: current week percentage
        if state.contract_hours > 0:
            week_pct = state.current_week_hours / state.contract_hours
        else:
            week_pct = 999  # No contract, rank last

        # Secondary: YTD deficit (negate for ascending sort)
        ytd_deficit = state.ytd_deficit

        # Tertiary: section preference
        try:
            section_priority = state.preferred_sections.index(slot.section_id)
        except ValueError:
            section_priority = 999  # Not in preferred list

        # Quaternary: time preference bonus
        time_bonus = 0
        weekday_key = _get_weekday_key(slot.date_iso)
        if weekday_key in state.preferred_working_times:
            pref = state.preferred_working_times[weekday_key]
            if hasattr(pref, "requirement") and pref.requirement == "preference":
                start_pref = _parse_time_to_minutes(getattr(pref, "startTime", None))
                end_pref = _parse_time_to_minutes(getattr(pref, "endTime", None))
                if start_pref is not None and end_pref is not None:
                    if start_pref <= slot.start_minutes and slot.end_minutes <= end_pref:
                        time_bonus = 1

        priority = (week_pct, -ytd_deficit, section_priority, -time_bonus)
        ranked.append((priority, doctor_id))

    # Sort by priority (ascending)
    ranked.sort(key=lambda x: x[0])

    # Extract doctor IDs
    doctor_ids = [doctor_id for _, doctor_id in ranked]

    # Skip first N doctors on retry
    if retry_count > 0:
        doctor_ids = doctor_ids[retry_count:]

    return doctor_ids


def _assign_doctor_to_slot(
    state: ClinicianState,
    slot: SlotInfo,
    assignments: List[Assignment],
) -> None:
    """Assign a doctor to a slot and update state."""
    # Add to assigned slots
    if slot.date_iso not in state.assigned_slots_by_date:
        state.assigned_slots_by_date[slot.date_iso] = []
    state.assigned_slots_by_date[slot.date_iso].append(slot)

    # Set location
    state.location_by_date[slot.date_iso] = slot.location_id

    # Update hours
    hours = slot.duration_minutes / 60.0
    state.current_week_hours += hours
    state.ytd_hours += hours
    state.ytd_deficit = state.ytd_expected - state.ytd_hours

    # Create assignment
    assignments.append(Assignment(
        id=f"heur-{slot.date_iso}-{state.clinician_id}-{slot.slot_id}",
        rowId=slot.slot_id,
        dateISO=slot.date_iso,
        clinicianId=state.clinician_id,
        source="solver",
    ))


def _fill_consecutive_slots(
    state: ClinicianState,
    initial_slot: SlotInfo,
    day_slots: List[SlotInfo],
    clinician_states: Dict[str, ClinicianState],
    solver_settings: SolverSettings,
    config: HeuristicConfig,
    assignments: List[Assignment],
) -> None:
    """
    Fill consecutive slots at same location (FILL_CONSECUTIVE_SLOTS from MD).

    Rules (from MD Section 3, Phase 3):
    - Same location
    - No time gap (next starts when previous ends)
    - Different sections allowed (if qualified)
    - Always check qualifications
    - Respect hour limits
    - Stop when target hours reached
    """
    location = initial_slot.location_id
    end_time = initial_slot.end_minutes
    if initial_slot.end_day_offset > 0:
        end_time = initial_slot.start_minutes + initial_slot.duration_minutes

    # Check if already in good range
    if state.contract_hours > 0:
        min_target = state.contract_hours - state.tolerance_hours
        max_target = state.contract_hours + state.tolerance_hours
        if min_target <= state.current_week_hours <= max_target:
            return  # Already in good range

    # Look for consecutive slots
    while True:
        # Find slot that starts exactly when previous ends
        next_slot = None
        for slot in day_slots:
            if slot.location_id != location:
                continue
            if slot.date_iso != initial_slot.date_iso:
                continue
            if slot.start_minutes == end_time:
                # Check if already filled
                already_filled = any(
                    s.slot_id == slot.slot_id
                    for s in state.assigned_slots_by_date.get(slot.date_iso, [])
                )
                if not already_filled:
                    next_slot = slot
                    break

        if next_slot is None:
            break  # No consecutive slot found

        # Check qualification
        if next_slot.section_id not in state.eligible_sections:
            break

        # Check if would exceed max hours
        if state.would_exceed_hours(next_slot):
            break

        # Check mandatory time window
        if not state.fits_mandatory_time_window(next_slot):
            break

        # Assign to next slot
        _assign_doctor_to_slot(state, next_slot, assignments)

        # Update end time
        end_time = next_slot.end_minutes
        if next_slot.end_day_offset > 0:
            end_time = next_slot.start_minutes + next_slot.duration_minutes

        # Check if target reached
        if state.contract_hours > 0:
            min_target = state.contract_hours - state.tolerance_hours
            if state.current_week_hours >= min_target:
                break  # Target hours reached


def _send_solution_update(
    on_progress: Callable,
    timer: SolverTimer,
    assignments: List[Assignment],
) -> None:
    """Send SSE progress update with current solution."""
    on_progress("solution", {
        "solution_num": 1,
        "time_ms": round(timer.total_ms(), 1),
        "objective": len(assignments),
        "assignments": [a.model_dump() for a in assignments],
    })


def _build_notes(
    timer: SolverTimer,
    total_slots: int,
    num_assignments: int,
    warnings: List[str],
) -> List[str]:
    """Build notes list from solve results."""
    notes = []
    notes.append(f"Human Heuristic Solver (v2) completed in {timer.total_ms():.0f}ms.")
    notes.append(f"Created {num_assignments} assignments for {total_slots} total slots.")

    if warnings:
        notes.append(f"Warnings: {len(warnings)}")
        for warning in warnings[:5]:  # Limit to first 5
            notes.append(f"  - {warning}")
        if len(warnings) > 5:
            notes.append(f"  ... and {len(warnings) - 5} more")

    return notes


def _build_abort_response(
    payload: SolveRangeRequest,
    timer: SolverTimer,
    assignments: List[Assignment] = None,
) -> dict:
    """Build response when solver is aborted."""
    return {
        "startISO": payload.startISO,
        "endISO": payload.endISO or payload.startISO,
        "assignments": [a.model_dump() for a in (assignments or [])],
        "notes": [
            "Human Heuristic Solver (v2) was aborted.",
            f"Time until abort: {timer.total_ms():.0f}ms",
        ],
        "debugInfo": {
            "timing": timer.to_dict(),
            "solver_status": "ABORTED",
        },
    }


def _build_error_response(payload: SolveRangeRequest, error: str) -> dict:
    """Build response when an error occurs."""
    return {
        "startISO": payload.startISO,
        "endISO": payload.endISO or payload.startISO,
        "assignments": [],
        "notes": [f"Error: {error}"],
        "debugInfo": {
            "solver_status": "ERROR",
            "error": error,
        },
    }
