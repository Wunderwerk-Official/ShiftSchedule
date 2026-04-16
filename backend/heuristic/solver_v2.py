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
        if self.end_day_offset > 0:
            base += self.end_day_offset * 24 * 60
        elif base < 0:  # Overnight slot without explicit end_day_offset
            base += 24 * 60
        return max(0, base)


class ClinicianState:
    """State for a single clinician across the solve range."""
    def __init__(self, clinician: Clinician, solve_start_date: date):
        self.clinician_id = clinician.id
        self.contract_hours = clinician.workingHoursPerWeek or 0
        # Match fallback used elsewhere (solver.py:1182, local_improvement.py:219) to avoid
        # TypeError in would_exceed_hours() if the field comes through as None.
        self.tolerance_hours = clinician.workingHoursToleranceHours or 5
        self.eligible_sections = clinician.qualifiedClassIds
        self.preferred_sections = clinician.preferredClassIds
        self.preferred_working_times = getattr(clinician, "preferredWorkingTimes", {})
        self.vacations = clinician.vacations

        # Calculate year-to-date hours and deficit
        self.ytd_hours = 0.0  # Will be calculated from assignments
        self._historical_ytd_hours = 0.0  # Hours from before solve range (set by _calculate_historical_ytd_hours)
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

        # Check overnight slots from previous days extending into today
        today = date.fromisoformat(date_iso)
        for days_back in range(1, 4):  # Check up to 3 days back (matching v1 cap)
            prev_date = (today - timedelta(days=days_back)).isoformat()
            prev_slots = self.assigned_slots_by_date.get(prev_date, [])
            for existing in prev_slots:
                effective_offset = existing.end_day_offset
                if effective_offset == 0 and existing.end_minutes <= existing.start_minutes:
                    effective_offset = 1  # Implicit overnight
                if effective_offset >= days_back:
                    # This slot extends into today
                    if effective_offset > days_back:
                        overnight_end_today = 1440  # Spans through entire today
                    else:
                        overnight_end_today = existing.end_minutes  # Ends today
                    if not (slot_end <= 0 or overnight_end_today <= slot_start):
                        return True

        # Check if the new slot extends into future days and conflicts
        new_effective_offset = slot.end_day_offset
        if new_effective_offset == 0 and slot.end_minutes <= slot.start_minutes:
            new_effective_offset = 1  # Implicit overnight
        if new_effective_offset > 0:
            for days_forward in range(1, min(new_effective_offset + 1, 4)):
                next_date = (today + timedelta(days=days_forward)).isoformat()
                next_slots = self.assigned_slots_by_date.get(next_date, [])
                if days_forward < new_effective_offset:
                    overflow_end = 1440  # New slot spans through entire day
                else:
                    overflow_end = slot.end_minutes  # New slot ends on this day
                for existing in next_slots:
                    existing_start = existing.start_minutes
                    existing_end = existing.end_minutes
                    if existing.end_day_offset > 0 or existing_end < existing_start:
                        existing_end = existing_start + existing.duration_minutes
                    if not (overflow_end <= existing_start or existing_end <= 0):
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

        # Normalize overnight slot end time
        slot_end = slot.end_minutes
        if slot.end_day_offset > 0 or slot_end < slot.start_minutes:
            slot_end = slot.start_minutes + slot.duration_minutes

        # Slot must fall entirely within the window
        return slot.start_minutes >= start_pref and slot_end <= end_pref

    def has_location_conflict(self, date_iso: str, location_id: str) -> bool:
        """Check if assigning to this location would create a conflict."""
        existing_location = self.location_by_date.get(date_iso)
        if existing_location is None:
            return False  # No location assigned yet
        return existing_location != location_id

    def would_create_gap(self, date_iso: str, slot: SlotInfo) -> bool:
        """Check if adding this slot would create a non-contiguous work block (split shift)."""
        assigned = self.assigned_slots_by_date.get(date_iso, [])
        if not assigned:
            return False  # First slot of the day, no gap possible

        # Build list of (start, end) intervals for all assigned + new slot
        def slot_interval(s: SlotInfo) -> Tuple[int, int]:
            start = s.start_minutes
            end = s.end_minutes
            if s.end_day_offset > 0 or end < start:
                end = start + s.duration_minutes
            return (start, end)

        intervals = [slot_interval(s) for s in assigned]
        new_interval = slot_interval(slot)
        intervals.append(new_interval)

        # Sort by start time
        intervals.sort()

        # Merge adjacent/overlapping intervals
        merged = [intervals[0]]
        for start, end in intervals[1:]:
            if start <= merged[-1][1]:  # Adjacent or overlapping
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))

        # Count how many blocks existed BEFORE adding the new slot
        existing_intervals = [slot_interval(s) for s in assigned]
        existing_intervals.sort()
        existing_merged = [existing_intervals[0]]
        for start, end in existing_intervals[1:]:
            if start <= existing_merged[-1][1]:
                existing_merged[-1] = (existing_merged[-1][0], max(existing_merged[-1][1], end))
            else:
                existing_merged.append((start, end))

        # If manual assignments already created multiple blocks, allow adding to them
        # but don't create even MORE blocks
        return len(merged) > len(existing_merged)


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

    # Add historical YTD hours from assignments before solve range
    _calculate_historical_ytd_hours(
        state.assignments,
        state,
        clinician_states,
        range_start,
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

    # Phase 0.5: Constrained Doctor Pre-assignment
    # Assign specialists (doctors with limited section options) first to prevent
    # flexible generalists from taking their slots.
    specialist_assignments, specialist_warnings = _preassign_constrained_doctors(
        slot_instances,
        clinician_states,
        solver_settings,
        config,
        cancel_event,
    )

    # Add bottleneck assignments to manual_assignments_map so they're preserved during backtracking
    for assignment in specialist_assignments:
        day_iso = assignment.dateISO
        clinician_id = assignment.clinicianId
        # Find the slot
        slot = next((s for s in slot_instances if s.slot_id == assignment.rowId and s.date_iso == day_iso), None)
        if slot:
            map_key = (day_iso, clinician_id)
            if map_key not in manual_assignments_map:
                manual_assignments_map[map_key] = []
            # Mark as "bottleneck" source so we can track it
            manual_assignments_map[map_key].append(("bottleneck", slot))

    timer.checkpoint("specialists")

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer, specialist_assignments)

    # Phase 1: Day-by-day iteration
    all_assignments = specialist_assignments[:]
    warnings = specialist_warnings[:]

    prev_week_number = None
    for day_iso in target_day_isos:
        # Reset weekly hours at the start of each new week (Monday)
        current_date = date.fromisoformat(day_iso)
        week_number = current_date.isocalendar()[1]
        if prev_week_number is not None and week_number != prev_week_number:
            # New week - reset all clinicians' weekly hours
            for cs in clinician_states.values():
                cs.current_week_hours = 0.0
        prev_week_number = week_number

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


