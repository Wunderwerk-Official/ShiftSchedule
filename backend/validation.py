"""
Deterministic validator for shift-schedule assignments.

Mirrors the hard constraints enforced by the CP-SAT solver in ``solver.py``,
but as plain, side-effect-free functions that can be called on ANY proposed
assignment list (LLM output, human edit, solver result, external import).

Intended primary use case: an LLM-based scheduler proposes assignments, and a
deterministic validator inspects the proposal against the same rules the
existing solver encodes as CP-SAT constraints. A violation list short-circuits
the LLM loop with precise feedback.

Scope
-----
Only **hard** constraints are checked here:

- Qualification       — assigned clinician must be qualified for the slot's section
- Vacation            — no assignments on days the clinician is on vacation
- Overlap             — a clinician cannot have overlapping time intervals
                        (correctly handling midnight-spanning overnight slots)
- Same location/day   — if ``enforceSameLocationPerDay`` is enabled
- On-call rest days   — if ``onCallRestEnabled`` is enabled
- Mandatory windows   — slots must fit inside ``preferredWorkingTimes`` entries
                        whose requirement is ``mandatory``
- Weekly hours        — per ISO week, total assigned hours must stay within
                        ``workingHoursPerWeek + workingHoursToleranceHours``
                        (matches the heuristic solver; CP-SAT treats this as a
                        soft penalty, so a CP-SAT plan may legitimately flag here)
- Split shifts        — max one contiguous work block per clinician/day when
                        ``preferContinuousShifts`` is enabled
- Capacity            — per slot instance, assignment count must not exceed
                        ``requiredSlots + slotOverridesByKey`` (plus the
                        distribute-all extra when ``only_fill_required=False``)
- Reference integrity — clinician/slot IDs actually exist in the app state

Checked separately (NOT part of ``validate_assignments`` pass/fail, because the
feature has never been enforced and existing plans may violate it):

- Solver rules        — ``validate_solver_rules`` checks the if/then
                        ``SolverRule`` entries; callers treat these as soft

Explicitly NOT covered:

- Section preferences, time-window *preferences*, working-hours balance
  below the hard cap, YTD balance — all soft objectives
- Min daily hours — soft objective

If you later want to score a candidate schedule (e.g. compare two LLM
proposals), use ``backend/scoring.py`` — this file stays focused on pass/fail
correctness.

Callers comparing a candidate plan against a baseline (e.g. an LLM repair loop)
should diff the two violation lists instead of demanding an empty report:
pre-existing manual data may legitimately violate e.g. weekly hours or
capacity, and the invariant that matters is "no NEW violations".

Design notes
------------
- Pure functions, no I/O, no global state. Safe to call from any request path.
- Does NOT import from ``solver.py`` to avoid a circular dependency with the
  subprocess-spawning code in that module. The small helpers (time parsing,
  slot-interval construction) are duplicated with a comment noting the source.
- Returns structured :class:`Violation` objects with stable ``code`` strings
  so callers (LLM feedback loops, UI conflict badges, logs) can pattern-match.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from .constants import DEFAULT_LOCATION_ID
from .models import AppState, Assignment, Clinician, SolverRule, SolverSettings


# ---------------------------------------------------------------------------
# Violation codes (stable strings for pattern-matching by callers)
# ---------------------------------------------------------------------------

VIOLATION_QUALIFICATION = "QUALIFICATION"
VIOLATION_VACATION = "VACATION"
VIOLATION_OVERLAP = "OVERLAP"
VIOLATION_SAME_LOCATION = "SAME_LOCATION_PER_DAY"
VIOLATION_ON_CALL_REST = "ON_CALL_REST"
VIOLATION_MANDATORY_WINDOW = "MANDATORY_WINDOW"
VIOLATION_WEEKLY_HOURS = "WEEKLY_HOURS"
VIOLATION_SPLIT_SHIFT = "SPLIT_SHIFT"
VIOLATION_CAPACITY = "CAPACITY_EXCEEDED"
VIOLATION_SOLVER_RULE = "SOLVER_RULE"
VIOLATION_UNKNOWN_CLINICIAN = "UNKNOWN_CLINICIAN"
VIOLATION_UNKNOWN_SLOT = "UNKNOWN_SLOT"

# Extra capacity per slot in "Distribute All" mode. Mirrors
# ``solver.EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL`` (duplicated, no import).
_EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL = 1


@dataclass(frozen=True)
class Violation:
    """A single hard-constraint violation.

    ``context`` carries per-code details so the caller can render a rich
    message without re-parsing the ``message`` string.
    """

    code: str
    message: str
    clinician_id: Optional[str] = None
    date_iso: Optional[str] = None
    slot_id: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ValidationReport:
    violations: List[Violation] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return not self.violations

    def by_code(self) -> Dict[str, List[Violation]]:
        grouped: Dict[str, List[Violation]] = {}
        for v in self.violations:
            grouped.setdefault(v.code, []).append(v)
        return grouped

    def extend(self, more: Iterable[Violation]) -> None:
        self.violations.extend(more)


# ---------------------------------------------------------------------------
# Helpers (duplicated from solver.py to keep this module independent)
# ---------------------------------------------------------------------------


def _parse_time_to_minutes(value: Optional[str]) -> Optional[int]:
    """Parse ``HH:MM`` → minutes from midnight. Mirrors ``solver._parse_time_to_minutes``."""
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def _slot_interval(slot: Any, location_id: str) -> Optional[Tuple[int, int, str]]:
    """Return ``(start_minutes, end_absolute_minutes, location_id)`` for a template slot.

    ``end_absolute_minutes`` accounts for ``endDayOffset`` so overnight slots
    produce positive durations. Mirrors ``solver._build_slot_interval`` but
    returns ``None`` when the slot has no start time (instead of silently
    defaulting — the validator is strict).
    """
    start = _parse_time_to_minutes(getattr(slot, "startTime", None))
    if start is None:
        return None
    end = _parse_time_to_minutes(getattr(slot, "endTime", None))
    if end is None:
        return None
    offset_raw = getattr(slot, "endDayOffset", None)
    offset = offset_raw if isinstance(offset_raw, int) else 0
    total_end = end + max(0, min(3, offset)) * 24 * 60
    if total_end <= start:
        # Zero-duration / malformed — treat as missing so the caller can report
        # it via validate_references rather than as a silent data issue here.
        return None
    return start, total_end, location_id


def _build_slot_lookup(state: AppState) -> Dict[str, Tuple[int, int, str]]:
    """slot_id → (start, end_abs, location) for every slot in the weekly template."""
    template = state.weeklyTemplate
    if template is None:
        return {}
    lookup: Dict[str, Tuple[int, int, str]] = {}
    for template_location in template.locations:
        location_id = (
            template_location.locationId
            if state.locationsEnabled
            else DEFAULT_LOCATION_ID
        )
        for slot in template_location.slots:
            interval = _slot_interval(slot, location_id)
            if interval is not None:
                lookup[slot.id] = interval
    return lookup


def _build_slot_section_map(state: AppState) -> Dict[str, str]:
    """slot_id → section_id. Section comes from the slot's block."""
    template = state.weeklyTemplate
    if template is None:
        return {}
    block_sections = {block.id: block.sectionId for block in (template.blocks or [])}
    mapping: Dict[str, str] = {}
    for template_location in template.locations:
        for slot in template_location.slots:
            section = block_sections.get(slot.blockId)
            if section is not None:
                mapping[slot.id] = section
    return mapping


