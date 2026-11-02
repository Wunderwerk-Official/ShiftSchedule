"""Bounded CP-SAT candidate search, always checked by the shared move gate.

The candidate model is a relaxation of the complete rule set. Its solve
status is deliberately not exposed as proof about the whole schedule.
Invalid candidates are excluded exactly, including unselected variables,
so adding a gap-filling assignment remains possible after a split rejection.
"""
from collections import defaultdict
from datetime import date
from itertools import combinations
import time

from ortools.sat.python import cp_model


def repair_neighborhood(executor, arguments):
    if not executor.ctx.settings.agentNeighborhoodSearch:
        return {"error": "Extended neighborhood search is disabled in this run's settings."}
    focus = arguments.get("dateISO")
    days = executor.ctx.target_day_isos
    if focus not in days:
        return {"error": "Choose a dateISO inside the planning range."}
    seconds = min(10.0, max(0.1, float(arguments.get("seconds", 4))))
    remaining = executor._tool_seconds_left() - 5
    if remaining <= 0:
        return {"proposals": [], "search_status": "budget_exhausted", "not_searched": [focus]}
    deadline = time.monotonic() + min(seconds, remaining)
    max_changes = min(12, max(1, int(arguments.get("max_changes", 8))))
    index = days.index(focus)
    local_days = days[max(0, index-1):index+2]
    local_slots = [inst for inst in executor.ctx.instances.values() if inst.date_iso in local_days]
    scope = {"days": local_days, "max_changes": max_changes, "seconds": seconds,
             "max_candidates": 12, "goal": "improve coverage, then preserve existing assignments"}
    result = {"proposals": [], "search_scope": scope, "evaluated_plans": 0,
              "note": "This bounded search covers at most three days. No result is a proof of global infeasibility or optimality. Fixed entries and all outside context remain protected."}
    if len(local_slots) > 120:
        return {**result, "search_status": "incomplete", "not_searched": local_days,
                "note": "Neighborhood exceeds 120 slot instances; use a smaller planning range."}

    original = dict(executor.current)
    base = {key: assignment for key, assignment in original.items() if key[1] not in local_days}
    baseline = executor._full_plan(list(base.values()))
    counts = executor._counts_by_instance(list(base.values()))
    model = cp_model.CpModel()
    variables = {}
    by_slot = defaultdict(list)
    by_person = defaultdict(list)

    def absolute(inst):
        offset = date.fromisoformat(inst.date_iso).toordinal()*1440
        return offset + inst.start, offset + inst.end

    for inst in local_slots:
        if time.monotonic() >= deadline:
            return {**result, "search_status": "incomplete", "not_searched": local_days}
        for clinician in executor.state.clinicians:
            identity = (inst.slot_id, inst.date_iso, clinician.id)
            if identity in executor.fixed_identity:
                continue
            if inst.section_id not in clinician.qualifiedClassIds:
                continue
            if any(v.startISO <= inst.date_iso <= v.endISO for v in clinician.vacations):
                continue
            if (clinician.id, inst.date_iso) in executor.manual_rest_days:
                continue
            window = executor.ctx.window_by_clinician_date.get((clinician.id, inst.date_iso))
            if window and window[0] == "mandatory" and not (inst.start >= window[1] and inst.end <= window[2]):
                continue
            var = model.new_bool_var(f"x{len(variables)}")
            variables[identity] = var
            by_slot[inst.slot_key].append(var)
            by_person[clinician.id].append((inst, var))
    if len(variables) > 1800:
        return {**result, "search_status": "incomplete", "not_searched": local_days,
                "note": "Neighborhood exceeds the bounded candidate model size."}

    changes = [1-var if identity in original else var for identity, var in variables.items()]
    removed_without_var = sum(key[1] in local_days and key not in variables for key in original)
    change_count = sum(changes) + removed_without_var
    model.add(change_count <= max_changes)
    covered = []
    for inst in local_slots:
        amount = sum(by_slot[inst.slot_key])
        fixed = counts.get(inst.slot_key, 0)
        model.add(amount <= max(0, inst.capacity-fixed))
        filled = model.new_int_var(0, inst.target, f"filled{len(covered)}")
        model.add_min_equality(filled, [fixed+amount, inst.target])
        covered.append(filled)

    def fixed_interval(assignment):
        interval = executor.ctx.all_slot_intervals.get(assignment.rowId)
        if interval is None or assignment.rowId.startswith("pool-"):
            return None
        offset = date.fromisoformat(assignment.dateISO).toordinal()*1440
        return offset+interval[0], offset+interval[1]

    # Encode the cheap, dominant restrictions; the exact shared validator
    # checks rest, continuity, fixed-history allowances and all remaining rules.
    for cid, items in by_person.items():
        if time.monotonic() >= deadline:
            return {**result, "search_status": "incomplete", "not_searched": local_days}
        fixed_for_person = [a for a in baseline if a.clinicianId == cid]
        for inst, var in items:
            start, end = absolute(inst)
            for assignment in fixed_for_person:
                interval = fixed_interval(assignment)
                if interval and start < interval[1] and interval[0] < end:
                    model.add(var == 0)
        for pair_index, ((left, lv), (right, rv)) in enumerate(combinations(items, 2)):
            if pair_index % 128 == 0 and time.monotonic() >= deadline:
                return {**result, "search_status": "incomplete", "not_searched": local_days}
            ls, le = absolute(left)
            rs, re = absolute(right)
            overlap = ls < re and rs < le
            mixed_location = (executor.ctx.settings.enforceSameLocationPerDay and
                              left.date_iso == right.date_iso and left.location_id != right.location_id)
            if overlap or mixed_location:
                model.add(lv + rv <= 1)
        clinician = executor.clinicians_by_id[cid]
        contract = clinician.workingHoursPerWeek
        if contract is None or contract <= 0:
            continue
        weeks = defaultdict(list)
        for inst, var in items:
            week = date.fromisoformat(inst.date_iso).isocalendar()[:2]
            weeks[week].append((inst.end-inst.start)*var)
        for week, terms in weeks.items():
            fixed_minutes = 0
            for assignment in fixed_for_person:
                if date.fromisoformat(assignment.dateISO).isocalendar()[:2] != week:
                    continue
                interval = fixed_interval(assignment)
                if interval:
                    fixed_minutes += interval[1]-interval[0]
            cap = int((contract + max(0, clinician.workingHoursToleranceHours))*60)
            seed_cap = executor.baseline_week_minutes.get(("WEEKLY_HOURS", cid, *week), 0)
            model.add(sum(terms) + fixed_minutes <= max(cap, seed_cap))

    model.maximize(sum(covered)*(max_changes+1) - change_count)
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    for _ in range(scope["max_candidates"]):
        left = deadline-time.monotonic()
        if left <= 0:
            break
        solver.parameters.max_time_in_seconds = left
        status = solver.solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        selected = {identity for identity, var in variables.items() if solver.value(var)}
        old_local = {key for key in original if key[1] in local_days}
        moves = [
            {"action": "unassign", "slot_key": f"{slot}__{day}", "clinicianId": cid}
            for slot, day, cid in sorted(old_local-selected)
        ] + [
            {"action": "assign", "slot_key": f"{slot}__{day}", "clinicianId": cid}
            for slot, day, cid in sorted(selected-old_local)
        ]
        result["evaluated_plans"] += 1
        if moves:
            preview = executor._tool_apply_moves({"moves": moves, "dry_run": True})
            if preview.get("valid") and preview.get("improves_best"):
                proposal = executor.workflow.propose(
                    moves, next_tool="suggest_day_blocks", next_args={"dateISO": focus}, preview=preview
                )
                result["proposals"] = [{**proposal, "changes": len(moves), "focus_date": focus}]
                result["search_status"] = "improvement_found"
                return result
        # Exclude exactly this complete assignment, not every superset. A
        # third assignment can repair a split between two retained slots.
        model.add_bool_or([var.Not() if identity in selected else var for identity, var in variables.items()])
    result["search_status"] = "bounded_no_improvement"
    return result


