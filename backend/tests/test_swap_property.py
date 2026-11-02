"""Property: the search's two-person slice gives the full calendar's verdict.

For random swaps, handovers and covers on four datasets, the scoped gate
(slice, context, references skipped) must report exactly the new or worse
violations of the apply gate (whole calendar, references checked), and the
solver-rule hits must agree. For valid cases the working-time warnings (ids
and texts) and the pre-existing checks must agree between slice and calendar
too.

Datasets: the arena fixture; a dense plan generated from its template where
people often hold touching shifts; rich_swap_state, which adds Rest Days, a
vacation-hidden holder, a two-block day and a solver rule; and
wide_swap_state, whose rules reach far beyond the moved weeks (on-call rest
of 3 and 7 days, a duty ending two days later, two locations) and whose
stretch of ward duties is longer than any margin. Counters make sure the
cases a narrow or careless slice would get wrong really occur.
"""

import random
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Set, Tuple

import pytest

from backend.constraint_policy import classify_violations, violation_key
from backend.models import AppState, Assignment, VacationRange
from backend.swaps.blocks import SwapUnit, blocks_on_date, instance_unit
from backend.swaps.matching import (
    BaselineCache,
    MovePlan,
    SwapContext,
    apply_plan,
    full_gate,
    plan_kept_warnings,
    plan_option,
    plan_warnings,
    preexisting_checks,
    prefilter,
    scoped_gate,
    scoped_new_violations,
    slice_window,
    solver_rule_hits,
)
from backend.swaps.policy import SwapRules, open_slot
from backend.swaps.worktime import WorkWarning, iso_week
from backend.validation import VIOLATION_CAPACITY, VIOLATION_ON_CALL_REST

from .swap_fixtures import (
    BEFORE_STRETCH_DAY,
    BEN_VACATION_DAY,
    CAPACITY_DAY,
    CROSSING_STRETCH_DAY,
    REST_CLASH_DAY,
    STRETCH_HOLDER,
    TOUCHING_STRETCH_DAY,
    WHOLE_DAY,
    WIDE_WHOLE_DAY,
    arena_state,
    chained_plan,
    rich_swap_state,
    wide_swap_state,
)

NOW = datetime(2025, 12, 1, tzinfo=timezone.utc)  # before every shift of every dataset
RULES = SwapRules()
SWAP_SEEDS = (7, 11)
SWAP_CASES_PER_SEED = 100
COVER_CASES = 60
COVER_DRAWS = 20

DATASETS: Dict[str, Callable[[], AppState]] = {
    "arena": arena_state,
    "chained": lambda: chained_plan(arena_state(), date(2026, 2, 2), 21, 3),
    "rich": rich_swap_state,
    "wide": wide_swap_state,
}


def _swap_plans(ctx: SwapContext, rng: random.Random, count: int) -> Iterator[MovePlan]:
    """Random swaps and handovers of visible blocks, planned as the search plans them."""
    people = [c.id for c in ctx.state.clinicians]
    qualified = {c.id: set(c.qualifiedClassIds) for c in ctx.state.clinicians}
    blocks = [(cid, block) for cid in people for block in ctx.blocks(cid)]
    produced = 0
    while produced < count:
        giver, block = rng.choice(blocks)
        same_day = blocks_on_date(ctx.blocks(giver), block.start_date_iso)
        whole_day = len(same_day) > 1 and rng.random() < 0.3
        give = SwapUnit(giver, tuple(same_day) if whole_day else (block,))
        mode = "swap" if rng.random() < 0.6 else "handover"
        partners = [p for p in people if p != giver]
        if rng.random() < 0.5:
            sections = {item.section_id for item in give.items}
            partners = [p for p in partners if sections <= qualified[p]] or partners
        partner = rng.choice(partners)
        take = None
        if mode == "swap":
            options = ctx.blocks(partner)
            if rng.random() < 0.5:
                options = [b for b in options
                           if {i.section_id for i in b.items} <= qualified[giver]] or options
            if not options:
                continue
            take = SwapUnit(partner, (rng.choice(options),))
            if take.instance_keys & give.instance_keys:
                continue
        produced += 1
        yield plan_option(ctx, mode, give, partner, take=take)


def _opened(state: AppState, a: Assignment, hide: bool) -> AppState:
    """A copy whose instance of ``a`` lost a visible holder: ``a``'s holder
    goes on vacation that day (hidden), or ``a`` is removed (open)."""
    if hide:
        clinicians = [
            c.model_copy(update={"vacations": c.vacations + [VacationRange(
                id="property-test", startISO=a.dateISO, endISO=a.dateISO)]}) if c.id == a.clinicianId else c
            for c in state.clinicians
        ]
        return state.model_copy(update={"clinicians": clinicians})
    return state.model_copy(update={"assignments": [x for x in state.assignments if x is not a]})