def _calculate_historical_ytd_hours(
    assignments: List[Assignment],
    app_state: AppState,
    clinician_states: Dict[str, ClinicianState],
    range_start: date,
) -> None:
    """
    Add YTD hours from assignments before the solve range.

    _mark_manual_assignments only counts hours for assignments within the solve
    range (since slot_instances only cover target dates). This function adds
    hours from earlier assignments in the same year so that YTD deficit
    calculations are accurate.
    """
    # Build duration lookup from slot templates (slot_id -> duration_minutes)
    slot_contexts = _collect_slot_contexts(app_state)
    slot_duration_by_id: Dict[str, int] = {}
    for ctx in slot_contexts:
        slot = ctx["slot"]
        start, end, _ = _build_slot_interval(slot, ctx["location_id"])
        end_day_offset = getattr(slot, "endDayOffset", 0) or 0
        duration = end - start
        if end_day_offset > 0:
            duration += end_day_offset * 24 * 60
        elif duration < 0:
            duration += 24 * 60
        slot_duration_by_id[slot.id] = max(0, duration)

    for assignment in assignments:
        if assignment.rowId.startswith("pool-"):
            continue

        try:
            assignment_date = date.fromisoformat(assignment.dateISO)
        except (ValueError, TypeError):
            continue

        # Only count assignments before the solve range, in the same year
        if assignment_date >= range_start:
            continue
        if assignment_date.year != range_start.year:
            continue

        clinician_state = clinician_states.get(assignment.clinicianId)
        if not clinician_state:
            continue

        duration = slot_duration_by_id.get(assignment.rowId, 0)
        if duration > 0:
            hours = duration / 60.0
            clinician_state._historical_ytd_hours += hours
            clinician_state.ytd_hours += hours

    # Recalculate deficits
    for state in clinician_states.values():
        state.ytd_deficit = state.ytd_expected - state.ytd_hours


