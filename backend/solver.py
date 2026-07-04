"""
Shift Schedule Solver using Google OR-Tools CP-SAT.

This module provides an automated schedule solver that assigns clinicians to shifts
while respecting constraints and optimizing for various objectives.

ARCHITECTURE
============
- The solver runs in a subprocess to allow force-abort and prevent blocking the main API.
- Real-time progress is streamed via Server-Sent Events (SSE) to the frontend.
- A heartbeat mechanism ensures orphaned subprocesses are cleaned up.

SOLVER PHASES (shown in UI progress)
====================================
1. load_state: Load schedule data from disk
2. slot_contexts: Analyze shift patterns from weekly template
3. create_variables: Create boolean decision variables (clinician × date × slot)
4. overlap_constraints: Prevent time conflicts and enforce same-location-per-day
5. coverage_constraints: Ensure required slots are filled
6. on_call_rest_days: Block days before/after on-call shifts
7. working_hours_constraints: Balance weekly hours per clinician
8. continuity_constraints: Enforce max continuous blocks per day
9. objective_setup: Build weighted objective function
10. solve: Run CP-SAT solver with solution callbacks

OBJECTIVE FUNCTION
==================
The solver minimizes a weighted sum of terms (some negated for maximization).
Defaults live in DEFAULT_WEIGHT_* constants below; users override them through
solverSettings in the app state.
- Coverage: maximise filled required slots (default weight: 1000)
- Slack: minimise unfilled slots (default weight: 1000)
- Total Assignments: maximise assignments in "Distribute All" mode (default weight: 100)
- Slot Priority: prefer earlier slots in template order (default weight: 10)
- Time Window: respect clinician preferred working hours (default weight: 20)
- Section Preference: assign clinicians to preferred sections (default weight: 10)
- Working Hours: balance hours to target ± tolerance (default weight: 3)
- Minimum Daily Hours: penalise days below the configured daily minimum (default weight: 5)
- YTD Balance: nudge year-to-date hours toward the per-clinician target (default weight: 5)

CONSTRAINTS
===========
- Qualification: Clinicians can only be assigned to sections they're qualified for
- Overlap: No overlapping time intervals for the same clinician
- Location: Optionally enforce same location per day per clinician
- Vacation: Clinicians on vacation cannot be assigned
- On-call rest: Configurable rest days before/after on-call shifts
- Continuity: If enabled, each clinician/day has at most one continuous block (or existing manual blocks)
- Manual assignments: Existing manual assignments are preserved as constraints

KEY DATA STRUCTURES
===================
- var_map: Dict[(clinician_id, date_iso, slot_id), BoolVar] - Decision variables
- slot_intervals: Dict[slot_id, (start_minutes, end_minutes, location_id)]
- manual_assignments: Dict[(clinician_id, date_iso), List[slot_id]] - Fixed assignments
- vars_by_clinician_date: Optimized lookup for constraints (O(n²) → O(slots_per_day²))
"""

import asyncio
import atexit
from datetime import date, datetime, timedelta
import json
import multiprocessing
import os
import signal
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from ortools.sat.python import cp_model

from .auth import _get_current_user, _verify_token_and_get_user

# Global cancellation event for solver abort
_solver_cancel_event = threading.Event()
_solver_running_lock = threading.Lock()
_solver_is_running = False
_solver_process: Optional[multiprocessing.Process] = None  # The solver subprocess

# Global list of (username, queue) for SSE clients to receive solver progress.
# Progress is delivered only to subscribers of the user who owns the active
# run — the channel used to be a broadcast to everyone, which leaked one
# user's draft assignments to all others and mixed foreign solution events
# into the live score chart (visible as a full-height "jump" mid-run).
_solver_progress_subscribers: List[Tuple[str, asyncio.Queue]] = []
_subscribers_lock = threading.Lock()

# Identity of the active run. Written under _solver_running_lock when a run
# starts; read by _broadcast_solver_progress. Deliberately NOT cleared when a
# run ends: late queue drains keep the old token, so a client that already
# started its next run filters them out by token mismatch.
_active_run_owner: Optional[str] = None
_active_run_token: Optional[str] = None

# Multiprocessing context for spawning solver processes
_mp_context = multiprocessing.get_context("spawn")

# Debug mode: set DEBUG_SOLVER=true to enable detailed timing logs
DEBUG_SOLVER = os.getenv("DEBUG_SOLVER", "").lower() == "true"

# Number of CPU cores to use for solver (leave 2 free for system responsiveness)
SOLVER_NUM_WORKERS = max(1, multiprocessing.cpu_count() - 2)

# Heartbeat timeout: if no heartbeat received for this long, subprocess terminates itself
SUBPROCESS_HEARTBEAT_TIMEOUT_SECONDS = 10.0


def _cleanup_solver_process():
    """Aggressively cleanup any running solver subprocess."""
    global _solver_process, _solver_is_running
    if _solver_process is not None:
        try:
            if _solver_process.is_alive():
                # First try graceful terminate
                _solver_process.terminate()
                _solver_process.join(timeout=2.0)
                # If still alive, force kill
                if _solver_process.is_alive():
                    _solver_process.kill()
                    _solver_process.join(timeout=1.0)
        except Exception:
            pass
        finally:
            _solver_process = None
            _solver_is_running = False


# Register cleanup on process exit
atexit.register(_cleanup_solver_process)


