"""Rebuild the arena's synthetic people and calendar from structural fields only.

No clinician, assignment, vacation, preference, holiday, or free-text value is
read from the input. The allowlisted template layout/times/capacities retain a
large scheduling problem; all identifiers and labels are regenerated too.
Run ``python -m backend.arena.generate_fixture`` to reproduce fixture version 2.
"""
from collections import defaultdict
from datetime import date, timedelta
import json
from pathlib import Path

from backend.models import AppState, Assignment
from backend.validation import validate_assignments

FIXTURE_VERSION = "synthetic-v2"
FIXTURE = Path(__file__).with_name("fixture_complex.json")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def generate(structure):
    location_ids = {loc["id"]: f"site-{i:02d}" for i, loc in enumerate(structure["locations"], 1)}
    section_ids = {row["id"]: f"section-{i:02d}" for i, row in enumerate(
        (row for row in structure["rows"] if row["kind"] == "class"), 1)}
    duty_section = section_ids[structure["solverSettings"]["onCallRestClassId"]]
    rows = [{"id": section_ids[row["id"]], "name": "On-call duty" if section_ids[row["id"]] == duty_section else f"Section {i:02d}",
             "kind": "class", "locationId": location_ids[row["locationId"]],
             "dotColorClass": "bg-blue-500", "blockColor": "#3b82f6", "subShifts": []}
            for i, row in enumerate((r for r in structure["rows"] if r["kind"] == "class"), 1)]
    rows += [{"id": row_id, "name": name, "kind": "pool", "dotColorClass": "bg-gray-400", "subShifts": []}
             for row_id, name in (("pool-rest-day", "Rest day"), ("pool-vacation", "Vacation"))]
    original = structure["weeklyTemplate"]
    block_ids = {b["id"]: f"block-{i:02d}" for i, b in enumerate(original["blocks"], 1)}
    blocks = [{"id": block_ids[b["id"]], "sectionId": section_ids[b["sectionId"]],
               "label": "On-call duty" if section_ids[b["sectionId"]] == duty_section else f"Block {i:02d}",
               "requiredSlots": b["requiredSlots"], "color": "#3b82f6"}
              for i, b in enumerate(original["blocks"], 1)]
    locations = []
    for loc in original["locations"]:
        lid = location_ids[loc["locationId"]]
        bands = {r["id"]: f"{lid}-row-{i:02d}" for i, r in enumerate(loc["rowBands"], 1)}
        cols = {c["id"]: f"{lid}-col-{i:02d}" for i, c in enumerate(loc["colBands"], 1)}
        locations.append({"locationId": lid,
            "rowBands": [{"id": bands[r["id"]], "order": r["order"], "label": f"Row {i:02d}"}
                         for i, r in enumerate(loc["rowBands"], 1)],
            "colBands": [{"id": cols[c["id"]], "order": c["order"], "dayType": c["dayType"], "label": f"Column {i:02d}"}
                         for i, c in enumerate(loc["colBands"], 1)],
            "slots": [{"id": f"{lid}-slot-{i:03d}", "locationId": lid,
                       "rowBandId": bands[s["rowBandId"]], "colBandId": cols[s["colBandId"]],
                       "blockId": block_ids[s["blockId"]], **{k: s.get(k) for k in
                           ("requiredSlots", "startTime", "endTime", "endDayOffset")}}
                      for i, s in enumerate(loc["slots"], 1)]})

    by_site = defaultdict(list)
    for row in rows:
        if row["kind"] == "class" and row["id"] != duty_section:
            by_site[row["locationId"]].append(row["id"])
    all_sections = [r["id"] for r in rows if r["kind"] == "class" and r["id"] != duty_section]
    # One required section has only two specialists: scarcity is intentional.
    sections_by_block = {b["id"]: b["sectionId"] for b in blocks}
    required_sections = {sections_by_block[s["blockId"]] for loc in locations for s in loc["slots"] if s["requiredSlots"] > 0}
    rare_section = next(b["sectionId"] for b in reversed(blocks)
                        if b["sectionId"] != duty_section and b["sectionId"] in required_sections)
    clinicians = []
    sites = list(location_ids.values())
    for i in range(24):
        cid = f"clinician-{i + 1:02d}"
        qualified = list(all_sections) if i < 4 else list(by_site[sites[i % len(sites)]])
        if i >= 4 and i % 3 == 0:
            qualified += by_site[sites[(i + 1) % len(sites)]]
        qualified = [s for s in qualified if s != rare_section]
        if i in (16, 20):
            qualified.append(rare_section)
        if i < 4 or i % 3 == 0:
            qualified.append(duty_section)
        vacations = []
        if i < 9:
            vacations.append({"id": f"vacation-{i + 1:02d}-crunch", "startISO": "2026-02-16", "endISO": "2026-02-20"})
        summer = date(2026, 6, 1) + timedelta(days=(i % 8) * 7)
        vacations.append({"id": f"vacation-{i + 1:02d}-summer", "startISO": summer.isoformat(),
                          "endISO": (summer + timedelta(days=4)).isoformat()})
        clinicians.append({"id": cid, "name": f"Clinician {i + 1:02d}", "qualifiedClassIds": list(dict.fromkeys(qualified)),
                           "preferredClassIds": qualified[:2], "vacations": vacations,
                           "workingHoursPerWeek": (40, 36, 32, 24, 20, 40)[i % 6], "workingHoursToleranceHours": 5,
                           "preferredWorkingTimes": {day: {"startTime": "08:00", "endTime": "16:00" if i % 6 < 3 else "14:00",
                                                          "requirement": "preference"} for day in WEEKDAYS[:5]}})
    state = AppState.model_validate({"locations": [{"id": lid, "name": f"Site {i:02d}"} for i, lid in enumerate(sites, 1)],
        "locationsEnabled": True, "rows": rows, "clinicians": clinicians, "assignments": [],
        "minSlotsByRowId": {sid: {"weekday": 0, "weekend": 0} for sid in section_ids.values()},
        "slotOverridesByKey": {}, "weeklyTemplate": {"version": 4, "blocks": blocks, "locations": locations},
        "holidayCountry": None, "holidayYear": 2026,
        "holidays": [{"dateISO": d, "name": "Synthetic holiday"} for d in
                     ("2026-01-01", "2026-04-03", "2026-04-06", "2026-12-25")],
        "publishedWeekStartISOs": [], "solverSettings": {
            "enforceSameLocationPerDay": True, "onCallRestEnabled": True, "onCallRestClassId": duty_section,
            "onCallRestDaysBefore": 1, "onCallRestDaysAfter": 1, "preferContinuousShifts": True}, "solverRules": []})
    _synthetic_history(state, duty_section)
    return {"version": 1, "fixtureVersion": FIXTURE_VERSION, "synthetic": True,
            "generator": "backend.arena.generate_fixture", "state": state.model_dump(exclude_none=True)}


