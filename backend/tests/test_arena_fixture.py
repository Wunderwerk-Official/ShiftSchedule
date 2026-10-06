"""The published benchmark fixture must be reproducible without personnel data."""
from copy import deepcopy
import json

from backend.arena.generate_fixture import FIXTURE, FIXTURE_VERSION, generate
from backend.models import AppState
from backend.validation import validate_assignments


def test_fixture_is_reproducible_and_all_assignments_are_valid():
    fixture = json.loads(FIXTURE.read_text())
    assert fixture["synthetic"] is True
    assert fixture["fixtureVersion"] == FIXTURE_VERSION
    assert generate(fixture["state"]) == fixture
    state = AppState.model_validate(fixture["state"])
    assert (len(state.locations), len(state.rows), len(state.clinicians)) == (4, 35, 24)
    slots = [s for loc in state.weeklyTemplate.locations for s in loc.slots]
    assert len(slots) == 163
    assert [c.id for c in state.clinicians] == [f"clinician-{i:02d}" for i in range(1, 25)]
    assert [c.name for c in state.clinicians] == [f"Clinician {i:02d}" for i in range(1, 25)]
    assert validate_assignments(state, state.assignments).is_valid
    assert len(state.assignments) > 100
    assert {a.source for a in state.assignments} == {"manual", "solver"}
    assert {"2026-02-01", "2026-02-08", "2026-02-15", "2026-02-22"} <= {a.dateISO for a in state.assignments if a.locked}
    assert sum(any(v.startISO <= "2026-02-16" <= v.endISO for v in c.vacations) for c in state.clinicians) == 9
    assert {20, 24, 32, 36, 40} <= {c.workingHoursPerWeek for c in state.clinicians}
    sections = {b.id: b.sectionId for b in state.weeklyTemplate.blocks}
    required = {sections[s.blockId] for s in slots if s.requiredSlots > 0}
    qualified_count = {section: sum(section in c.qualifiedClassIds for c in state.clinicians) for section in required}
    assert min(qualified_count.values()) == 2
    # synthetic-v3: exactly one rare required section with two specialists;
    # every other required section can be staffed by at least 10 of the 24.
    rare = {section for section, count in qualified_count.items() if count == 2}
    assert len(rare) == 1
    assert min(count for section, count in qualified_count.items() if section not in rare) >= 10
    # Every clinician is employable: no empty lists, and at least six ordinary
    # (non-duty, non-rare) qualifications each. synthetic-v2 keyed the groups by
    # the section's location and left 8 clinicians with none and 5 with one.
    duty = state.solverSettings["onCallRestClassId"]
    ordinary = {r.id for r in state.rows if r.kind == "class" and r.id != duty} - rare
    assert all(c.qualifiedClassIds for c in state.clinicians)
    ordinary_counts = [len(set(c.qualifiedClassIds) & ordinary) for c in state.clinicians]
    assert min(ordinary_counts) >= 6
    assert ordinary_counts[:4] == [len(ordinary)] * 4  # four all-rounders
    assert all(len(c.qualifiedClassIds) == len(set(c.qualifiedClassIds)) for c in state.clinicians)
    # Benchmark weeks: every required slot except the rare section's has at
    # least three clinicians who are both qualified and not on vacation.
    from backend.scoring import build_scoring_context
    for start, end in (("2026-02-02", "2026-02-06"), ("2026-02-16", "2026-02-20")):
        ctx = build_scoring_context(state, start, end, only_fill_required=True)
        for instance in ctx.instances.values():
            if instance.target <= 0 or instance.section_id in rare:
                continue
            eligible = sum(instance.section_id in c.qualifiedClassIds
                           and not any(v.startISO <= instance.date_iso <= v.endISO for v in c.vacations)
                           for c in state.clinicians)
            assert eligible >= 3, (instance.slot_key, instance.date_iso, eligible)


def test_generator_ignores_personnel_calendars_and_untrusted_free_text():
    fixture = json.loads(FIXTURE.read_text())
    structure = deepcopy(fixture["state"])
    for key in ("clinicians", "assignments", "holidays", "solverRules", "publishedWeekStartISOs",
                "minSlotsByRowId", "slotOverridesByKey"):
        structure[key] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    structure["solverSettings"]["agentInstructions"] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    for row in structure["rows"]:
        row["name"] = row["planningWishes"] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    for loc in structure["locations"]:
        loc["name"] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    for block in structure["weeklyTemplate"]["blocks"]:
        block["label"] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    for loc in structure["weeklyTemplate"]["locations"]:
        for band in loc["rowBands"] + loc["colBands"]:
            band["label"] = "PRIVATE_INPUT_MUST_NOT_SURVIVE"
    assert generate(structure) == fixture
