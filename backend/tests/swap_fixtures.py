"""Test data for the swap assistant.

``make_swap_state`` builds a one-location template whose slots cover every
shape a swap meets: touching day shifts, an overnight night with its next
morning demo, and a 24 h on-call. It passes ``_normalize_state`` without
losing a slot or an assignment, so tests can seed it through ``_save_state``.
"""

import json
import random
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from backend.arena.generate_fixture import FIXTURE
from backend.models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    PreferredWorkingTime,
    SolverRule,
    TemplateBlock,
    TemplateRowBand,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
)
from backend.validation import (
    _build_slot_day_type_map,
    _build_slot_lookup,
    _build_slot_section_map,
    _day_type,
)

from .conftest import (
    DAY_TYPES,
    make_clinician,
    make_location,
    make_pool_row,
    make_template_col_band,
    make_template_slot,
    make_workplace_row,
)

# ISO week 2026-W02; the property and matching tests also use W03.
WEEK = ("2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11")
MON, TUE, WED, THU, FRI, SAT, SUN = WEEK
NOW = datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc)

SECTIONS = {
    "sec-day": "Day",
    "sec-ct": "CT",
    "sec-night": "Night duty",
    "sec-oncall": "On call",
    "sec-demo": "Demo",
}
ALL_SECTIONS = tuple(SECTIONS)

# slot prefix -> (block, start, end, endDayOffset)
SLOT_SHAPES = {
    "early": ("block-day", "07:00", "12:00", 0),
    "late": ("block-day", "12:00", "16:00", 0),
    "ct": ("block-ct", "08:00", "16:00", 0),
    "night": ("block-night", "20:00", "08:00", 1),
    "demo": ("block-demo", "07:15", "07:45", 0),
    "oncall": ("block-oncall", "08:00", "08:00", 1),
}

SWAP_SETTINGS: Dict[str, Any] = {
    "enforceSameLocationPerDay": False,
    "onCallRestEnabled": True,
    "onCallRestClassId": "sec-oncall",
    "onCallRestDaysBefore": 1,
    "onCallRestDaysAfter": 1,
    "preferContinuousShifts": True,
}


def asg(
    assignment_id: str,
    slot: str,
    date_iso: str,
    clinician_id: str,
    source: Optional[str] = "manual",
    locked: bool = True,
) -> Assignment:
    return Assignment(id=assignment_id, rowId=slot, dateISO=date_iso, clinicianId=clinician_id,
                      source=source, locked=locked)


def default_clinicians() -> List[Clinician]:
    return [
        make_clinician("clin-anna", "Anna Weber", list(ALL_SECTIONS), working_hours_per_week=40),
        make_clinician("clin-ben", "Ben Ott", list(ALL_SECTIONS), working_hours_per_week=40),
        make_clinician("clin-clara", "Clara Schmidt", ["sec-day", "sec-ct"], working_hours_per_week=40),
        make_clinician("clin-dora", "Dora Klein", list(ALL_SECTIONS)),
    ]


def make_swap_state(
    assignments: Iterable[Assignment] = (),
    clinicians: Optional[List[Clinician]] = None,
    solver_settings: Optional[Dict[str, Any]] = None,
    holidays: Optional[List[Holiday]] = None,
    slot_overrides: Optional[Dict[str, int]] = None,
) -> AppState:
    """The swap template (slot ids ``{prefix}-{dayType}``, all required once).

    ``solver_settings`` entries override ``SWAP_SETTINGS`` key by key.
    """
    slots = [
        make_template_slot(
            slot_id=f"{prefix}-{day_type}",
            col_band_id=f"col-{day_type}",
            block_id=block_id,
            start_time=start,
            end_time=end,
            end_day_offset=offset,
        )
        for day_type in DAY_TYPES
        for prefix, (block_id, start, end, offset) in SLOT_SHAPES.items()
    ]
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[
            TemplateBlock(id="block-day", sectionId="sec-day"),
            TemplateBlock(id="block-ct", sectionId="sec-ct"),
            TemplateBlock(id="block-night", sectionId="sec-night"),
            TemplateBlock(id="block-oncall", sectionId="sec-oncall"),
            TemplateBlock(id="block-demo", sectionId="sec-demo"),
        ],
        locations=[
            WeeklyTemplateLocation(
                locationId="loc-default",
                rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
                colBands=[make_template_col_band(f"col-{dt}", "", 1, dt) for dt in DAY_TYPES],
                slots=slots,
            )
        ],
    )
    return AppState(
        locations=[make_location()],
        locationsEnabled=True,
        rows=[make_workplace_row(section_id, name) for section_id, name in SECTIONS.items()]
        + [make_pool_row("pool-rest-day", "Rest Day"), make_pool_row("pool-vacation", "Vacation")],
        clinicians=clinicians if clinicians is not None else default_clinicians(),
        assignments=list(assignments),
        minSlotsByRowId={},
        slotOverridesByKey=dict(slot_overrides or {}),
        weeklyTemplate=template,
        holidays=list(holidays or []),
        solverSettings={**SWAP_SETTINGS, **(solver_settings or {})},
        solverRules=[],
    )