def _synthetic_history(state, duty_section):
    blocks = {b.id: b.sectionId for b in state.weeklyTemplate.blocks}
    cols = {c.id: c.dayType for loc in state.weeklyTemplate.locations for c in loc.colBands}
    slots = [s for loc in state.weeklyTemplate.locations for s in loc.slots]
    holidays = {h.dateISO for h in state.holidays}

    def candidates(day, duty):
        day_type = "holiday" if day.isoformat() in holidays else WEEKDAYS[day.weekday()]
        return [s for s in slots if cols[s.colBandId] == day_type
                and (blocks[s.blockId] == duty_section) == duty and (duty or s.requiredSlots > 0)]

    def add(slot, day, clinician, *, fixed):
        if blocks[slot.blockId] not in clinician.qualifiedClassIds:
            return False
        assignment = Assignment(id=f"synthetic-{slot.id}-{day.isoformat()}-{clinician.id}", rowId=slot.id,
                                dateISO=day.isoformat(), clinicianId=clinician.id,
                                source="manual" if fixed else "solver", locked=fixed)
        # Optional template duties need an explicit dated target to hold
        # their fixed booking without a baseline capacity violation.
        override_key = f"{slot.id}__{day.isoformat()}"
        if fixed:
            state.slotOverridesByKey[override_key] = 1
        if not validate_assignments(state, state.assignments + [assignment]).is_valid:
            if fixed:
                state.slotOverridesByKey.pop(override_key, None)
            return False
        state.assignments.append(assignment)
        return True

    # Fixed duties include both sides of the February benchmark weeks.
    for offset in range(60):
        day = date(2026, 1, 1) + timedelta(days=offset)
        rotated = state.clinicians[offset % 24:] + state.clinicians[:offset % 24]
        for slot in candidates(day, duty=True):
            for clinician in rotated:
                if add(slot, day, clinician, fixed=True):
                    break
    # Entirely generated prior workload, with intentionally uneven totals.
    # One daytime assignment per person/day; validation preserves rest,
    # capacity, weekly caps and every other hard constraint.
    for offset in range(26):
        day = date(2026, 1, 5) + timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        rotated = state.clinicians[offset % 24:] + state.clinicians[:offset % 24]
        for clinician in rotated[:14]:
            for slot in candidates(day, duty=False):
                if add(slot, day, clinician, fixed=False):
                    break


def main():
    fixture = generate(json.loads(FIXTURE.read_text())["state"])
    FIXTURE.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    print(f"Generated {FIXTURE_VERSION}: {len(fixture['state']['clinicians'])} synthetic clinicians, "
          f"{len(fixture['state']['assignments'])} synthetic assignments.")


if __name__ == "__main__":
    main()