def _cover(ctx: SwapContext, row_id: str, date_iso: str, partner: str, stats: Counter) -> List[MovePlan]:
    """The cover plans of one open instance: with the first hidden holder's
    removal, and also without it when the removal is optional."""
    info = open_slot(ctx.vctx, ctx.by_instance, row_id, date_iso)
    unit = instance_unit(ctx.vctx, row_id, date_iso)
    hidden = info.hidden[0] if info.hidden else None
    removals: List[Optional[Assignment]] = [hidden]
    if hidden is not None and len(info.stored) + 1 <= info.target:
        stats["optional hidden removal"] += 1
        removals.append(None)
    return [plan_option(ctx, "cover", unit, partner, cover=info, hidden_removal=removal)
            for removal in removals]


def _cover_cases(state: AppState, rng: random.Random, count: int,
                 stats: Counter) -> Iterator[Tuple[SwapContext, List[MovePlan]]]:
    """Random covers of instances opened on a copy of the state, for a partner
    who does not hold the instance."""
    work = [a for a in state.assignments if not a.rowId.startswith("pool-")]
    for _case in range(count):
        for _draw in range(COVER_DRAWS):
            a = rng.choice(work)
            ctx = SwapContext(_opened(state, a, rng.random() < 0.5), RULES, NOW)
            info = open_slot(ctx.vctx, ctx.by_instance, a.rowId, a.dateISO)
            if info.is_open:
                break
        else:
            continue
        holders = {x.clinicianId for x in info.stored}
        partner = rng.choice([c.id for c in ctx.state.clinicians if c.id not in holders])
        yield ctx, _cover(ctx, a.rowId, a.dateISO, partner, stats)


def _rich_extras(ctx: SwapContext, stats: Counter) -> Iterator[MovePlan]:
    """Cases random draws rarely reach in rich_swap_state: covering Ben's
    vacation-hidden instance (its target of 2 makes removing him optional)
    and handing over Dora's two-block day."""
    hidden = next(a for a in ctx.by_person["clin-ben"]
                  if a.dateISO == BEN_VACATION_DAY and not a.rowId.startswith("pool-"))
    holders = {a.clinicianId for a in ctx.by_instance[(hidden.rowId, hidden.dateISO)]}
    dora_day = SwapUnit("clin-dora", tuple(blocks_on_date(ctx.blocks("clin-dora"), WHOLE_DAY)))
    for partner in (c.id for c in ctx.state.clinicians):
        if partner not in holders:
            yield from _cover(ctx, hidden.rowId, hidden.dateISO, partner, stats)
        if partner != "clin-dora":
            yield plan_option(ctx, "handover", dora_day, partner)


def _wide_extras(ctx: SwapContext, stats: Counter) -> Iterator[MovePlan]:
    """The cases wide_swap_state is built for: covering the target-2 instance
    with and without removing Ben's hidden entry (without it overfills the
    slot), handing over Dora's two-block day, handing Eva Five's shifts before,
    next to and after the long stretch to its holder, and Eva Five's shift
    seven days after Ben's on-call to Ben."""
    people = [c.id for c in ctx.state.clinicians]
    info = open_slot(ctx.vctx, ctx.by_instance, "ct-tue", CAPACITY_DAY)
    unit = instance_unit(ctx.vctx, "ct-tue", CAPACITY_DAY)
    holders = {a.clinicianId for a in info.stored}
    for partner in people:
        if partner not in holders:
            for removal in (info.hidden[0], None):
                yield plan_option(ctx, "cover", unit, partner, cover=info, hidden_removal=removal)
    dora_day = SwapUnit("clin-dora", tuple(blocks_on_date(ctx.blocks("clin-dora"), WIDE_WHOLE_DAY)))
    for partner in people:
        if partner != "clin-dora":
            yield plan_option(ctx, "handover", dora_day, partner)

    def eva_five(day: str) -> SwapUnit:
        return SwapUnit("clin-e5", tuple(blocks_on_date(ctx.blocks("clin-e5"), day)))

    for day in (BEFORE_STRETCH_DAY, TOUCHING_STRETCH_DAY, CROSSING_STRETCH_DAY):
        yield plan_option(ctx, "handover", eva_five(day), STRETCH_HOLDER)
    yield plan_option(ctx, "handover", eva_five(REST_CLASH_DAY), "clin-ben")


def _days_outside(date_iso: str, weeks: Set[Tuple[int, int]]) -> int:
    """Days between a date and the nearest of the ISO weeks (0 inside one)."""
    day = date.fromisoformat(date_iso)
    gaps = []
    for year, week in weeks:
        monday = date.fromisocalendar(year, week, 1)
        sunday = monday + timedelta(days=6)
        gaps.append(0 if monday <= day <= sunday else min(abs((day - monday).days), abs((day - sunday).days)))
    return min(gaps)


def _texts(warnings: Iterable[WorkWarning]) -> Set[Tuple[str, str, str]]:
    return {(w.id, w.message, w.short) for w in warnings}