def _is_on_vacation(clinician: Clinician, date_iso: str) -> bool:
    for vac in clinician.vacations or []:
        if vac.startISO <= date_iso <= vac.endISO:
            return True
    return False


def _day_offset(date_iso: str, origin_iso: str) -> int:
    """Whole-day offset between two ISO dates (can be negative)."""
    origin = datetime.fromisoformat(f"{origin_iso}T00:00:00").date()
    target = datetime.fromisoformat(f"{date_iso}T00:00:00").date()
    return (target - origin).days


def _weekday_key(date_iso: str) -> str:
    """``mon``..``sun`` for an ISO date. Mirrors ``solver._get_weekday_key``."""
    dt = datetime.fromisoformat(f"{date_iso}T00:00:00")
    return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][dt.weekday()]


def _day_type(date_iso: str, state: AppState) -> str:
    """Day type incl. ``holiday``. Mirrors ``solver._get_day_type``."""
    if any(h.dateISO == date_iso for h in state.holidays or []):
        return "holiday"
    return _weekday_key(date_iso)


def _build_slot_day_type_map(state: AppState) -> Dict[str, str]:
    """slot_id → the day type its column band targets (slots without a
    resolvable col band are omitted, matching ``solver._collect_slot_contexts``
    which skips them entirely)."""
    template = state.weeklyTemplate
    if template is None:
        return {}
    mapping: Dict[str, str] = {}
    for template_location in template.locations:
        col_band_by_id = {band.id: band for band in template_location.colBands}
        for slot in template_location.slots:
            col_band = col_band_by_id.get(slot.colBandId)
            if col_band is not None:
                mapping[slot.id] = col_band.dayType
    return mapping


