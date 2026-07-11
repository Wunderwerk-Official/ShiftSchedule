"""The arena's scenario transforms must stay deterministic — the README
compares rounds across weeks of work, which only holds if e.g. 'crunch'
always removes the same clinicians for the same range."""

from backend.arena.run import apply_scenario, load_state

CARNIVAL_START, CARNIVAL_END = "2026-02-16", "2026-02-20"


def _on_vacation(c, start, end):
    return any(v.startISO <= end and v.endISO >= start for v in (c.vacations or []))


def test_crunch_removes_two_most_flexible_available_clinicians():
    state = load_state()
    before = {c.id: c for c in state.clinicians}
    desc = apply_scenario(state, "crunch", CARNIVAL_START, CARNIVAL_END)
    removed = [before[cid] for cid in before if cid not in {c.id for c in state.clinicians}]
    assert len(removed) == 2
    # Only clinicians who were actually available (not on vacation) drop out,
    # and they are the most-flexible ones among those.
    assert all(not _on_vacation(c, CARNIVAL_START, CARNIVAL_END) for c in removed)
    available_quals = sorted(
        (
            len(c.qualifiedClassIds or [])
            for c in before.values()
            if (c.qualifiedClassIds or [])
            and not _on_vacation(c, CARNIVAL_START, CARNIVAL_END)
        ),
        reverse=True,
    )
    assert sorted((len(c.qualifiedClassIds or []) for c in removed), reverse=True) == available_quals[:2]
    assert all(c.name in desc for c in removed)
    # Their assignments are gone too.
    gone = {c.id for c in removed}
    assert not any(a.clinicianId in gone for a in state.assignments)


def test_oncall_scenario_requires_duty_and_clears_in_range_cover():
    state = load_state()
    on_call_class = state.solverSettings["onCallRestClassId"]
    blocks = {b.id for b in state.weeklyTemplate.blocks if b.sectionId == on_call_class}
    slot_ids = {
        s.id
        for loc in state.weeklyTemplate.locations
        for s in loc.slots
        if s.blockId in blocks
    }
    assert slot_ids, "fixture must contain on-call template slots"
    in_range_before = [
        a for a in state.assignments
        if a.rowId in slot_ids and CARNIVAL_START <= a.dateISO <= CARNIVAL_END
    ]
    out_of_range_before = [
        a for a in state.assignments
        if a.rowId in slot_ids and not (CARNIVAL_START <= a.dateISO <= CARNIVAL_END)
    ]

    apply_scenario(state, "oncall", CARNIVAL_START, CARNIVAL_END)

    for loc in state.weeklyTemplate.locations:
        for s in loc.slots:
            if s.id in slot_ids:
                assert s.requiredSlots == 1
    remaining = [a for a in state.assignments if a.rowId in slot_ids]
    assert not any(CARNIVAL_START <= a.dateISO <= CARNIVAL_END for a in remaining)
    # Out-of-range on-call cover (context for rest-day checks) is untouched.
    assert len(remaining) == len(out_of_range_before)


def test_pinned_scenario_books_anchors_deterministically():
    state = load_state()
    n_before = len(state.assignments)
    desc = apply_scenario(state, "pinned", CARNIVAL_START, CARNIVAL_END)
    pins = [a for a in state.assignments if a.id.startswith("arena-pin-")]
    assert len(state.assignments) == n_before + len(pins)
    assert pins, "carnival week must produce anchor bookings"
    assert all(a.source == "manual" for a in pins)
    assert all(CARNIVAL_START <= a.dateISO <= CARNIVAL_END for a in pins)
    # Max two anchors per day, distinct clinicians within a day.
    from collections import Counter
    per_day = Counter(a.dateISO for a in pins)
    assert all(count <= 2 for count in per_day.values())
    for date_iso in per_day:
        day_pins = [a for a in pins if a.dateISO == date_iso]
        assert len({a.clinicianId for a in day_pins}) == len(day_pins)
    assert str(len(pins)) in desc
    # Deterministic: same transform twice -> same pins.
    state2 = load_state()
    apply_scenario(state2, "pinned", CARNIVAL_START, CARNIVAL_END)
    pins2 = sorted(
        (a.id, a.clinicianId) for a in state2.assignments if a.id.startswith("arena-pin-")
    )
    assert pins2 == sorted((a.id, a.clinicianId) for a in pins)


def test_daynight_scenario_splits_weekend_oncall():
    state = load_state()
    desc = apply_scenario(state, "daynight", "2026-02-16", "2026-02-22")
    on_call_class = state.solverSettings["onCallRestClassId"]
    blocks = {b.id for b in state.weeklyTemplate.blocks if b.sectionId == on_call_class}
    day_slots = []
    night_slots = []
    for loc in state.weeklyTemplate.locations:
        for s in loc.slots:
            if s.blockId in blocks:
                if s.id.endswith("-night"):
                    night_slots.append(s)
                elif s.startTime == "08:00":
                    day_slots.append(s)
    assert night_slots, "weekend on-call must gain night duties"
    assert len(day_slots) == len(night_slots)
    for s in night_slots:
        assert (s.startTime, s.endTime, s.endDayOffset) == ("20:00", "08:00", 1)
        assert s.requiredSlots == 1
    for s in day_slots:
        assert (s.endTime, s.endDayOffset) == ("20:00", 0)
        assert s.requiredSlots == 1
    assert "night slots added" in desc
