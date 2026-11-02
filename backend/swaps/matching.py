"""Swap search: move plans, the two-person gate, warnings, findings and ranking.

A search evaluates many options against one calendar, so it never validates
the whole calendar. The gate validates a *slice*: the stored assignments of
the people a plan touches, in whole ISO weeks around the moved dates plus a
margin of at least seven days (cover adds the co-holders of the covered slot
instance and their Rest Days that day). Everyone else keeps identical
assignments, so their violations cancel between baseline and candidate; the
touched people's rules look at most seven days away; WEEKLY_HOURS sees whole
weeks. Every gate counts the Rest Days a plan holds itself (own_rest_days):
the slice holds every Rest Day entry of the person-days it checks, so a Rest
Day the plan moves away or removes stops counting there as on the whole
calendar. The scoped verdict therefore equals the full-calendar verdict
(test_swap_property.py checks it), and apply re-checks the full calendar
anyway.

Working-time warnings name whole work blocks, which can be longer than any
margin (a holiday stretch of 24 h duties). Their slice widens each person's
window until no block of theirs crosses its edges, so its warnings are the
full calendar's.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import (
    TYPE_CHECKING,
    Any,
    Dict,
    FrozenSet,
    Iterable,
    List,
    Optional,
    Sequence,
    Set,
    Tuple,
)

from fastapi import HTTPException

from ..assignment_policy import REST_DAY_ROW_ID
from ..constraint_policy import classify_violations, resolved_violations
from ..models import AppState, Assignment, Clinician
from ..validation import (
    VIOLATION_CAPACITY,
    VIOLATION_MANDATORY_WINDOW,
    VIOLATION_ON_CALL_REST,
    VIOLATION_OVERLAP,
    VIOLATION_QUALIFICATION,
    VIOLATION_REST_DAY,
    VIOLATION_SAME_LOCATION,
    VIOLATION_SPLIT_SHIFT,
    VIOLATION_UNKNOWN_CLINICIAN,
    VIOLATION_UNKNOWN_SLOT,
    VIOLATION_VACATION,
    VIOLATION_WEEKLY_HOURS,
    Violation,
    _is_on_vacation,
    _parse_time_to_minutes,
    _weekday_key,
    build_validation_context,
    validate_assignments,
    validate_solver_rules,
)
from . import labels, policy
from .blocks import (
    SwapUnit,
    TimedItem,
    UnitError,
    WorkBlock,
    abs_minute,
    blocks_on_date,
    build_blocks,
    instance_unit,
    local_iso,
    slot_fingerprint,
    unit_for,
    visible_items,
)
from .policy import OpenSlotInfo, StartStatus, SwapRules, open_slot, start_status
from .worktime import WorkWarning, iso_week, kept_warnings, new_warnings, person_hours, ytd_deficit_pct

if TYPE_CHECKING:  # schemas is the HTTP layer; the search only reads the request
    from .schemas import AssignmentRefIn, CandidatesRequest, SlotRefIn

PREVIEW_ID_PREFIX = "swp-preview"


def swap_error(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    """An error of the swap endpoints: detail {"code", "message", ...extra}."""
    return HTTPException(status, detail={"code": code, "message": message, **extra})


class SwapContext:
    """Request-scoped indexes over ONE loaded AppState; never reused across requests."""

    def __init__(self, state: AppState, rules: SwapRules, now: datetime) -> None:
        self.state = state
        self.rules = rules
        self.now = now
        self.vctx = build_validation_context(state)
        self.settings = self.vctx.settings
        # All stored assignments of a person, pool and vacation-hidden ones
        # included, sorted by date (stable, so same-day order is the stored one).
        self.by_person: Dict[str, List[Assignment]] = {}
        # Non-pool stored assignments per slot instance (rowId, dateISO).
        self.by_instance: Dict[Tuple[str, str], List[Assignment]] = {}
        # (clinicianId, dateISO) -> every stored Rest Day entry, in stored order.
        self.rest_days: Dict[Tuple[str, str], List[Assignment]] = {}
        for a in state.assignments:
            self.by_person.setdefault(a.clinicianId, []).append(a)
            if a.rowId == REST_DAY_ROW_ID:
                self.rest_days.setdefault((a.clinicianId, a.dateISO), []).append(a)
            elif not a.rowId.startswith("pool-"):
                self.by_instance.setdefault((a.rowId, a.dateISO), []).append(a)
        for assignments in self.by_person.values():
            assignments.sort(key=lambda a: a.dateISO)
        self._dates = {cid: [a.dateISO for a in items] for cid, items in self.by_person.items()}
        self.max_end_offset = max(
            (max(0, min(3, slot.endDayOffset)) for slot in self.vctx.slot_by_id.values()
             if isinstance(slot.endDayOffset, int)),
            default=0,
        )
        self._blocks: Dict[str, List[WorkBlock]] = {}
        self._windows: Dict[Tuple[str, str, str], Tuple[str, str]] = {}
        self._ytd: Dict[str, Dict[str, int]] = {}
        self._row_names = {row.id: row.name for row in state.rows}
        self._location_names = {location.id: location.name for location in state.locations}
        template_blocks = state.weeklyTemplate.blocks if state.weeklyTemplate else []
        self._block_labels = {block.id: block.label for block in template_blocks}

    def person_window(self, clinician_id: str, lo: str, hi: str) -> List[Assignment]:
        """The person's stored assignments with lo <= dateISO <= hi."""
        dates = self._dates.get(clinician_id, [])
        items = self.by_person.get(clinician_id, [])
        return items[bisect_left(dates, lo):bisect_right(dates, hi)]

    def blocks(self, clinician_id: str) -> List[WorkBlock]:
        if clinician_id not in self._blocks:
            items = visible_items(self.vctx, self.by_person.get(clinician_id, []))
            self._blocks[clinician_id] = build_blocks(items)
        return self._blocks[clinician_id]

    def _around(self, clinician_id: str, edge: str) -> Tuple[int, Optional[int]]:
        """(the latest end among the person's items dated before ``edge``, the
        start of their first item dated ``edge`` or later). An item ends before
        the midnight max_end_offset days after its date, so only the items that
        close to ``edge`` count; without one the end is 0."""
        day, reach_days = date.fromisoformat(edge), self.max_end_offset
        near = visible_items(self.vctx, self.person_window(clinician_id, _shifted(day, -reach_days),
                                                           _shifted(day, reach_days - 1)))
        reach = 0
        for item in near:
            if item.date_iso >= edge:
                return reach, item.abs_start
            reach = max(reach, item.abs_end)
        return reach, None

    def _crosses(self, clinician_id: str, edge: str) -> bool:
        """Whether a block of the person has items dated before ``edge`` and
        from ``edge`` on: its first item from ``edge`` on starts by the latest
        end of the items before."""
        reach, start = self._around(clinician_id, edge)
        return start is not None and start <= reach

    def _ends_after(self, clinician_id: str, day: str) -> bool:
        """Whether a block of the person with items dated ``day`` or earlier
        ends after ``day``."""
        next_day = _shifted(date.fromisoformat(day), 1)
        reach, start = self._around(clinician_id, next_day)
        return reach > abs_minute(next_day, 0) or (start is not None and start <= reach)

    def whole_block_window(self, clinician_id: str, lo: str, hi: str) -> Tuple[str, str]:
        """[lo, hi] widened until no block of the person has items dated on
        both sides of lo, and none with items dated up to hi ends after hi.
        Every block with an item in the window then lies in it whole, and so
        does the shift that starts on the day one of them ends (no free day
        after a night). The edges move a day at a time: every day between an
        edge and the far end of the block it cuts is cut by that block too."""
        key = (clinician_id, lo, hi)
        if key not in self._windows:
            first_day, last_day = date.min.isoformat(), date.max.isoformat()
            while lo > first_day and self._crosses(clinician_id, lo):
                lo = _shifted(date.fromisoformat(lo), -1)
            while hi < last_day and self._ends_after(clinician_id, hi):
                hi = _shifted(date.fromisoformat(hi), 1)
            self._windows[key] = (lo, hi)
        return self._windows[key]

    def clinician(self, clinician_id: str) -> Clinician:
        return self.vctx.clinicians_by_id[clinician_id]

    def name(self, clinician_id: str) -> str:
        clinician = self.vctx.clinicians_by_id.get(clinician_id)
        return clinician.name if clinician is not None else clinician_id

    def row_name(self, row_id: str) -> Optional[str]:
        return self._row_names.get(row_id)

    def section_name(self, section_id: str) -> str:
        return self._row_names.get(section_id, section_id)

    def location_name(self, location_id: str) -> Optional[str]:
        return self._location_names.get(location_id)

    def slot_label(self, slot_id: str) -> Optional[str]:
        slot = self.vctx.slot_by_id.get(slot_id)
        label = self._block_labels.get(slot.blockId) if slot is not None else None
        return (label.strip() or None) if label else None

    def ytd_pct(self, date_iso: str) -> Dict[str, int]:
        """Year-to-date hours deficit in percent per clinician with a contract
        (positive = behind), counted from the calendar's first planned date."""
        if date_iso not in self._ytd:
            self._ytd[date_iso] = ytd_deficit_pct(self.vctx, date_iso)
        return self._ytd[date_iso]