def _check(ctx: SwapContext, plan: MovePlan, cache: BaselineCache, stats: Counter) -> None:
    state = ctx.state
    full = full_gate(state, plan)[0]
    weeks = {iso_week(d) for d in plan.moved_dates}
    stats["rest-day move"] += bool(plan.rest_day_moves)
    stats["rest-day removal"] += bool(plan.rest_day_removals)
    stats["whole-day unit"] += len(plan.give.blocks) > 1
    stats["on-call rest outside the moved weeks"] += any(
        v.code == VIOLATION_ON_CALL_REST and _days_outside(v.context["on_call_date"], weeks) >= 2 for v in full)
    stats["cover capacity"] += plan.mode == "cover" and any(v.code == VIOLATION_CAPACITY for v in full)
    if prefilter(ctx, plan):
        assert full, f"pre-filter failed but the calendar accepts {plan.mode} {plan.moved_dates}"
        stats[f"{plan.mode} invalid"] += 1
        return
    keys = {violation_key(v) for v in full}
    assert {violation_key(v) for v in scoped_new_violations(ctx, plan)} == keys
    assert {violation_key(v) for v in scoped_new_violations(ctx, plan, cache)} == keys
    hits = {violation_key(v) for v in solver_rule_hits(ctx, plan, scope="full")}
    assert {violation_key(v) for v in solver_rule_hits(ctx, plan, scope="slice")} == hits
    stats["solver rule hit"] += bool(hits)
    if keys:
        stats[f"{plan.mode} invalid"] += 1
        return
    stats[f"{plan.mode} valid"] += 1
    stats["whole-day valid"] += len(plan.give.blocks) > 1
    new = plan_warnings(ctx, plan, scope="slice")
    assert _texts(new) == _texts(plan_warnings(ctx, plan, scope="full"))
    # The slice sees the warnings of its window, each exactly as the calendar
    # has it, and every one of the touched weeks.
    kept, kept_full = plan_kept_warnings(ctx, plan, scope="slice"), plan_kept_warnings(ctx, plan, scope="full")
    assert _texts(kept) <= _texts(kept_full)
    assert _texts(w for w in kept_full if iso_week(w.date_iso) in weeks) <= _texts(kept)
    lo, hi = slice_window(ctx, plan.moved_dates)
    stats["long stretch new"] += any(w.code == "block_too_long" and w.date_iso < lo for w in new)
    stats["long stretch kept"] += any(w.code == "block_too_long" and w.date_iso < lo for w in kept)
    # A night warning's id ends with the day its block ends, which can lie beyond the window.
    stats["night after a stretch"] += any(
        w.code == "night_no_free_day" and w.id.rsplit(":", 1)[1] > hi and iso_week(w.date_iso) in weeks
        for w in kept)
    scoped = preexisting_checks(ctx, plan, scoped_gate(ctx, plan)[1], kept)
    carried = classify_violations(state, state.assignments, apply_plan(state.assignments, plan),
                                  only_fill_required=True)[1]
    assert scoped == preexisting_checks(ctx, plan, carried, kept_full)
    stats["preexisting"] += bool(scoped)


INGREDIENTS = {
    "rich": ("rest-day move", "rest-day removal", "optional hidden removal", "whole-day unit",
             "solver rule hit", "preexisting"),
    # Each one fails the property under a slice that is too narrow, ignores
    # the co-holders of a covered instance or cuts a long block.
    "wide": ("on-call rest outside the moved weeks", "cover capacity", "whole-day valid", "long stretch new",
             "long stretch kept", "night after a stretch", "preexisting"),
}


def _non_vacuous(name: str, stats: Counter) -> None:
    if name not in INGREDIENTS:
        assert stats["swap valid"] + stats["handover valid"] >= 5, stats
        assert stats["swap invalid"] + stats["handover invalid"] >= 5, stats
        assert stats["cover valid"] >= 3, stats
        return
    for mode in ("swap", "handover", "cover"):
        assert stats[f"{mode} valid"] >= 1 and stats[f"{mode} invalid"] >= 1, stats
    for ingredient in INGREDIENTS[name]:
        assert stats[ingredient] >= 1, (ingredient, stats)


@pytest.mark.parametrize("name", list(DATASETS))
def test_scoped_verdict_equals_the_full_calendar_verdict(name: str):
    state = DATASETS[name]()
    stats: Counter = Counter()
    ctx = SwapContext(state, RULES, NOW)
    # One baseline cache shared by every case of a context covers the cache key.
    shared: BaselineCache = {}
    for seed in SWAP_SEEDS:
        # One generator per dataset and kind: a new dataset never changes the others' cases.
        for plan in _swap_plans(ctx, random.Random(f"{name}-swap-{seed}"), SWAP_CASES_PER_SEED):
            _check(ctx, plan, shared, stats)
    for cover_ctx, plans in _cover_cases(state, random.Random(f"{name}-cover"), COVER_CASES, stats):
        case_cache: BaselineCache = {}
        for plan in plans:
            _check(cover_ctx, plan, case_cache, stats)
    extras = {"rich": _rich_extras, "wide": _wide_extras}.get(name)
    if extras is not None:
        for plan in extras(ctx, stats):
            _check(ctx, plan, shared, stats)
    _non_vacuous(name, stats)