def arena_state() -> AppState:
    return AppState.model_validate(json.loads(FIXTURE.read_text())["state"])


def chained_plan(state: AppState, start: date, days: int, seed: int, *, fill: float = 1.0,
                 exclude: Sequence[str] = ()) -> AppState:
    """A dense plan in which people often hold touching shifts (multi-item blocks).
    With ``fill`` below 1 each position stays empty with probability 1 - fill;
    the ``exclude``d people get nothing. The defaults draw exactly the numbers
    of the dense plan."""
    rng = random.Random(seed)
    lookup = _build_slot_lookup(state)
    section_of = _build_slot_section_map(state)
    day_type_of = _build_slot_day_type_map(state)
    slots = [s for loc in state.weeklyTemplate.locations for s in loc.slots]
    out: List[Assignment] = []
    taken: Dict[Tuple[str, str], List[str]] = {}
    for i in range(days):
        iso = (start + timedelta(days=i)).isoformat()
        dt = _day_type(iso, state)
        day_slots = [s for s in slots if day_type_of.get(s.id) == dt and s.id in lookup]
        rng.shuffle(day_slots)
        for s in day_slots:
            for _ in range(max(1, s.requiredSlots or 0)):
                if fill < 1.0 and rng.random() >= fill:
                    continue
                cands = [c for c in state.clinicians
                         if section_of.get(s.id) in c.qualifiedClassIds and c.id not in exclude]
                rng.shuffle(cands)
                st, en, loc = lookup[s.id]

                def touches(c: Clinician) -> bool:
                    return any(lookup[o][2] == loc and (lookup[o][1] == st or lookup[o][0] == en)
                               for o in taken.get((c.id, iso), []))

                cands.sort(key=lambda c: (not touches(c), len(taken.get((c.id, iso), []))))
                for c in cands:
                    if s.id in taken.get((c.id, iso), []):
                        continue
                    taken.setdefault((c.id, iso), []).append(s.id)
                    out.append(Assignment(id=f"c{len(out)}", rowId=s.id, dateISO=iso,
                                          clinicianId=c.id, source="solver"))
                    break
    copy = state.model_copy(deep=True)
    copy.assignments = out
    return copy


def _rest_days_after_duties(assignments: Sequence[Assignment]) -> List[Assignment]:
    """A Rest Day the morning after every night and on-call, unless the holder works or rests then."""
    occupied = {(a.clinicianId, a.dateISO) for a in assignments if not a.rowId.startswith("pool-")}
    rests: List[Assignment] = []
    for a in assignments:
        if not a.rowId.startswith(("night-", "oncall-")):
            continue
        key = (a.clinicianId, (date.fromisoformat(a.dateISO) + timedelta(days=1)).isoformat())
        if key in occupied:
            continue
        occupied.add(key)
        rests.append(asg(f"rest-{len(rests)}", "pool-rest-day", key[1], key[0], locked=False))
    return rests


BEN_VACATION_DAY = "2026-01-08"
WHOLE_DAY = "2026-01-19"  # a Monday