def _cleanup_orphaned_solver_processes():
    """
    Clean up any orphaned solver subprocesses from previous runs.
    Called on backend startup to ensure no stale processes are running.
    """
    import subprocess
    import sys

    try:
        # Find processes that match our solver subprocess pattern
        # On macOS/Linux, look for python processes with _solver_subprocess_worker
        if sys.platform == "darwin" or sys.platform.startswith("linux"):
            # Use pgrep to find python processes, then filter by command line
            result = subprocess.run(
                ["pgrep", "-f", "_solver_subprocess_worker"],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0 and result.stdout.strip():
                pids = result.stdout.strip().split("\n")
                current_pid = os.getpid()
                for pid_str in pids:
                    try:
                        pid = int(pid_str.strip())
                        # Don't kill ourselves
                        if pid != current_pid:
                            print(f"[solver] Killing orphaned solver subprocess: {pid}")
                            os.kill(pid, signal.SIGKILL)
                    except (ValueError, ProcessLookupError, PermissionError):
                        pass
    except Exception as e:
        print(f"[solver] Error cleaning up orphaned processes: {e}")


# Clean up orphans on module load (backend startup)
_cleanup_orphaned_solver_processes()


class SolverTimer:
    """Track timing for each step of the solver."""

    def __init__(self):
        self.start_time = time.time()
        self.checkpoints: List[Tuple[str, float, float]] = []  # (name, timestamp, duration_ms)
        self.last_checkpoint = self.start_time

    def checkpoint(self, name: str) -> float:
        """Record a checkpoint and return the duration since last checkpoint in ms."""
        now = time.time()
        duration_ms = (now - self.last_checkpoint) * 1000
        self.checkpoints.append((name, now, duration_ms))
        self.last_checkpoint = now
        return duration_ms

    def total_ms(self) -> float:
        """Return total elapsed time in ms."""
        return (time.time() - self.start_time) * 1000

    def to_dict(self) -> Dict[str, Any]:
        """Return timing data as a dictionary."""
        return {
            "total_ms": self.total_ms(),
            "checkpoints": [
                {"name": name, "duration_ms": round(dur, 2)}
                for name, _, dur in self.checkpoints
            ],
        }

    def summary(self) -> str:
        """Return a human-readable summary."""
        lines = [f"Total: {self.total_ms():.1f}ms"]
        for name, _, dur in self.checkpoints:
            lines.append(f"  {name}: {dur:.1f}ms")
        return "\n".join(lines)


def _dump_solver_debug(
    timer: SolverTimer,
    payload: Any,
    state: Any,
    model_stats: Dict[str, Any],
    result_info: Dict[str, Any],
) -> None:
    """Dump detailed solver debug info to a JSON file."""
    if not DEBUG_SOLVER:
        return

    debug_dir = "backend/logs/solver_debug"
    os.makedirs(debug_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"{debug_dir}/solve_{timestamp}.json"

    # Prepare state summary (avoid dumping full state unless needed)
    state_summary = {
        "clinicians_count": len(state.clinicians) if hasattr(state, "clinicians") else 0,
        "locations_count": len(state.locations) if hasattr(state, "locations") else 0,
        "assignments_count": len(state.assignments) if hasattr(state, "assignments") else 0,
        "holidays_count": len(state.holidays) if hasattr(state, "holidays") else 0,
    }

    # Add clinician details for debugging qualification issues
    clinician_details = []
    for c in (state.clinicians if hasattr(state, "clinicians") else []):
        clinician_details.append({
            "id": c.id,
            "name": getattr(c, "name", "unknown"),
            "qualified_sections": len(c.qualifiedClassIds) if hasattr(c, "qualifiedClassIds") else 0,
            "vacations": len(c.vacations) if hasattr(c, "vacations") else 0,
        })
    state_summary["clinicians"] = clinician_details

    debug_data = {
        "timestamp": timestamp,
        "request": {
            "startISO": getattr(payload, "startISO", None),
            "endISO": getattr(payload, "endISO", None),
            "onlyFillRequired": getattr(payload, "onlyFillRequired", getattr(payload, "only_fill_required", None)),
        },
        "timing": timer.to_dict(),
        "state_summary": state_summary,
        "model_stats": model_stats,
        "result": result_info,
    }

    try:
        with open(filename, "w") as f:
            json.dump(debug_data, f, indent=2, default=str)
        print(f"[DEBUG_SOLVER] Wrote debug dump to {filename}")
    except Exception as e:
        print(f"[DEBUG_SOLVER] Failed to write debug dump: {e}")
from .constants import (
    DEFAULT_LOCATION_ID,
    DEFAULT_SUB_SHIFT_MINUTES,
    DEFAULT_SUB_SHIFT_START_MINUTES,
)
from .models import (
    Assignment,
    Holiday,
    SolveRangeRequest,
    SolveRangeResponse,
    SolverDebugInfo,
    SolverDebugSolutionTime,
    SolverSettings,
    SolverSubScores,
    UserPublic,
)
from .state import _load_state

router = APIRouter()


def _solver_subprocess_worker(
    username: str,
    payload_dict: dict,
    progress_queue: multiprocessing.Queue,
    cancel_event: multiprocessing.Event,
    heartbeat_value: multiprocessing.Value,
    start_time: float,
):
    """
    Worker function that runs in a subprocess.
    Performs the actual CP-SAT solving and sends progress via queue.

    The heartbeat_value is a shared counter that the parent process increments.
    If it doesn't change for SUBPROCESS_HEARTBEAT_TIMEOUT_SECONDS, we assume
    the parent is gone (e.g., browser tab closed) and terminate ourselves.

    start_time is the timestamp when the solve request started (for accurate timeout).
    """
    import sys

    # Set up signal handlers for graceful termination
    def signal_handler(signum, frame):
        print(f"[solver subprocess] Received signal {signum}, setting cancel event", file=sys.stderr)
        cancel_event.set()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    # Start a watchdog thread to monitor heartbeat
    last_heartbeat = heartbeat_value.value
    last_heartbeat_time = time.time()
    watchdog_stop = threading.Event()

    def heartbeat_watchdog():
        nonlocal last_heartbeat, last_heartbeat_time
        while not watchdog_stop.is_set():
            current_heartbeat = heartbeat_value.value
            if current_heartbeat != last_heartbeat:
                last_heartbeat = current_heartbeat
                last_heartbeat_time = time.time()
            elif time.time() - last_heartbeat_time > SUBPROCESS_HEARTBEAT_TIMEOUT_SECONDS:
                # Parent is gone, terminate ourselves
                print("[solver subprocess] Heartbeat timeout - parent process gone, terminating", file=sys.stderr)
                cancel_event.set()
                # Give a moment for graceful shutdown, then force exit
                time.sleep(0.5)
                os._exit(1)
            time.sleep(1.0)

    watchdog_thread = threading.Thread(target=heartbeat_watchdog, daemon=True)
    watchdog_thread.start()

    try:
        # Reconstruct payload from dict
        payload = SolveRangeRequest(**payload_dict)

        # Create a mock user for state loading
        class MockUser:
            def __init__(self, username: str):
                self.username = username

        mock_user = MockUser(username)

        # Run the solver with a custom progress callback
        def on_progress(event_type: str, data: dict):
            try:
                progress_queue.put_nowait({"type": "progress", "event": event_type, "data": data})
            except:
                pass  # Queue full, skip

        # Mode switch: agent, heuristic, or CP-SAT solver
        mode = payload.resolved_mode()
        if mode == "agent":
            print(f"[SOLVER] Using AGENT solver for {payload.startISO} to {payload.endISO}")
            from .agent.harness import agent_solve_range
            from .state import _load_state
            state = _load_state(mock_user.username)
            result = agent_solve_range(payload, state, cancel_event, on_progress, start_time)
        elif mode == "heuristic":
            print(f"[SOLVER] Using HEURISTIC solver v2 for {payload.startISO} to {payload.endISO}")
            from .heuristic.solver_v2 import heuristic_solve_range_v2
            from .state import _load_state
            state = _load_state(mock_user.username)
            result = heuristic_solve_range_v2(payload, state, cancel_event, on_progress, start_time)
        else:
            print(f"[SOLVER] Using CP-SAT solver for {payload.startISO} to {payload.endISO}")
            result = _solve_range_impl_subprocess(payload, mock_user, cancel_event, on_progress, start_time)

        # Send result
        progress_queue.put({"type": "result", "data": result})
    except Exception as e:
        import traceback
        progress_queue.put({"type": "error", "error": str(e), "traceback": traceback.format_exc()})
    finally:
        watchdog_stop.set()


def _broadcast_solver_progress(event_type: str, data: dict):
    """Deliver solver progress to the SSE subscribers of the run owner.

    Events are tagged with the client-chosen run token so the frontend can
    drop stragglers from a previous run (e.g. the drain after a force-abort)
    instead of mixing them into the current run's chart.
    """
    if _active_run_token:
        data = {**data, "run_token": _active_run_token}
    with _subscribers_lock:
        for username, queue in _solver_progress_subscribers:
            if _active_run_owner is not None and username != _active_run_owner:
                continue
            try:
                # Use put_nowait since we're in a sync context
                queue.put_nowait({"event": event_type, "data": data})
            except asyncio.QueueFull:
                pass  # Skip if queue is full (client too slow)


@router.post("/v1/solve/abort")
async def abort_solver(
    force: bool = Query(False, description="Force immediate termination by killing subprocess"),
    current_user: UserPublic = Depends(_get_current_user),
):
    """Abort any currently running solver operation.

    This endpoint is async to ensure it can be processed even when the
    sync thread pool is blocked by a running solver.

    Args:
        force: If True, immediately kills the solver subprocess.
               Otherwise, signals graceful abort (stops at next solution).
    """
    global _solver_is_running, _solver_process
    # Note: We don't use the lock here to avoid potential deadlock with the solver
    # The worst case is a race condition that returns slightly stale status
    if _solver_is_running:
        _solver_cancel_event.set()
        if force and _solver_process is not None:
            # Immediately terminate the subprocess
            try:
                if _solver_process.is_alive():
                    _solver_process.terminate()
                    _solver_process.join(timeout=1.0)
                    if _solver_process.is_alive():
                        _solver_process.kill()
                        _solver_process.join(timeout=1.0)
                return {"status": "force_killed", "message": "Solver process terminated immediately"}
            except Exception as e:
                return {"status": "force_kill_error", "message": f"Error terminating solver: {e}"}
        return {"status": "abort_requested", "message": "Solver abort signal sent"}
    else:
        return {"status": "no_solver_running", "message": "No solver is currently running"}


@router.get("/v1/solve/progress")
async def solver_progress_stream(token: str = Query(...)):
    """SSE endpoint for real-time solver progress updates.

    Uses query param for token since EventSource doesn't support Authorization headers.
    """
    # Verify token (will raise HTTPException if invalid)
    subscriber = _verify_token_and_get_user(token)

    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    entry = (subscriber.username, queue)

    with _subscribers_lock:
        _solver_progress_subscribers.append(entry)

    async def event_generator():
        try:
            # Send initial connection message
            yield f"data: {json.dumps({'event': 'connected', 'data': {}})}\n\n"

            while True:
                try:
                    # Wait for new events with timeout to keep connection alive
                    msg = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield f": keepalive\n\n"
        finally:
            with _subscribers_lock:
                if entry in _solver_progress_subscribers:
                    _solver_progress_subscribers.remove(entry)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Default weights (used if not configured in solver_settings)
DEFAULT_WEIGHT_COVERAGE = 1000
DEFAULT_WEIGHT_SLACK = 1000
DEFAULT_WEIGHT_TOTAL_ASSIGNMENTS = 100
DEFAULT_WEIGHT_SLOT_PRIORITY = 10
DEFAULT_WEIGHT_TIME_WINDOW = 20
DEFAULT_WEIGHT_SECTION_PREFERENCE = 10
DEFAULT_WEIGHT_WORKING_HOURS = 3
DEFAULT_WEIGHT_MINIMUM_DAILY_HOURS = 5
DEFAULT_WEIGHT_YTD_BALANCE = 5

# Extra capacity per slot in "Distribute All" mode (beyond required)
EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL = 1

# Early stopping: once the optimality gap drops below this threshold,
# allow SOLVER_GAP_GRACE_SECONDS for further improvement, then stop.
SOLVER_GAP_THRESHOLD = 0.05  # 5% relative gap
SOLVER_GAP_GRACE_SECONDS = 20.0  # seconds to wait for more improvements


def _get_day_type(date_iso: str, holidays: List[Holiday]) -> str:
    if any(holiday.dateISO == date_iso for holiday in holidays):
        return "holiday"
    dt = datetime.fromisoformat(f"{date_iso}T00:00:00")
    weekday = dt.weekday()
    mapping = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    return mapping[weekday]


def _get_weekday_key(date_iso: str) -> str:
    dt = datetime.fromisoformat(f"{date_iso}T00:00:00")
    mapping = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    return mapping[dt.weekday()]


def _normalize_window_requirement(value: Any) -> str:
    if not isinstance(value, str):
        return "none"
    trimmed = value.strip().lower()
    if trimmed == "preferred":
        return "preference"
    if trimmed in ("none", "preference", "mandatory"):
        return trimmed
    return "none"


def _get_clinician_time_window(clinician: Any, weekday_key: str) -> Tuple[str, Optional[int], Optional[int]]:
    raw = getattr(clinician, "preferredWorkingTimes", None)
    if not isinstance(raw, dict):
        return "none", None, None
    entry = raw.get(weekday_key)
    if not entry:
        return "none", None, None
    if isinstance(entry, dict):
        start_raw = entry.get("startTime")
        end_raw = entry.get("endTime")
        requirement_raw = entry.get("requirement", entry.get("mode", entry.get("status")))
    else:
        start_raw = getattr(entry, "startTime", None)
        end_raw = getattr(entry, "endTime", None)
        requirement_raw = getattr(entry, "requirement", None)
    requirement = _normalize_window_requirement(requirement_raw)
    start_minutes = _parse_time_to_minutes(start_raw)
    end_minutes = _parse_time_to_minutes(end_raw)
    if (
        requirement == "none"
        or start_minutes is None
        or end_minutes is None
        or end_minutes <= start_minutes
    ):
        return "none", None, None
    return requirement, start_minutes, end_minutes


def _parse_time_to_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
    except ValueError:
        return None
    if h < 0 or h > 23 or m < 0 or m > 59:
        return None
    return h * 60 + m


def _build_slot_interval(slot, location_id: str) -> Tuple[int, int, str]:
    start = _parse_time_to_minutes(getattr(slot, "startTime", None))
    if start is None:
        start = DEFAULT_SUB_SHIFT_START_MINUTES
    end = _parse_time_to_minutes(getattr(slot, "endTime", None))
    if end is None:
        end = start + DEFAULT_SUB_SHIFT_MINUTES
    offset = (
        slot.endDayOffset if isinstance(getattr(slot, "endDayOffset", None), int) else 0
    )
    total_end = end + max(0, min(3, offset)) * 24 * 60
    if total_end <= start:
        total_end = start
    return start, total_end, location_id


def _collect_slot_contexts(state) -> List[Dict[str, Any]]:
    template = state.weeklyTemplate
    if not template:
        return []
    location_order = {loc.id: idx for idx, loc in enumerate(state.locations)}
    day_order = {day_type: idx for idx, day_type in enumerate(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"])}
    block_by_id = {block.id: block for block in template.blocks or []}
    block_order = {block.id: idx for idx, block in enumerate(template.blocks or [])}
    contexts: List[Dict[str, Any]] = []
    for template_location in template.locations:
        row_band_by_id = {band.id: band.order for band in template_location.rowBands}
        col_band_by_id = {band.id: band for band in template_location.colBands}
        location_id = (
            template_location.locationId
            if state.locationsEnabled
            else DEFAULT_LOCATION_ID
        )
        for slot in template_location.slots:
            block = block_by_id.get(slot.blockId)
            if not block:
                continue
            col_band = col_band_by_id.get(slot.colBandId)
            if not col_band:
                continue
            contexts.append(
                {
                    "slot": slot,
                    "block": block,
                    "slot_id": slot.id,
                    "section_id": block.sectionId,
                    "location_id": location_id,
                    "block_order": block_order.get(block.id, len(block_order)),
                    "row_order": row_band_by_id.get(slot.rowBandId, 0),
                    "col_order": col_band.order,
                    "day_type": col_band.dayType,
                    "day_order": day_order.get(col_band.dayType, 0),
                    "location_order": location_order.get(
                        template_location.locationId, 0
                    ),
                }
            )
    contexts.sort(
        key=lambda item: (
            item["block_order"],
            item["location_order"],
            item["row_order"],
            item["day_order"],
            item["col_order"],
        )
    )
    return contexts


def _build_date_context(
    payload: SolveRangeRequest, context_pad_days: int = 1
) -> Tuple[date, date, List[str], List[str], set[str], Dict[str, int]]:
    """Parse the requested range and build day lists + index lookups."""
    try:
        range_start = datetime.fromisoformat(f"{payload.startISO}T00:00:00+00:00").date()
    except ValueError:
        raise ValueError("Invalid startISO")
    if payload.endISO:
        try:
            range_end = datetime.fromisoformat(f"{payload.endISO}T00:00:00+00:00").date()
        except ValueError:
            raise ValueError("Invalid endISO")
    else:
        range_end = range_start + timedelta(days=6)
    if range_end < range_start:
        raise ValueError("Invalid endISO")

    context_start = range_start - timedelta(days=context_pad_days)
    context_end = range_end + timedelta(days=context_pad_days)
    day_isos: List[str] = []
    cursor = context_start
    while cursor <= context_end:
        day_isos.append(cursor.isoformat())
        cursor += timedelta(days=1)

    target_day_isos: List[str] = []
    cursor = range_start
    while cursor <= range_end:
        target_day_isos.append(cursor.isoformat())
        cursor += timedelta(days=1)
    target_date_set = set(target_day_isos)
    day_index_by_iso = {date_iso: idx for idx, date_iso in enumerate(day_isos)}
    return range_start, range_end, day_isos, target_day_isos, target_date_set, day_index_by_iso


def _build_slot_contexts_and_intervals(
    state,
) -> Tuple[
    List[Dict[str, Any]],
    set[str],
    Dict[str, str],
    Dict[str, Tuple[int, int, str]],
    Dict[str, Tuple[int, int, str]],
]:
    """Build slot contexts + interval maps (both active and full template)."""
    slot_contexts = _collect_slot_contexts(state)
    slot_ids = {ctx["slot_id"] for ctx in slot_contexts}
    section_by_slot_id = {ctx["slot_id"]: ctx["section_id"] for ctx in slot_contexts}
    slot_intervals: Dict[str, Tuple[int, int, str]] = {}
    for ctx in slot_contexts:
        slot_intervals[ctx["slot_id"]] = _build_slot_interval(
            ctx["slot"], ctx["location_id"]
        )

    # Include intervals for all template slots (even outside active day types).
    all_slot_intervals: Dict[str, Tuple[int, int, str]] = dict(slot_intervals)
    template = state.weeklyTemplate
    if template:
        for template_location in template.locations:
            location_id = (
                template_location.locationId
                if state.locationsEnabled
                else DEFAULT_LOCATION_ID
            )
            for slot in template_location.slots:
                if slot.id not in all_slot_intervals:
                    all_slot_intervals[slot.id] = _build_slot_interval(slot, location_id)

    return (
        slot_contexts,
        slot_ids,
        section_by_slot_id,
        slot_intervals,
        all_slot_intervals,
    )


def _collect_manual_assignments(
    state,
    day_isos: List[str],
    slot_ids: set[str],
    all_slot_intervals: Dict[str, Tuple[int, int, str]],
    is_on_vac,
) -> Tuple[
    Dict[Tuple[str, str], List[str]],
    Dict[Tuple[str, str], List[str]],
    List[str],
]:
    """Collect manual assignments (target slots + all slots for continuity checks)."""
    manual_assignments: Dict[Tuple[str, str], List[str]] = {}
    all_manual_assignments: Dict[Tuple[str, str], List[str]] = {}
    skipped_assignments: List[str] = []
    for assignment in state.assignments:
        if assignment.dateISO not in day_isos:
            continue
        if is_on_vac(assignment.clinicianId, assignment.dateISO):
            continue
        # Skip pool assignments - they are not slot assignments.
        if assignment.rowId.startswith("pool-"):
            continue
        # Track all manual assignments for continuity/overlap calculations.
        if assignment.rowId in all_slot_intervals:
            all_manual_assignments.setdefault((assignment.clinicianId, assignment.dateISO), []).append(
                assignment.rowId
            )
        else:
            skipped_assignments.append(f"{assignment.clinicianId} on {assignment.dateISO}: rowId={assignment.rowId}")
        # Only add to solver constraints if it's in the target slot set.
        if assignment.rowId in slot_ids:
            manual_assignments.setdefault((assignment.clinicianId, assignment.dateISO), []).append(
                assignment.rowId
            )
    return manual_assignments, all_manual_assignments, skipped_assignments


def _build_working_window_by_clinician_date(
    state,
    target_day_isos: List[str],
    weekday_by_iso: Dict[str, str],
) -> Dict[Tuple[str, str], Tuple[str, int, int]]:
    """Normalize preferred working windows into a lookup map."""
    working_window_by_clinician_date: Dict[Tuple[str, str], Tuple[str, int, int]] = {}
    for clinician in state.clinicians:
        for date_iso in target_day_isos:
            weekday_key = weekday_by_iso.get(date_iso)
            if not weekday_key:
                continue
            requirement, start_minutes, end_minutes = _get_clinician_time_window(
                clinician, weekday_key
            )
            if requirement == "none" or start_minutes is None or end_minutes is None:
                continue
            working_window_by_clinician_date[(clinician.id, date_iso)] = (
                requirement,
                start_minutes,
                end_minutes,
            )
    return working_window_by_clinician_date


def _build_active_slots_by_date(
    slot_contexts: List[Dict[str, Any]],
    day_type_by_iso: Dict[str, str],
    target_day_isos: List[str],
) -> Dict[str, List[Dict[str, Any]]]:
    """Filter slot contexts to those active on each target date."""
    active_slots_by_date: Dict[str, List[Dict[str, Any]]] = {}
    for date_iso in target_day_isos:
        day_type = day_type_by_iso.get(date_iso)
        active_slots_by_date[date_iso] = [
            ctx
            for ctx in slot_contexts
            if ctx.get("day_type") == day_type
        ]
    return active_slots_by_date


def _build_assignment_vars(
    model: cp_model.CpModel,
    state,
    target_day_isos: List[str],
    active_slots_by_date: Dict[str, List[Dict[str, Any]]],
    slot_intervals: Dict[str, Tuple[int, int, str]],
    working_window_by_clinician_date: Dict[Tuple[str, str], Tuple[str, int, int]],
    is_on_vac,
) -> Tuple[Dict[Tuple[str, str, str], cp_model.IntVar], List[cp_model.IntVar]]:
    """Create decision variables for each eligible clinician/date/slot."""
    var_map: Dict[Tuple[str, str, str], cp_model.IntVar] = {}
    time_window_terms: List[cp_model.IntVar] = []
    for clinician in state.clinicians:
        for date_iso in target_day_isos:
            if is_on_vac(clinician.id, date_iso):
                continue
            window = working_window_by_clinician_date.get((clinician.id, date_iso))
            for ctx in active_slots_by_date.get(date_iso, []):
                if ctx["section_id"] not in clinician.qualifiedClassIds:
                    continue
                slot_id = ctx["slot_id"]
                interval = slot_intervals.get(slot_id)
                if not interval:
                    continue
                start, end, _loc = interval
                fits_window = False
                if window:
                    requirement, window_start, window_end = window
                    fits_window = (
                        start >= window_start and end <= window_end
                    )
                    if requirement == "mandatory" and not fits_window:
                        continue
                var = model.NewBoolVar(f"x_{clinician.id}_{date_iso}_{slot_id}")
                var_map[(clinician.id, date_iso, slot_id)] = var
                if window and window[0] == "preference" and fits_window:
                    time_window_terms.append(var)
    return var_map, time_window_terms


def _group_vars_by_clinician_date(
    var_map: Dict[Tuple[str, str, str], cp_model.IntVar],
    slot_intervals: Dict[str, Tuple[int, int, str]],
) -> Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]]:
    """Group variables by clinician/date with interval metadata for constraint building."""
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]] = {}
    for (cid, date_iso, sid), var in var_map.items():
        interval = slot_intervals.get(sid)
        if not interval:
            continue
        start, end, loc = interval
        vars_by_clinician_date.setdefault(cid, {}).setdefault(date_iso, []).append(
            (sid, var, start, end, loc)
        )
    return vars_by_clinician_date


