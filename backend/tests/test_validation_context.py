"""A ValidationContext only saves lookup work: every validator returns exactly the
same violations, in the same order, with and without it, also for checked lists
that add or drop Rest Day entries of the calendar."""

import random
from datetime import date
from typing import Callable, Dict, List, Optional, Tuple

import pytest

from backend.models import (
    AppState,
    Assignment,
    Holiday,
    PreferredWorkingTime,
    SolverRule,
    SolverSettings,
    TemplateBlock,
)
from backend.validation import (
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
    ValidationContext,
    Violation,
    _build_slot_day_type_map,
    _build_slot_lookup,
    build_validation_context,
    validate_assignments,
    validate_capacity,
    validate_mandatory_windows,
    validate_on_call_rest,
    validate_overlaps,
    validate_qualifications,
    validate_references,
    validate_rest_days,
    validate_same_location_per_day,
    validate_solver_rules,
    validate_split_shifts,
    validate_vacations,
    validate_weekly_hours,
)

from .conftest import make_template_slot
from .swap_fixtures import THU, arena_state, asg, chained_plan, make_swap_state, rest_swap_state, rich_swap_state

Plan = List[Assignment]
ValidatorCall = Callable[[AppState, Plan, Optional[ValidationContext]], List[Violation]]

VALIDATORS: Dict[str, ValidatorCall] = {
    "references": lambda s, p, c: validate_references(s, p, context=c),
    "qualifications": lambda s, p, c: validate_qualifications(s, p, context=c),
    "vacations": lambda s, p, c: validate_vacations(s, p, context=c),
    "rest_days": lambda s, p, c: validate_rest_days(s, p, context=c),
    "own_rest_days": lambda s, p, c: validate_rest_days(s, p, context=c, own_rest_days=True),
    "overlaps": lambda s, p, c: validate_overlaps(s, p, context=c),
    "same_location": lambda s, p, c: validate_same_location_per_day(s, p, context=c),
    "on_call_rest": lambda s, p, c: validate_on_call_rest(s, p, context=c),
    "mandatory_windows": lambda s, p, c: validate_mandatory_windows(s, p, context=c),
    "weekly_hours": lambda s, p, c: validate_weekly_hours(s, p, context=c),
    "split_shifts": lambda s, p, c: validate_split_shifts(s, p, context=c),
    "capacity": lambda s, p, c: validate_capacity(s, p, context=c),
    "capacity_required_only": lambda s, p, c: validate_capacity(
        s, p, only_fill_required=True, context=c),
    "solver_rules": lambda s, p, c: validate_solver_rules(s, p, context=c),
}
# Explicit settings win over the context's settings (which are the state's own).
SETTINGS_OVERRIDES: Dict[str, ValidatorCall] = {
    "same_location_off": lambda s, p, c: validate_same_location_per_day(
        s, p, SolverSettings(enforceSameLocationPerDay=False), context=c),
    "on_call_rest_off": lambda s, p, c: validate_on_call_rest(
        s, p, SolverSettings(onCallRestEnabled=False), context=c),
    "split_shifts_off": lambda s, p, c: validate_split_shifts(
        s, p, SolverSettings(preferContinuousShifts=False), context=c),
}
FLAG_COMBINATIONS = [(False, False), (False, True), (True, False), (True, True)]


def _arena_with_two_locations_in_one_day() -> AppState:
    state = arena_state()
    lookup = _build_slot_lookup(state)
    day_types = _build_slot_day_type_map(state)
    monday_slots = sorted(s for s, dt in day_types.items() if dt == "mon" and s in lookup)
    first = monday_slots[0]
    second = next(s for s in monday_slots if lookup[s][2] != lookup[first][2])
    who = state.clinicians[0].id
    state.assignments = state.assignments + [
        Assignment(id="x-loc-1", rowId=first, dateISO="2026-02-02", clinicianId=who),
        Assignment(id="x-loc-2", rowId=second, dateISO="2026-02-02", clinicianId=who),
    ]
    return state