def rich_swap_state(seed: int = 7) -> AppState:
    """The property test's third dataset: ten people, two dense weeks
    from MON, Rest Days after duties and one solver rule. Also:

    - Ben is on vacation on BEN_VACATION_DAY, where the seed gives him a shift, so
      it is hidden. Its instance's target is 2: covering it may keep his entry
      (every other target is 1, where removing a hidden entry is required).
    - Dora works early and night on WHOLE_DAY, after the dense weeks: two blocks
      starting on one date (a "Whole day" unit), which a chained plan never makes.
    """
    clinicians = default_clinicians() + [
        make_clinician(f"clin-e{n}", f"Eva {word}", list(ALL_SECTIONS), working_hours_per_week=40)
        for n, word in enumerate(("One", "Two", "Three", "Four", "Five", "Six"), start=1)
    ]
    state = chained_plan(make_swap_state(clinicians=clinicians), start=date.fromisoformat(MON), days=14,
                         seed=seed)
    work = state.assignments + [
        asg("whole-day-early", "early-mon", WHOLE_DAY, "clin-dora"),
        asg("whole-day-night", "night-mon", WHOLE_DAY, "clin-dora"),
    ]
    state.assignments = work + _rest_days_after_duties(work)
    ben = next(c for c in state.clinicians if c.id == "clin-ben")
    ben.vacations.append(VacationRange(id="vac-ben", startISO=BEN_VACATION_DAY, endISO=BEN_VACATION_DAY))
    hidden = next((a for a in work if a.clinicianId == "clin-ben" and a.dateISO == BEN_VACATION_DAY), None)
    if hidden is None:
        raise ValueError(f"Seed {seed} gives Ben no shift on {BEN_VACATION_DAY}; choose another seed.")
    state.slotOverridesByKey = {f"{hidden.rowId}__{hidden.dateISO}": 1}
    state.solverRules = [
        SolverRule(id="rule-off-after-night-thu", name="Off after Thursday night",
                   ifShiftRowId="night-thu", dayDelta=1, thenType="off").model_dump()
    ]
    return state


# The fourth property dataset (wide_swap_state): rules that reach far from a
# moved date, and a block longer than any margin.
WIDE_SETTINGS: Dict[str, Any] = {
    "enforceSameLocationPerDay": True,
    "onCallRestDaysBefore": 3,
    "onCallRestDaysAfter": 7,
    "preferContinuousShifts": False,
}
# slot prefix -> (block, start, end, endDayOffset) at the second location
NORTH_SHAPES = {
    "north": ("block-day", "09:00", "17:00", 0),
    "ward": ("block-ward", "08:00", "08:00", 1),  # 24 h, not on-call: no rest days around it
    "long": ("block-night", "18:00", "06:00", 2),  # 36 h, ends two days after its date
}
WIDE_PLAN_START, WIDE_PLAN_DAYS = "2026-01-05", 21
STRETCH_HOLDER, STRETCH_START, STRETCH_DAYS = "clin-e6", "2026-01-01", 14
BEFORE_STRETCH_DAY = "2025-12-29"  # the Monday of the week the stretch starts in
TOUCHING_STRETCH_DAY = "2026-01-15"  # the stretch ends Thu 15 Jan 08:00
CROSSING_STRETCH_DAY = "2026-01-21"  # its ISO week's slice window starts inside the stretch
WIDE_WHOLE_DAY = "2026-01-26"  # a Monday
CAPACITY_DAY = "2026-01-27"  # a Tuesday
REST_CALL_DAY, REST_CLASH_DAY = "2026-02-02", "2026-02-09"  # Mondays: the 7th rest day is in the next ISO week


def _add_north_location(state: AppState) -> None:
    """A second location (NORTH_SHAPES) and the Ward section of its 24 h duty."""
    state.locations.append(make_location("loc-north", "North"))
    state.rows.insert(len(SECTIONS), make_workplace_row("sec-ward", "Ward"))
    template = state.weeklyTemplate
    template.blocks.append(TemplateBlock(id="block-ward", sectionId="sec-ward"))
    template.locations.append(WeeklyTemplateLocation(
        locationId="loc-north",
        rowBands=[TemplateRowBand(id="row-1", label="Row 1", order=1)],
        colBands=[make_template_col_band(f"north-col-{dt}", "", 1, dt) for dt in DAY_TYPES],
        slots=[make_template_slot(slot_id=f"{prefix}-{dt}", location_id="loc-north", col_band_id=f"north-col-{dt}",
                                  block_id=block_id, start_time=start, end_time=end, end_day_offset=offset)
               for dt in DAY_TYPES for prefix, (block_id, start, end, offset) in NORTH_SHAPES.items()],
    ))


