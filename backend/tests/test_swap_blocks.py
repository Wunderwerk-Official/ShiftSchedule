"""Work blocks and swap units, plus the self-tests of swap_fixtures."""

from collections import defaultdict
from typing import Dict, Iterable, List, Tuple

import pytest

import backend.db as db
from backend.models import AppState, Assignment, Holiday, SolverSettings, VacationRange
from backend.state import _load_state, _normalize_state, _save_state
from backend.swaps.blocks import (
    SwapUnit,
    TimedItem,
    UnitError,
    abs_minute,
    blocks_on_date,
    build_blocks,
    date_of,
    instance_unit,
    is_hidden,
    local_iso,
    slot_fingerprint,
    unit_for,
    visible_items,
)
from backend.swaps.policy import open_slot
from backend.validation import build_validation_context

from .conftest import make_clinician, make_template_slot
from .swap_fixtures import (
    ALL_SECTIONS,
    BEN_VACATION_DAY,
    FRI,
    MON,
    SAT,
    SLOT_SHAPES,
    SUN,
    THU,
    TUE,
    WED,
    WHOLE_DAY,
    asg,
    make_swap_state,
    rich_swap_state,
)

ON_CALL = SolverSettings(onCallRestEnabled=True, onCallRestClassId="sec-oncall")


def _add_slot(state: AppState, slot_id: str, block_id: str, start: str, end: str, offset: int = 0) -> None:
    state.weeklyTemplate.locations[0].slots.append(make_template_slot(
        slot_id, col_band_id=f"col-{slot_id.rsplit('-', 1)[1]}", block_id=block_id,
        start_time=start, end_time=end, end_day_offset=offset,
    ))


def _unit(state: AppState, assignment_id: str, *, whole_day: bool = False) -> SwapUnit:
    vctx = build_validation_context(state)
    a = next(x for x in state.assignments if x.id == assignment_id)
    person = [x for x in state.assignments if x.clinicianId == a.clinicianId]
    return unit_for(vctx, person, a, whole_day=whole_day)


def _ids(items: Iterable[TimedItem]) -> List[str]:
    return [item.assignment.id for item in items]


def test_minute_axis_helpers_round_trip():
    start = abs_minute(THU, 20 * 60)
    assert date_of(start) == THU
    assert local_iso(start) == "2026-01-08T20:00"
    assert local_iso(start + 12 * 60) == "2026-01-09T08:00"


def test_touching_shifts_form_one_block():
    state = make_swap_state([asg("e", "early-mon", MON, "clin-anna"), asg("l", "late-mon", MON, "clin-anna")])
    unit = _unit(state, "l")
    (block,) = unit.blocks
    assert _ids(block.items) == ["e", "l"]
    assert block.minutes == unit.minutes == 540
    assert (local_iso(block.abs_start), local_iso(block.abs_end)) == ("2026-01-05T07:00", "2026-01-05T16:00")
    assert not unit.overnight
    assert unit.kind(ON_CALL) == "shift"


def test_night_and_next_morning_demo_form_one_overnight_block():
    state = make_swap_state([asg("n", "night-thu", THU, "clin-anna"), asg("d", "demo-fri", FRI, "clin-anna")])
    unit = _unit(state, "d")
    (block,) = unit.blocks
    assert _ids(block.items) == ["n", "d"]
    assert local_iso(block.abs_end) == "2026-01-09T08:00"
    assert block.overnight
    assert (block.start_date_iso, block.end_date_iso) == (THU, FRI)
    assert unit.start_date_iso == THU
    assert unit.dates == (THU, FRI)
    assert unit.instance_keys == {("night-thu", THU), ("demo-fri", FRI)}
    assert unit.kind(ON_CALL) == "duty"
    assert unit.primary_section == "sec-night"


def test_block_ending_at_midnight_is_not_overnight():
    state = make_swap_state([asg("x", "evening-mon", MON, "clin-anna")])
    _add_slot(state, "evening-mon", "block-day", "16:00", "00:00", offset=1)
    (block,) = _unit(state, "x").blocks
    assert block.end_date_iso == MON
    assert not block.overnight


def test_whole_day_bundles_every_block_starting_that_date():
    state = make_swap_state([
        asg("c", "ct-mon", MON, "clin-anna"),
        asg("n", "night-mon", MON, "clin-anna"),
        asg("w", "ct-wed", WED, "clin-anna"),
    ])
    single = _unit(state, "c")
    assert _ids(single.items) == ["c"]
    assert single.kind(ON_CALL) == "shift"

    whole = _unit(state, "c", whole_day=True)
    assert len(whole.blocks) == 2  # blocksOnDate
    assert _ids(whole.items) == ["c", "n"]
    assert whole.minutes == 8 * 60 + 12 * 60
    assert (local_iso(whole.abs_start), local_iso(whole.abs_end)) == ("2026-01-05T08:00", "2026-01-06T08:00")
    assert whole.overnight
    assert whole.kind(ON_CALL) == "duty"
    assert whole.primary_section == "sec-night"