def _rich_with_edge_cases() -> AppState:
    """rich_swap_state plus a holiday on a planned Tuesday, a mandatory window,
    a second (shiftRow) rule and assignments for every remaining violation kind."""
    state = rich_swap_state()
    anna = next(c for c in state.clinicians if c.id == "clin-anna")
    anna.preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="08:00", endTime="16:00", requirement="mandatory"),
    }
    state.holidays = [Holiday(dateISO="2026-01-06", name="Test holiday")]
    state.weeklyTemplate.blocks.append(TemplateBlock(id="block-ghost", sectionId="sec-ghost"))
    state.weeklyTemplate.locations[0].slots += [
        make_template_slot("orphan-mon", col_band_id="col-gone", block_id="block-day"),
        make_template_slot("ghost-mon", col_band_id="col-mon", block_id="block-ghost"),
    ]
    state.solverRules = state.solverRules + [
        SolverRule(id="rule-ct-after-oncall-sat", name="CT after Saturday on-call",
                   ifShiftRowId="oncall-sat", dayDelta=1, thenType="shiftRow",
                   thenShiftRowId="ct-sun").model_dump(),
    ]
    state.assignments = state.assignments + [
        asg("x-split-1", "early-mon", "2026-01-19", "clin-anna"),
        asg("x-split-2", "night-mon", "2026-01-19", "clin-anna"),
        asg("x-unqualified", "night-tue", "2026-01-20", "clin-clara"),
        asg("x-full-1", "ct-wed", "2026-01-21", "clin-dora"),
        asg("x-full-2", "ct-wed", "2026-01-21", "clin-e1"),
        asg("x-full-3", "ct-wed", "2026-01-21", "clin-e2"),
        asg("x-rule-1", "night-thu", "2026-01-22", "clin-e3"),
        asg("x-rule-2", "ct-fri", "2026-01-23", "clin-e3"),
        asg("x-unknown-clinician", "ct-mon", "2026-01-19", "clin-ghost"),
        asg("x-unknown-slot", "nope-mon", "2026-01-19", "clin-e4"),
        asg("x-no-column", "orphan-mon", "2026-01-19", "clin-e5"),
        asg("x-no-section", "ghost-mon", "2026-01-19", "clin-e6"),
    ]
    return state


def _random_subsets(plan: Plan, count: int, seed: int) -> List[Plan]:
    rng = random.Random(seed)
    return [rng.sample(plan, rng.randint(1, len(plan))) for _ in range(count)]


def _rest_day_plans(state: AppState, seed: int) -> List[Plan]:
    """Checked lists that differ from the calendar in Rest Days: without its
    Rest Day entries, with new ones on days people work (stored first and
    last), and random mixes of both."""
    rng = random.Random(seed)
    work = [a for a in state.assignments if not a.rowId.startswith("pool-")]
    without = [a for a in state.assignments if a.rowId != "pool-rest-day"]
    added = [asg(f"x-rest-{k}", "pool-rest-day", a.dateISO, a.clinicianId, locked=False)
             for k, a in enumerate(rng.sample(work, 8))]
    plans = [without, state.assignments + added, added + without, added[:4] + work[::3]]
    plans += [rng.sample(state.assignments + added, rng.randint(1, len(state.assignments))) for _ in range(10)]
    return plans


@pytest.fixture(scope="module")
def datasets() -> List[Tuple[AppState, List[Plan]]]:
    arena = arena_state()
    chained = chained_plan(arena, start=date(2026, 2, 2), days=21, seed=3)
    two_locations = _arena_with_two_locations_in_one_day()
    rich = _rich_with_edge_cases()
    rest = rest_swap_state()
    return [
        (arena, [arena.assignments] + _rest_day_plans(arena, seed=19)),
        (chained, _random_subsets(chained.assignments, 50, seed=13)),
        (two_locations, [two_locations.assignments]),
        (rich, [rich.assignments] + _random_subsets(rich.assignments, 10, seed=17)),
        (rest, [rest.assignments] + _rest_day_plans(rest, seed=23)),
    ]