# --- Move plans -------------------------------------------------------------


@dataclass
class RestDayMove:
    from_id: str
    to_id: str
    date_iso: str
    # Every stored Rest Day entry of the giver that day: the move takes them
    # all, so the giver keeps none and undo finds none left behind.
    entries: Tuple[Assignment, ...]


@dataclass
class MovePlan:
    mode: str  # "swap" | "handover" | "cover"
    giver_id: Optional[str]  # A; None for cover
    partner_id: str  # B
    give: SwapUnit  # X; cover: the synthetic unit of the instance
    take: Optional[SwapUnit]  # Y (swap only)
    cover: Optional[OpenSlotInfo]
    rest_day_moves: List[RestDayMove]
    # The takers' own Rest Day entries on the dates of the items they receive.
    rest_day_removals: List[Assignment]
    hidden_removal: Optional[Assignment]  # cover: the vacation-hidden holder's assignment
    removed: List[Assignment]  # stored objects leaving the plan (identity matters)
    added: List[Assignment]
    persons: FrozenSet[str]  # A, B, and the hidden holder when removed
    moved_dates: Tuple[str, ...]
    touched_instances: FrozenSet[Tuple[str, str]]


def _receipts(plan: MovePlan) -> List[Tuple[str, SwapUnit]]:
    """(taker, unit): B receives X or the cover item; in a swap A receives Y."""
    receipts = [(plan.partner_id, plan.give)]
    if plan.take is not None and plan.giver_id is not None:
        receipts.append((plan.giver_id, plan.take))
    return receipts


def build_move_plan(
    ctx: SwapContext,
    mode: str,
    give: SwapUnit,
    partner_id: str,
    *,
    take: Optional[SwapUnit] = None,
    cover: Optional[OpenSlotInfo] = None,
    rest_day_moves: Sequence[RestDayMove] = (),
    hidden_removal: Optional[Assignment] = None,
    id_prefix: str = PREVIEW_ID_PREFIX,
) -> MovePlan:
    """The exact change: every item of X goes to B (and of Y to A) as a new
    locked manual assignment; ids must be unique within the calendar because
    validate_on_call_rest tells assignments apart by id."""
    giver_id = give.clinician_id
    removed: List[Assignment] = []
    added: List[Assignment] = []

    def hand_over(unit: SwapUnit, to_id: str) -> None:
        for item in unit.items:
            if item.assignment is not None:
                removed.append(item.assignment)
            added.append(Assignment(id=f"{id_prefix}-{len(added)}", rowId=item.slot_id, dateISO=item.date_iso,
                                    clinicianId=to_id, source="manual", locked=True))

    hand_over(give, partner_id)
    if take is not None and giver_id is not None:
        hand_over(take, giver_id)
    if hidden_removal is not None:
        removed.append(hidden_removal)
    for k, move in enumerate(rest_day_moves):
        removed.extend(move.entries)
        # One Rest Day for the taker, however many entries the giver had.
        # Pool rows carry no lock, as when a Rest Day is entered by hand.
        added.append(Assignment(id=f"{id_prefix}-rest-{k}", rowId=REST_DAY_ROW_ID, dateISO=move.date_iso,
                                clinicianId=move.to_id, source="manual", locked=False))
    persons = {partner_id}
    if giver_id is not None:
        persons.add(giver_id)
    if hidden_removal is not None:
        persons.add(hidden_removal.clinicianId)
    units = [give] if take is None else [give, take]
    plan = MovePlan(
        mode=mode,
        giver_id=giver_id,
        partner_id=partner_id,
        give=give,
        take=take,
        cover=cover,
        rest_day_moves=list(rest_day_moves),
        rest_day_removals=[],
        hidden_removal=hidden_removal,
        removed=removed,
        added=added,
        persons=frozenset(persons),
        moved_dates=tuple(sorted({item.date_iso for unit in units for item in unit.items})),
        touched_instances=frozenset(key for unit in units for key in unit.instance_keys),
    )
    plan.rest_day_removals = rest_day_removals(ctx, plan)
    plan.removed.extend(plan.rest_day_removals)
    return plan


def apply_plan(assignments: Sequence[Assignment], plan: MovePlan) -> List[Assignment]:
    """``assignments`` without the plan's removed objects (by identity, not
    equality), plus every added one."""
    removed = {id(a) for a in plan.removed}
    return [a for a in assignments if id(a) not in removed] + plan.added


def detect_rest_day_moves(
    ctx: SwapContext,
    giver_id: str,
    taker_id: str,
    unit: SwapUnit,
    taker_after: Sequence[Assignment],
) -> List[RestDayMove]:
    """The giver's Rest Days that belong to the given unit (the day after a
    night, the on-call rest days after an on-call) and can follow it to the
    taker: the taker neither rests nor works that day after the work moves. As
    for the REST_DAY rule, any stored shift is work, one hidden by a vacation
    or without valid times too. A move takes every entry of its day, as a
    removal does."""
    follow = {block.end_date_iso for block in unit.blocks if block.overnight}
    settings = ctx.settings
    days_after = max(0, settings.onCallRestDaysAfter or 0)
    if settings.onCallRestEnabled and settings.onCallRestClassId and days_after > 0:
        for item in unit.items:
            if item.section_id == settings.onCallRestClassId:
                start = date.fromisoformat(item.date_iso)
                follow.update((start + timedelta(days=k)).isoformat() for k in range(1, days_after + 1))
    days = [day for day in sorted(follow)
            if (giver_id, day) in ctx.rest_days and (taker_id, day) not in ctx.rest_days]
    if not days:
        return []
    working = {a.dateISO for a in taker_after
               if a.dateISO in days and a.clinicianId == taker_id and not a.rowId.startswith("pool-")}
    return [RestDayMove(giver_id, taker_id, day, tuple(ctx.rest_days[(giver_id, day)]))
            for day in days if day not in working]