def _preassign_constrained_doctors(
    all_slot_instances: List[SlotInfo],
    clinician_states: Dict[str, ClinicianState],
    solver_settings: SolverSettings,
    config: HeuristicConfig,
    cancel_event,
) -> Tuple[List[Assignment], List[str]]:
    """
    Phase 0.5: Pre-assign constrained doctors (specialists) first.

    This ensures doctors with limited section options get their work before
    flexible generalists take those slots. Without this, a specialist like
    Dr. Brown (only mammography) might be left idle while Dr. Johnson
    (MRI + mammography) takes all the mammography slots.

    Algorithm:
    1. Identify specialists: doctors with <= SPECIALIST_THRESHOLD qualified sections
    2. Sort by constraint level (fewest options first)
    3. For each specialist, greedily assign them to unfilled slots in their domain
    4. Mark those slots as filled before main algorithm runs

    Returns: (assignments made, warnings)
    """
    assignments = []
    warnings = []
    bottleneck_count = 0

    # Group slots by date for efficient processing
    slots_by_date = {}
    for slot in all_slot_instances:
        if slot.date_iso not in slots_by_date:
            slots_by_date[slot.date_iso] = []
        slots_by_date[slot.date_iso].append(slot)

    # Process all dates
    for date_iso in sorted(slots_by_date.keys()):
        day_slots = slots_by_date[date_iso]

        # Iteratively find and assign bottleneck slots
        # (eligibility changes after each assignment, so we need to loop)
        max_iterations = len(day_slots) * 2  # Prevent infinite loops
        iteration = 0

        while iteration < max_iterations:
            if cancel_event.is_set():
                break

            iteration += 1
            found_bottleneck = False

            # Find unfilled slots and their eligible doctors
            for slot in day_slots:
                # Check if slot still needs filling
                filled_count = sum(
                    1 for s in clinician_states.values()
                    if any(assigned.slot_id == slot.slot_id
                           for assigned in s.assigned_slots_by_date.get(slot.date_iso, []))
                )
                if filled_count >= slot.required_count:
                    continue  # Slot already filled

                # Find eligible doctors for this slot
                eligible = []
                for clinician_id, state in clinician_states.items():
                    if _is_doctor_eligible_for_slot(state, slot, solver_settings):
                        eligible.append((clinician_id, state))

                # If only 1 doctor eligible → bottleneck!
                if len(eligible) == 1:
                    clinician_id, state = eligible[0]

                    # Pre-assign this slot
                    assignment = _assign_slot_to_doctor(slot, state, "solver")
                    assignments.append(assignment)
                    bottleneck_count += 1
                    found_bottleneck = True

                    if bottleneck_count == 1:
                        warnings.append(f"[BOTTLENECK] Pre-assigning slots with only 1 eligible doctor")

                    # Break and recheck all slots (eligibility may have changed)
                    break

            # If no bottlenecks found in this iteration, we're done
            if not found_bottleneck:
                break

    if bottleneck_count > 0:
        warnings.append(f"[BOTTLENECK] Pre-assigned {bottleneck_count} bottleneck slot(s)")

    return assignments, warnings


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
    best_assignments = []

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

        # Keep track of best attempt
        if len(day_assignments) > len(best_assignments):
            best_assignments = day_assignments

        if success:
            return day_assignments, warnings

        # Failed, will retry
        if retry_count < config.MAX_DAY_RETRIES - 1:
            warnings.append(f"Day {day_iso}: retry {retry_count + 1}/{config.MAX_DAY_RETRIES}")

    # All retries failed - return best partial solution
    warnings.append(f"Day {day_iso}: Could not fully fill after {config.MAX_DAY_RETRIES} attempts")

    # Restore clinician state to match best solution
    # (The last retry may have left state in inconsistent state)
    _reset_day_to_manual_only(day_iso, clinician_states, manual_assignments_map)
    # Re-apply best assignments to restore correct state
    for assignment in best_assignments:
        clinician_id = assignment.clinicianId
        slot_id = assignment.rowId
        # Find the slot
        matching_slot = next((s for s in day_slots if s.slot_id == slot_id), None)
        if matching_slot and clinician_id in clinician_states:
            state = clinician_states[clinician_id]
            # Re-apply assignment (without creating new Assignment object)
            if day_iso not in state.assigned_slots_by_date:
                state.assigned_slots_by_date[day_iso] = []
            state.assigned_slots_by_date[day_iso].append(matching_slot)
            if day_iso not in state.location_by_date:
                state.location_by_date[day_iso] = matching_slot.location_id
            hours = matching_slot.duration_minutes / 60.0
            state.current_week_hours += hours
            state.ytd_hours += hours
            state.ytd_deficit = state.ytd_expected - state.ytd_hours

    # Return best partial solution
    return best_assignments, warnings