def test_primary_section_tie_goes_to_the_earlier_item():
    state = make_swap_state([asg("l", "late-mon", MON, "clin-anna"),
                             asg("t", "ctlate-mon", MON, "clin-anna")])
    _add_slot(state, "ctlate-mon", "block-ct", "16:00", "20:00")
    unit = _unit(state, "t")
    assert _ids(unit.items) == ["l", "t"]
    assert unit.primary_section == "sec-day"


def test_on_call_section_makes_a_daytime_unit_a_duty():
    state = make_swap_state([asg("o", "oncallday-mon", MON, "clin-anna")])
    _add_slot(state, "oncallday-mon", "block-oncall", "08:00", "12:00")
    unit = _unit(state, "o")
    assert not unit.overnight
    assert unit.kind(ON_CALL) == "duty"
    assert unit.kind(SolverSettings(onCallRestEnabled=False, onCallRestClassId="sec-oncall")) == "shift"


def test_unit_errors_for_pool_rows_hidden_items_and_slots_without_times():
    anna = make_clinician("clin-anna", "Anna Weber", list(ALL_SECTIONS), working_hours_per_week=40,
                          vacations=[VacationRange(id="v", startISO=TUE, endISO=TUE)])
    state = make_swap_state(
        [
            asg("r", "pool-rest-day", MON, "clin-anna", locked=False),
            asg("h", "ct-tue", TUE, "clin-anna"),
            asg("b", "broken-mon", MON, "clin-anna"),
            asg("c", "ct-wed", WED, "clin-anna"),
        ],
        clinicians=[anna],
    )
    _add_slot(state, "broken-mon", "block-night", "20:00", "08:00")  # no day offset: end <= start
    codes = {}
    for assignment_id in ("r", "h", "b"):
        with pytest.raises(UnitError) as error:
            _unit(state, assignment_id)
        codes[assignment_id] = (error.value.code, error.value.message)
    assert codes == {
        "r": ("pool_row", "Rest Day and Vacation entries can't be swapped."),
        "h": ("vacation_hidden", "Anna Weber is on vacation on Tue 6 Jan; this shift is hidden. "
                                 "Use Find cover on the open slot instead."),
        "b": ("no_times", "This shift has no valid times in the template."),
    }
    vctx = build_validation_context(state)
    assert is_hidden(vctx, state.assignments[1])
    assert _ids(visible_items(vctx, state.assignments)) == ["c"]


def test_unit_needs_the_holders_own_assignments():
    state = make_swap_state([asg("a", "ct-mon", MON, "clin-anna"), asg("b", "ct-tue", TUE, "clin-ben")])
    vctx = build_validation_context(state)
    with pytest.raises(ValueError):
        unit_for(vctx, [state.assignments[1]], state.assignments[0], whole_day=False)


def test_slot_fingerprint_format():
    state = make_swap_state()
    _add_slot(state, "broken-mon", "block-night", "20:00", "08:00")
    vctx = build_validation_context(state)
    assert slot_fingerprint(vctx, "night-thu") == "1200-1920@loc-default#sec-night"
    assert slot_fingerprint(vctx, "demo-fri") == "435-465@loc-default#sec-demo"
    assert slot_fingerprint(vctx, "broken-mon") is None
    assert slot_fingerprint(vctx, "missing-slot") is None


def test_items_sort_by_start_then_longest_then_slot_then_id():
    state = make_swap_state([
        asg("b", "ct-mon", MON, "clin-anna"),
        asg("a", "ct-mon", MON, "clin-anna"),
        asg("o", "oncall-mon", MON, "clin-anna"),
        asg("e", "early-mon", MON, "clin-anna"),
    ])
    vctx = build_validation_context(state)
    items = visible_items(vctx, state.assignments)
    assert _ids(items) == ["e", "o", "a", "b"]
    assert _ids(build_blocks(list(reversed(items)))[0].items) == ["e", "o", "a", "b"]