def _mandatory_window(clinician: Clinician, weekday_key: str) -> Optional[Tuple[int, int]]:
    """The clinician's mandatory working window for a weekday, if any.

    Mirrors ``solver._get_clinician_time_window``: entries may be models or raw
    dicts, ``preferred`` normalizes to ``preference``, and windows with missing
    or inverted times count as "no window".
    """
    raw = getattr(clinician, "preferredWorkingTimes", None)
    if not isinstance(raw, dict):
        return None
    entry = raw.get(weekday_key)
    if not entry:
        return None
    if isinstance(entry, dict):
        start_raw = entry.get("startTime")
        end_raw = entry.get("endTime")
        requirement_raw = entry.get("requirement", entry.get("mode", entry.get("status")))
    else:
        start_raw = getattr(entry, "startTime", None)
        end_raw = getattr(entry, "endTime", None)
        requirement_raw = getattr(entry, "requirement", None)
    requirement = requirement_raw.strip().lower() if isinstance(requirement_raw, str) else "none"
    if requirement != "mandatory":
        return None
    start_minutes = _parse_time_to_minutes(start_raw)
    end_minutes = _parse_time_to_minutes(end_raw)
    if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
        return None
    return start_minutes, end_minutes


def _parse_solver_rules(state: AppState) -> List[SolverRule]:
    """Parse ``state.solverRules`` (raw dicts), skipping invalid or disabled entries."""
    rules: List[SolverRule] = []
    for raw in state.solverRules or []:
        try:
            rule = SolverRule.model_validate(raw)
        except Exception:
            continue
        if rule.enabled:
            rules.append(rule)
    return rules


def _resolve_settings(
    state: AppState,
    solver_settings: Optional[SolverSettings],
) -> SolverSettings:
    if solver_settings is not None:
        return solver_settings
    return SolverSettings.model_validate(state.solverSettings or {})


# ---------------------------------------------------------------------------
# Individual validators
# ---------------------------------------------------------------------------


