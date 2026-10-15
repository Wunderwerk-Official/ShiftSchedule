"""
Deterministic plan statistics and open slots for shift-schedule assignments.

Companion to ``validation.py`` (pass/fail hard constraints): this module
answers "how GOOD is a plan" so two candidate schedules can be compared.
The agent's lexicographic quality gate
(``agent/tools.PlanToolExecutor._quality``) compares plans tier by tier over
``plan_stats`` + validator counts; ``open_slots`` lists the remaining gaps.
There is no weighted score here: the CP-SAT objective is built in
``solver.py`` only.

Usage::

    ctx = build_scoring_context(state, "2026-01-05", "2026-01-11",
                                only_fill_required=True)
    stats = plan_stats(ctx, proposed_assignments)   # feeds the quality tiers
    gaps = open_slots(ctx, proposed_assignments)

Design notes
------------
- Pure functions over an immutable, precomputed :class:`ScoringContext`; build
  the context once per solve range and reuse it for every candidate (the agent
  loop calls ``plan_stats`` after every move batch).
- "Fixed" assignments — everything already in ``state.assignments`` for the
  range, regardless of ``source`` — are treated as immovable context, exactly
  like both solvers treat them.
- Reuses the pure helpers from ``solver.py`` (slot contexts, intervals, day
  types, YTD deficit) so scoring can never drift from the solver's own slot
  expansion. This import is safe: ``solver.py`` never imports this module at
  module level.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel

from .models import AppState, Assignment, SolverSettings
from .planning_preferences import daily_min_minutes, vacation_dates_in_range
from .solver import (
    EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL,
    _build_slot_contexts_and_intervals,
    _compute_ytd_deficit_hours,
    _get_clinician_time_window,
    _get_day_type,
    _get_weekday_key,
)


# ---------------------------------------------------------------------------
# Result shapes
# ---------------------------------------------------------------------------


class OpenSlot(BaseModel):
    """A slot instance still below its required target."""

    slot_key: str  # "<slot_id>__<date_iso>"
    slot_id: str
    dateISO: str
    section_id: str
    location_id: str
    start: str  # "HH:MM"
    end: str  # "HH:MM" clock time (may wrap past midnight for overnight slots)
    missing: int


class PlanStats(BaseModel):
    """Aggregate quality metrics, mirroring ``src/lib/solverStats.ts``."""

    total_required_slots: int
    filled_slots: int
    open_slots: int
    total_assignments: int
    section_preference_matches: int
    time_window_fits: int
    working_hours_deviation_minutes: int
    split_shifts: int
    location_changes: int
    # Clinician-days whose TOTAL work (fixed + solver) stays below the derived
    # daily minimum — the "someone comes in for just 1-2 hours" smell. Counts
    # fixed-only days too, so extending a manually pinned mini-day registers
    # as an improvement.
    short_days: int = 0


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SlotInstance:
    """One concrete (template slot, date) occurrence inside the solve range."""

    slot_key: str
    slot_id: str
    date_iso: str
    section_id: str
    location_id: str
    start: int  # minutes from midnight
    end: int  # absolute minutes (offset-inclusive for overnight slots)
    target: int  # required + per-day override
    capacity: int  # target (+ distribute-all headroom)
    order_weight: int


class ScoringContext:
    """Precomputed problem data for one solve range. Treat as immutable."""

    def __init__(
        self,
        state: AppState,
        start_iso: str,
        end_iso: Optional[str],
        *,
        only_fill_required: bool = False,
    ):
        try:
            range_start = datetime.fromisoformat(f"{start_iso}T00:00:00").date()
        except ValueError:
            raise ValueError("Invalid startISO")
        if end_iso:
            try:
                range_end = datetime.fromisoformat(f"{end_iso}T00:00:00").date()
            except ValueError:
                raise ValueError("Invalid endISO")
        else:
            range_end = range_start + timedelta(days=6)
        if range_end < range_start:
            raise ValueError("Invalid endISO")

        self.state = state
        self.clinicians_by_id = {c.id: c for c in state.clinicians}
        self.start_iso = range_start.isoformat()
        self.end_iso = range_end.isoformat()
        self.only_fill_required = only_fill_required
        self.settings = SolverSettings.model_validate(state.solverSettings or {})

        self.target_day_isos: List[str] = []
        cursor = range_start
        while cursor <= range_end:
            self.target_day_isos.append(cursor.isoformat())
            cursor += timedelta(days=1)
        self.target_date_set = set(self.target_day_isos)

        (
            slot_contexts,
            _slot_ids,
            self.section_by_slot_id,
            self.slot_intervals,
            self.all_slot_intervals,
        ) = _build_slot_contexts_and_intervals(state)

        # Priority weight per slot: template order, same formula as
        # solver._add_coverage_constraints.
        total_slots = len(slot_contexts)
        self.order_weight_by_slot_id: Dict[str, int] = {
            ctx["slot_id"]: min(100, max(1, total_slots - index))
            for index, ctx in enumerate(slot_contexts)
        }

        holidays = state.holidays or []
        day_type_by_iso = {
            date_iso: _get_day_type(date_iso, holidays)
            for date_iso in self.target_day_isos
        }

        self.instances: Dict[str, SlotInstance] = {}
        for date_iso in self.target_day_isos:
            day_type = day_type_by_iso[date_iso]
            for ctx in slot_contexts:
                if ctx.get("day_type") != day_type:
                    continue
                slot_id = ctx["slot_id"]
                start, end, location_id = self.slot_intervals[slot_id]
                raw_required = getattr(ctx["slot"], "requiredSlots", 0)
                base_required = raw_required if isinstance(raw_required, int) else 0
                override = state.slotOverridesByKey.get(f"{slot_id}__{date_iso}", 0)
                target = max(0, base_required + override)
                if only_fill_required:
                    capacity = target
                else:
                    extra = EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL if target > 0 else 0
                    capacity = target + extra
                slot_key = f"{slot_id}__{date_iso}"
                self.instances[slot_key] = SlotInstance(
                    slot_key=slot_key,
                    slot_id=slot_id,
                    date_iso=date_iso,
                    section_id=ctx["section_id"],
                    location_id=ctx["location_id"],
                    start=start,
                    end=end,
                    target=target,
                    capacity=capacity,
                    order_weight=self.order_weight_by_slot_id[slot_id],
                )

        # Fixed context: everything already in state for the range, any source.
        self.fixed_assignments: List[Assignment] = [
            a
            for a in state.assignments
            if not a.rowId.startswith("pool-")
            and a.dateISO in self.target_date_set
            and f"{a.rowId}__{a.dateISO}" in self.instances
        ]
        self.fixed_counts: Dict[str, int] = {}
        self.fixed_minutes_by_clinician_date: Dict[Tuple[str, str], int] = {}
        for a in self.fixed_assignments:
            inst = self.instances[f"{a.rowId}__{a.dateISO}"]
            self.fixed_counts[inst.slot_key] = self.fixed_counts.get(inst.slot_key, 0) + 1
            duration = max(0, inst.end - inst.start)
            key = (a.clinicianId, a.dateISO)
            self.fixed_minutes_by_clinician_date[key] = (
                self.fixed_minutes_by_clinician_date.get(key, 0) + duration
            )

        self.preferred_sections: Dict[str, set] = {
            c.id: set(c.preferredClassIds or []) for c in state.clinicians
        }

        # Normalized working windows per (clinician, date) — preference AND
        # mandatory entries, as in solver._build_working_window_by_clinician_date.
        self.window_by_clinician_date: Dict[Tuple[str, str], Tuple[str, int, int]] = {}
        for clinician in state.clinicians:
            for date_iso in self.target_day_isos:
                requirement, w_start, w_end = _get_clinician_time_window(
                    clinician, _get_weekday_key(date_iso)
                )
                if requirement == "none" or w_start is None or w_end is None:
                    continue
                self.window_by_clinician_date[(clinician.id, date_iso)] = (
                    requirement,
                    w_start,
                    w_end,
                )

        self.contract_hours: Dict[str, float] = {}
        self.tolerance_hours: Dict[str, float] = {}
        for clinician in state.clinicians:
            if (
                isinstance(clinician.workingHoursPerWeek, (int, float))
                and clinician.workingHoursPerWeek > 0
            ):
                self.contract_hours[clinician.id] = clinician.workingHoursPerWeek
                _tol = clinician.workingHoursToleranceHours
                self.tolerance_hours[clinician.id] = max(
                    0, _tol if _tol is not None else 5
                )

        self.ytd_deficit_pct = _compute_ytd_deficit_hours(
            state, range_start, self.all_slot_intervals
        )


def build_scoring_context(
    state: AppState,
    start_iso: str,
    end_iso: Optional[str] = None,
    *,
    only_fill_required: bool = False,
) -> ScoringContext:
    return ScoringContext(
        state, start_iso, end_iso, only_fill_required=only_fill_required
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _active_new_assignments(
    ctx: ScoringContext, new_assignments: List[Assignment]
) -> List[Tuple[Assignment, SlotInstance]]:
    """Pair each candidate assignment with its slot instance; drop everything
    that has no active instance in the range (pool rows, out-of-range dates,
    slots inactive on that day type) — the solvers cannot produce those."""
    out: List[Tuple[Assignment, SlotInstance]] = []
    for a in new_assignments:
        if a.rowId.startswith("pool-"):
            continue
        inst = ctx.instances.get(f"{a.rowId}__{a.dateISO}")
        if inst is not None:
            out.append((a, inst))
    return out


# ---------------------------------------------------------------------------
# Statistics + open slots
# ---------------------------------------------------------------------------


def open_slots(ctx: ScoringContext, new_assignments: List[Assignment]) -> List[OpenSlot]:
    """Slot instances still below target, sorted by date then template order."""
    counts: Dict[str, int] = dict(ctx.fixed_counts)
    for _a, inst in _active_new_assignments(ctx, new_assignments):
        counts[inst.slot_key] = counts.get(inst.slot_key, 0) + 1
    out: List[OpenSlot] = []
    for inst in ctx.instances.values():
        missing = inst.target - counts.get(inst.slot_key, 0)
        if missing > 0:
            out.append(
                OpenSlot(
                    slot_key=inst.slot_key,
                    slot_id=inst.slot_id,
                    dateISO=inst.date_iso,
                    section_id=inst.section_id,
                    location_id=inst.location_id,
                    start=f"{inst.start // 60:02d}:{inst.start % 60:02d}",
                    end=f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}",
                    missing=missing,
                )
            )
    out.sort(key=lambda o: (o.dateISO, -ctx.order_weight_by_slot_id.get(o.slot_id, 0)))
    return out


def plan_stats(ctx: ScoringContext, new_assignments: List[Assignment]) -> PlanStats:
    new = _active_new_assignments(ctx, new_assignments)

    counts: Dict[str, int] = dict(ctx.fixed_counts)
    for _a, inst in new:
        counts[inst.slot_key] = counts.get(inst.slot_key, 0) + 1

    total_required = 0
    filled = 0
    open_count = 0
    for inst in ctx.instances.values():
        total_required += inst.target
        count = counts.get(inst.slot_key, 0)
        filled += min(count, inst.target)
        open_count += max(0, inst.target - count)

    section_matches = 0
    window_fits = 0
    for a, inst in new:
        if inst.section_id in ctx.preferred_sections.get(a.clinicianId, set()):
            section_matches += 1
        window = ctx.window_by_clinician_date.get((a.clinicianId, a.dateISO))
        if (
            window is not None
            and inst.start >= window[1]
            and inst.end <= window[2]
        ):
            window_fits += 1

    intervals_by_clinician_date: Dict[Tuple[str, str], List[Tuple[int, int]]] = {}
    locations_by_clinician_date: Dict[Tuple[str, str], set] = {}
    for a in ctx.fixed_assignments:
        inst = ctx.instances[f"{a.rowId}__{a.dateISO}"]
        key = (a.clinicianId, a.dateISO)
        intervals_by_clinician_date.setdefault(key, []).append((inst.start, inst.end))
        if inst.location_id:
            locations_by_clinician_date.setdefault(key, set()).add(inst.location_id)
    for a, inst in new:
        key = (a.clinicianId, a.dateISO)
        intervals_by_clinician_date.setdefault(key, []).append((inst.start, inst.end))
        if inst.location_id:
            locations_by_clinician_date.setdefault(key, set()).add(inst.location_id)

    split_shifts = 0
    for intervals in intervals_by_clinician_date.values():
        if len(intervals) < 2:
            continue
        intervals.sort()
        blocks = 1
        current_end = intervals[0][1]
        for start, end in intervals[1:]:
            if start <= current_end:
                current_end = max(current_end, end)
            else:
                blocks += 1
                current_end = end
        if blocks > 1:
            split_shifts += 1

    location_changes = sum(
        1 for locs in locations_by_clinician_date.values() if len(locs) > 1
    )

    # Working-hours deviation is computed PER ISO WEEK with per-week
    # vacation-scaled targets, mirroring the frontend's live stats
    # (src/lib/solverStats.ts). A single whole-range comparison would report
    # ~0 for e.g. 0h in week 1 + 2x target in week 2. (The CP-SAT objective
    # itself uses the whole-range scale — see
    # solver._add_working_hours_constraints — which is the right reference
    # for the objective, but not for this user-facing stat.)
    week_days: Dict[Tuple[int, int], int] = {}
    for date_iso in ctx.target_day_isos:
        wk = datetime.fromisoformat(f"{date_iso}T00:00:00").date().isocalendar()[:2]
        week_days[wk] = week_days.get(wk, 0) + 1

    vacation_days: Dict[Tuple[str, Tuple[int, int]], int] = {}
    vacation_start = datetime.fromisoformat(ctx.start_iso).date()
    vacation_end = datetime.fromisoformat(ctx.end_iso).date() + timedelta(days=1)
    for clinician in ctx.state.clinicians:
        for vacation_day in vacation_dates_in_range(clinician, vacation_start, vacation_end):
            key = (clinician.id, vacation_day.isocalendar()[:2])
            vacation_days[key] = vacation_days.get(key, 0) + 1

    minutes_by_clinician_week: Dict[Tuple[str, Tuple[int, int]], int] = {}

    def _add_week_minutes(clinician_id: str, date_iso: str, minutes: int) -> None:
        wk = datetime.fromisoformat(f"{date_iso}T00:00:00").date().isocalendar()[:2]
        key = (clinician_id, wk)
        minutes_by_clinician_week[key] = minutes_by_clinician_week.get(key, 0) + minutes

    for a in ctx.fixed_assignments:
        inst = ctx.instances[f"{a.rowId}__{a.dateISO}"]
        _add_week_minutes(a.clinicianId, a.dateISO, max(0, inst.end - inst.start))
    for a, inst in new:
        _add_week_minutes(a.clinicianId, a.dateISO, max(0, inst.end - inst.start))

    hours_deviation = 0
    for cid, contract in ctx.contract_hours.items():
        tol_hours = ctx.tolerance_hours[cid]
        for wk, days in week_days.items():
            available = days - vacation_days.get((cid, wk), 0)
            if available <= 0:
                continue
            week_scale = available / 7.0
            target_minutes = contract * 60 * week_scale
            tol_minutes = tol_hours * 60 * week_scale
            total_minutes = minutes_by_clinician_week.get((cid, wk), 0)
            deviation = abs(total_minutes - target_minutes)
            hours_deviation += int(round(max(0.0, deviation - tol_minutes)))

    # Short days over the FULL plan (fixed + working copy): any day someone
    # comes in only for a stint below their daily minimum, no matter whether
    # the stint is manual or solver-placed. This matches the agent's
    # list_short_days tool exactly — previously days consisting ONLY of fixed
    # assignments were invisible to this metric, so the agent had no measured
    # incentive to extend e.g. a manually pinned half-day into a full one.
    # Fixed-only short days the agent cannot fix are a constant offset and
    # never distort comparisons.
    short_days = 0
    total_minutes_by_cd: Dict[Tuple[str, str], int] = dict(
        ctx.fixed_minutes_by_clinician_date
    )
    for a, inst in new:
        key = (a.clinicianId, a.dateISO)
        total_minutes_by_cd[key] = (
            total_minutes_by_cd.get(key, 0) + max(0, inst.end - inst.start)
        )
    for (cid, date_iso), total_minutes in total_minutes_by_cd.items():
        if total_minutes <= 0:
            continue
        window = ctx.window_by_clinician_date.get((cid, date_iso))
        clinician = ctx.clinicians_by_id.get(cid)
        min_minutes = daily_min_minutes(clinician, window) if clinician else None
        if min_minutes is None:
            continue
        if total_minutes < min_minutes:
            short_days += 1

    return PlanStats(
        total_required_slots=total_required,
        filled_slots=filled,
        open_slots=open_count,
        total_assignments=len(ctx.fixed_assignments) + len(new),
        section_preference_matches=section_matches,
        time_window_fits=window_fits,
        working_hours_deviation_minutes=hours_deviation,
        split_shifts=split_shifts,
        location_changes=location_changes,
        short_days=short_days,
    )


__all__ = [
    "PlanStats",
    "OpenSlot",
    "SlotInstance",
    "ScoringContext",
    "build_scoring_context",
    "plan_stats",
    "open_slots",
]