def _build_manual_by_clinician_date(
    all_manual_assignments: Dict[Tuple[str, str], List[str]],
    all_slot_intervals: Dict[str, Tuple[int, int, str]],
) -> Dict[str, Dict[str, List[Tuple[int, int, str]]]]:
    """Map manual assignments into interval lists by clinician/date."""
    manual_by_clinician_date: Dict[str, Dict[str, List[Tuple[int, int, str]]]] = {}
    for (cid, date_iso), row_ids in all_manual_assignments.items():
        day_map = manual_by_clinician_date.setdefault(cid, {}).setdefault(date_iso, [])
        for row_id in row_ids:
            interval = all_slot_intervals.get(row_id)
            if not interval:
                continue
            start, end, loc = interval
            day_map.append((start, end, loc))
    return manual_by_clinician_date


def _add_overlap_constraints(
    model: cp_model.CpModel,
    solver_settings: SolverSettings,
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]],
    manual_by_clinician_date: Dict[str, Dict[str, List[Tuple[int, int, str]]]],
    day_index_by_iso: Dict[str, int],
) -> None:
    """Block overlapping intervals and (optionally) multiple locations per day.

    Uses CP-SAT IntervalVar + NoOverlap for O(n log n) propagation instead of
    O(n²) pairwise boolean constraints.  A single NoOverlap per clinician
    handles same-day overlaps, cross-day (midnight-spanning) overlaps, and
    solver-vs-manual conflicts in one constraint.
    """
    for cid, clinician_vars in vars_by_clinician_date.items():
        clinician_manual = manual_by_clinician_date.get(cid, {})

        # --- Part 1: NoOverlap for all time-based conflicts ---
        all_intervals = []

        # Optional intervals for solver decision variables
        for date_iso, day_vars in clinician_vars.items():
            day_idx = day_index_by_iso.get(date_iso)
            if day_idx is None:
                continue
            day_offset = day_idx * 24 * 60
            for sid, var, start, end, loc in day_vars:
                duration = end - start
                if duration <= 0:
                    continue
                abs_start = start + day_offset
                interval = model.NewOptionalFixedSizeIntervalVar(
                    abs_start, duration, var,
                    f"iv_{cid}_{date_iso}_{sid}",
                )
                all_intervals.append(interval)

        # Fixed (always-present) intervals for manual assignments
        for date_iso, manual_slots in clinician_manual.items():
            day_idx = day_index_by_iso.get(date_iso)
            if day_idx is None:
                continue
            day_offset = day_idx * 24 * 60
            for m_idx, (start, end, loc) in enumerate(manual_slots):
                duration = end - start
                if duration <= 0:
                    continue
                abs_start = start + day_offset
                interval = model.NewFixedSizeIntervalVar(
                    abs_start, duration,
                    f"miv_{cid}_{date_iso}_{m_idx}",
                )
                all_intervals.append(interval)

        if len(all_intervals) > 1:
            model.AddNoOverlap(all_intervals)

        # --- Part 2: Same-location-per-day constraint ---
        if solver_settings.enforceSameLocationPerDay:
            for date_iso, day_vars in clinician_vars.items():
                # Group solver vars by location (skip vars without a location)
                vars_by_loc: Dict[str, List[cp_model.IntVar]] = {}
                for _sid, var, _s, _e, loc in day_vars:
                    if loc:
                        vars_by_loc.setdefault(loc, []).append(var)

                if not vars_by_loc:
                    continue

                # Collect manual locations for this day
                manual_locs: set[str] = set()
                for _s, _e, loc in clinician_manual.get(date_iso, []):
                    if loc:
                        manual_locs.add(loc)

                if manual_locs:
                    # Manual assignments pin the location for this day.
                    # A solver var at location X is only allowed if every
                    # manual assignment is also at X (matches old behaviour).
                    for loc, loc_vars in vars_by_loc.items():
                        if manual_locs != {loc}:
                            for var in loc_vars:
                                model.Add(var == 0)
                elif len(vars_by_loc) > 1:
                    # No manual location fixed — at most one location active.
                    loc_indicators = []
                    for loc, loc_vars in vars_by_loc.items():
                        at_loc = model.NewBoolVar(f"at_{cid}_{date_iso}_{loc}")
                        for var in loc_vars:
                            model.Add(var <= at_loc)
                        model.Add(at_loc <= sum(loc_vars))
                        loc_indicators.append(at_loc)
                    model.Add(sum(loc_indicators) <= 1)