def _reset_day_to_manual_only(
    day_iso: str,
    clinician_states: Dict[str, ClinicianState],
    manual_assignments_map: Dict[Tuple[str, str], List[Tuple[str, SlotInfo]]],
) -> None:
    """
    Reset day to only include manual and bottleneck assignments.

    This implements the backtracking logic: before each retry, we clear
    solver-generated assignments and restore only manual and bottleneck ones.
    Bottleneck assignments (slots with only 1 eligible doctor) are preserved
    because they must be assigned to that specific doctor.
    """
    # For each clinician, reset their state for this day
    for clinician_id, state in clinician_states.items():
        # Get assignments for this clinician on this day
        map_key = (day_iso, clinician_id)
        assigned_slots = manual_assignments_map.get(map_key, [])

        # Filter to manual and bottleneck assignments (preserve both during backtracking)
        preserved_slots = [slot for source, slot in assigned_slots if source in ["manual", "bottleneck"]]

        # Reset assigned slots for this day
        if preserved_slots:
            state.assigned_slots_by_date[day_iso] = preserved_slots
            # Set location from first preserved slot
            state.location_by_date[day_iso] = preserved_slots[0].location_id
        else:
            # No preserved assignments, clear the day
            if day_iso in state.assigned_slots_by_date:
                del state.assigned_slots_by_date[day_iso]
            if day_iso in state.location_by_date:
                del state.location_by_date[day_iso]

        # Recalculate hours from assigned slots (source of truth)
        current_week = date.fromisoformat(day_iso).isocalendar()[1]
        current_year = date.fromisoformat(day_iso).isocalendar()[0]
        state.current_week_hours = 0.0
        state.ytd_hours = 0.0
        for assigned_date_iso, slots in state.assigned_slots_by_date.items():
            for slot in slots:
                hours = slot.duration_minutes / 60.0
                state.ytd_hours += hours
                assigned_week = date.fromisoformat(assigned_date_iso).isocalendar()[1]
                assigned_year = date.fromisoformat(assigned_date_iso).isocalendar()[0]
                if assigned_week == current_week and assigned_year == current_year:
                    state.current_week_hours += hours
        state.ytd_hours += state._historical_ytd_hours
        state.ytd_deficit = state.ytd_expected - state.ytd_hours


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
    unfillable_count = 0
    skipped_count = 0
    for slot, criticality, eligible_list in slot_criticality:
        if cancel_event.is_set():
            return False, assignments

        # Re-filter eligible doctors (assignments may have changed since we built the list)
        eligible_list = _filter_eligible_doctors(slot, clinician_states, solver_settings)

        if not eligible_list:
            if criticality == 0:
                # Slot was already unfillable before any assignments - skip it
                unfillable_count += 1
                continue
            else:
                # Slot became unfillable due to earlier assignments — trigger backtracking
                return False, assignments

        # Rank doctors
        ranked_doctors = _rank_doctors_by_deficit(eligible_list, slot, retry_count, clinician_states)

        if not ranked_doctors:
            # All ranked doctors were skipped by retry offset - skip this slot
            skipped_count += 1
            continue

        # Assign top-ranked doctor
        chosen_doctor_id = ranked_doctors[0]
        chosen_state = clinician_states[chosen_doctor_id]

        # Make assignment
        _assign_doctor_to_slot(chosen_state, slot, assignments)

        # Try consecutive slot filling
        if config.ENABLE_CONSECUTIVE_FILLING:
            _fill_consecutive_slots(chosen_state, slot, day_slots, clinician_states, solver_settings, config, assignments)

    # If slots were skipped due to retry offset, signal failure so the
    # retry loop can pick the best attempt (typically retry_count=0).
    if skipped_count > 0:
        return False, assignments

    return True, assignments


