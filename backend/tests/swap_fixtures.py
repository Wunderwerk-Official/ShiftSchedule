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


def chained_plan(state: AppState, start: date, days: int, seed: int) -> AppState:
    """A dense plan in which people often hold touching shifts (multi-item blocks)."""
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
                cands = [c for c in state.clinicians if section_of.get(s.id) in c.qualifiedClassIds]
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