def _add_coverage_constraints(
    model: cp_model.CpModel,
    payload: SolveRangeRequest,
    state,
    slot_contexts: List[Dict[str, Any]],
    target_day_isos: List[str],
    day_type_by_iso: Dict[str, str],
    var_map: Dict[Tuple[str, str, str], cp_model.IntVar],
    manual_assignments: Dict[Tuple[str, str], List[str]],
) -> Tuple[
    List[Any],
    List[Any],
    int,
    Dict[str, int],
]:
    """Apply required-slot coverage + per-slot capacity caps."""
    total_slots = len(slot_contexts)
    order_weight_by_slot_id: Dict[str, int] = {}
    total_required = 0
    coverage_terms: List[Any] = []
    slack_terms: List[Any] = []

    # Build lookup: (date, slot_id) -> list of vars (for coverage constraints)
    vars_by_date_slot: Dict[Tuple[str, str], List[cp_model.IntVar]] = {}
    for (cid, date_iso, sid), var in var_map.items():
        key = (date_iso, sid)
        vars_by_date_slot.setdefault(key, []).append(var)

    # Build lookup: (date, slot_id) -> manual count
    manual_count_by_date_slot: Dict[Tuple[str, str], int] = {}
    for (cid, diso), row_ids in manual_assignments.items():
        for rid in row_ids:
            key = (diso, rid)
            manual_count_by_date_slot[key] = manual_count_by_date_slot.get(key, 0) + 1

    # First pass: collect slot info for coverage and capacity
    slot_date_info: List[Dict[str, Any]] = []
    for index, ctx in enumerate(slot_contexts):
        slot_id = ctx["slot_id"]
        order_weight = min(100, max(1, total_slots - index))
        order_weight_by_slot_id[slot_id] = order_weight
        for date_iso in target_day_isos:
            day_type = day_type_by_iso.get(date_iso)
            if ctx.get("day_type") != day_type:
                continue
            raw_required = getattr(ctx["slot"], "requiredSlots", 0)
            base_required = raw_required if isinstance(raw_required, int) else 0
            override = state.slotOverridesByKey.get(f"{slot_id}__{date_iso}", 0)
            target = max(0, base_required + override)
            total_required += target
            already = manual_count_by_date_slot.get((date_iso, slot_id), 0)
            missing = max(0, target - already)
            vars_here = vars_by_date_slot.get((date_iso, slot_id), [])
            slot_date_info.append({
                "slot_id": slot_id,
                "date_iso": date_iso,
                "order_weight": order_weight,
                "target": target,
                "already": already,
                "missing": missing,
                "vars_here": vars_here,
            })

    for info in slot_date_info:
        slot_id = info["slot_id"]
        date_iso = info["date_iso"]
        order_weight = info["order_weight"]
        target = info["target"]
        already = info["already"]
        missing = info["missing"]
        vars_here = info["vars_here"]

        if missing == 0:
            if payload.only_fill_required:
                if vars_here:
                    model.Add(sum(vars_here) == 0)
                continue
            if vars_here:
                extra = EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL if target > 0 else 0
                slot_capacity = max(0, target + extra - already)
                model.Add(sum(vars_here) <= slot_capacity)
            continue
        if vars_here:
            # covered=1 iff the slot has at least one assignment (already + new).
            # Since the objective maximises coverage, a single upper-bound suffices:
            # the solver sets covered=1 whenever it legally can.
            covered = model.NewBoolVar(f"covered_{slot_id}_{date_iso}")
            model.Add(covered <= sum(vars_here) + already)
            coverage_terms.append(covered * order_weight)
            if payload.only_fill_required:
                slot_capacity = missing
            else:
                extra = EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL if target > 0 else 0
                slot_capacity = max(0, target + extra - already)
            model.Add(sum(vars_here) <= slot_capacity)
        # `missing` already discounts manual assignments; adding `already`
        # here again would let slack under-count unfilled positions whenever
        # a slot is partially manned manually.
        slack = model.NewIntVar(0, missing, f"slack_{slot_id}_{date_iso}")
        if vars_here:
            model.Add(sum(vars_here) + slack >= missing)
        else:
            model.Add(slack >= missing)
        slack_terms.append(slack * order_weight)

    return coverage_terms, slack_terms, total_required, order_weight_by_slot_id


def _add_on_call_rest_constraints(
    model: cp_model.CpModel,
    solver_settings: SolverSettings,
    slot_contexts: List[Dict[str, Any]],
    manual_assignments: Dict[Tuple[str, str], List[str]],
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]],
    target_date_set: set[str],
    day_isos: List[str],
    day_index_by_iso: Dict[str, int],
) -> Tuple[List[str], set[str], int, int]:
    """Enforce rest days around on-call assignments."""
    rest_class_id = solver_settings.onCallRestClassId
    rest_before = max(0, solver_settings.onCallRestDaysBefore or 0)
    rest_after = max(0, solver_settings.onCallRestDaysAfter or 0)
    rest_shift_row_ids = {
        ctx["slot_id"]
        for ctx in slot_contexts
        if ctx["section_id"] == rest_class_id
    }

    rest_day_conflicts: List[str] = []
    if (
        solver_settings.onCallRestEnabled
        and rest_shift_row_ids
        and (rest_before > 0 or rest_after > 0)
    ):
        on_call_dates_by_cid: Dict[str, List[Tuple[int, str]]] = {}
        for (cid, date_iso), row_ids in manual_assignments.items():
            if any(rid in rest_shift_row_ids for rid in row_ids):
                idx = day_index_by_iso.get(date_iso)
                if idx is not None:
                    on_call_dates_by_cid.setdefault(cid, []).append((idx, date_iso))

        for cid, on_call_list in on_call_dates_by_cid.items():
            for on_call_idx, on_call_date in on_call_list:
                for offset in range(1, rest_before + 1):
                    check_idx = on_call_idx - offset
                    if 0 <= check_idx < len(day_isos):
                        check_date = day_isos[check_idx]
                        if manual_assignments.get((cid, check_date)):
                            rest_day_conflicts.append(
                                f"{cid}: on-call {on_call_date} but assigned on {check_date} (rest day before)"
                            )
                for offset in range(1, rest_after + 1):
                    check_idx = on_call_idx + offset
                    if 0 <= check_idx < len(day_isos):
                        check_date = day_isos[check_idx]
                        if manual_assignments.get((cid, check_date)):
                            rest_day_conflicts.append(
                                f"{cid}: on-call {on_call_date} but assigned on {check_date} (rest day after)"
                            )

    if (
        solver_settings.onCallRestEnabled
        and rest_shift_row_ids
        and (rest_before > 0 or rest_after > 0)
    ):
        for clinician_id, clinician_vars in vars_by_clinician_date.items():
            for day_index, date_iso in enumerate(day_isos):
                manual_rows = manual_assignments.get((clinician_id, date_iso), [])
                manual_on_call = any(
                    row_id in rest_shift_row_ids for row_id in manual_rows
                )
                day_vars = clinician_vars.get(date_iso, [])
                on_call_vars = [
                    var for (sid, var, _s, _e, _l) in day_vars
                    if sid in rest_shift_row_ids
                ]
                if not manual_on_call and not on_call_vars:
                    continue
                on_call_var: Optional[cp_model.IntVar] = None
                if not manual_on_call:
                    on_call_var = model.NewBoolVar(
                        f"on_call_{clinician_id}_{date_iso}"
                    )
                    model.AddMaxEquality(on_call_var, on_call_vars)

                def apply_rest_constraint(target_idx: int) -> None:
                    if target_idx < 0 or target_idx >= len(day_isos):
                        return
                    target_date = day_isos[target_idx]
                    in_target_range = target_date in target_date_set
                    target_day_vars = clinician_vars.get(target_date, [])
                    vars_target = [var for (_sid, var, _s, _e, _l) in target_day_vars]
                    manual_target = len(
                        manual_assignments.get((clinician_id, target_date), [])
                    )
                    if manual_on_call:
                        if manual_target > 0:
                            return
                        if in_target_range and vars_target:
                            model.Add(sum(vars_target) == 0)
                        return
                    if on_call_var is None:
                        return
                    if manual_target > 0:
                        # Applies to CONTEXT days too: the solver must not
                        # freshly place an on-call whose rest window collides
                        # with manual work just outside the range.
                        model.Add(on_call_var == 0)
                    elif in_target_range and vars_target:
                        model.Add(sum(vars_target) <= len(vars_target) * (1 - on_call_var))

                for offset in range(1, rest_before + 1):
                    apply_rest_constraint(day_index - offset)
                for offset in range(1, rest_after + 1):
                    apply_rest_constraint(day_index + offset)

    return rest_day_conflicts, rest_shift_row_ids, rest_before, rest_after


def _add_working_hours_constraints(
    model: cp_model.CpModel,
    state,
    target_day_isos: List[str],
    target_date_set: set[str],
    manual_assignments: Dict[Tuple[str, str], List[str]],
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]],
    slot_intervals: Dict[str, Tuple[int, int, str]],
) -> List[cp_model.IntVar]:
    """Add working hours deviation penalties."""
    hours_penalty_terms: List[cp_model.IntVar] = []
    total_days = len(target_day_isos)
    scale = total_days / 7.0 if total_days else 0
    slot_duration_by_id = {
        slot_id: max(0, end - start)
        for slot_id, (start, end, _loc) in slot_intervals.items()
    }
    manual_minutes_by_clinician: Dict[str, int] = {c.id: 0 for c in state.clinicians}
    for (clinician_id, date_iso), row_ids in manual_assignments.items():
        if date_iso not in target_date_set:
            continue
        total_minutes = 0
        for row_id in row_ids:
            duration = slot_duration_by_id.get(row_id)
            if duration is None:
                continue
            total_minutes += duration
        manual_minutes_by_clinician[clinician_id] = (
            manual_minutes_by_clinician.get(clinician_id, 0) + total_minutes
        )
    for clinician in state.clinicians:
        if not isinstance(clinician.workingHoursPerWeek, (int, float)):
            continue
        if clinician.workingHoursPerWeek <= 0:
            continue
        # Default to 5 only when missing (None); an explicit 0 (strict cap)
        # must be preserved, not coerced to 5 by a falsy `or`.
        _tol = clinician.workingHoursToleranceHours
        tolerance_hours = max(0, _tol if _tol is not None else 5)
        target_minutes = int(round(clinician.workingHoursPerWeek * 60 * scale))
        tol_minutes = int(round(tolerance_hours * 60 * scale))
        if target_minutes <= 0 and tol_minutes <= 0:
            continue
        clinician_date_vars = vars_by_clinician_date.get(clinician.id, {})
        decision_terms = []
        max_decision_minutes = 0
        for _date_iso, day_vars in clinician_date_vars.items():
            for (sid, var, _s, _e, _l) in day_vars:
                duration = slot_duration_by_id.get(sid, 0)
                decision_terms.append(var * duration)
                max_decision_minutes += duration
        manual_minutes = manual_minutes_by_clinician.get(clinician.id, 0)
        max_total = manual_minutes + max_decision_minutes
        target_minus_tol = max(0, target_minutes - tol_minutes)
        target_plus_tol = target_minutes + tol_minutes
        total_minutes_expr = manual_minutes + sum(decision_terms)
        max_under = max(max_total, target_minus_tol)
        under = model.NewIntVar(0, max_under, f"under_{clinician.id}")
        over = model.NewIntVar(0, max_total, f"over_{clinician.id}")
        model.Add(under >= target_minus_tol - total_minutes_expr)
        model.Add(over >= total_minutes_expr - target_plus_tol)
        hours_penalty_terms.append(under + over)

    return hours_penalty_terms