def _is_doctor_eligible_for_slot(
    state: ClinicianState,
    slot: SlotInfo,
    solver_settings: SolverSettings,
) -> bool:
    """
    Check if a single doctor is eligible for a slot (all 7 criteria).

    Returns: True if eligible, False otherwise
    """
    # 1. Qualification
    if slot.section_id not in state.eligible_sections:
        return False

    # 2. Vacation
    if state.is_on_vacation(slot.date_iso):
        return False

    # 3. Time overlap
    if state.has_time_overlap(slot.date_iso, slot):
        return False

    # 4. Mandatory time window
    if not state.fits_mandatory_time_window(slot):
        return False

    # 5. On-call rest days
    if slot.date_iso in state.rest_days:
        return False

    # 6. Same location per day
    if solver_settings.enforceSameLocationPerDay:
        if state.has_location_conflict(slot.date_iso, slot.location_id):
            return False

    # 7. Hour limit
    if state.would_exceed_hours(slot):
        return False

    # 8. Continuous shift enforcement (no split shifts)
    if solver_settings.preferContinuousShifts:
        if state.would_create_gap(slot.date_iso, slot):
            return False

    return True


def _assign_slot_to_doctor(
    slot: SlotInfo,
    state: ClinicianState,
    source: str = "solver",
) -> Assignment:
    """
    Assign a slot to a doctor and update their state.

    Returns: Assignment object
    """
    # Update state
    if slot.date_iso not in state.assigned_slots_by_date:
        state.assigned_slots_by_date[slot.date_iso] = []
    state.assigned_slots_by_date[slot.date_iso].append(slot)
    if slot.date_iso not in state.location_by_date:
        state.location_by_date[slot.date_iso] = slot.location_id

    # Update hours
    hours = slot.duration_minutes / 60.0
    state.current_week_hours += hours
    state.ytd_hours += hours
    state.ytd_deficit = state.ytd_expected - state.ytd_hours

    # Create assignment
    assignment = Assignment(
        id=f"heur-{slot.date_iso}-{state.clinician_id}-{slot.slot_id}",
        clinicianId=state.clinician_id,
        rowId=slot.slot_id,
        dateISO=slot.date_iso,
        source=source if source in ["manual", "solver"] else "solver",
    )
    return assignment


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
        if _is_doctor_eligible_for_slot(state, slot, solver_settings):
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

        # Tertiary: section preference (per spec, use eligible_sections ordering)
        try:
            section_priority = state.eligible_sections.index(slot.section_id)
        except ValueError:
            section_priority = 999  # Not in list

        # Quaternary: time preference bonus
        time_bonus = 0
        weekday_key = _get_weekday_key(slot.date_iso)
        if weekday_key in state.preferred_working_times:
            pref = state.preferred_working_times[weekday_key]
            if hasattr(pref, "requirement") and pref.requirement == "preference":
                start_pref = _parse_time_to_minutes(getattr(pref, "startTime", None))
                end_pref = _parse_time_to_minutes(getattr(pref, "endTime", None))
                # Overnight slots can't fit a single-day preference window — their
                # end_minutes refers to the next day, so a naive comparison would
                # spuriously award bonuses (e.g. a 22:00–06:00 slot passing a
                # 08:00–18:00 daytime preference). Skip the bonus in that case.
                is_overnight = (
                    slot.end_day_offset > 0 or slot.end_minutes < slot.start_minutes
                )
                if (
                    start_pref is not None
                    and end_pref is not None
                    and not is_overnight
                    and start_pref <= slot.start_minutes
                    and slot.end_minutes <= end_pref
                ):
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
    """Assign a doctor to a slot and update state (wrapper for _assign_slot_to_doctor)."""
    assignment = _assign_slot_to_doctor(slot, state, source="solver")
    assignments.append(assignment)


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
                # Check if already filled by ANY clinician (not just this one)
                filled_count = sum(
                    1 for s in clinician_states.values()
                    if any(assigned.slot_id == slot.slot_id
                           for assigned in s.assigned_slots_by_date.get(slot.date_iso, []))
                )
                if filled_count < slot.required_count:
                    next_slot = slot
                    break

        if next_slot is None:
            break  # No consecutive slot found

        # Check all eligibility criteria (qualification, vacation, time overlap,
        # mandatory time window, on-call rest, location, hours, continuity)
        if not _is_doctor_eligible_for_slot(state, next_slot, solver_settings):
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