def detected_rest_day_moves(ctx: SwapContext, plan: MovePlan) -> List[RestDayMove]:
    """Every rest-day move of a plan's work moves: X from A to B, in a swap also
    Y from B to A. A cover has no giver, so nothing follows it."""
    if plan.giver_id is None:
        return []
    flows = [(plan.giver_id, plan.partner_id, plan.give)]
    if plan.take is not None:
        flows.append((plan.partner_id, plan.giver_id, plan.take))
    moves: Dict[Tuple[str, str, str], RestDayMove] = {}
    for giver_id, taker_id, unit in flows:
        after = apply_plan(ctx.by_person.get(taker_id, []), plan)
        for move in detect_rest_day_moves(ctx, giver_id, taker_id, unit, after):
            moves.setdefault((move.from_id, move.to_id, move.date_iso), move)
    return list(moves.values())


def rest_day_removals(ctx: SwapContext, plan: MovePlan) -> List[Assignment]:
    """The takers' own Rest Day entries on the date of an item they receive,
    every one of them, removed as when a shift is added by hand. The end date
    of a received night does not count: a shift counts on its start date, and
    a Rest Day there is the normal free day after it."""
    moved = {id(entry) for move in plan.rest_day_moves for entry in move.entries}
    found: Dict[int, Assignment] = {}
    for taker_id, unit in _receipts(plan):
        for item in unit.items:
            for entry in ctx.rest_days.get((taker_id, item.date_iso), ()):
                if id(entry) not in moved:
                    found.setdefault(id(entry), entry)
    return sorted(found.values(), key=lambda a: (a.dateISO, a.clinicianId))


def rest_day_removal_days(ctx: SwapContext, plan: MovePlan) -> List[Dict[str, str]]:
    """The plan's Rest Day removals as the preview and History name them: one
    per person-day, though every duplicate entry of that day goes."""
    days = sorted({(a.dateISO, a.clinicianId) for a in plan.rest_day_removals})
    return [{"clinicianId": clinician_id, "name": ctx.name(clinician_id), "dateISO": date_iso}
            for date_iso, clinician_id in days]


def plan_option(
    ctx: SwapContext,
    mode: str,
    give: SwapUnit,
    partner_id: str,
    *,
    take: Optional[SwapUnit] = None,
    cover: Optional[OpenSlotInfo] = None,
    hidden_removal: Optional[Assignment] = None,
) -> MovePlan:
    """The plan the search evaluates: the work moves with every detected rest-day move."""
    plan = build_move_plan(ctx, mode, give, partner_id, take=take, cover=cover, hidden_removal=hidden_removal)
    moves = detected_rest_day_moves(ctx, plan)
    if not moves:
        return plan
    return build_move_plan(ctx, mode, give, partner_id, take=take, cover=cover, rest_day_moves=moves,
                           hidden_removal=hidden_removal)


# --- Pre-filters and the gate -----------------------------------------------


def prefilter(ctx: SwapContext, plan: MovePlan) -> List[Tuple[str, str]]:
    """Cheap failures, each of which the gate would also report: [(reason code, message)]."""
    received = [(ctx.clinician(taker_id), item) for taker_id, unit in _receipts(plan) for item in unit.items]
    removed = {id(a) for a in plan.removed}
    failures: List[Tuple[str, str]] = []

    def fail(code: str, message: str) -> None:
        if (code, message) not in failures:
            failures.append((code, message))

    for taker, item in received:
        if item.section_id and item.section_id not in (taker.qualifiedClassIds or []):
            fail("not_qualified", labels.not_qualified(taker.name, ctx.section_name(item.section_id)))
    for taker, item in received:
        if _is_on_vacation(taker, item.date_iso):
            fail("on_vacation", labels.on_vacation(taker.name, item.date_iso))
    for taker, item in received:
        holders = ctx.by_instance.get(item.instance_key, [])
        if any(a.clinicianId == taker.id and id(a) not in removed for a in holders):
            fail("already_assigned",
                 labels.already_assigned(taker.name, ctx.section_name(item.section_id), item.date_iso))
    return failures


def _shifted(day: date, days: int) -> str:
    """``day`` plus ``days``, kept inside the calendar's date range."""
    return date.fromordinal(min(max(day.toordinal() + days, 1), date.max.toordinal())).isoformat()


def slice_window(ctx: SwapContext, dates: Iterable[str]) -> Tuple[str, str]:
    """Whole ISO weeks of the dates, widened by every rule's reach (at least 7 days)."""
    settings = ctx.settings
    margin = max(7, settings.onCallRestDaysBefore or 0, settings.onCallRestDaysAfter or 0,
                 ctx.max_end_offset + 1)
    ordered = sorted(dates)
    first, last = date.fromisoformat(ordered[0]), date.fromisoformat(ordered[-1])
    return _shifted(first, -(first.weekday() + margin)), _shifted(last, 6 - last.weekday() + margin)


def _slice(ctx: SwapContext, plan: MovePlan, lo: str, hi: str) -> List[Assignment]:
    base = [a for cid in sorted(plan.persons) for a in ctx.person_window(cid, lo, hi)]
    if plan.mode == "cover":
        # Cover changes the instance's count, so CAPACITY must see its
        # co-holders; REST_DAY then sees their Rest Days that day as well.
        seen = {id(a) for a in base}
        for key in sorted(plan.touched_instances):
            for a in ctx.by_instance.get(key, []):
                for entry in [a, *ctx.rest_days.get((a.clinicianId, a.dateISO), ())]:
                    if id(entry) not in seen:
                        seen.add(id(entry))
                        base.append(entry)
    return base


def slice_of(ctx: SwapContext, plan: MovePlan) -> List[Assignment]:
    """The stored assignments the gate validates for a plan (pool rows included)."""
    lo, hi = slice_window(ctx, plan.moved_dates)
    return _slice(ctx, plan, lo, hi)


BaselineCache = Dict[Tuple[Any, ...], List[Violation]]


def scoped_gate(
    ctx: SwapContext,
    plan: MovePlan,
    cache: Optional[BaselineCache] = None,
) -> Tuple[List[Violation], List[Violation]]:
    """(new_or_worse, carried_over) on the plan's slice. ``cache`` (one per
    search) keeps baseline validations: a swap or handover slice depends only
    on the people and the window, so all Y blocks of one partner in one week
    share a baseline."""
    lo, hi = slice_window(ctx, plan.moved_dates)
    base = _slice(ctx, plan, lo, hi)
    key: Tuple[Any, ...] = (plan.mode, plan.persons, lo, hi)
    if plan.mode == "cover":
        key += (plan.touched_instances,)
    baseline = cache.get(key) if cache is not None else None
    if baseline is None:
        baseline = validate_assignments(ctx.state, base, skip_references=True, only_fill_required=True,
                                        context=ctx.vctx, own_rest_days=True).violations
        if cache is not None:
            cache[key] = baseline
    return classify_violations(ctx.state, base, apply_plan(base, plan), only_fill_required=True,
                               skip_references=True, context=ctx.vctx, baseline_violations=baseline,
                               own_rest_days=True)