def _add_minimum_daily_minutes_penalty(
    model: cp_model.CpModel,
    state,
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]],
    manual_by_clinician_date: Dict[str, Dict[str, List[Tuple[int, int, str]]]],
    slot_intervals: Dict[str, Tuple[int, int, str]],
    working_window_by_clinician_date: Dict[Tuple[str, str], Tuple[str, int, int]],
) -> List[cp_model.IntVar]:
    """Penalize daily assignments shorter than a derived minimum.

    The minimum is derived per (clinician, date):
    1. If clinician has a preferred working window for that day:
       min_minutes = 50% of window duration
    2. Else if clinician has workingHoursPerWeek:
       min_minutes = 50% of (weeklyHours * 60 / 5)
    3. Otherwise: no penalty

    The deficit (minutes below minimum) is added as a penalty term only when
    the solver assigns at least one slot to that (clinician, date).
    """
    deficit_terms: List[cp_model.IntVar] = []
    slot_duration_by_id = {
        slot_id: max(0, end - start)
        for slot_id, (start, end, _loc) in slot_intervals.items()
    }
    # Build clinician weekly hours lookup
    weekly_hours_by_id: Dict[str, float] = {}
    for clinician in state.clinicians:
        if isinstance(clinician.workingHoursPerWeek, (int, float)) and clinician.workingHoursPerWeek > 0:
            weekly_hours_by_id[clinician.id] = clinician.workingHoursPerWeek

    counter = 0
    for cid, clinician_dates in vars_by_clinician_date.items():
        for date_iso, day_vars in clinician_dates.items():
            if not day_vars:
                continue

            # Derive minimum daily minutes
            window = working_window_by_clinician_date.get((cid, date_iso))
            if window is not None:
                _req, w_start, w_end = window
                min_minutes = max(1, (w_end - w_start) // 2)
            elif cid in weekly_hours_by_id:
                daily_avg_minutes = int(round(weekly_hours_by_id[cid] * 60 / 5))
                min_minutes = max(1, daily_avg_minutes // 2)
            else:
                continue  # No basis to derive minimum

            # Calculate manual minutes for this (clinician, date)
            manual_slots = manual_by_clinician_date.get(cid, {}).get(date_iso, [])
            manual_minutes = sum(max(0, end - start) for start, end, _loc in manual_slots)

            # If manual assignments already meet the minimum, skip
            if manual_minutes >= min_minutes:
                continue

            # Build solver minutes expression for this day
            solver_duration_terms = []
            max_solver_minutes = 0
            for sid, var, _s, _e, _l in day_vars:
                dur = slot_duration_by_id.get(sid, 0)
                if dur > 0:
                    solver_duration_terms.append(var * dur)
                    max_solver_minutes += dur

            if not solver_duration_terms:
                continue

            # has_solver: indicator that at least one solver slot is assigned
            has_solver = model.NewBoolVar(f"has_solver_min_daily_{counter}")
            solver_count = sum(var for (_sid, var, _s, _e, _l) in day_vars)
            # has_solver == 1 iff solver_count >= 1
            model.Add(solver_count >= 1).OnlyEnforceIf(has_solver)
            model.Add(solver_count == 0).OnlyEnforceIf(has_solver.Not())

            total_minutes = manual_minutes + sum(solver_duration_terms)
            remaining_min = min_minutes - manual_minutes  # > 0 guaranteed

            # deficit: how many minutes below minimum when solver is active
            deficit = model.NewIntVar(0, remaining_min, f"daily_deficit_{counter}")
            # When has_solver: deficit >= min_minutes - total_minutes
            model.Add(deficit >= min_minutes - total_minutes).OnlyEnforceIf(has_solver)
            # When not has_solver: deficit == 0
            model.Add(deficit == 0).OnlyEnforceIf(has_solver.Not())

            deficit_terms.append(deficit)
            counter += 1

    return deficit_terms


def _compute_ytd_deficit_hours(
    state,
    range_start: date,
    all_slot_intervals: Dict[str, Tuple[int, int, str]],
) -> Dict[str, int]:
    """Compute per-clinician YTD deficit as a percentage (positive = behind, negative = ahead).

    Uses percentage-based deficit so clinicians with different contract hours
    get comparable scores. A full-time clinician at 90% of target gets the same
    score as a part-time clinician at 90% of target.

    Returns integer percentage: 10 means 10% behind target, -5 means 5% ahead.
    """
    # Build slot duration map (minutes) from all_slot_intervals
    slot_duration_minutes: Dict[str, int] = {}
    for slot_id, (start, end, _loc) in all_slot_intervals.items():
        slot_duration_minutes[slot_id] = max(0, end - start)

    year_start = date(range_start.year, 1, 1)

    # No history if solving from Jan 1
    if range_start <= year_start:
        return {}

    weeks_elapsed = (range_start - year_start).days / 7.0
    # Need at least 1 week of history for meaningful YTD balance
    if weeks_elapsed < 1.0:
        return {}

    def _vacation_days_in_window(clinician, window_start: date, window_end: date) -> int:
        """Vacation days in [window_start, window_end) — inclusive vacation ranges."""
        days = 0
        for vacation in clinician.vacations or []:
            try:
                v_start = date.fromisoformat(vacation.startISO)
                v_end = date.fromisoformat(vacation.endISO)
            except (ValueError, TypeError, AttributeError):
                continue
            overlap_start = max(v_start, window_start)
            overlap_end = min(v_end, window_end - timedelta(days=1))
            if overlap_end >= overlap_start:
                days += (overlap_end - overlap_start).days + 1
        return days

    range_start_iso = range_start.isoformat()
    year_start_iso = year_start.isoformat()

    # Sum actual minutes per clinician from historical assignments
    actual_minutes_by_clinician: Dict[str, int] = {}
    for assignment in state.assignments:
        if assignment.dateISO >= range_start_iso:
            continue
        if assignment.dateISO < year_start_iso:
            continue
        if assignment.rowId.startswith("pool-"):
            continue
        duration = slot_duration_minutes.get(assignment.rowId, 0)
        if duration > 0:
            actual_minutes_by_clinician[assignment.clinicianId] = (
                actual_minutes_by_clinician.get(assignment.clinicianId, 0) + duration
            )

    # Compute percentage deficit per clinician
    ytd_deficit_pct: Dict[str, int] = {}
    for clinician in state.clinicians:
        if not isinstance(clinician.workingHoursPerWeek, (int, float)):
            continue
        if clinician.workingHoursPerWeek <= 0:
            continue

        # Credit vacation days: expecting contract hours for weeks the
        # clinician was on vacation would otherwise mark returnees as far
        # behind target and systematically over-assign them.
        vacation_days = _vacation_days_in_window(clinician, year_start, range_start)
        effective_weeks = max(0.0, weeks_elapsed - vacation_days / 7.0)
        expected_minutes = clinician.workingHoursPerWeek * 60 * effective_weeks
        if expected_minutes <= 0:
            continue
        actual_minutes = actual_minutes_by_clinician.get(clinician.id, 0)
        deficit_pct = round((expected_minutes - actual_minutes) / expected_minutes * 100)
        # Clamp to [-100, 100] to prevent extreme values
        deficit_pct = max(-100, min(100, deficit_pct))
        ytd_deficit_pct[clinician.id] = deficit_pct

    return ytd_deficit_pct


def _add_ytd_balance_objective(
    ytd_deficit_pct: Dict[str, int],
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, "cp_model.IntVar", int, int, str]]]],
    slot_intervals: Dict[str, Tuple[int, int, str]],
) -> list:
    """Build YTD balance bonus terms for the objective function.

    For each clinician with a deficit percentage, creates terms: var * deficit_pct.
    Positive deficit (behind) produces positive bonus; negative (ahead) produces penalty.
    The caller negates this in Minimize so positive bonus reduces cost.

    Uses percentage-based deficit so the bonus is comparable across clinicians
    with different contract hours.
    """
    bonus_terms = []
    for clinician_id, deficit_pct in ytd_deficit_pct.items():
        if deficit_pct == 0:
            continue
        clinician_dates = vars_by_clinician_date.get(clinician_id, {})
        for _date_iso, day_vars in clinician_dates.items():
            for (sid, var, _s, _e, _l) in day_vars:
                bonus_terms.append(var * deficit_pct)

    return bonus_terms


def _add_continuity_constraints(
    model: cp_model.CpModel,
    solver_settings: SolverSettings,
    vars_by_clinician_date: Dict[str, Dict[str, List[Tuple[str, cp_model.IntVar, int, int, str]]]],
    manual_by_clinician_date: Dict[str, Dict[str, List[Tuple[int, int, str]]]],
) -> None:
    """Enforce max 1 continuous work block per clinician/day (or manual blocks)."""
    if not solver_settings.preferContinuousShifts:
        return

    block_counter = 0
    for cid, clinician_dates in vars_by_clinician_date.items():
        clinician_manual = manual_by_clinician_date.get(cid, {})
        for date_iso, day_vars in clinician_dates.items():
            manual_slots = clinician_manual.get(date_iso, [])
            if not manual_slots and not day_vars:
                continue

            candidate_ends_by_key: Dict[Tuple[int, str], List[cp_model.IntVar]] = {}
            for _sid, var, start, end, loc in day_vars:
                if end <= start:
                    continue
                candidate_ends_by_key.setdefault((end, loc), []).append(var)

            manual_end_keys = {(end, loc) for (_start, end, loc) in manual_slots}

            manual_blocks = 0
            if manual_slots:
                manual_blocks = sum(
                    1
                    for (start, _end, loc) in manual_slots
                    if (start, loc) not in manual_end_keys
                )
            max_blocks = max(1, manual_blocks)

            block_terms: List[Any] = []
            prev_indicator_by_start: Dict[Tuple[int, str], Any] = {}

            def _prev_indicator(start_min: int, loc: str) -> Any:
                nonlocal block_counter
                key = (start_min, loc)
                if key in prev_indicator_by_start:
                    return prev_indicator_by_start[key]
                if key in manual_end_keys:
                    prev_indicator_by_start[key] = 1
                    return 1
                vars_ending = candidate_ends_by_key.get(key, [])
                if not vars_ending:
                    prev_indicator_by_start[key] = 0
                    return 0
                if len(vars_ending) == 1:
                    prev_indicator_by_start[key] = vars_ending[0]
                    return vars_ending[0]
                block_counter += 1
                has_prev = model.NewBoolVar(
                    f"has_prev_{cid}_{date_iso}_{block_counter}"
                )
                model.AddMaxEquality(has_prev, vars_ending)
                prev_indicator_by_start[key] = has_prev
                return has_prev

            def _add_block_start(y_expr: Any, prev_indicator: Any) -> None:
                nonlocal block_counter
                if isinstance(prev_indicator, int):
                    if prev_indicator == 1:
                        return
                    block_terms.append(y_expr)
                    return
                block_counter += 1
                start_var = model.NewBoolVar(
                    f"block_start_{cid}_{date_iso}_{block_counter}"
                )
                model.Add(start_var <= y_expr)
                model.Add(start_var <= 1 - prev_indicator)
                model.Add(start_var >= y_expr - prev_indicator)
                block_terms.append(start_var)

            for start, _end, loc in manual_slots:
                prev_indicator = _prev_indicator(start, loc)
                _add_block_start(1, prev_indicator)

            for _sid, var, start, _end, loc in day_vars:
                prev_indicator = _prev_indicator(start, loc)
                _add_block_start(var, prev_indicator)

            if any(isinstance(term, cp_model.IntVar) for term in block_terms):
                model.Add(sum(block_terms) <= max_blocks)


