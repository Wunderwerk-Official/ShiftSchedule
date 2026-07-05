"""
Deterministic plan scoring and statistics for shift-schedule assignments.

Companion to ``validation.py`` (pass/fail hard constraints): this module
answers "how GOOD is a plan" so two candidate schedules can be compared.

The AGENT solver does NOT use the weighted score: since the lexicographic
quality gate (``agent/tools.PlanToolExecutor._quality``) replaced it, the
agent compares plans tier by tier over ``plan_stats`` + validator counts, and
``score_plan`` below survives only as the pure-Python replica of the legacy
CP-SAT objective (same hand-tuned :class:`SolverSettings` weights, same
minimized orientation: LOWER IS BETTER) for the ``solver_mode="cpsat"`` API
path and its parity tests. Do not wire the weighted score back into agent
decisions — its weights are gut-feel calibrations that predate the agent.

Terms that the CP-SAT model computes over its decision variables only (total
assignments, slot priority, preferences, time windows, YTD bonus) are computed
over the *new* assignments only; terms that include manual context (coverage,
slack, working hours, minimum daily minutes) include the pre-existing
assignments captured in the context. Constant offsets versus the CP-SAT
objective are possible (e.g. instances fully covered by manual assignments),
which never affects comparisons between plans of the same problem.

Usage::

    ctx = build_scoring_context(state, "2026-01-05", "2026-01-11",
                                only_fill_required=True)
    stats = plan_stats(ctx, proposed_assignments)   # feeds the quality tiers
    gaps = open_slots(ctx, proposed_assignments)
    score = score_plan(ctx, proposed_assignments)   # CP-SAT replica only

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

from pydantic import BaseModel, Field

from .models import AppState, Assignment, SolverSettings
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


class PlanScore(BaseModel):
    """Objective value on the CP-SAT scale (minimized — lower is better)."""

    total: float
    components: Dict[str, float] = Field(default_factory=dict)


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
        self.fixed_minutes_by_clinician: Dict[str, int] = {}
        self.fixed_minutes_by_clinician_date: Dict[Tuple[str, str], int] = {}
        for a in self.fixed_assignments:
            inst = self.instances[f"{a.rowId}__{a.dateISO}"]
            self.fixed_counts[inst.slot_key] = self.fixed_counts.get(inst.slot_key, 0) + 1
            duration = max(0, inst.end - inst.start)
            self.fixed_minutes_by_clinician[a.clinicianId] = (
                self.fixed_minutes_by_clinician.get(a.clinicianId, 0) + duration
            )
            key = (a.clinicianId, a.dateISO)
            self.fixed_minutes_by_clinician_date[key] = (
                self.fixed_minutes_by_clinician_date.get(key, 0) + duration
            )

        # Section preference weights, same rank formula as solver.py.
        self.pref_weight: Dict[str, Dict[str, int]] = {}
        for clinician in state.clinicians:
            preferred = clinician.preferredClassIds or []
            self.pref_weight[clinician.id] = {
                class_id: max(1, len(preferred) - idx)
                for idx, class_id in enumerate(preferred)
            }
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

        self.scale = len(self.target_day_isos) / 7.0
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
# Scoring
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


def score_plan(ctx: ScoringContext, new_assignments: List[Assignment]) -> PlanScore:
    """Score fixed-context + ``new_assignments``. Lower is better."""
    s = ctx.settings
    new = _active_new_assignments(ctx, new_assignments)

    counts: Dict[str, int] = dict(ctx.fixed_counts)
    for _a, inst in new:
        counts[inst.slot_key] = counts.get(inst.slot_key, 0) + 1

    covered_weighted = 0
    slack_weighted = 0
    for inst in ctx.instances.values():
        count = counts.get(inst.slot_key, 0)
        if inst.target > 0 and count >= 1:
            covered_weighted += inst.order_weight
        slack_weighted += inst.order_weight * max(0, inst.target - count)

    preference_score = 0
    time_window_score = 0
    priority_score = 0
    ytd_bonus = 0
    new_minutes_by_clinician: Dict[str, int] = {}
    new_minutes_by_clinician_date: Dict[Tuple[str, str], int] = {}
    new_count_by_clinician_date: Dict[Tuple[str, str], int] = {}
    for a, inst in new:
        priority_score += inst.order_weight
        preference_score += ctx.pref_weight.get(a.clinicianId, {}).get(inst.section_id, 0)
        window = ctx.window_by_clinician_date.get((a.clinicianId, a.dateISO))
        if (
            window is not None
            and window[0] == "preference"
            and inst.start >= window[1]
            and inst.end <= window[2]
        ):
            time_window_score += 1
        ytd_bonus += ctx.ytd_deficit_pct.get(a.clinicianId, 0)
        duration = max(0, inst.end - inst.start)
        new_minutes_by_clinician[a.clinicianId] = (
            new_minutes_by_clinician.get(a.clinicianId, 0) + duration
        )
        key = (a.clinicianId, a.dateISO)
        new_minutes_by_clinician_date[key] = (
            new_minutes_by_clinician_date.get(key, 0) + duration
        )
        new_count_by_clinician_date[key] = new_count_by_clinician_date.get(key, 0) + 1

    hours_penalty_minutes = 0
    for cid, contract in ctx.contract_hours.items():
        total_minutes = ctx.fixed_minutes_by_clinician.get(
            cid, 0
        ) + new_minutes_by_clinician.get(cid, 0)
        target_minutes = int(round(contract * 60 * ctx.scale))
        tol_minutes = int(round(ctx.tolerance_hours[cid] * 60 * ctx.scale))
        if target_minutes <= 0 and tol_minutes <= 0:
            continue
        under = max(0, (target_minutes - tol_minutes) - total_minutes)
        over = max(0, total_minutes - (target_minutes + tol_minutes))
        hours_penalty_minutes += under + over

    daily_deficit_minutes = 0
    for (cid, date_iso), new_count in new_count_by_clinician_date.items():
        if new_count < 1:
            continue
        window = ctx.window_by_clinician_date.get((cid, date_iso))
        if window is not None:
            min_minutes = max(1, (window[2] - window[1]) // 2)
        elif cid in ctx.contract_hours:
            min_minutes = max(1, int(round(ctx.contract_hours[cid] * 60 / 5)) // 2)
        else:
            continue
        manual_minutes = ctx.fixed_minutes_by_clinician_date.get((cid, date_iso), 0)
        if manual_minutes >= min_minutes:
            continue
        total_day = manual_minutes + new_minutes_by_clinician_date.get((cid, date_iso), 0)
        deficit = min(max(0, min_minutes - total_day), min_minutes - manual_minutes)
        daily_deficit_minutes += deficit

    components: Dict[str, float] = {
        "coverage": -covered_weighted * s.weightCoverage,
        "slack": slack_weighted * s.weightSlack,
        "section_preference": -preference_score * s.weightSectionPreference,
        "time_window": -time_window_score * s.weightTimeWindow,
        "working_hours": hours_penalty_minutes * s.weightWorkingHours,
        "minimum_daily_hours": daily_deficit_minutes * s.weightMinimumDailyHours,
        "ytd_balance": -ytd_bonus * s.weightYtdBalance,
    }
    if not ctx.only_fill_required:
        components["total_assignments"] = -len(new) * s.weightTotalAssignments
        components["slot_priority"] = -priority_score * s.weightSlotPriority

    return PlanScore(total=sum(components.values()), components=components)


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
    # itself uses the whole-range scale — see score_plan — which is the right
    # reference for the objective, but not for this user-facing stat.)
    week_days: Dict[Tuple[int, int], int] = {}
    for date_iso in ctx.target_day_isos:
        wk = datetime.fromisoformat(f"{date_iso}T00:00:00").date().isocalendar()[:2]
        week_days[wk] = week_days.get(wk, 0) + 1

    target_day_set = set(ctx.target_day_isos)
    vacation_days: Dict[Tuple[str, Tuple[int, int]], int] = {}
    for clinician in ctx.state.clinicians:
        for vacation in clinician.vacations or []:
            try:
                v_start = datetime.fromisoformat(f"{vacation.startISO}T00:00:00").date()
                v_end = datetime.fromisoformat(f"{vacation.endISO}T00:00:00").date()
            except (ValueError, TypeError):
                continue
            cursor = v_start
            while cursor <= v_end:
                iso = cursor.isoformat()
                if iso in target_day_set:
                    wk = cursor.isocalendar()[:2]
                    key = (clinician.id, wk)
                    vacation_days[key] = vacation_days.get(key, 0) + 1
                cursor += timedelta(days=1)

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
        if window is not None:
            min_minutes = max(1, (window[2] - window[1]) // 2)
        elif cid in ctx.contract_hours:
            min_minutes = max(1, int(round(ctx.contract_hours[cid] * 60 / 5)) // 2)
        else:
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
    "PlanScore",
    "PlanStats",
    "OpenSlot",
    "SlotInstance",
    "ScoringContext",
    "build_scoring_context",
    "score_plan",
    "plan_stats",
    "open_slots",
]