def analyze_bottlenecks(executor, arguments):
    requested = arguments.get("dateISO")
    days = [requested] if requested else executor.ctx.target_day_isos
    if any(day not in executor.ctx.target_date_set for day in days):
        return {"error": "Choose a date inside the planning range."}
    entries = []
    not_searched = []
    for index, day in enumerate(days):
        if executor._tool_seconds_left() <= 5:
            not_searched = days[index:]
            break
        for item in executor._day_open_entries(day):
            item = {key: value for key, value in item.items() if key != "raw_slot_key"}
            entries.append({**item, "dateISO": day})
    entries.sort(key=lambda item: (item["eligible_count"], item["section_rank"], item["dateISO"]))
    return {"bottlenecks": entries[:20], "more_slots": max(0, len(entries)-20),
            "not_searched": not_searched, "search_status": "incomplete" if not_searched else "completed",
            "note": "Counts describe direct placements in the current plan. They are not a proof of insufficient capacity: rearranging other days may free hours or rest days."}


def explain_unfilled(executor, arguments):
    analysis = analyze_bottlenecks(executor, arguments)
    if "error" in analysis:
        return analysis
    explanations = []
    for item in analysis["bottlenecks"][:8]:
        if executor._tool_seconds_left() <= 5:
            analysis["search_status"] = "incomplete"
            break
        candidates = executor._candidates_for_slot(executor._resolve_slot_key(item["slot_key"]))
        explanations.append({"slot_key": item["slot_key"], "dateISO": item["dateISO"],
                             "direct_candidates": item["eligible_count"],
                             "blocking_reasons": [{"clinicianId": c["clinicianId"], "reasons": c["reasons"],
                                                   **({"week_over_cap_hours": c["week_over_cap_hours"]}
                                                      if "week_over_cap_hours" in c else {})}
                                                  for c in candidates["candidates"] if not c["eligible"]]})
    return {"explanations": explanations, "more_slots": analysis["more_slots"] + len(analysis["bottlenecks"])-len(explanations),
            "not_searched": analysis["not_searched"], "search_status": analysis["search_status"],
            "search_history": executor.workflow.summary(current_only=True), "note": analysis["note"]}