@router.post("/v1/solve/range", response_model=SolveRangeResponse)
def solve_range(payload: SolveRangeRequest, current_user: UserPublic = Depends(_get_current_user)):
    global _solver_is_running, _solver_process, _active_run_owner, _active_run_token

    # Capture start time BEFORE anything else - this is used for accurate timeout calculation
    request_start_time = time.time()

    # Reconcile solver state before starting a new run.
    # Scenarios we handle here:
    #   (1) Clean slate — no previous run active. Just proceed.
    #   (2) Zombie state — _solver_is_running is True but the subprocess is
    #       dead (finally block didn't complete, subprocess crashed, or a
    #       prior abort interrupted cleanup). Reset and carry on; the user
    #       was trying to recover and shouldn't have to restart the backend.
    #   (3) Genuine concurrent run — another solve is alive. Refuse this one
    #       with 409 instead of silently overwriting _solver_process and
    #       leaving the other handler orphaned (which was how this state
    #       got wedged in the first place).
    # Create the subprocess and publish the global `_solver_process` *while
    # still holding the lock*, then start it, all before releasing. This closes
    # a race the previous code left open: if the global were assigned only after
    # the lock was released, there was a window where `_solver_is_running` was
    # True but `_solver_process` was still None. A second near-simultaneous
    # /v1/solve/range would acquire the lock, see that combination, mistake it
    # for a dead run via the zombie-recovery path, reset, and spawn a *second*
    # live subprocess — orphaning the first. `owned_process` is also kept as a
    # LOCAL reference that this handler uses from here on; we never read the
    # mutable global inside the while-loop.
    with _solver_running_lock:
        if _solver_is_running:
            process_alive = (
                _solver_process is not None and _solver_process.is_alive()
            )
            if process_alive:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Another solve is already running. Abort it first "
                        "via POST /v1/solve/abort."
                    ),
                )
            # Zombie state — clear residue so the new run starts fresh.
            if _solver_process is not None:
                try:
                    _solver_process.join(timeout=0.5)
                except Exception:
                    pass
            _solver_process = None
        _solver_is_running = True
        _solver_cancel_event.clear()
        _active_run_owner = current_user.username
        _active_run_token = payload.run_token

        # Create multiprocessing primitives (after the 409/zombie check so we
        # don't leak a Queue/Event when refusing a concurrent run).
        progress_queue = _mp_context.Queue(maxsize=1000)
        cancel_event = _mp_context.Event()
        heartbeat_value = _mp_context.Value('i', 0)  # Shared integer for heartbeat

        # Spawn subprocess - pass start_time for accurate timeout calculation.
        owned_process = _mp_context.Process(
            target=_solver_subprocess_worker,
            args=(
                current_user.username,
                payload.model_dump(),
                progress_queue,
                cancel_event,
                heartbeat_value,
                request_start_time,
            ),
        )
        _solver_process = owned_process
        owned_process.start()

    # Broadcast start event (after the subprocess is live and the lock released)
    _broadcast_solver_progress("start", {
        "startISO": payload.startISO,
        "endISO": payload.endISO,
        "timeout_seconds": payload.timeout_seconds,
    })

    result = None
    error = None
    last_solution_assignments = None  # Track last known good solution
    heartbeat_counter = 0

    try:
        # Monitor the subprocess and relay progress to SSE
        while True:
            # Send heartbeat to subprocess so it knows parent is alive
            heartbeat_counter += 1
            heartbeat_value.value = heartbeat_counter

            # Check if abort was requested
            if _solver_cancel_event.is_set():
                cancel_event.set()

            # Check if process is still alive
            if not owned_process.is_alive():
                # Process ended, drain remaining messages
                while not progress_queue.empty():
                    try:
                        msg = progress_queue.get_nowait()
                        if msg["type"] == "progress":
                            _broadcast_solver_progress(msg["event"], msg["data"])
                            # Track solution assignments for force-abort recovery
                            if msg["event"] == "solution" and "assignments" in msg["data"]:
                                last_solution_assignments = msg["data"]["assignments"]
                        elif msg["type"] == "result":
                            result = msg["data"]
                        elif msg["type"] == "error":
                            error = msg
                    except:
                        break
                break

            # Try to get a message with timeout
            try:
                msg = progress_queue.get(timeout=0.1)
                if msg["type"] == "progress":
                    _broadcast_solver_progress(msg["event"], msg["data"])
                    # Track solution assignments for force-abort recovery
                    if msg["event"] == "solution" and "assignments" in msg["data"]:
                        last_solution_assignments = msg["data"]["assignments"]
                elif msg["type"] == "result":
                    result = msg["data"]
                elif msg["type"] == "error":
                    error = msg
            except:
                pass  # Timeout, continue loop

        # Wait for process to finish
        owned_process.join(timeout=2.0)

        if error:
            raise Exception(error.get("error", "Unknown solver error"))

        # If result is None but we have a last solution (force-abort case), use it
        if result is None and last_solution_assignments is not None:
            result = {
                "startISO": payload.startISO,
                "endISO": payload.endISO,
                "assignments": last_solution_assignments,
                "notes": ["Solver was aborted - using last available solution"],
            }

        if result is None:
            raise Exception("Solver process terminated without result")

        # Convert dict result back to response
        response = SolveRangeResponse(**result)

        # Broadcast complete event
        _broadcast_solver_progress("complete", {
            "startISO": response.startISO,
            "endISO": response.endISO,
            "status": "success",
        })
        return response

    except Exception as e:
        # Broadcast error event
        _broadcast_solver_progress("complete", {
            "startISO": payload.startISO,
            "endISO": payload.endISO,
            "status": "error",
            "error": str(e),
        })
        raise
    finally:
        # Terminate our owned subprocess aggressively. We operate on the local
        # reference (owned_process) so we always clean up THIS handler's child,
        # regardless of what the global _solver_process currently points at.
        try:
            if owned_process.is_alive():
                owned_process.terminate()
                owned_process.join(timeout=2.0)
                if owned_process.is_alive():
                    owned_process.kill()
                    owned_process.join(timeout=1.0)
        except Exception:
            pass

        # Only reset the globals if they still refer to OUR subprocess. If
        # another request grabbed the slot in the meantime (unlikely with the
        # guard at the top, but possible on a zombie-recovery path), we must
        # not trample on it.
        with _solver_running_lock:
            if _solver_process is owned_process:
                _solver_process = None
                _solver_is_running = False
                _solver_cancel_event.clear()


def _solve_range_impl_subprocess(
    payload: SolveRangeRequest,
    current_user,
    cancel_event,
    on_progress,
    start_time: float = None,
) -> dict:
    """
    Subprocess-compatible implementation of solve_range.
    Returns a dict that can be serialized and sent back to main process.

    start_time: The timestamp when the solve request started (for accurate timeout).
    """
    result = _solve_range_impl(
        payload,
        current_user,
        cancel_event=cancel_event,
        on_progress=on_progress,
        start_time=start_time,
    )
    # Convert to dict for serialization
    return result.model_dump()