def scoped_new_violations(ctx: SwapContext, plan: MovePlan,
                          cache: Optional[BaselineCache] = None) -> List[Violation]:
    return scoped_gate(ctx, plan, cache)[0]


def full_gate(state: AppState, plan: MovePlan) -> Tuple[List[Violation], List[Violation]]:
    """The apply gate: the whole calendar, references checked, no context.
    Returns (new or worse violations, the calendar's violations the plan
    resolves or eases). Undo may bring the latter back: they existed before."""
    baseline = validate_assignments(state, state.assignments, only_fill_required=True,
                                    own_rest_days=True).violations
    new, carried = classify_violations(state, state.assignments, apply_plan(state.assignments, plan),
                                       only_fill_required=True, baseline_violations=baseline,
                                       own_rest_days=True)
    return new, resolved_violations(baseline, new + carried)


# --- Warnings, pre-existing problems, findings and hours --------------------

_CARRIED_CHECKS = {
    VIOLATION_REST_DAY: "rest_day",
    VIOLATION_OVERLAP: "overlap",
    VIOLATION_SAME_LOCATION: "same_location",
    VIOLATION_ON_CALL_REST: "on_call_rest",
    VIOLATION_MANDATORY_WINDOW: "mandatory_window",
    VIOLATION_WEEKLY_HOURS: "weekly_hours",
    VIOLATION_SPLIT_SHIFT: "split_shift",
    VIOLATION_CAPACITY: "capacity",
}


def _names(ctx: SwapContext, plan: MovePlan) -> Dict[str, str]:
    return {cid: ctx.name(cid) for cid in plan.persons}


def _scoped_before(ctx: SwapContext, plan: MovePlan, scope: str) -> List[Assignment]:
    return slice_of(ctx, plan) if scope == "slice" else ctx.state.assignments


def _warning_before(ctx: SwapContext, plan: MovePlan, scope: str) -> List[Assignment]:
    """The assignments the warnings are computed on: on the slice, each
    person's window widened to whole blocks. The change only touches the moved
    dates, deep inside the window, so the blocks in it are whole after the
    change too."""
    if scope != "slice":
        return ctx.state.assignments
    lo, hi = slice_window(ctx, plan.moved_dates)
    return [a for cid in sorted(plan.persons)
            for a in ctx.person_window(cid, *ctx.whole_block_window(cid, lo, hi))]


def plan_warnings(ctx: SwapContext, plan: MovePlan, *, scope: str) -> List[WorkWarning]:
    """New working-time warnings of the plan's people; ``scope`` is "slice"
    (search) or "full" (apply). Both scopes give the same warnings."""
    before = _warning_before(ctx, plan, scope)
    return new_warnings(ctx.vctx, ctx.rules, before, apply_plan(before, plan), sorted(plan.persons),
                        _names(ctx, plan))


def plan_kept_warnings(ctx: SwapContext, plan: MovePlan, *, scope: str) -> List[WorkWarning]:
    """Working-time warnings the plan's people have before and after the change.
    The slice gives those of the full calendar that lie in the window."""
    before = _warning_before(ctx, plan, scope)
    return kept_warnings(ctx.vctx, ctx.rules, before, apply_plan(before, plan), sorted(plan.persons),
                         _names(ctx, plan))


def preexisting_checks(
    ctx: SwapContext,
    plan: MovePlan,
    carried: Sequence[Violation],
    kept: Sequence[WorkWarning],
) -> List[str]:
    """Check codes the plan's people already break in a touched ISO week without
    the change making it worse. QUALIFICATION and VACATION never count: their
    checks only speak about the moved shifts, and a vacation-hidden shift is
    the normal state after a vacation is entered."""
    weeks = {iso_week(d) for d in plan.moved_dates}
    found: Set[str] = set()
    for v in carried:
        check = _CARRIED_CHECKS.get(v.code)
        if check is None:
            continue
        if v.code == VIOLATION_CAPACITY:
            if (v.slot_id, v.date_iso) in plan.touched_instances:
                found.add(check)
        elif v.clinician_id in plan.persons and v.date_iso and iso_week(v.date_iso) in weeks:
            found.add(check)
    found.update(w.check for w in kept if w.clinician_id in plan.persons and iso_week(w.date_iso) in weeks)
    return [check["code"] for check in labels.check_list(ctx.settings, ctx.rules, plan.mode)
            if check["code"] in found]


def _rule_key(v: Violation) -> Tuple[Any, ...]:
    return (v.code, v.clinician_id, v.date_iso, v.slot_id, v.context.get("rule_id"), v.context.get("if_date"))


def solver_rule_hits(ctx: SwapContext, plan: MovePlan, *, scope: str) -> List[Violation]:
    """New solver-rule hits of the plan's people ("slice" with the context, or "full")."""
    if not ctx.vctx.solver_rules:
        return []
    before = _scoped_before(ctx, plan, scope)
    context = ctx.vctx if scope == "slice" else None

    def hits(assignments: List[Assignment]) -> List[Violation]:
        return [v for v in validate_solver_rules(ctx.state, assignments, context=context)
                if v.clinician_id in plan.persons]

    known = {_rule_key(v) for v in hits(before)}
    return [v for v in hits(apply_plan(before, plan)) if _rule_key(v) not in known]


def preference_window(clinician: Clinician, weekday_key: str) -> Optional[Tuple[int, int]]:
    """The clinician's preferred (soft) working window on a weekday, read like
    solver._get_clinician_time_window ("preferred" means "preference"); None
    without one."""
    raw = getattr(clinician, "preferredWorkingTimes", None)
    if not isinstance(raw, dict):
        return None
    entry = raw.get(weekday_key)
    if not entry:
        return None
    if isinstance(entry, dict):
        start_raw, end_raw = entry.get("startTime"), entry.get("endTime")
        requirement_raw = entry.get("requirement", entry.get("mode", entry.get("status")))
    else:
        start_raw, end_raw = getattr(entry, "startTime", None), getattr(entry, "endTime", None)
        requirement_raw = getattr(entry, "requirement", None)
    requirement = requirement_raw.strip().lower() if isinstance(requirement_raw, str) else "none"
    if requirement not in ("preference", "preferred"):
        return None
    start, end = _parse_time_to_minutes(start_raw), _parse_time_to_minutes(end_raw)
    if start is None or end is None or end <= start:
        return None
    return start, end


def _fits_window(ctx: SwapContext, item: TimedItem, window: Tuple[int, int]) -> bool:
    start, end, _location = ctx.vctx.slot_lookup[item.slot_id]
    return start >= window[0] and end <= window[1]


def _contract(clinician: Clinician) -> Optional[float]:
    hours = clinician.workingHoursPerWeek
    return hours if isinstance(hours, (int, float)) and hours > 0 else None


def _section_rank(prefs: Sequence[str], section_id: str) -> int:
    return prefs.index(section_id) if section_id in prefs else len(prefs)


def _finding(code: str, clinician_id: str, note: labels.Note) -> Dict[str, Any]:
    return {"code": code, "clinicianId": clinician_id, "message": note.message, "short": note.short}


