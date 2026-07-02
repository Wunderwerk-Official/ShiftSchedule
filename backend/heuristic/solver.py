"""
Heuristic Scheduler Main Module

This module orchestrates all phases of the heuristic scheduler:
1. Night/On-Call assignment
2. Coarse planning (location + pattern)
3. Fine assignment (section matching)
4. Repair loops
5. Local improvement

It provides the same interface as the CP-SAT solver for easy integration.
"""

import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..models import (
    AppState,
    Assignment,
    SolverSettings,
    SolveRangeRequest,
)
from ..solver import (
    _build_date_context,
    SolverTimer,
)
from .models import (
    HeuristicSolverStats,
    Position,
    SlotInstance,
    UnfilledPosition,
)
from .utils import (
    build_eligibility_matrix,
    count_filled_positions,
    count_required_positions,
    expand_positions,
    expand_slots_to_instances,
    initialize_clinician_day_states,
    mark_manual_assignments,
)
from .phases import (
    phase_night_oncall,
    phase_coarse_planning,
    phase_fine_assignment,
    phase_repair,
    phase_local_improvement,
)


def heuristic_solve_range(
    payload: SolveRangeRequest,
    state: AppState,
    cancel_event,
    on_progress: Callable[[str, Dict[str, Any]], None],
    start_time: float,
) -> dict:
    """
    Main entry point for the heuristic scheduler.

    Follows the same interface as the CP-SAT solver for easy integration.
    Returns a dict compatible with SolveRangeResponse.

    Args:
        payload: The solve request with date range and options
        state: The application state (clinicians, template, etc.)
        cancel_event: Threading event to check for abort
        on_progress: Callback for SSE progress updates
        start_time: Request start time for timeout calculation

    Returns:
        Dict with keys: startISO, endISO, assignments, notes, debugInfo
    """
    timer = SolverTimer()
    stats = HeuristicSolverStats()

    # Phase 0: Prepare data
    on_progress("phase", {"phase": "prepare", "label": "Vorbereitung: Daten laden..."})

    try:
        range_start, range_end, day_isos, target_day_isos, target_date_set, day_index_by_iso = \
            _build_date_context(payload)
    except ValueError as e:
        return _build_error_response(payload, str(e))

    holidays = state.holidays or []
    solver_settings = SolverSettings.model_validate(state.solverSettings or {})
    timer.checkpoint("prepare_context")

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer)

    # Phase 1: Expand slots to instances
    on_progress("phase", {"phase": "expand", "label": "Vorbereitung: Slots expandieren..."})

    slot_instances = expand_slots_to_instances(state, target_day_isos, holidays)
    slot_instances_by_id = {s.id: s for s in slot_instances}

    positions = expand_positions(slot_instances)
    stats.total_positions = len(positions)
    timer.checkpoint("expand_slots")

    # Mark manual assignments
    mark_manual_assignments(positions, state.assignments, slot_instances_by_id)
    stats.manual_positions = sum(1 for p in positions if p.is_manual)

    # Initialize clinician day states
    clinician_day_states = initialize_clinician_day_states(
        state.clinicians,
        target_day_isos,
        state.assignments,
        slot_instances_by_id,
    )
    timer.checkpoint("init_states")

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer)

    # Build eligibility matrix
    on_progress("phase", {"phase": "eligibility", "label": "Vorbereitung: Berechtigungen prüfen..."})

    eligibility_matrix = build_eligibility_matrix(
        positions,
        state.clinicians,
        slot_instances_by_id,
        clinician_day_states,
        solver_settings,
    )
    timer.checkpoint("build_eligibility")

    clinicians_by_id = {c.id: c for c in state.clinicians}

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer)

    # Phase 1: Night/On-Call
    on_progress("phase", {"phase": "night_oncall", "label": "Phase 1/5: Nacht/Bereitschaft..."})

    positions, clinician_day_states = phase_night_oncall(
        positions,
        slot_instances_by_id,
        eligibility_matrix,
        clinician_day_states,
        solver_settings.onCallRestClassId if solver_settings.onCallRestEnabled else None,
        solver_settings.onCallRestDaysBefore if solver_settings.onCallRestEnabled else 0,
        solver_settings.onCallRestDaysAfter if solver_settings.onCallRestEnabled else 0,
        target_day_isos,
        on_progress=lambda step, msg, cur, tot: None,
    )
    stats.night_oncall_assigned = sum(
        1 for p in positions
        if p.assigned_clinician_id and not p.is_manual
        and slot_instances_by_id.get(p.slot_instance_id)
        and slot_instances_by_id[p.slot_instance_id].band.value == "N"
    )
    timer.checkpoint("phase_night_oncall")
    stats.phase_times_ms["night_oncall"] = timer.checkpoints[-1][2]

    # Send solution update
    _send_solution_update(on_progress, 1, timer, positions, slot_instances_by_id)

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer, positions, slot_instances_by_id)

    # Phase 2: Coarse planning
    on_progress("phase", {"phase": "coarse", "label": "Phase 2/5: Grobplanung..."})

    clinician_day_states = phase_coarse_planning(
        positions,
        slot_instances_by_id,
        state.clinicians,
        clinician_day_states,
        target_day_isos,
        solver_settings,
        on_progress=lambda step, msg, cur, tot: None,
    )
    stats.coarse_patterns_set = sum(
        1 for state in clinician_day_states.values()
        if state.pattern.value != "OFF"
    )
    timer.checkpoint("phase_coarse")
    stats.phase_times_ms["coarse_planning"] = timer.checkpoints[-1][2]

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer, positions, slot_instances_by_id)

    # Phase 3: Fine assignment
    on_progress("phase", {"phase": "fine", "label": "Phase 3/5: Feinzuordnung..."})

    positions = phase_fine_assignment(
        positions,
        slot_instances_by_id,
        eligibility_matrix,
        clinician_day_states,
        clinicians_by_id,
        on_progress=lambda step, msg, cur, tot: None,
    )
    stats.fine_assigned = count_filled_positions(positions) - stats.manual_positions - stats.night_oncall_assigned
    timer.checkpoint("phase_fine")
    stats.phase_times_ms["fine_assignment"] = timer.checkpoints[-1][2]

    # Send solution update
    _send_solution_update(on_progress, 2, timer, positions, slot_instances_by_id)

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer, positions, slot_instances_by_id)

    # Phase 4: Repair
    on_progress("phase", {"phase": "repair", "label": "Phase 4/5: Reparatur..."})

    filled_before_repair = count_filled_positions(positions)
    positions, unfilled_reasons = phase_repair(
        positions,
        slot_instances_by_id,
        eligibility_matrix,
        clinician_day_states,
        clinicians_by_id,
        solver_settings,
        max_iterations=100,
        on_progress=lambda step, msg, cur, tot: None,
    )
    stats.repair_fixed = count_filled_positions(positions) - filled_before_repair
    timer.checkpoint("phase_repair")
    stats.phase_times_ms["repair"] = timer.checkpoints[-1][2]

    # Send solution update
    _send_solution_update(on_progress, 3, timer, positions, slot_instances_by_id)

    # Check for cancellation
    if cancel_event.is_set():
        return _build_abort_response(payload, timer, positions, slot_instances_by_id)

    # Phase 5: Local improvement
    on_progress("phase", {"phase": "improve", "label": "Phase 5/5: Optimierung..."})

    positions, swaps_made = phase_local_improvement(
        positions,
        slot_instances_by_id,
        clinician_day_states,
        clinicians_by_id,
        target_day_isos,
        max_iterations=50,
        on_progress=lambda step, msg, cur, tot: None,
    )
    stats.improvement_swaps = swaps_made
    timer.checkpoint("phase_improve")
    stats.phase_times_ms["local_improvement"] = timer.checkpoints[-1][2]

    # Send final solution update
    _send_solution_update(on_progress, 4, timer, positions, slot_instances_by_id)

    # Build result
    stats.filled_positions = count_filled_positions(positions)
    stats.required_positions = count_required_positions(positions, slot_instances_by_id)
    stats.unfilled_positions = stats.required_positions - sum(
        1 for p in positions
        if p.assigned_clinician_id
        and slot_instances_by_id.get(p.slot_instance_id)
        and slot_instances_by_id[p.slot_instance_id].required_count > 0
    )
    stats.total_time_ms = timer.total_ms()

    # Convert positions to assignments
    assignments = _convert_positions_to_assignments(positions, slot_instances_by_id)

    # Build notes
    notes = _build_notes(stats, unfilled_reasons)

    # Build debug info
    debug_info = {
        "timing": timer.to_dict(),
        "solution_times": [
            {"solution": 1, "time_ms": stats.phase_times_ms.get("night_oncall", 0), "objective": 0},
            {"solution": 2, "time_ms": stats.phase_times_ms.get("fine_assignment", 0), "objective": 0},
            {"solution": 3, "time_ms": stats.phase_times_ms.get("repair", 0), "objective": 0},
            {"solution": 4, "time_ms": stats.total_time_ms, "objective": stats.filled_positions},
        ],
        "num_variables": stats.total_positions,
        "num_days": len(target_day_isos),
        "num_slots": len(slot_instances),
        "solver_status": "HEURISTIC_COMPLETE",
        "cpu_workers_used": 1,
        "cpu_cores_available": 1,
        "heuristic_stats": {
            "night_oncall_assigned": stats.night_oncall_assigned,
            "coarse_patterns_set": stats.coarse_patterns_set,
            "fine_assigned": stats.fine_assigned,
            "repair_fixed": stats.repair_fixed,
            "improvement_swaps": stats.improvement_swaps,
        },
    }

    return {
        "startISO": range_start.isoformat(),
        "endISO": range_end.isoformat(),
        "assignments": [a.model_dump() for a in assignments],
        "notes": notes,
        "debugInfo": debug_info,
    }