def _solve_range_impl(
    payload: SolveRangeRequest,
    current_user,
    cancel_event=None,
    on_progress=None,
    start_time: float = None,
):
    """
    Core solver implementation that builds and solves the constraint satisfaction problem.

    This function constructs a CP-SAT model with:
    1. Decision variables: One boolean per (clinician, date, slot) tuple
    2. Hard constraints: Overlap prevention, qualifications, vacations, location rules, continuity (if enabled)
    3. Soft constraints: Coverage targets, working hours balance
    4. Objective: Weighted sum of coverage, distribution, and preference terms

    The solver operates in two modes based on `payload.only_fill_required`:
    - True: Only fill slots up to their required count
    - False: "Distribute All" mode - assign as many people as possible with a simple per-slot cap

    Args:
        payload: The solve request containing date range, timeout, and mode settings
        current_user: User object (must have .username attribute) for loading state
        cancel_event: Optional threading.Event to check for abort (defaults to global)
        on_progress: Optional callback(event_type, data) for UI progress updates
        start_time: Timestamp when request started (for accurate timeout calculation)

    Returns:
        SolveRangeResponse with assignments, notes, and debug timing info

    Raises:
        ValueError: If date range is invalid
    """
    # Use defaults if not provided
    if cancel_event is None:
        cancel_event = _solver_cancel_event
    if on_progress is None:
        on_progress = _broadcast_solver_progress

    # Use provided start_time for accurate timeout calculation, or current time as fallback
    actual_start_time = start_time if start_time is not None else time.time()
    timer = SolverTimer()

    # Broadcast phase progress for UI feedback
    on_progress("phase", {"phase": "load_state", "label": "Preparation (1/10): Loading schedule data..."})
    state = _load_state(current_user.username)
    timer.checkpoint("load_state")
    diagnostics: List[str] = []  # Track potential issues for debugging
    # Size the context window from the rest settings: a fixed +/-1 day silently
    # missed rest violations against manual on-call shifts 2+ days outside the
    # range when onCallRestDaysBefore/After >= 2.
    _settings = SolverSettings.model_validate(state.solverSettings or {})
    _context_pad = 1
    if _settings.onCallRestEnabled:
        _context_pad = max(
            1, _settings.onCallRestDaysBefore or 0, _settings.onCallRestDaysAfter or 0
        )
    range_start, range_end, day_isos, target_day_isos, target_date_set, day_index_by_iso = (
        _build_date_context(payload, context_pad_days=_context_pad)
    )
    timer.checkpoint("date_setup")

    on_progress("phase", {"phase": "slot_contexts", "label": "Preparation (2/10): Analyzing shift patterns..."})
    (
        slot_contexts,
        slot_ids,
        section_by_slot_id,
        slot_intervals,
        all_slot_intervals,
    ) = _build_slot_contexts_and_intervals(state)
    timer.checkpoint("slot_contexts")

    # Compute YTD hour deficits (pre-solve constants, no CP-SAT variables)
    ytd_deficit_hours = _compute_ytd_deficit_hours(state, range_start, all_slot_intervals)

    on_progress("phase", {"phase": "create_variables", "label": "Preparation (3/10): Setting up assignment options..."})
    holidays = state.holidays or []
    day_type_by_iso = {iso: _get_day_type(iso, holidays) for iso in day_isos}
    weekday_by_iso = {iso: _get_weekday_key(iso) for iso in day_isos}

    vac_by_clinician: Dict[str, List[Tuple[str, str]]] = {}
    for clinician in state.clinicians:
        vac_by_clinician[clinician.id] = [(v.startISO, v.endISO) for v in clinician.vacations]

    def is_on_vac(clinician_id: str, date_iso: str) -> bool:
        for start, end in vac_by_clinician.get(clinician_id, []):
            if start <= date_iso <= end:
                return True
        return False

    # manual_assignments: for solver constraints (slots in the template for target dates)
    # all_manual_assignments: for continuity/overlap checks (includes all template slots)
    manual_assignments, all_manual_assignments, orphaned_assignments = _collect_manual_assignments(
        state,
        day_isos,
        slot_ids,
        all_slot_intervals,
        is_on_vac,
    )

    solver_settings = SolverSettings.model_validate(state.solverSettings or {})
    pref_weight: Dict[str, Dict[str, int]] = {}
    for clinician in state.clinicians:
        weights: Dict[str, int] = {}
        preferred = clinician.preferredClassIds or []
        for idx, class_id in enumerate(preferred):
            weights[class_id] = max(1, len(preferred) - idx)
        pref_weight[clinician.id] = weights
    working_window_by_clinician_date = _build_working_window_by_clinician_date(
        state,
        target_day_isos,
        weekday_by_iso,
    )

    model = cp_model.CpModel()
    active_slots_by_date = _build_active_slots_by_date(
        slot_contexts,
        day_type_by_iso,
        target_day_isos,
    )
    var_map, time_window_terms = _build_assignment_vars(
        model,
        state,
        target_day_isos,
        active_slots_by_date,
        slot_intervals,
        working_window_by_clinician_date,
        is_on_vac,
    )
    timer.checkpoint("create_variables")

    on_progress("phase", {"phase": "overlap_constraints", "label": "Preparation (4/10): Adding schedule conflict rules..."})
    # Diagnostic: check if we have any variables at all
    if not var_map:
        # Figure out why no variables were created
        total_clinicians = len(state.clinicians)
        clinicians_on_vacation = sum(
            1 for c in state.clinicians
            if all(is_on_vac(c.id, d) for d in target_day_isos)
        )
        total_slots = len(slot_contexts)
        slots_with_sections = len({ctx["section_id"] for ctx in slot_contexts})
        clinician_qualifications = sum(len(c.qualifiedClassIds) for c in state.clinicians)
        diagnostics.append(f"No assignment variables created.")
        diagnostics.append(f"Clinicians: {total_clinicians} total, {clinicians_on_vacation} fully on vacation.")
        diagnostics.append(f"Slots: {total_slots} total across {slots_with_sections} sections.")
        if clinician_qualifications == 0:
            diagnostics.append("No clinicians have any section qualifications.")
        else:
            # Check if qualifications match slot sections
            slot_section_ids = {ctx["section_id"] for ctx in slot_contexts}
            clinician_section_ids = set()
            for c in state.clinicians:
                clinician_section_ids.update(c.qualifiedClassIds)
            matching = slot_section_ids & clinician_section_ids
            if not matching:
                diagnostics.append(f"No overlap between slot sections {slot_section_ids} and clinician qualifications {clinician_section_ids}.")

    # Overlap + location constraints (optimized: group by clinician+date to avoid O(n²))
    vars_by_clinician_date = _group_vars_by_clinician_date(var_map, slot_intervals)

    # Build YTD balance objective terms
    ytd_bonus_terms = _add_ytd_balance_objective(
        ytd_deficit_hours, vars_by_clinician_date, slot_intervals,
    )

    # Build manual assignments lookup: clinician_id -> date -> list of (start, end, loc)
    # Uses all_manual_assignments (from all locations) for continuity and overlap checks.
    manual_by_clinician_date = _build_manual_by_clinician_date(
        all_manual_assignments,
        all_slot_intervals,
    )
    timer.checkpoint("vacation_and_manual_setup")

    _add_overlap_constraints(
        model,
        solver_settings,
        vars_by_clinician_date,
        manual_by_clinician_date,
        day_index_by_iso,
    )
    timer.checkpoint("overlap_constraints")

    on_progress("phase", {"phase": "coverage_constraints", "label": "Preparation (5/10): Applying staffing requirements..."})
    # Coverage + rules
    notes: List[str] = []

    # Add warning if there are orphaned assignments (slots not in template)
    if orphaned_assignments:
        notes.append(f"WARNING: {len(orphaned_assignments)} assignment(s) reference slots not in the template and were ignored by the solver.")

    coverage_terms, slack_terms, total_required, order_weight_by_slot_id = _add_coverage_constraints(
        model,
        payload,
        state,
        slot_contexts,
        target_day_isos,
        day_type_by_iso,
        var_map,
        manual_assignments,
    )
    timer.checkpoint("coverage_constraints")

    on_progress("phase", {"phase": "on_call_rest_days", "label": "Preparation (6/10): Setting up on-call rest rules..."})
    rest_day_conflicts, rest_shift_row_ids, rest_before, rest_after = _add_on_call_rest_constraints(
        model,
        solver_settings,
        slot_contexts,
        manual_assignments,
        vars_by_clinician_date,
        target_date_set,
        day_isos,
        day_index_by_iso,
    )

    # Add rest day conflict warnings to notes
    if rest_day_conflicts:
        notes.append(f"WARNING: {len(rest_day_conflicts)} manual assignment(s) violate on-call rest day rules.")
    timer.checkpoint("on_call_rest_days")

    on_progress("phase", {"phase": "working_hours_constraints", "label": "Preparation (7/10): Balancing working hours..."})
    hours_penalty_terms = _add_working_hours_constraints(
        model,
        state,
        target_day_isos,
        target_date_set,
        manual_assignments,
        vars_by_clinician_date,
        slot_intervals,
    )
    timer.checkpoint("working_hours_constraints")

    daily_deficit_terms = _add_minimum_daily_minutes_penalty(
        model,
        state,
        vars_by_clinician_date,
        manual_by_clinician_date,
        slot_intervals,
        working_window_by_clinician_date,
    )
    timer.checkpoint("minimum_daily_minutes")

    on_progress("phase", {"phase": "continuity_constraints", "label": "Preparation (8/10): Enforcing continuous shifts..."})
    _add_continuity_constraints(
        model,
        solver_settings,
        vars_by_clinician_date,
        manual_by_clinician_date,
    )

    timer.checkpoint("continuity_constraints")

    on_progress("phase", {"phase": "objective_setup", "label": "Preparation (9/10): Finalizing optimization goals..."})
    total_slack = sum(slack_terms) if slack_terms else 0
    total_coverage = sum(coverage_terms) if coverage_terms else 0

    # Use optimized lookup instead of scanning all var_map
    priority_terms = []
    preference_terms = []
    for cid, clinician_dates in vars_by_clinician_date.items():
        clinician_prefs = pref_weight.get(cid, {})
        for _date_iso, day_vars in clinician_dates.items():
            for (sid, var, _s, _e, _l) in day_vars:
                priority_terms.append(var * order_weight_by_slot_id.get(sid, 0))
                section_id = section_by_slot_id.get(sid, "")
                preference_terms.append(var * clinician_prefs.get(section_id, 0))
    total_priority = sum(priority_terms) if priority_terms else 0
    total_preference = sum(preference_terms) if preference_terms else 0
    total_time_window_preference = sum(time_window_terms) if time_window_terms else 0
    total_hours_penalty = sum(hours_penalty_terms) if hours_penalty_terms else 0
    total_daily_deficit = sum(daily_deficit_terms) if daily_deficit_terms else 0
    total_ytd_bonus = sum(ytd_bonus_terms) if ytd_bonus_terms else 0
    # Total assignments - used to maximize distribution when not only_fill_required
    total_assignments = sum(var for var in var_map.values())

    # Get configurable weights from solver_settings (with defaults)
    # Note: Use 'is not None' check to allow explicit 0 values (0 is falsy in Python)
    def get_weight(attr_name: str, default: int) -> int:
        val = getattr(solver_settings, attr_name, None)
        return val if val is not None else default

    w_coverage = get_weight('weightCoverage', DEFAULT_WEIGHT_COVERAGE)
    w_slack = get_weight('weightSlack', DEFAULT_WEIGHT_SLACK)
    w_total_assignments = get_weight('weightTotalAssignments', DEFAULT_WEIGHT_TOTAL_ASSIGNMENTS)
    w_slot_priority = get_weight('weightSlotPriority', DEFAULT_WEIGHT_SLOT_PRIORITY)
    w_time_window = get_weight('weightTimeWindow', DEFAULT_WEIGHT_TIME_WINDOW)
    w_section_pref = get_weight('weightSectionPreference', DEFAULT_WEIGHT_SECTION_PREFERENCE)
    w_working_hours = get_weight('weightWorkingHours', DEFAULT_WEIGHT_WORKING_HOURS)
    w_min_daily = get_weight('weightMinimumDailyHours', DEFAULT_WEIGHT_MINIMUM_DAILY_HOURS)
    w_ytd_balance = get_weight('weightYtdBalance', DEFAULT_WEIGHT_YTD_BALANCE)

    if payload.only_fill_required:
        model.Minimize(
            -total_coverage * w_coverage
            + total_slack * w_slack
            - total_preference * w_section_pref
            - total_time_window_preference * w_time_window
            + total_hours_penalty * w_working_hours
            + total_daily_deficit * w_min_daily
            - total_ytd_bonus * w_ytd_balance
        )
    else:
        # When distributing all people, maximize total assignments
        model.Minimize(
            -total_coverage * w_coverage
            + total_slack * w_slack
            - total_assignments * w_total_assignments
            - total_priority * w_slot_priority
            - total_preference * w_section_pref
            - total_time_window_preference * w_time_window
            + total_hours_penalty * w_working_hours
            + total_daily_deficit * w_min_daily
            - total_ytd_bonus * w_ytd_balance
        )
    # Decision strategy: try high-priority slot variables first for faster initial solutions
    priority_sorted_vars = sorted(
        var_map.keys(),
        key=lambda k: order_weight_by_slot_id.get(k[2], 0),
        reverse=True,
    )
    if priority_sorted_vars:
        model.AddDecisionStrategy(
            [var_map[k] for k in priority_sorted_vars],
            cp_model.CHOOSE_FIRST,
            cp_model.SELECT_MAX_VALUE,
        )

    timer.checkpoint("objective_setup")

    on_progress("phase", {"phase": "solve", "label": "Preparation (10/10): Solving constraints..."})
    # Solution callback to track when solutions are found and check for cancellation.
    # Implements gap-based early stopping: once the optimality gap drops below
    # SOLVER_GAP_THRESHOLD, a grace timer starts.  Each improving solution resets
    # the timer.  If no improvement comes within SOLVER_GAP_GRACE_SECONDS the
    # search is stopped (StopSearch is thread-safe in OR-Tools).
    class SolutionCallback(cp_model.CpSolverSolutionCallback):
        def __init__(self, timer: SolverTimer, cancel_event_ref, var_map: Dict, progress_callback):
            super().__init__()
            self.timer = timer
            self.cancel_event = cancel_event_ref
            self.var_map = var_map
            self.progress_callback = progress_callback
            self.solution_times: List[Tuple[int, float, float]] = []  # (solution_num, time_ms, objective)
            self.solve_start = time.time()
            self.was_aborted = False
            self.stopped_by_gap = False
            self.last_assignments: List[Dict] = []  # Store last solution's assignments
            # Grace-period timer state
            self._grace_timer: Optional[threading.Timer] = None
            self._grace_lock = threading.Lock()

        def _restart_grace_timer(self) -> None:
            """Start or restart the grace-period countdown."""
            with self._grace_lock:
                if self._grace_timer is not None:
                    self._grace_timer.cancel()
                self._grace_timer = threading.Timer(
                    SOLVER_GAP_GRACE_SECONDS, self._grace_expired,
                )
                self._grace_timer.daemon = True
                self._grace_timer.start()

        def _cancel_grace_timer(self) -> None:
            with self._grace_lock:
                if self._grace_timer is not None:
                    self._grace_timer.cancel()
                    self._grace_timer = None

        def _grace_expired(self) -> None:
            """Called from timer thread when grace period elapses."""
            self.stopped_by_gap = True
            self.StopSearch()  # thread-safe: sets an atomic flag in C++

        def on_solution_callback(self):
            elapsed_ms = (time.time() - self.solve_start) * 1000
            solution_num = len(self.solution_times) + 1
            objective = self.ObjectiveValue()
            self.solution_times.append((solution_num, elapsed_ms, objective))

            # Extract current assignments from this solution
            current_assignments = []
            for (clinician_id, date_iso, row_id), var in self.var_map.items():
                if self.Value(var) == 1:
                    current_assignments.append({
                        "id": f"as-{date_iso}-{clinician_id}-{row_id}",
                        "rowId": row_id,
                        "dateISO": date_iso,
                        "clinicianId": clinician_id,
                        "source": "solver",
                    })
            self.last_assignments = current_assignments

            # Send progress via callback (SSE broadcast or queue)
            self.progress_callback("solution", {
                "solution_num": solution_num,
                "time_ms": round(elapsed_ms, 1),
                "objective": objective,
                "assignments": current_assignments,
            })

            # Gap-based early stopping with grace period
            best_bound = self.BestObjectiveBound()
            denom = max(1, abs(objective))
            gap = abs(objective - best_bound) / denom
            if gap <= SOLVER_GAP_THRESHOLD:
                # Within gap — (re)start the grace countdown.
                # Each new improving solution resets the 20 s window.
                self._restart_grace_timer()

            # Check if abort was requested
            if self.cancel_event.is_set():
                self._cancel_grace_timer()
                self.was_aborted = True
                self.StopSearch()

    solution_callback = SolutionCallback(timer, cancel_event, var_map, on_progress)

    solver = cp_model.CpSolver()
    total_timeout_seconds = payload.timeout_seconds if payload.timeout_seconds is not None else 60.0
    # Calculate elapsed time since the request started (includes subprocess spawn + all preparation)
    elapsed_since_start = time.time() - actual_start_time
    # Subtract elapsed time from total budget to get remaining time for actual solving
    remaining_timeout = max(1.0, total_timeout_seconds - elapsed_since_start)  # At least 1 second
    solver.parameters.max_time_in_seconds = remaining_timeout
    solver.parameters.num_search_workers = SOLVER_NUM_WORKERS
    solver.parameters.relative_gap_limit = SOLVER_GAP_THRESHOLD
    result = solver.SolveWithSolutionCallback(model, solution_callback)
    solution_callback._cancel_grace_timer()  # clean up any pending timer
    timer.checkpoint("solve")

    if result not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Add more diagnostics about why no solution was found
        if not diagnostics:
            diagnostics.append("No feasible assignment found.")
            diagnostics.append(f"Variables: {len(var_map)} assignment options.")
            if var_map:
                # Count constraints that might be too restrictive
                unique_clinicians = len(set(cid for cid, _, _ in var_map.keys()))
                unique_dates = len(set(d for _, d, _ in var_map.keys()))
                unique_slots = len(set(sid for _, _, sid in var_map.keys()))
                diagnostics.append(f"Clinicians with options: {unique_clinicians}, Dates: {unique_dates}, Slots: {unique_slots}.")

                # Check for on-call rest day issues
                if solver_settings.onCallRestEnabled:
                    rest_before = solver_settings.onCallRestDaysBefore or 0
                    rest_after = solver_settings.onCallRestDaysAfter or 0
                    diagnostics.append(f"On-call rest days enabled: {rest_before} before, {rest_after} after.")
                    # Check for manual on-call assignments that might conflict
                    on_call_class_id = solver_settings.onCallRestClassId
                    on_call_slot_ids = {
                        ctx["slot_id"] for ctx in slot_contexts
                        if ctx["section_id"] == on_call_class_id
                    }
                    for (cid, date_iso), row_ids in manual_assignments.items():
                        if any(rid in on_call_slot_ids for rid in row_ids):
                            diagnostics.append(f"Manual on-call assignment: clinician {cid} on {date_iso}.")

                if solver_settings.enforceSameLocationPerDay:
                    diagnostics.append("Enforce same location per day: enabled.")

                # Include pre-computed rest day conflicts
                if rest_day_conflicts:
                    diagnostics.append("MANUAL ASSIGNMENT CONFLICTS DETECTED:")
                    for conflict in rest_day_conflicts[:10]:
                        diagnostics.append(f"  - {conflict}")
                    if len(rest_day_conflicts) > 10:
                        diagnostics.append(f"  ... and {len(rest_day_conflicts) - 10} more conflicts")

        # Try to provide more specific infeasibility info
        diagnostics.append(f"Solver status: {solver.StatusName(result)}")
        total_elapsed = time.time() - actual_start_time
        diagnostics.append(f"Total time: {total_elapsed:.1f}s (budget: {total_timeout_seconds}s, prep: {elapsed_since_start:.1f}s, solver limit: {remaining_timeout:.1f}s)")
        if result == cp_model.UNKNOWN:
            diagnostics.append("Solver timed out. Problem may be too large or have complex constraints.")

        # If solving the entire range failed and range is > 14 days, try week-by-week
        total_days = (range_end - range_start).days + 1
        if total_days > 14:
            # Attempt week-by-week solving as fallback
            week_assignments: List[Assignment] = []
            week_notes: List[str] = [f"Full-range solver failed after {timer.total_ms():.0f}ms. Trying week-by-week..."]

            week_cursor = range_start
            week_num = 0
            week_success = True
            total_weeks = (total_days + 6) // 7
            # Divide the remaining budget across the weeks instead of giving
            # every week the full original timeout.
            week_timeout = max(10.0, float(payload.timeout_seconds or 60) / max(1, total_weeks))
            while week_cursor <= range_end:
                if cancel_event is not None and cancel_event.is_set():
                    week_notes.append("Week-by-week solving aborted by user.")
                    week_success = False
                    break
                week_num += 1
                week_end = min(week_cursor + timedelta(days=6), range_end)

                # Create a sub-request for this week
                week_payload = SolveRangeRequest(
                    startISO=week_cursor.isoformat(),
                    endISO=week_end.isoformat(),
                    only_fill_required=payload.only_fill_required,
                    timeout_seconds=week_timeout,
                )

                # Solve this week IN-PROCESS: calling the solve_range route
                # handler here would re-enter the subprocess-spawning /
                # global-lock machinery from inside the solver subprocess.
                try:
                    week_result = _solve_range_impl(
                        week_payload,
                        current_user,
                        cancel_event=cancel_event,
                        on_progress=on_progress,
                        start_time=time.time(),
                    )
                    if any("No solution" in note for note in week_result.notes):
                        week_notes.append(f"Week {week_num} ({week_cursor} to {week_end}): No solution found.")
                        week_success = False
                    else:
                        week_assignments.extend(week_result.assignments)
                        # Extract timing from notes if present
                        timing_note = next((n for n in week_result.notes if "completed in" in n), None)
                        if timing_note:
                            week_notes.append(f"Week {week_num}: {timing_note}")
                except Exception as e:
                    week_notes.append(f"Week {week_num} ({week_cursor} to {week_end}): Error - {str(e)}")
                    week_success = False

                week_cursor = week_end + timedelta(days=1)

            if week_success and week_assignments:
                week_notes.append(f"Week-by-week solving completed successfully with {len(week_assignments)} assignments.")
                return SolveRangeResponse(
                    startISO=range_start.isoformat(),
                    endISO=range_end.isoformat(),
                    assignments=week_assignments,
                    notes=week_notes,
                )
            else:
                # Week-by-week also failed
                week_notes.append("Week-by-week solving also failed.")
                return SolveRangeResponse(
                    startISO=range_start.isoformat(),
                    endISO=range_end.isoformat(),
                    assignments=week_assignments,  # Return partial results if any
                    notes=["No solution"] + week_notes,
                )

        return SolveRangeResponse(
            startISO=range_start.isoformat(),
            endISO=range_end.isoformat(),
            assignments=[],
            notes=["No solution"] + diagnostics,
        )

    new_assignments: List[Assignment] = []
    for (clinician_id, date_iso, row_id), var in var_map.items():
        if solver.Value(var) == 1:
            new_assignments.append(
                Assignment(
                    id=f"as-{date_iso}-{clinician_id}-{row_id}",
                    rowId=row_id,
                    dateISO=date_iso,
                    clinicianId=clinician_id,
                    source="solver",
                )
            )

    if (
        solver_settings.onCallRestEnabled
        and rest_shift_row_ids
        and (rest_before > 0 or rest_after > 0)
    ):
        boundary_conflicts: set[tuple[str, str, str]] = set()
        on_call_assignments: set[tuple[str, str]] = set()
        for (clinician_id, date_iso), row_ids in manual_assignments.items():
            if date_iso not in target_date_set:
                continue
            if any(row_id in rest_shift_row_ids for row_id in row_ids):
                on_call_assignments.add((clinician_id, date_iso))
        for assignment in new_assignments:
            if assignment.dateISO not in target_date_set:
                continue
            if assignment.rowId in rest_shift_row_ids:
                on_call_assignments.add((assignment.clinicianId, assignment.dateISO))

        for clinician_id, date_iso in on_call_assignments:
            base_index = day_index_by_iso.get(date_iso)
            if base_index is None:
                continue
            for offset in range(1, rest_before + 1):
                target_idx = base_index - offset
                if target_idx < 0 or target_idx >= len(day_isos):
                    continue
                target_date = day_isos[target_idx]
                if target_date in target_date_set:
                    continue
                if manual_assignments.get((clinician_id, target_date)):
                    boundary_conflicts.add((clinician_id, date_iso, target_date))
            for offset in range(1, rest_after + 1):
                target_idx = base_index + offset
                if target_idx < 0 or target_idx >= len(day_isos):
                    continue
                target_date = day_isos[target_idx]
                if target_date in target_date_set:
                    continue
                if manual_assignments.get((clinician_id, target_date)):
                    boundary_conflicts.add((clinician_id, date_iso, target_date))

        if boundary_conflicts:
            notes.append(
                "Rest day conflicts outside the selected range; some boundary days are already assigned."
            )

    if solver.Value(total_slack) > 0:
        notes.append("Could not fill all required slots.")
    if payload.only_fill_required and total_required == 0:
        notes.append("No required slots detected for the selected timeframe.")
    timer.checkpoint("result_extraction")

    # Always include timing info
    notes.append(f"Solver completed in {timer.total_ms():.0f}ms.")

    # Dump debug info if DEBUG_SOLVER is enabled
    _dump_solver_debug(
        timer=timer,
        payload=payload,
        state=state,
        model_stats={
            "num_variables": len(var_map),
            "num_clinicians": len(state.clinicians),
            "num_days": len(target_day_isos),
            "num_slots": len(slot_contexts),
            "solver_status": solver.StatusName(result),
            "solver_objective": solver.ObjectiveValue() if result in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
            "solution_times": [
                {"solution": num, "time_ms": round(t, 1), "objective": obj}
                for num, t, obj in solution_callback.solution_times
            ],
        },
        result_info={
            "num_assignments": len(new_assignments),
            "total_slack": solver.Value(total_slack) if slack_terms else 0,
        },
    )

    # Add note if solver was stopped early
    if solution_callback.was_aborted:
        notes.append("Solver was aborted by user request.")
    elif solution_callback.stopped_by_gap:
        notes.append(f"Solver stopped early: within {SOLVER_GAP_THRESHOLD*100:.0f}% of optimal after {SOLVER_GAP_GRACE_SECONDS:.0f}s grace period.")

    # Compute sub-scores for the final solution
    sub_scores = None
    if result in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Evaluate each component by summing the values of individual terms
        eval_coverage = sum(solver.Value(t) for t in coverage_terms) if coverage_terms else 0
        eval_slack = sum(solver.Value(t) for t in slack_terms) if slack_terms else 0
        eval_preference = sum(solver.Value(t) for t in preference_terms) if preference_terms else 0
        eval_time_window = sum(solver.Value(t) for t in time_window_terms) if time_window_terms else 0
        eval_hours_penalty = sum(solver.Value(t) for t in hours_penalty_terms) if hours_penalty_terms else 0
        eval_ytd_bonus = sum(solver.Value(t) for t in ytd_bonus_terms) if ytd_bonus_terms else 0

        sub_scores = SolverSubScores(
            slots_filled=eval_coverage,
            slots_unfilled=eval_slack,
            total_assignments=len(new_assignments),
            preference_score=eval_preference,
            time_window_score=eval_time_window,
            hours_penalty=eval_hours_penalty,
            ytd_balance_bonus=eval_ytd_bonus,
        )

    # Build debug info (always included for frontend timing display)
    debug_info = SolverDebugInfo(
        timing=timer.to_dict(),
        solution_times=[
            SolverDebugSolutionTime(solution=num, time_ms=round(t, 1), objective=obj)
            for num, t, obj in solution_callback.solution_times
        ],
        num_variables=len(var_map),
        num_days=len(target_day_isos),
        num_slots=len(slot_contexts),
        solver_status="ABORTED" if solution_callback.was_aborted else ("GAP_CONVERGED" if solution_callback.stopped_by_gap else solver.StatusName(result)),
        cpu_workers_used=SOLVER_NUM_WORKERS,
        cpu_cores_available=multiprocessing.cpu_count(),
        sub_scores=sub_scores,
    )

    return SolveRangeResponse(
        startISO=range_start.isoformat(),
        endISO=range_end.isoformat(),
        assignments=new_assignments,
        notes=notes,
        debugInfo=debug_info,
    )