def _weekday_slot(prefix: str, date_iso: str) -> str:
    return f"{prefix}-{('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')[date.fromisoformat(date_iso).weekday()]}"


def wide_swap_state(seed: int = 5) -> AppState:
    """The property test's fourth dataset, where a narrow slice would fail:

    - on-call rest 3 days before and 7 after, a 36 h duty that ends two days
      after its date, two locations with enforceSameLocationPerDay and Clara's
      mandatory 07:00–15:00 on Thursdays: rules that reach far from a moved date;
    - preferContinuousShifts off, so a Whole-day unit can be valid: Dora works
      early and night on WIDE_WHOLE_DAY;
    - Eva Six (no contract hours) holds the 24 h ward duty every day from
      STRETCH_START, one 336 h block, and works the night of the day it ends;
      Eva Five (left out of the random plan) works CT before it in its first
      week, on the day it ends and in the week after;
    - Ben is on call on REST_CALL_DAY, and Eva Five works CT on REST_CLASH_DAY,
      seven days later, at the far end of the slice margin;
    - ct-tue on CAPACITY_DAY has target 2, held by Clara and by Ben, whose
      vacation hides it: covering it without removing Ben overfills it.

    A sparse plan of three weeks from WIDE_PLAN_START fills the rest.
    """
    clinicians = default_clinicians() + [
        make_clinician(f"clin-e{n}", f"Eva {word}", list(ALL_SECTIONS) + ["sec-ward"],
                       working_hours_per_week=None if n == 6 else 40)
        for n, word in enumerate(("One", "Two", "Three", "Four", "Five", "Six"), start=1)
    ]
    for clinician in clinicians[:2]:  # Anna and Ben also take ward duties
        clinician.qualifiedClassIds.append("sec-ward")
    clara = next(c for c in clinicians if c.id == "clin-clara")
    clara.preferredWorkingTimes = {"thu": PreferredWorkingTime(startTime="07:00", endTime="15:00",
                                                               requirement="mandatory")}
    base = make_swap_state(clinicians=clinicians, solver_settings=WIDE_SETTINGS,
                           holidays=[Holiday(dateISO="2026-01-19", name="Holiday")],
                           slot_overrides={f"ct-tue__{CAPACITY_DAY}": 1})
    _add_north_location(base)
    state = chained_plan(base, start=date.fromisoformat(WIDE_PLAN_START), days=WIDE_PLAN_DAYS, seed=seed,
                         fill=0.45, exclude=(STRETCH_HOLDER, "clin-e5"))
    stretch_start = date.fromisoformat(STRETCH_START)
    stretch = [(stretch_start + timedelta(days=k)).isoformat() for k in range(STRETCH_DAYS)]
    state.assignments += [asg(f"stretch-{k}", _weekday_slot("ward", day), day, STRETCH_HOLDER)
                          for k, day in enumerate(stretch)] + [
        asg("after-stretch", _weekday_slot("night", TOUCHING_STRETCH_DAY), TOUCHING_STRETCH_DAY, STRETCH_HOLDER),
        asg("before-stretch", _weekday_slot("ct", BEFORE_STRETCH_DAY), BEFORE_STRETCH_DAY, "clin-e5"),
        asg("touching-stretch", _weekday_slot("ct", TOUCHING_STRETCH_DAY), TOUCHING_STRETCH_DAY, "clin-e5"),
        asg("crossing-stretch", _weekday_slot("ct", CROSSING_STRETCH_DAY), CROSSING_STRETCH_DAY, "clin-e5"),
        asg("wide-day-early", "early-mon", WIDE_WHOLE_DAY, "clin-dora"),
        asg("wide-day-night", "night-mon", WIDE_WHOLE_DAY, "clin-dora"),
        asg("capacity-visible", "ct-tue", CAPACITY_DAY, "clin-clara"),
        asg("capacity-hidden", "ct-tue", CAPACITY_DAY, "clin-ben"),
        asg("rest-call", _weekday_slot("oncall", REST_CALL_DAY), REST_CALL_DAY, "clin-ben"),
        asg("rest-clash", _weekday_slot("ct", REST_CLASH_DAY), REST_CLASH_DAY, "clin-e5"),
    ]
    ben = next(c for c in state.clinicians if c.id == "clin-ben")
    ben.vacations.append(VacationRange(id="vac-ben-wide", startISO=CAPACITY_DAY, endISO=CAPACITY_DAY))
    return state