def soft_findings(ctx: SwapContext, plan: MovePlan, hours: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Amber notes that need no acknowledgement. Receivers: B for X or the
    cover item, A for Y."""
    findings: List[Dict[str, Any]] = []

    def add(code: str, clinician_id: str, note: labels.Note) -> None:
        finding = _finding(code, clinician_id, note)
        if finding not in findings:
            findings.append(finding)

    # A receiver's Rest Day is a day off placed by hand: the option removes it
    # (as adding a shift by hand does), so it is never a best match, just as
    # the person picker lists such a person after those without a warning.
    for removal in rest_day_removal_days(ctx, plan):
        add("rest_day_removed", removal["clinicianId"],
            labels.rest_day_removed(removal["name"], removal["dateISO"]))
    rule_names = {rule.id: rule.name for rule in ctx.vctx.solver_rules}
    for v in solver_rule_hits(ctx, plan, scope="slice"):
        if v.clinician_id is not None and v.date_iso is not None:
            rule_name = rule_names.get(v.context.get("rule_id", ""), "")
            add("solver_rule", v.clinician_id,
                labels.solver_rule(ctx.name(v.clinician_id), rule_name, v.date_iso))
    received = [(ctx.clinician(taker_id), item) for taker_id, unit in _receipts(plan) for item in unit.items]
    for receiver, item in received:
        weekday = _weekday_key(item.date_iso)
        window = preference_window(receiver, weekday)
        if window is not None and not _fits_window(ctx, item, window):
            add("preference_window", receiver.id, labels.preference_window(receiver.name, *window, weekday))
    for receiver, item in received:
        weekday = _weekday_key(item.date_iso)
        if receiver.workPattern is not None and weekday in receiver.workPattern.preferredDaysOff:
            add("preferred_day_off", receiver.id, labels.preferred_day_off(receiver.name, weekday))
    for taker_id, unit in _receipts(plan):
        receiver = ctx.clinician(taker_id)
        prefs = receiver.preferredClassIds or []
        rank = _section_rank(prefs, unit.primary_section)
        # What the receiver gives in exchange: B gives Y in a swap, A gives X.
        traded = plan.take if taker_id == plan.partner_id else plan.give
        if len(prefs) >= 3 and rank >= 2 and (
                traded is None or rank > _section_rank(prefs, traded.primary_section)):
            add("section_preference", receiver.id,
                labels.section_preference(receiver.name, ctx.section_name(unit.primary_section)))
    weeks_of = {person["clinicianId"]: person["weeks"] for person in hours}
    for taker_id, _unit in _receipts(plan):
        contract = _contract(ctx.clinician(taker_id))
        if contract is None:
            continue
        for week in weeks_of[taker_id]:
            if week["afterMinutes"] > max(week["contractMinutes"], week["beforeMinutes"]):
                add("hours_above_contract", taker_id, labels.hours_above_contract(
                    ctx.name(taker_id), week["isoWeek"], week["afterMinutes"], contract))
    if plan.mode == "swap" and plan.take is not None:
        status = start_status(plan.take.abs_start, ctx.rules, ctx.now)
        if status.inside_notice:
            add("partner_notice", plan.partner_id, labels.partner_notice(
                ctx.name(plan.partner_id), status.hours_until, ctx.rules.notice_hours))
    return findings


def plan_hours(ctx: SwapContext, plan: MovePlan) -> List[Dict[str, Any]]:
    """Weekly hours before and after of A and B (cover: B) in the touched ISO
    weeks, counted like validate_weekly_hours (vacation-hidden shifts too)."""
    weeks = {iso_week(d) for d in plan.moved_dates}
    shown = [plan.partner_id] if plan.giver_id is None else [plan.giver_id, plan.partner_id]
    return [
        person_hours(ctx.vctx, ctx.clinician(cid), ctx.by_person.get(cid, []),
                     apply_plan(ctx.by_person.get(cid, []), plan), weeks)
        for cid in shown
    ]


def target_findings(ctx: SwapContext, mode: str, give: SwapUnit) -> List[Dict[str, Any]]:
    """Amber notes that hold for every option of a search, so they are shown
    once. In a handover the giver always loses X's hours: one note per touched
    ISO week in which a giver with contract hours drops below
    min(contract, before). Swap and cover have none."""
    giver_id = give.clinician_id
    if mode != "handover" or giver_id is None:
        return []
    giver = ctx.clinician(giver_id)
    contract = _contract(giver)
    if contract is None:
        return []
    # Every option of a handover takes exactly X's items from A, so these are
    # the numbers of A's hours card in each option's preview.
    before = ctx.by_person.get(giver_id, [])
    given = {id(item.assignment) for item in give.items}
    hours = person_hours(ctx.vctx, giver, before, [a for a in before if id(a) not in given],
                         {iso_week(item.date_iso) for item in give.items})
    return [
        _finding("giver_below_contract", giver_id,
                 labels.giver_below_contract(giver.name, week["isoWeek"], week["afterMinutes"], contract))
        for week in hours["weeks"]
        if week["afterMinutes"] < min(week["contractMinutes"], week["beforeMinutes"])
    ]


# --- Reasons ----------------------------------------------------------------

_REASON_PRIORITY = (
    VIOLATION_QUALIFICATION,
    VIOLATION_VACATION,
    VIOLATION_REST_DAY,
    VIOLATION_OVERLAP,
    VIOLATION_ON_CALL_REST,
    VIOLATION_MANDATORY_WINDOW,
    VIOLATION_SAME_LOCATION,
    VIOLATION_SPLIT_SHIFT,
    VIOLATION_WEEKLY_HOURS,
    VIOLATION_CAPACITY,
)

ItemKey = Tuple[str, str, str]  # (rowId, dateISO, clinicianId)


def new_item_keys(assignments: Iterable[Assignment]) -> Set[ItemKey]:
    """The moved or restored work items of a change, to tell them apart in reasons."""
    return {(a.rowId, a.dateISO, a.clinicianId) for a in assignments if not a.rowId.startswith("pool-")}


def _slot_section_name(ctx: SwapContext, slot_id: str) -> str:
    return ctx.section_name(ctx.vctx.slot_sections.get(slot_id, ""))


def _shift(ctx: SwapContext, slot_id: str, date_iso: str) -> labels.Shift:
    start, end, _location = ctx.vctx.slot_lookup[slot_id]
    begin = abs_minute(date_iso, start)
    return labels.Shift(_slot_section_name(ctx, slot_id), date_iso, local_iso(begin),
                        local_iso(begin + end - start))


def _vacation_hidden(ctx: SwapContext, clinician_id: Optional[str], date_iso: str) -> bool:
    """Whether the person's stored shifts on that day are hidden by a vacation:
    the validators still count them, the grid shows their slot as open."""
    clinician = ctx.vctx.clinicians_by_id.get(clinician_id) if clinician_id is not None else None
    return clinician is not None and _is_on_vacation(clinician, date_iso)


def _reason(ctx: SwapContext, v: Violation, new_items: Set[ItemKey]) -> Tuple[str, str]:
    name = ctx.name(v.clinician_id) if v.clinician_id is not None else ""
    details = v.context or {}
    day = v.date_iso or ""
    if v.code == VIOLATION_QUALIFICATION:
        return "not_qualified", labels.not_qualified(name, ctx.section_name(details.get("section_id", "")))
    if v.code == VIOLATION_VACATION:
        return "on_vacation", labels.on_vacation(name, day)
    if v.code == VIOLATION_REST_DAY:
        return "rest_day", labels.rest_day(name, day)
    if v.code == VIOLATION_OVERLAP:
        this = (v.slot_id or "", day)
        other = (details.get("other_slot_id", ""), details.get("other_date_iso", ""))
        this_new = (*this, v.clinician_id) in new_items
        if this_new and (*other, v.clinician_id) in new_items:
            # Both shifts are new for the person: a unit that already overlapped itself.
            first, second = sorted((_shift(ctx, *other), _shift(ctx, *this)), key=lambda s: s.start_local)
            return "overlap", labels.overlap_received(name, first, second)
        # Name the shift the person already works: the pair's other item when this one is new.
        shift = _shift(ctx, *(other if this_new else this))
        if _vacation_hidden(ctx, v.clinician_id, shift.date_iso):
            return "overlap", labels.hidden_overlap(name, shift.section, shift.date_iso, shift.start_local,
                                                    shift.end_local)
        return "overlap", labels.overlap(name, shift.section, shift.date_iso, shift.start_local,
                                         shift.end_local)
    if v.code == VIOLATION_ON_CALL_REST:
        call_date = details.get("on_call_date", "")
        if (details.get("on_call_slot_id"), call_date, v.clinician_id) in new_items:
            # The on-call is new; the clash is a stored shift unless it is new too.
            if ((v.slot_id or "", day, v.clinician_id) not in new_items
                    and _vacation_hidden(ctx, v.clinician_id, day)):
                return "on_call_rest", labels.hidden_rest_clash(name, _slot_section_name(ctx, v.slot_id or ""),
                                                                day)
            return "on_call_rest", labels.on_call_rest_works(name, day)
        if _vacation_hidden(ctx, v.clinician_id, call_date):
            return "on_call_rest", labels.hidden_on_call(name, call_date)
        return "on_call_rest", labels.on_call_rest_on_call(name, call_date)
    if v.code == VIOLATION_MANDATORY_WINDOW:
        return "mandatory_window", labels.mandatory_window(
            name, details["window_start"], details["window_end"], _weekday_key(day))
    if v.code == VIOLATION_SAME_LOCATION:
        return "same_location", labels.same_location(name, day)
    if v.code == VIOLATION_SPLIT_SHIFT:
        return "split_shift", labels.split_shift(name, day)
    if v.code == VIOLATION_WEEKLY_HOURS:
        return "weekly_hours", labels.weekly_hours(name, details["iso_week"], details["assigned_minutes"],
                                                   details["max_minutes"])
    if v.code == VIOLATION_CAPACITY:
        return "capacity", labels.capacity(_slot_section_name(ctx, v.slot_id or ""), day)
    # The reference checks run on the full calendar only; their messages name raw ids.
    if v.code == VIOLATION_UNKNOWN_CLINICIAN:
        return "unknown_person", labels.PERSON_GONE
    if v.code == VIOLATION_UNKNOWN_SLOT:
        return "unknown_slot", labels.unknown_slot(day)
    return "rule", v.message


def ranked_reasons(
    ctx: SwapContext,
    violations: Sequence[Violation],
    *,
    partner_id: Optional[str],
    new_items: Set[ItemKey],
) -> List[Tuple[str, str]]:
    """(code, message) per violation, most important first and without
    duplicates: by rule priority, then the partner's before others', then date."""
    def order(v: Violation) -> Tuple[int, int, str]:
        priority = _REASON_PRIORITY.index(v.code) if v.code in _REASON_PRIORITY else len(_REASON_PRIORITY)
        return priority, 0 if v.clinician_id == partner_id else 1, v.date_iso or ""

    reasons: List[Tuple[str, str]] = []
    for v in sorted(violations, key=order):
        reason = _reason(ctx, v, new_items)
        if reason not in reasons:
            reasons.append(reason)
    return reasons


def reason_for(ctx: SwapContext, plan: MovePlan, violations: Sequence[Violation]) -> Tuple[str, str]:
    """The one reason shown for a gate-blocked option."""
    return ranked_reasons(ctx, violations, partner_id=plan.partner_id, new_items=new_item_keys(plan.added))[0]


# --- JSON shapes ------------------------------------------------------------


def item_json(ctx: SwapContext, item: TimedItem) -> Dict[str, Any]:
    return {
        "assignmentId": item.assignment.id if item.assignment is not None else None,
        "rowId": item.slot_id,
        "dateISO": item.date_iso,
        "clinicianId": item.clinician_id,
        "sectionId": item.section_id,
        "sectionName": ctx.section_name(item.section_id),
        "slotLabel": ctx.slot_label(item.slot_id),
        "locationId": item.location_id,
        "locationName": ctx.location_name(item.location_id),
        "start": local_iso(item.abs_start),
        "end": local_iso(item.abs_end),
        "minutes": item.minutes,
        "fp": slot_fingerprint(ctx.vctx, item.slot_id),
    }


def unit_json(ctx: SwapContext, unit: SwapUnit) -> Dict[str, Any]:
    return {
        "clinicianId": unit.clinician_id,
        "startDateISO": unit.start_date_iso,
        "start": local_iso(unit.abs_start),
        "end": local_iso(unit.abs_end),
        "minutes": unit.minutes,
        "kind": unit.kind(ctx.settings),
        "overnight": unit.overnight,
        "blockCount": len(unit.blocks),
        "primarySectionName": ctx.section_name(unit.primary_section),
        "items": [item_json(ctx, item) for item in unit.items],
    }


def take_key(unit: Optional[SwapUnit]) -> str:
    if unit is None:
        return "-"
    return "+".join(f"{item.slot_id}@{item.date_iso}" for item in unit.items)


# --- Target -----------------------------------------------------------------


@dataclass
class Target:
    """The resolved selection: its JSON (SwapTargetInfo), the unit X, and for
    cover the slot instance."""

    info: Dict[str, Any]
    unit: Optional[SwapUnit]
    status: Optional[StartStatus]
    cover: Optional[OpenSlotInfo]

    @property
    def blocked(self) -> bool:
        return self.info["blocked"] is not None


def _row_section_name(ctx: SwapContext, row_id: str) -> Optional[str]:
    if row_id.startswith("pool-"):
        return ctx.row_name(row_id)
    section_id = ctx.vctx.slot_sections.get(row_id)
    return ctx.section_name(section_id) if section_id is not None else None


def _blocked(code: str, message: str) -> Dict[str, str]:
    return {"code": code, "message": message}


def _check_partner(ctx: SwapContext, partner_id: Optional[str], holder_id: Optional[str]) -> None:
    if partner_id is None:
        return
    if partner_id == holder_id:
        raise swap_error(400, "invalid_request", labels.INVALID_SAME_PERSON)
    if partner_id not in ctx.vctx.clinicians_by_id:
        raise swap_error(400, "invalid_request", labels.INVALID_UNKNOWN_PERSON)


def stored_assignment(ctx: SwapContext, ref: "AssignmentRefIn") -> Assignment:
    """The stored assignment a request names, by value; with several matches
    the one with the request's id. 409 swap_stale when there is none."""
    matches = [a for a in ctx.by_person.get(ref.clinicianId, [])
               if a.rowId == ref.rowId and a.dateISO == ref.dateISO]
    if not matches:
        raise swap_error(409, "swap_stale", labels.STALE_GONE)
    return next((a for a in matches if a.id == ref.assignmentId), matches[0])


def _timing(ctx: SwapContext, unit: SwapUnit) -> Tuple[StartStatus, Dict[str, Any]]:
    status = start_status(unit.abs_start, ctx.rules, ctx.now)
    return status, {"unit": unit_json(ctx, unit), "startsAt": status.starts_at.isoformat(timespec="minutes"),
                    "hoursUntilStart": status.hours_until}


def _resolve_assignment(
    ctx: SwapContext,
    ref: "AssignmentRefIn",
    req: "CandidatesRequest",
    info: Dict[str, Any],
) -> Target:
    a = stored_assignment(ctx, ref)
    if a.clinicianId not in ctx.vctx.clinicians_by_id:
        raise swap_error(400, "invalid_request", labels.INVALID_UNKNOWN_PERSON)
    _check_partner(ctx, req.partnerId, a.clinicianId)
    info.update(holderId=a.clinicianId, holderName=ctx.name(a.clinicianId),
                excludedPartnerIds=[a.clinicianId])
    try:
        unit = unit_for(ctx.vctx, ctx.by_person[a.clinicianId], a, whole_day=req.wholeDay)
    except UnitError as error:
        info["blocked"] = _blocked(error.code, error.message)
        return Target(info, None, None, None)
    count = len(blocks_on_date(ctx.blocks(a.clinicianId), unit.start_date_iso))
    whole_day = req.wholeDay and count > 1
    status, timing = _timing(ctx, unit)
    info.update(timing, blocksOnDate=count, wholeDay=whole_day)
    if status.started:
        message = labels.TARGET_DAY_STARTED if whole_day else labels.TARGET_STARTED
        info["blocked"] = _blocked("started", message)
    else:
        info["insideNotice"] = status.inside_notice
    return Target(info, unit, status, None)


def _resolve_cover(
    ctx: SwapContext,
    ref: "SlotRefIn",
    req: "CandidatesRequest",
    info: Dict[str, Any],
) -> Target:
    _check_partner(ctx, req.partnerId, None)
    slot = open_slot(ctx.vctx, ctx.by_instance, ref.rowId, ref.dateISO)
    info["excludedPartnerIds"] = sorted({a.clinicianId for a in slot.stored})
    unit = instance_unit(ctx.vctx, ref.rowId, ref.dateISO)
    if not slot.active or unit is None:
        info["blocked"] = _blocked("inactive_slot", labels.TARGET_INACTIVE)
        return Target(info, None, None, slot)
    status, timing = _timing(ctx, unit)
    info.update(timing, blocksOnDate=1, openCount=slot.missing)
    if slot.hidden:
        hidden = slot.hidden[0]
        info["hiddenHolder"] = {"clinicianId": hidden.clinicianId, "name": ctx.name(hidden.clinicianId),
                                "assignmentId": hidden.id}
    if slot.missing <= 0:
        info["blocked"] = _blocked("not_open", labels.TARGET_NOT_OPEN)
    elif status.started:
        info["blocked"] = _blocked("started", labels.TARGET_SLOT_STARTED)
    else:
        info["insideNotice"] = status.inside_notice
    return Target(info, unit, status, slot)


def _target_info(ctx: SwapContext, mode: str, row_id: str, date_iso: str) -> Dict[str, Any]:
    """SwapTargetInfo before resolution: nothing known beyond the request."""
    return {
        "mode": mode,
        "holderId": None,
        "holderName": None,
        "dateISO": date_iso,
        "sectionName": _row_section_name(ctx, row_id),
        "unit": None,
        "blocksOnDate": 0,
        "wholeDay": False,
        "startsAt": None,
        "hoursUntilStart": None,
        "insideNotice": False,
        "noticeHours": ctx.rules.notice_hours,
        "timeZone": ctx.rules.time_zone,
        "blocked": None,
        "openCount": None,
        "hiddenHolder": None,
        "excludedPartnerIds": [],
    }


def resolve_target(ctx: SwapContext, req: "CandidatesRequest") -> Target:
    """The selected shift or slot instance and whether anything can be offered
    for it. The request model guarantees the reference its mode needs."""
    if req.mode == "cover":
        slot = req.slot
        return _resolve_cover(ctx, slot, req, _target_info(ctx, req.mode, slot.rowId, slot.dateISO))
    ref = req.assignment
    return _resolve_assignment(ctx, ref, req, _target_info(ctx, req.mode, ref.rowId, ref.dateISO))


# --- Search -----------------------------------------------------------------


@dataclass
class _Pending:
    """One option before evaluation: a partner and, in a swap, one of their blocks."""

    partner: Clinician
    take: Optional[SwapUnit]
    take_status: Optional[StartStatus]
    key: str  # take_key
    other_week: int  # 1 when Y starts outside X's ISO week (0 outside swap mode)
    distance: int  # days between the start dates of X and Y (0 outside swap mode)

    def evaluation_order(self) -> Tuple[int, int, str, str, str]:
        return self.other_week, abs(self.distance), self.partner.name.casefold(), self.partner.id, self.key


def _like_for_like(ctx: SwapContext, give: SwapUnit, take: SwapUnit) -> Optional[str]:
    """"same_section", "same_type" or None."""
    if give.primary_section == take.primary_section:
        return "same_section"
    if give.kind(ctx.settings) == take.kind(ctx.settings) and abs(give.minutes - take.minutes) <= 60:
        return "same_type"
    return None


def _in_range(req: "CandidatesRequest", give: SwapUnit, block: WorkBlock) -> bool:
    if req.range == "dates":
        return block.start_date_iso in req.dates
    start = date.fromisoformat(give.start_date_iso)
    monday = start - timedelta(days=start.weekday())
    last = monday + timedelta(days=6 if req.range == "sameWeek" else 27)
    return monday.isoformat() <= block.start_date_iso <= last.isoformat()


def _pending(ctx: SwapContext, req: "CandidatesRequest", target: Target, give: SwapUnit) -> List[_Pending]:
    excluded = set(target.info["excludedPartnerIds"])
    partners = [c for c in ctx.state.clinicians
                if c.id not in excluded and (req.partnerId is None or c.id == req.partnerId)]
    if req.mode != "swap":
        return [_Pending(partner, None, None, take_key(None), 0, 0) for partner in partners]
    pending: List[_Pending] = []
    give_week = iso_week(give.start_date_iso)
    give_day = date.fromisoformat(give.start_date_iso)
    for partner in partners:
        for block in ctx.blocks(partner.id):
            if not _in_range(req, give, block):
                continue
            take = SwapUnit(partner.id, (block,))
            status = start_status(take.abs_start, ctx.rules, ctx.now)
            if status.started or take.instance_keys & give.instance_keys:
                continue
            if req.sameTypeOnly and _like_for_like(ctx, give, take) is None:
                continue
            pending.append(_Pending(
                partner, take, status, take_key(take), 0 if iso_week(take.start_date_iso) == give_week else 1,
                (date.fromisoformat(take.start_date_iso) - give_day).days,
            ))
    return pending


def _hours_move(hours: Sequence[Dict[str, Any]]) -> int:
    """Minutes by which the shown people's weeks move away from their contracts."""
    return sum(
        max(0, abs(week["afterMinutes"] - week["contractMinutes"])
            - abs(week["beforeMinutes"] - week["contractMinutes"]))
        for person in hours for week in person["weeks"] if week["contractMinutes"] is not None
    )


def _preference_score(ctx: SwapContext, plan: MovePlan) -> int:
    score = 0
    for taker_id, unit in _receipts(plan):
        receiver = ctx.clinician(taker_id)
        prefs = receiver.preferredClassIds or []
        for item in unit.items:
            if len(prefs) >= 2 and item.section_id in prefs[:2]:
                score += 1
            window = preference_window(receiver, _weekday_key(item.date_iso))
            if window is not None and _fits_window(ctx, item, window):
                score += 1
    return score


def _chip(code: str, label: str, tone: str) -> Dict[str, str]:
    return {"code": code, "label": label, "tone": tone}


def _option(ctx: SwapContext, give_status: StartStatus, pending: _Pending, plan: MovePlan) -> Dict[str, Any]:
    """The option fields every group shares; the group-specific ones start empty."""
    take_status = pending.take_status
    hidden = None
    if plan.cover is not None and plan.hidden_removal is not None:
        holder = plan.hidden_removal.clinicianId
        hidden = {"clinicianId": holder, "name": ctx.name(holder), "assignmentId": plan.hidden_removal.id,
                  "required": len(plan.cover.stored) + 1 > plan.cover.target}
    return {
        "key": f"{pending.partner.id}|{pending.key}",
        "partnerId": pending.partner.id,
        "partnerName": pending.partner.name,
        "take": unit_json(ctx, pending.take) if pending.take is not None else None,
        "group": "blocked",
        "chips": [],
        "reason": None,
        "blockerCount": 0,
        "warnings": [],
        "findings": [],
        "hours": [],
        "restDayMoves": [],
        "restDayRemovals": [],
        "hiddenRemoval": hidden,
        "insideNotice": give_status.inside_notice or (take_status is not None and take_status.inside_notice),
        "takeHoursUntilStart": take_status.hours_until if take_status is not None else None,
        "preexisting": [],
    }


def _evaluate_valid(
    ctx: SwapContext,
    pending: _Pending,
    plan: MovePlan,
    carried: Sequence[Violation],
    option: Dict[str, Any],
) -> Tuple[Any, ...]:
    """Fill a valid option; returns its ranking key."""
    warnings = plan_warnings(ctx, plan, scope="slice")
    hours = plan_hours(ctx, plan)
    findings = soft_findings(ctx, plan, hours)
    partner = pending.partner
    hours_known = _contract(partner) is not None
    hours_move = _hours_move(hours)
    like = _like_for_like(ctx, plan.give, pending.take) if pending.take is not None else None
    chips = []
    if like == "same_section":
        chips.append(_chip("same_section", labels.SAME_SECTION, "positive"))
    elif like == "same_type":
        chips.append(_chip("same_type", labels.SAME_TYPE, "positive"))
    if pending.take is not None and not pending.other_week:
        chips.append(_chip("same_week", labels.SAME_WEEK, "neutral"))
    if not hours_known:
        chips.append(_chip("no_contract", labels.NO_CONTRACT, "neutral"))
    elif hours_move == 0:
        chips.append(_chip("hours_even", labels.HOURS_EVEN, "neutral"))
    prefs = partner.preferredClassIds or []
    if len(prefs) >= 2 and plan.give.primary_section in prefs[:2]:
        section = ctx.section_name(plan.give.primary_section)
        chips.append(_chip("prefers", labels.prefers(section), "positive"))
    ytd_rank: Tuple[int, int] = (0, 0)
    if plan.mode in ("handover", "cover"):
        ytd = ctx.ytd_pct(plan.give.start_date_iso).get(partner.id)
        ytd_rank = (0, -ytd) if ytd is not None else (1, 0)
        if ytd is not None and ytd >= 5:
            chips.append(_chip("behind_on_hours", labels.behind_on_hours(ytd), "positive"))
    kept = plan_kept_warnings(ctx, plan, scope="slice")
    option.update(
        group="possible" if warnings or findings else "best",
        chips=chips,
        warnings=[w.as_json() for w in warnings],
        findings=findings,
        hours=hours,
        restDayMoves=[{"fromClinicianId": m.from_id, "toClinicianId": m.to_id, "dateISO": m.date_iso}
                      for m in plan.rest_day_moves],
        restDayRemovals=rest_day_removal_days(ctx, plan),
        preexisting=preexisting_checks(ctx, plan, carried, kept),
    )
    swap = plan.mode == "swap"
    take_ordinal = date.fromisoformat(pending.take.start_date_iso).toordinal() if pending.take else 0
    return (
        0 if not warnings and not findings else 1,
        0 if like or not swap else 1,
        pending.other_week,
        abs(pending.distance),
        0 if hours_known else 1,
        hours_move,
        -_preference_score(ctx, plan),
        ytd_rank,
        take_ordinal,
        partner.name.casefold(),
        partner.id,
        pending.key,
    )


def _blocked_order(pending: _Pending, gate_blocked: bool, count: int) -> Tuple[Any, ...]:
    return (0 if gate_blocked else 1, count, pending.other_week, abs(pending.distance),
            pending.partner.name.casefold(), pending.partner.id, pending.key)


def find_candidates(ctx: SwapContext, req: "CandidatesRequest") -> Dict[str, Any]:
    """The full response of POST /v1/swaps/candidates."""
    target = resolve_target(ctx, req)
    response: Dict[str, Any] = {
        "revision": ctx.state.revision,
        "target": target.info,
        "targetFindings": [],
        "checks": [],
        "best": [],
        "possible": [],
        "blocked": [],
        "closest": [],
        "totals": {"best": 0, "possible": 0, "blocked": 0},
        "checked": 0,
        "truncated": False,
    }
    if target.blocked:
        return response
    # An unblocked target always has its unit and start.
    give, give_status = target.unit, target.status
    hidden = None
    if target.cover is not None and target.cover.hidden:
        hidden = target.cover.hidden[0]
    valid: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []
    blocked: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []
    cache: BaselineCache = {}
    checked = gate_runs = 0
    truncated = False
    for pending in sorted(_pending(ctx, req, target, give), key=_Pending.evaluation_order):
        if gate_runs >= policy.MAX_GATE_EVALUATIONS:
            truncated = True
            break
        plan = plan_option(ctx, req.mode, give, pending.partner.id, take=pending.take, cover=target.cover,
                           hidden_removal=hidden)
        option = _option(ctx, give_status, pending, plan)
        checked += 1
        failures = prefilter(ctx, plan)
        if failures:
            code, message = failures[0]
            option.update(reason={"code": code, "message": message}, blockerCount=len(failures))
            blocked.append((_blocked_order(pending, False, len(failures)), option))
            continue
        gate_runs += 1
        new, carried = scoped_gate(ctx, plan, cache)
        if new:
            code, message = reason_for(ctx, plan, new)
            count = len({(v.code, v.clinician_id, v.date_iso) for v in new})
            option.update(reason={"code": code, "message": message}, blockerCount=count)
            blocked.append((_blocked_order(pending, True, count), option))
            continue
        valid.append((_evaluate_valid(ctx, pending, plan, carried, option), option))
    best = [option for _key, option in sorted(valid, key=lambda entry: entry[0]) if option["group"] == "best"]
    possible = [option for _key, option in sorted(valid, key=lambda entry: entry[0])
                if option["group"] == "possible"]
    blocked_options = [option for _key, option in sorted(blocked, key=lambda entry: entry[0])]
    response.update(
        targetFindings=target_findings(ctx, req.mode, give),
        checks=labels.check_list(ctx.settings, ctx.rules, req.mode),
        best=best[:policy.BEST_CAP],
        possible=possible[:policy.POSSIBLE_CAP],
        blocked=blocked_options[:policy.BLOCKED_CAP],
        closest=blocked_options[:policy.CLOSEST_COUNT] if not best and not possible else [],
        totals={"best": len(best), "possible": len(possible), "blocked": len(blocked_options)},
        checked=checked,
        truncated=truncated,
    )
    return response