def _convert_positions_to_assignments(
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> List[Assignment]:
    """Convert assigned positions to Assignment objects."""
    assignments = []

    for position in positions:
        if not position.assigned_clinician_id:
            continue
        if position.is_manual:
            continue  # Don't include manual assignments in solver output

        slot_inst = slot_instances_by_id.get(position.slot_instance_id)
        if not slot_inst:
            continue

        assignments.append(Assignment(
            id=f"heur-{slot_inst.date_iso}-{position.assigned_clinician_id}-{slot_inst.slot_id}",
            rowId=slot_inst.slot_id,
            dateISO=slot_inst.date_iso,
            clinicianId=position.assigned_clinician_id,
            source="solver",
        ))

    return assignments


def _build_notes(
    stats: HeuristicSolverStats,
    unfilled_reasons: List[UnfilledPosition],
) -> List[str]:
    """Build notes list from stats and unfilled reasons."""
    notes = []

    # Add completion note
    notes.append(f"Heuristischer Solver abgeschlossen in {stats.total_time_ms:.0f}ms.")

    # Add coverage info
    if stats.unfilled_positions > 0:
        notes.append(f"Konnte {stats.unfilled_positions} von {stats.required_positions} Pflichtpositionen nicht besetzen.")

        # Group unfilled by reason
        reasons_count: Dict[str, int] = {}
        for uf in unfilled_reasons:
            reason_str = uf.reason.value
            reasons_count[reason_str] = reasons_count.get(reason_str, 0) + 1

        for reason, count in reasons_count.items():
            notes.append(f"  - {reason}: {count}")
    else:
        notes.append(f"Alle {stats.required_positions} Pflichtpositionen besetzt.")

    # Add phase stats
    notes.append(f"Phasen: Nacht={stats.night_oncall_assigned}, Grob={stats.coarse_patterns_set}, "
                f"Fein={stats.fine_assigned}, Repair={stats.repair_fixed}, Swaps={stats.improvement_swaps}")

    return notes


def _send_solution_update(
    on_progress: Callable,
    solution_num: int,
    timer: SolverTimer,
    positions: List[Position],
    slot_instances_by_id: Dict[str, SlotInstance],
) -> None:
    """Send a solution update via SSE."""
    filled = count_filled_positions(positions)
    assignments = _convert_positions_to_assignments(positions, slot_instances_by_id)

    on_progress("solution", {
        "solution_num": solution_num,
        "time_ms": round(timer.total_ms(), 1),
        "objective": filled,
        "assignments": [a.model_dump() for a in assignments],
    })


def _build_abort_response(
    payload: SolveRangeRequest,
    timer: SolverTimer,
    positions: Optional[List[Position]] = None,
    slot_instances_by_id: Optional[Dict[str, SlotInstance]] = None,
) -> dict:
    """Build response when solver is aborted."""
    assignments = []
    if positions and slot_instances_by_id:
        assignments = [
            a.model_dump()
            for a in _convert_positions_to_assignments(positions, slot_instances_by_id)
        ]

    return {
        "startISO": payload.startISO,
        "endISO": payload.endISO or payload.startISO,
        "assignments": assignments,
        "notes": [
            "Heuristischer Solver wurde abgebrochen.",
            f"Zeit bis Abbruch: {timer.total_ms():.0f}ms",
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
        "notes": [f"Fehler: {error}"],
        "debugInfo": {
            "solver_status": "ERROR",
            "error": error,
        },
    }