def test_validate_assignments_is_identical_with_context(datasets):
    codes = set()
    reasons = set()
    differs = 0  # checked lists whose own Rest Days give another verdict than the calendar's with them
    for state, plans in datasets:
        context = build_validation_context(state)
        for plan in plans:
            for skip_references, only_fill_required in FLAG_COMBINATIONS:
                found = []
                for own_rest_days in (False, True):
                    flags = {"skip_references": skip_references, "only_fill_required": only_fill_required,
                             "own_rest_days": own_rest_days}
                    expected = validate_assignments(state, plan, **flags).violations
                    assert validate_assignments(state, plan, context=context, **flags).violations == expected
                    codes.update(v.code for v in expected)
                    reasons.update(v.context["reason"] for v in expected if v.code == VIOLATION_UNKNOWN_SLOT)
                    found.append([v for v in expected if v.code == VIOLATION_REST_DAY])
                differs += found[0] != found[1]
    assert codes == {
        VIOLATION_QUALIFICATION, VIOLATION_VACATION, VIOLATION_REST_DAY, VIOLATION_OVERLAP,
        VIOLATION_SAME_LOCATION, VIOLATION_ON_CALL_REST, VIOLATION_MANDATORY_WINDOW, VIOLATION_WEEKLY_HOURS,
        VIOLATION_SPLIT_SHIFT, VIOLATION_CAPACITY, VIOLATION_UNKNOWN_CLINICIAN, VIOLATION_UNKNOWN_SLOT,
    }
    assert reasons == {
        "unknown_or_invalid_slot", "unresolved_section", "unresolved_column", "inactive_day_type",
    }
    assert differs > 0


def test_rest_days_come_from_the_calendar_and_the_checked_list():
    rest = asg("rest", "pool-rest-day", THU, "clin-anna", locked=False)
    shift = asg("ct", "ct-thu", THU, "clin-anna")
    stored = make_swap_state([rest, shift])
    listed = make_swap_state([shift])
    for state, plan, union, own in [
        (stored, [shift], 1, 0),  # the calendar rests, the list does not
        (listed, [rest, shift], 1, 1),  # the list rests, the calendar does not
        (stored, [rest, shift], 1, 1),
        (listed, [shift], 0, 0),
    ]:
        context = build_validation_context(state)
        for own_rest_days, count in ((False, union), (True, own)):
            for c in (None, context):
                violations = validate_rest_days(state, plan, context=c, own_rest_days=own_rest_days)
                assert [(v.code, v.clinician_id, v.date_iso, v.slot_id) for v in violations] == [
                    (VIOLATION_REST_DAY, "clin-anna", THU, "ct-thu")] * count


@pytest.mark.parametrize("name", sorted(VALIDATORS) + sorted(SETTINGS_OVERRIDES))
def test_each_validator_is_identical_with_context(datasets, name):
    validator = {**VALIDATORS, **SETTINGS_OVERRIDES}[name]
    found = 0
    for state, plans in datasets:
        context = build_validation_context(state)
        for plan in plans:
            expected = validator(state, plan, None)
            assert validator(state, plan, context) == expected
            found += len(expected)
    assert found > 0 or name in SETTINGS_OVERRIDES


@pytest.mark.parametrize("name", sorted(VALIDATORS))
def test_context_of_another_state_is_rejected(name):
    state = make_swap_state([asg("a", "ct-mon", "2026-01-05", "clin-anna")])
    twin = state.model_copy(deep=True)
    with pytest.raises(ValueError, match="another AppState"):
        VALIDATORS[name](twin, twin.assignments, build_validation_context(state))


def test_validate_assignments_rejects_context_of_another_state():
    state = make_swap_state()
    with pytest.raises(ValueError, match="another AppState"):
        validate_assignments(state.model_copy(deep=True), [], context=build_validation_context(state))