def test_blocks_merge_across_midnight_and_are_found_by_start_date():
    state = make_swap_state([
        asg("n", "night-sun", SUN, "clin-anna"),
        asg("c", "ct-mon", "2026-01-12", "clin-anna"),
        asg("l", "late-mon", "2026-01-12", "clin-anna"),
    ])
    vctx = build_validation_context(state)
    blocks = build_blocks(visible_items(vctx, state.assignments))
    # The night ends Mon 08:00 where the CT shift starts; CT and late overlap at 12-16.
    assert [_ids(b.items) for b in blocks] == [["n", "c", "l"]]
    assert blocks_on_date(blocks, SUN) == blocks
    assert blocks_on_date(blocks, "2026-01-12") == []


def test_instance_unit_is_one_synthetic_item_without_holder():
    state = make_swap_state()
    _add_slot(state, "broken-mon", "block-night", "20:00", "08:00")
    vctx = build_validation_context(state)
    unit = instance_unit(vctx, "night-thu", THU)
    assert unit.clinician_id is None
    (item,) = unit.items
    assert (item.assignment, item.clinician_id) == (None, None)
    assert (item.section_id, item.minutes) == ("sec-night", 720)
    assert unit.kind(ON_CALL) == "duty"
    assert instance_unit(vctx, "broken-mon", MON) is None


# --- swap_fixtures self-tests ---------------------------------------------------


def _every_slot_kind_state() -> AppState:
    assignments = [asg(f"a-{prefix}", f"{prefix}-mon", MON, "clin-anna") for prefix in SLOT_SHAPES]
    assignments += [
        asg("b-night", "night-thu", THU, "clin-ben"),
        asg("b-demo", "demo-fri", FRI, "clin-ben"),
        asg("c-holiday", "ct-holiday", TUE, "clin-clara"),
        asg("d-rest", "pool-rest-day", FRI, "clin-dora", locked=False),
        asg("d-vacation", "pool-vacation", SAT, "clin-dora", source=None, locked=False),
    ]
    return make_swap_state(assignments, holidays=[Holiday(dateISO=TUE, name="Holiday")],
                           slot_overrides={f"ct-thu__{THU}": 1})


def _slots(state: AppState) -> List[dict]:
    return [slot.model_dump() for loc in state.weeklyTemplate.locations for slot in loc.slots]


FIXTURE_STATES = {"every slot kind": _every_slot_kind_state, "rich": rich_swap_state}


@pytest.mark.parametrize("name", sorted(FIXTURE_STATES))
def test_fixture_states_survive_normalization(name):
    state = FIXTURE_STATES[name]()
    normalized, _ = _normalize_state(state.model_copy(deep=True))
    assert normalized.assignments == state.assignments
    assert _slots(normalized) == _slots(state)
    assert len(_slots(state)) == 8 * len(SLOT_SHAPES)
    assert normalized.slotOverridesByKey == state.slotOverridesByKey
    assert normalized.solverRules == state.solverRules


@pytest.mark.parametrize("name", sorted(FIXTURE_STATES))
def test_fixture_states_survive_a_save_and_load_round_trip(name, tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "swaps.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    state = FIXTURE_STATES[name]()
    _save_state(state.model_copy(deep=True), "fixture-user")
    loaded = _load_state("fixture-user")
    assert loaded.assignments == state.assignments
    assert _slots(loaded) == _slots(state)


def test_rich_swap_state_holds_what_the_property_test_needs():
    state = rich_swap_state()
    vctx = build_validation_context(state)
    by_instance: Dict[Tuple[str, str], List[Assignment]] = defaultdict(list)
    for a in state.assignments:
        if not a.rowId.startswith("pool-"):
            by_instance[(a.rowId, a.dateISO)].append(a)

    hidden = [a for a in state.assignments if not a.rowId.startswith("pool-") and is_hidden(vctx, a)]
    assert hidden and {(a.clinicianId, a.dateISO) for a in hidden} == {("clin-ben", BEN_VACATION_DAY)}
    info = open_slot(vctx, by_instance, hidden[0].rowId, BEN_VACATION_DAY)
    assert info.is_open
    assert info.hidden == [hidden[0]]
    assert len(info.stored) + 1 <= info.target  # covering it may keep Ben's entry

    blocks_by_person = {
        c.id: build_blocks(visible_items(vctx, [a for a in state.assignments if a.clinicianId == c.id]))
        for c in state.clinicians
    }
    assert len(blocks_on_date(blocks_by_person["clin-dora"], WHOLE_DAY)) == 2
    assert any(len(b.items) > 1 for blocks in blocks_by_person.values() for b in blocks)
    assert any(a.rowId == "pool-rest-day" for a in state.assignments)
    assert [rule["id"] for rule in state.solverRules] == ["rule-off-after-night-thu"]