# The fifth property dataset (rest_swap_state): Rest Days in every shape the
# REST_DAY rule meets.
REST_PAIR_EVERY = 6  # every sixth shift of the dense weeks has a Rest Day of its holder that day
REST_DUPLICATE_EVERY = 3  # every third Rest Day after a duty is stored twice
FOLLOW_NIGHT_DAY, FOLLOW_REST_DAY = "2026-01-27", "2026-01-28"  # a Tuesday night and the Wednesday after
CO_HOLDER_DAY = "2026-01-29"  # a Thursday


def rest_swap_state(seed: int = 7) -> AppState:
    """The property test's fifth dataset: rich_swap_state with Rest Days in
    every shape the REST_DAY rule meets:

    - pre-existing pairs: every REST_PAIR_EVERY-th shift of the dense weeks
      has a Rest Day of its holder on the same day, so the calendar already
      breaks REST_DAY there;
    - duplicates: every REST_DUPLICATE_EVERY-th Rest Day after a duty is
      stored twice;
    - Eva One works the night of FOLLOW_NIGHT_DAY and rests on FOLLOW_REST_DAY,
      when Eva Two, on vacation, holds a hidden late shift: handing her the
      night must not move the Rest Day onto that shift;
    - ct-thu on CO_HOLDER_DAY has target 2, held by Anna, who rests that day
      too, and by Ben, whose vacation hides it: a cover's slice must see
      Anna's Rest Day.
    """
    state = rich_swap_state(seed)
    work = [a for a in state.assignments if not a.rowId.startswith("pool-")]
    rests = [a for a in state.assignments if a.rowId == "pool-rest-day"]
    resting = {(a.clinicianId, a.dateISO) for a in rests}
    pairs: List[Assignment] = []
    for k, a in enumerate(work):
        if k % REST_PAIR_EVERY == 0 and (a.clinicianId, a.dateISO) not in resting:
            resting.add((a.clinicianId, a.dateISO))
            pairs.append(asg(f"rest-pair-{k}", "pool-rest-day", a.dateISO, a.clinicianId, locked=False))
    duplicates = [asg(f"{a.id}-twice", "pool-rest-day", a.dateISO, a.clinicianId, locked=False)
                  for k, a in enumerate(rests) if k % REST_DUPLICATE_EVERY == 0]
    state.assignments = state.assignments + pairs + duplicates + [
        asg("follow-night", "night-tue", FOLLOW_NIGHT_DAY, "clin-e1"),
        asg("follow-rest", "pool-rest-day", FOLLOW_REST_DAY, "clin-e1", locked=False),
        asg("follow-hidden", "late-wed", FOLLOW_REST_DAY, "clin-e2"),
        asg("co-holder", "ct-thu", CO_HOLDER_DAY, "clin-anna"),
        asg("co-holder-rest", "pool-rest-day", CO_HOLDER_DAY, "clin-anna", locked=False),
        asg("co-holder-hidden", "ct-thu", CO_HOLDER_DAY, "clin-ben"),
    ]
    away = {"clin-e2": FOLLOW_REST_DAY, "clin-ben": CO_HOLDER_DAY}
    for clinician in state.clinicians:
        if clinician.id in away:
            clinician.vacations.append(VacationRange(id=f"vac-rest-{clinician.id}", startISO=away[clinician.id],
                                                     endISO=away[clinician.id]))
    state.slotOverridesByKey[f"ct-thu__{CO_HOLDER_DAY}"] = 1
    return state