def validate_references(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Clinician and slot IDs must exist in the state.

    Pool rows (``pool-*``) are allowed without a matching template slot: they
    are virtual rows for Rest Day / Vacation tracking, not schedulable slots.
    """
    clinician_ids = {c.id for c in state.clinicians}
    slot_lookup = _build_slot_lookup(state)
    out: List[Violation] = []
    for a in assignments:
        if a.clinicianId not in clinician_ids:
            out.append(
                Violation(
                    code=VIOLATION_UNKNOWN_CLINICIAN,
                    message=f"Unknown clinician id: {a.clinicianId}",
                    clinician_id=a.clinicianId,
                    date_iso=a.dateISO,
                    slot_id=a.rowId,
                )
            )
        if a.rowId.startswith("pool-"):
            continue
        if a.rowId not in slot_lookup:
            out.append(
                Violation(
                    code=VIOLATION_UNKNOWN_SLOT,
                    message=f"Unknown slot id: {a.rowId}",
                    clinician_id=a.clinicianId,
                    date_iso=a.dateISO,
                    slot_id=a.rowId,
                )
            )
    return out


def validate_qualifications(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Each non-pool assignment's section must be in the clinician's qualified list."""
    clinicians_by_id = {c.id: c for c in state.clinicians}
    slot_section = _build_slot_section_map(state)
    out: List[Violation] = []
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        clinician = clinicians_by_id.get(a.clinicianId)
        if clinician is None:
            continue  # caught by validate_references
        section = slot_section.get(a.rowId)
        if section is None:
            continue  # caught by validate_references (unknown slot)
        if section not in (clinician.qualifiedClassIds or []):
            out.append(
                Violation(
                    code=VIOLATION_QUALIFICATION,
                    message=(
                        f"{clinician.name} is not qualified for section {section} "
                        f"(slot {a.rowId} on {a.dateISO})"
                    ),
                    clinician_id=a.clinicianId,
                    date_iso=a.dateISO,
                    slot_id=a.rowId,
                    context={"section_id": section},
                )
            )
    return out


def validate_vacations(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Clinicians on vacation cannot hold slot assignments on those dates.

    Pool rows are exempt: ``pool-vacation`` is the normal way vacation is
    recorded, so flagging those would be circular.
    """
    clinicians_by_id = {c.id: c for c in state.clinicians}
    out: List[Violation] = []
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        clinician = clinicians_by_id.get(a.clinicianId)
        if clinician is None:
            continue
        if _is_on_vacation(clinician, a.dateISO):
            out.append(
                Violation(
                    code=VIOLATION_VACATION,
                    message=(
                        f"{clinician.name} is on vacation on {a.dateISO} "
                        f"but is assigned to slot {a.rowId}"
                    ),
                    clinician_id=a.clinicianId,
                    date_iso=a.dateISO,
                    slot_id=a.rowId,
                )
            )
    return out


def validate_overlaps(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """No overlapping time intervals per clinician.

    Intervals are placed on an absolute minute axis (day-offset from the
    earliest assignment per clinician) so a 22:00–06:00 overnight slot
    correctly overlaps a 00:00–08:00 slot the following day.

    Returns at most one violation per overlapping pair; for N overlapping
    assignments on the same clinician you'll see N-1 violations (consecutive
    sorted pairs), which is enough feedback for a fix loop without spamming.
    """
    slot_intervals = _build_slot_lookup(state)
    by_clinician: Dict[str, List[Assignment]] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        if a.rowId not in slot_intervals:
            continue
        by_clinician.setdefault(a.clinicianId, []).append(a)

    out: List[Violation] = []
    for cid, items in by_clinician.items():
        if len(items) < 2:
            continue
        origin_iso = min(a.dateISO for a in items)
        placed: List[Tuple[int, int, Assignment]] = []
        for a in items:
            start, end, _loc = slot_intervals[a.rowId]
            duration = end - start
            if duration <= 0:
                continue
            day_minutes = _day_offset(a.dateISO, origin_iso) * 24 * 60
            placed.append((start + day_minutes, start + day_minutes + duration, a))
        placed.sort(key=lambda x: x[0])
        for i in range(len(placed) - 1):
            s1, e1, a1 = placed[i]
            s2, _e2, a2 = placed[i + 1]
            if s2 < e1:
                out.append(
                    Violation(
                        code=VIOLATION_OVERLAP,
                        message=(
                            f"Overlap for clinician {cid}: "
                            f"{a1.rowId}@{a1.dateISO} overlaps {a2.rowId}@{a2.dateISO}"
                        ),
                        clinician_id=cid,
                        date_iso=a2.dateISO,
                        slot_id=a2.rowId,
                        context={
                            "other_slot_id": a1.rowId,
                            "other_date_iso": a1.dateISO,
                            "other_assignment_id": a1.id,
                        },
                    )
                )
    return out


def validate_same_location_per_day(
    state: AppState,
    assignments: List[Assignment],
    solver_settings: Optional[SolverSettings] = None,
) -> List[Violation]:
    """When ``enforceSameLocationPerDay`` is on, a clinician's same-day slots must share a location."""
    settings = _resolve_settings(state, solver_settings)
    if not settings.enforceSameLocationPerDay:
        return []
    slot_intervals = _build_slot_lookup(state)
    by_key: Dict[Tuple[str, str], Set[str]] = {}
    first_seen: Dict[Tuple[str, str], Assignment] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        interval = slot_intervals.get(a.rowId)
        if not interval:
            continue
        _s, _e, loc = interval
        if not loc:
            continue
        key = (a.clinicianId, a.dateISO)
        by_key.setdefault(key, set()).add(loc)
        first_seen.setdefault(key, a)
    out: List[Violation] = []
    for (cid, date_iso), locs in by_key.items():
        if len(locs) > 1:
            sample = first_seen[(cid, date_iso)]
            out.append(
                Violation(
                    code=VIOLATION_SAME_LOCATION,
                    message=(
                        f"Clinician {cid} assigned to {len(locs)} different locations "
                        f"on {date_iso}: {sorted(locs)}"
                    ),
                    clinician_id=cid,
                    date_iso=date_iso,
                    slot_id=sample.rowId,
                    context={"locations": sorted(locs)},
                )
            )
    return out


def validate_on_call_rest(
    state: AppState,
    assignments: List[Assignment],
    solver_settings: Optional[SolverSettings] = None,
) -> List[Violation]:
    """Enforce rest days before/after on-call shifts.

    An "on-call" assignment is one whose slot belongs to the section identified
    by ``solver_settings.onCallRestClassId``. When present, the clinician must
    not hold any other non-on-call assignment on the N days before and M days
    after (configured via ``onCallRestDaysBefore`` / ``onCallRestDaysAfter``).

    A second on-call shift within the rest window is allowed (matches the
    solver behaviour — it only blocks *other* work, not back-to-back on-call).
    """
    settings = _resolve_settings(state, solver_settings)
    if not settings.onCallRestEnabled:
        return []
    rest_before = max(0, settings.onCallRestDaysBefore or 0)
    rest_after = max(0, settings.onCallRestDaysAfter or 0)
    if rest_before == 0 and rest_after == 0:
        return []
    if settings.onCallRestClassId is None:
        return []
    slot_section = _build_slot_section_map(state)
    on_call_slot_ids: Set[str] = {
        sid for sid, sec in slot_section.items() if sec == settings.onCallRestClassId
    }
    if not on_call_slot_ids:
        return []

    by_clinician: Dict[str, List[Assignment]] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        by_clinician.setdefault(a.clinicianId, []).append(a)

    out: List[Violation] = []
    for cid, items in by_clinician.items():
        on_call_items = [a for a in items if a.rowId in on_call_slot_ids]
        if not on_call_items:
            continue
        by_date: Dict[str, List[Assignment]] = {}
        for a in items:
            by_date.setdefault(a.dateISO, []).append(a)
        for call in on_call_items:
            base = datetime.fromisoformat(f"{call.dateISO}T00:00:00")
            for direction, count in (("before", rest_before), ("after", rest_after)):
                for offset in range(1, count + 1):
                    delta = -offset if direction == "before" else offset
                    day = (base + timedelta(days=delta)).date().isoformat()
                    clashing = [
                        a
                        for a in by_date.get(day, [])
                        if a.rowId not in on_call_slot_ids
                    ]
                    for clash in clashing:
                        out.append(
                            Violation(
                                code=VIOLATION_ON_CALL_REST,
                                message=(
                                    f"Clinician {cid}: on-call on {call.dateISO} "
                                    f"conflicts with assignment on {day} "
                                    f"(rest day {direction})"
                                ),
                                clinician_id=cid,
                                date_iso=day,
                                slot_id=clash.rowId,
                                context={
                                    "on_call_date": call.dateISO,
                                    "on_call_slot_id": call.rowId,
                                    "direction": direction,
                                },
                            )
                        )
    return out


def validate_mandatory_windows(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Slots must fit entirely inside a clinician's *mandatory* working window.

    Only ``preferredWorkingTimes`` entries with requirement ``mandatory`` are
    hard; ``preference`` entries are a soft objective and ignored here. An
    overnight slot can never fit a same-day window (its absolute end exceeds
    24:00), matching the CP-SAT solver which excludes such variables outright.
    """
    clinicians_by_id = {c.id: c for c in state.clinicians}
    slot_intervals = _build_slot_lookup(state)
    out: List[Violation] = []
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        clinician = clinicians_by_id.get(a.clinicianId)
        if clinician is None:
            continue
        interval = slot_intervals.get(a.rowId)
        if interval is None:
            continue
        window = _mandatory_window(clinician, _weekday_key(a.dateISO))
        if window is None:
            continue
        w_start, w_end = window
        start, end, _loc = interval
        if start < w_start or end > w_end:
            out.append(
                Violation(
                    code=VIOLATION_MANDATORY_WINDOW,
                    message=(
                        f"{clinician.name}: slot {a.rowId} on {a.dateISO} "
                        f"({start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d} abs) "
                        f"is outside the mandatory window "
                        f"{w_start // 60:02d}:{w_start % 60:02d}-{w_end // 60:02d}:{w_end % 60:02d}"
                    ),
                    clinician_id=a.clinicianId,
                    date_iso=a.dateISO,
                    slot_id=a.rowId,
                    context={"window_start": w_start, "window_end": w_end},
                )
            )
    return out


def validate_weekly_hours(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Per ISO week, assigned hours must not exceed contract + tolerance.

    Matches the heuristic solver's hard cap (``ClinicianState.would_exceed_hours``).
    Clinicians without ``workingHoursPerWeek`` are exempt. Weekly totals are
    computed from the assignments *passed in* — the caller controls the scope.
    One violation per (clinician, ISO week).
    """
    clinicians_by_id = {c.id: c for c in state.clinicians}
    slot_intervals = _build_slot_lookup(state)
    minutes_by_week: Dict[Tuple[str, Tuple[int, int]], int] = {}
    first_date_by_week: Dict[Tuple[str, Tuple[int, int]], str] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        interval = slot_intervals.get(a.rowId)
        if interval is None:
            continue
        start, end, _loc = interval
        week = datetime.fromisoformat(f"{a.dateISO}T00:00:00").date().isocalendar()[:2]
        key = (a.clinicianId, week)
        minutes_by_week[key] = minutes_by_week.get(key, 0) + (end - start)
        if key not in first_date_by_week or a.dateISO < first_date_by_week[key]:
            first_date_by_week[key] = a.dateISO

    out: List[Violation] = []
    for (cid, week), minutes in minutes_by_week.items():
        clinician = clinicians_by_id.get(cid)
        if clinician is None:
            continue
        contract = clinician.workingHoursPerWeek
        if not isinstance(contract, (int, float)) or contract <= 0:
            continue
        # Default 5 only when genuinely missing (None); an explicit 0 is a
        # strict cap. Mirrors solver.py / solver_v2.py.
        _tol = clinician.workingHoursToleranceHours
        tolerance = max(0, _tol if _tol is not None else 5)
        max_minutes = (contract + tolerance) * 60
        if minutes > max_minutes:
            out.append(
                Violation(
                    code=VIOLATION_WEEKLY_HOURS,
                    message=(
                        f"{clinician.name}: {minutes / 60:.1f}h assigned in ISO week "
                        f"{week[0]}-W{week[1]:02d} exceeds the limit of "
                        f"{max_minutes / 60:.1f}h ({contract}h contract + {tolerance}h tolerance)"
                    ),
                    clinician_id=cid,
                    date_iso=first_date_by_week[(cid, week)],
                    context={
                        "iso_year": week[0],
                        "iso_week": week[1],
                        "assigned_minutes": minutes,
                        "max_minutes": int(max_minutes),
                    },
                )
            )
    return out


def validate_split_shifts(
    state: AppState,
    assignments: List[Assignment],
    solver_settings: Optional[SolverSettings] = None,
) -> List[Violation]:
    """When ``preferContinuousShifts`` is on, a clinician's same-day slots must
    merge into ONE contiguous time block (adjacent slots count as contiguous).

    Mirrors the heuristic's ``would_create_gap`` interval-merging. Callers that
    tolerate pre-existing manual splits should diff against a baseline report
    rather than expecting zero violations.
    """
    settings = _resolve_settings(state, solver_settings)
    if not settings.preferContinuousShifts:
        return []
    slot_intervals = _build_slot_lookup(state)
    by_key: Dict[Tuple[str, str], List[Tuple[int, int, str]]] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        interval = slot_intervals.get(a.rowId)
        if interval is None:
            continue
        start, end, _loc = interval
        by_key.setdefault((a.clinicianId, a.dateISO), []).append((start, end, a.rowId))

    out: List[Violation] = []
    for (cid, date_iso), items in by_key.items():
        if len(items) < 2:
            continue
        items.sort()
        merged_blocks = 1
        current_end = items[0][1]
        for start, end, _rid in items[1:]:
            if start <= current_end:
                current_end = max(current_end, end)
            else:
                merged_blocks += 1
                current_end = end
        if merged_blocks > 1:
            out.append(
                Violation(
                    code=VIOLATION_SPLIT_SHIFT,
                    message=(
                        f"Clinician {cid} has {merged_blocks} separate work blocks "
                        f"on {date_iso} (continuous shifts are enforced)"
                    ),
                    clinician_id=cid,
                    date_iso=date_iso,
                    slot_id=items[0][2],
                    context={"blocks": merged_blocks, "slot_ids": [rid for _s, _e, rid in items]},
                )
            )
    return out


def validate_capacity(
    state: AppState,
    assignments: List[Assignment],
    *,
    only_fill_required: bool = False,
) -> List[Violation]:
    """Per slot instance ``(slot_id, date)``, the assignment count must not
    exceed capacity.

    Capacity per instance mirrors ``solver._add_coverage_constraints``:
    ``target = requiredSlots + slotOverridesByKey["<slot_id>__<date>"]``; in
    distribute-all mode (``only_fill_required=False``) targeted slots get
    ``+_EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL`` headroom. Instances whose
    slot day type does not match the date's day type are skipped — the solver
    never schedules those, and stray data there is a reference-level concern.
    """
    slot_by_id: Dict[str, Any] = {}
    template = state.weeklyTemplate
    if template is not None:
        for template_location in template.locations:
            for slot in template_location.slots:
                slot_by_id[slot.id] = slot
    slot_day_type = _build_slot_day_type_map(state)

    counts: Dict[Tuple[str, str], int] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        if a.rowId not in slot_by_id:
            continue
        key = (a.rowId, a.dateISO)
        counts[key] = counts.get(key, 0) + 1

    out: List[Violation] = []
    for (slot_id, date_iso), count in counts.items():
        if slot_day_type.get(slot_id) != _day_type(date_iso, state):
            continue
        slot = slot_by_id[slot_id]
        raw_required = getattr(slot, "requiredSlots", 0)
        base_required = raw_required if isinstance(raw_required, int) else 0
        override = state.slotOverridesByKey.get(f"{slot_id}__{date_iso}", 0)
        target = max(0, base_required + override)
        if only_fill_required:
            capacity = target
        else:
            extra = _EXTRA_ASSIGNMENTS_PER_SLOT_DISTRIBUTE_ALL if target > 0 else 0
            capacity = target + extra
        if count > capacity:
            out.append(
                Violation(
                    code=VIOLATION_CAPACITY,
                    message=(
                        f"Slot {slot_id} on {date_iso} has {count} assignments "
                        f"but capacity {capacity} (target {target})"
                    ),
                    date_iso=date_iso,
                    slot_id=slot_id,
                    context={"count": count, "capacity": capacity, "target": target},
                )
            )
    return out


def validate_solver_rules(
    state: AppState,
    assignments: List[Assignment],
) -> List[Violation]:
    """Check the if/then ``SolverRule`` entries (``state.solverRules``).

    Rule semantics: when a clinician works ``ifShiftRowId`` on day D, then on
    day ``D + dayDelta`` they must work ``thenShiftRowId`` (thenType
    ``shiftRow``) or hold no slot assignment at all (thenType ``off``; pool
    rows like Rest Day are fine).

    NOT part of ``validate_assignments``: no solver has ever enforced these
    rules, so existing plans may violate them freely. Callers should treat
    the result as soft feedback.
    """
    rules = _parse_solver_rules(state)
    if not rules:
        return []
    slots_by_clinician_date: Dict[Tuple[str, str], Set[str]] = {}
    for a in assignments:
        if a.rowId.startswith("pool-"):
            continue
        slots_by_clinician_date.setdefault((a.clinicianId, a.dateISO), set()).add(a.rowId)

    out: List[Violation] = []
    for (cid, date_iso), row_ids in sorted(slots_by_clinician_date.items()):
        for rule in rules:
            if rule.ifShiftRowId not in row_ids:
                continue
            then_date = (
                datetime.fromisoformat(f"{date_iso}T00:00:00") + timedelta(days=rule.dayDelta)
            ).date().isoformat()
            then_rows = slots_by_clinician_date.get((cid, then_date), set())
            if rule.thenType == "off":
                if then_rows:
                    out.append(
                        Violation(
                            code=VIOLATION_SOLVER_RULE,
                            message=(
                                f"Rule '{rule.name}': clinician {cid} works "
                                f"{rule.ifShiftRowId} on {date_iso} and must be off "
                                f"on {then_date}, but has {len(then_rows)} assignment(s)"
                            ),
                            clinician_id=cid,
                            date_iso=then_date,
                            slot_id=next(iter(sorted(then_rows))),
                            context={"rule_id": rule.id, "if_date": date_iso},
                        )
                    )
            else:  # shiftRow
                if rule.thenShiftRowId is None:
                    continue
                if rule.thenShiftRowId not in then_rows:
                    out.append(
                        Violation(
                            code=VIOLATION_SOLVER_RULE,
                            message=(
                                f"Rule '{rule.name}': clinician {cid} works "
                                f"{rule.ifShiftRowId} on {date_iso} and must work "
                                f"{rule.thenShiftRowId} on {then_date}, but does not"
                            ),
                            clinician_id=cid,
                            date_iso=then_date,
                            slot_id=rule.thenShiftRowId,
                            context={"rule_id": rule.id, "if_date": date_iso},
                        )
                    )
    return out


# ---------------------------------------------------------------------------
# Aggregated entry point
# ---------------------------------------------------------------------------


def validate_assignments(
    state: AppState,
    assignments: List[Assignment],
    solver_settings: Optional[SolverSettings] = None,
    *,
    skip_references: bool = False,
    only_fill_required: bool = False,
) -> ValidationReport:
    """Run every hard-constraint validator and collect results.

    Parameters
    ----------
    state:
        The full :class:`AppState` (clinicians, weekly template, etc.).
    assignments:
        Candidate assignments to check — can be a complete schedule or any
        subset. Pool-row assignments (``rowId.startswith("pool-")``) are
        intentionally ignored for most checks since they are virtual rows
        (Rest Day / Vacation), not schedulable slots.
    solver_settings:
        Override for the settings embedded in ``state``. Pass this when the
        caller wants to try alternate enforcement flags without mutating
        ``state``.
    skip_references:
        When ``True``, skips the unknown-clinician / unknown-slot checks.
        Useful when you already know references are valid and want to avoid
        the extra work.
    only_fill_required:
        Capacity semantics: when ``True``, slot instances cap at their target
        (required + override); when ``False`` (distribute-all), targeted slots
        get the solver's extra-assignment headroom.

    Returns
    -------
    ValidationReport
        ``report.is_valid`` is ``True`` iff no hard constraints were violated.
        ``validate_solver_rules`` is intentionally NOT included — see its
        docstring; call it separately for soft rule feedback.
    """
    report = ValidationReport()
    if not skip_references:
        report.extend(validate_references(state, assignments))
    report.extend(validate_qualifications(state, assignments))
    report.extend(validate_vacations(state, assignments))
    report.extend(validate_overlaps(state, assignments))
    report.extend(validate_same_location_per_day(state, assignments, solver_settings))
    report.extend(validate_on_call_rest(state, assignments, solver_settings))
    report.extend(validate_mandatory_windows(state, assignments))
    report.extend(validate_weekly_hours(state, assignments))
    report.extend(validate_split_shifts(state, assignments, solver_settings))
    report.extend(validate_capacity(state, assignments, only_fill_required=only_fill_required))
    return report


__all__ = [
    "Violation",
    "ValidationReport",
    "VIOLATION_QUALIFICATION",
    "VIOLATION_VACATION",
    "VIOLATION_OVERLAP",
    "VIOLATION_SAME_LOCATION",
    "VIOLATION_ON_CALL_REST",
    "VIOLATION_MANDATORY_WINDOW",
    "VIOLATION_WEEKLY_HOURS",
    "VIOLATION_SPLIT_SHIFT",
    "VIOLATION_CAPACITY",
    "VIOLATION_SOLVER_RULE",
    "VIOLATION_UNKNOWN_CLINICIAN",
    "VIOLATION_UNKNOWN_SLOT",
    "validate_assignments",
    "validate_references",
    "validate_qualifications",
    "validate_vacations",
    "validate_overlaps",
    "validate_same_location_per_day",
    "validate_on_call_rest",
    "validate_mandatory_windows",
    "validate_weekly_hours",
    "validate_split_shifts",
    "validate_capacity",
    "validate_solver_rules",
]
