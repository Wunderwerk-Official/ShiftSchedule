"""Experimental "direct" strategy (arena only): the model plans the WHOLE
range in one answer, without tools.

It answers the question whether a strong model (Claude Opus 5.5) plans as well
or more cheaply when it simply gets the complete problem and the rules, instead
of the tool-driven day-by-day procedure. The digest holds everything the tools
would otherwise look up: every open place with the people the gate would
accept given the fixed context, each person's weekly hours booked and cap,
vacations, fixed shifts and time windows. The model's placements go through
the same acceptance gate one by one (illegal ones are dropped and reported);
one correction round sends the rejections and the remaining open places back.

The UI never selects this strategy; production planning stays day-by-day.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

from ..planning_preferences import vacation_dates_in_range

DIRECT_MAX_ROUNDS = 2  # the plan, then one correction round
DIRECT_MAX_TOKENS = 32000

DIRECT_SYSTEM_PROMPT = """You are an expert clinician shift planner. You plan the WHOLE date range in one answer. There are no tools: everything you need is in the message.

A checker validates every placement you return, one by one in your order, against the hard rules below, and drops any placement that breaks one (you get the list back once to correct it):
- Qualification: people only work sections they are qualified for (the legal list per place already accounts for qualification, vacation, mandatory time windows, rest days and overlaps with FIXED shifts).
- No overlapping shifts for one person, including overnight shifts.
- Weekly hours per ISO week (Monday to Sunday) stay within the person's cap: booked hours (fixed work) + everything you place in that week <= cap.
- Same site per day, one contiguous work block per person per day and rest days around on-call duties, when the rules section says they are enforced.
- A place takes at most its open count.

Goals, in this order: (1) fill every open place; when not all can be filled, fill the higher-priority places; weekly hours are shared across the days of a week, so do not spend a scarce person's last hours on a low-priority place another day needs them for; (2) no short days (below the person's daily minimum) and no over-long days (above the comfortable length); (3) each person's hours in the range close to their range target (within the given tolerance; the target is the contract pro rata for the days they are not on vacation, fixed work included); (4) people behind their year-to-date target first, section preferences, preferred working times, admin instructions and clinician wishes.

Plan like an experienced planner: scarcest places first (fewest legal people), give each person one contiguous block per day.

Answer with ONE fenced block and nothing after it:
```plan
S12__2026-02-16 = Full Name
```
One placement per line, the slot key copied exactly and the name exactly as listed. In a correction round, add lines "- S12__2026-02-16 = Full Name" to remove one of your earlier placements."""

_LINE = re.compile(r"^\s*(?P<remove>-\s*)?(?P<slot>S\d+__\d{4}-\d{2}-\d{2})\s*[=:|]\s*(?P<name>.+?)\s*$")


def _hhmm(minutes: int) -> str:
    minutes = minutes % (24 * 60) if minutes >= 24 * 60 else minutes
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _span(start: int, end: int) -> str:
    return f"{_hhmm(start)}-{_hhmm(end)}" + (" (+1d)" if end > 24 * 60 else "")


def _weekday(date_iso: str) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][date.fromisoformat(date_iso).weekday()]


def _iso_week(date_iso: str) -> Tuple[int, int]:
    return date.fromisoformat(date_iso).isocalendar()[:2]


def _legal_people(executor, inst) -> List[str]:
    """People the gate accepts for this place in the CURRENT plan (cheap
    qualification/vacation filter first, then the exact gate check)."""
    names = []
    for clinician in executor.state.clinicians:
        if inst.section_id not in (clinician.qualifiedClassIds or []):
            continue
        if any(v.startISO <= inst.date_iso <= v.endISO for v in clinician.vacations or []):
            continue
        identity = (inst.slot_id, inst.date_iso, clinician.id)
        if identity in executor.current or identity in executor.fixed_identity:
            continue
        if executor._tool_seconds_left() <= 5:
            break
        if not executor._direct_addition_codes(inst.slot_id, inst.date_iso, clinician.id):
            names.append(executor._alias(clinician.id))
    return names


def open_place_lines(executor) -> List[str]:
    ex = executor
    counts = ex._counts_by_instance(ex._working_list())
    rows = []
    for inst in ex.ctx.instances.values():
        missing = max(0, inst.target - counts.get(inst.slot_key, 0))
        if missing:
            rows.append((inst, missing))
    rows.sort(key=lambda row: (row[0].date_iso, -row[0].order_weight, row[0].start))
    lines = []
    for inst, missing in rows:
        legal = _legal_people(ex, inst)
        lines.append(
            f"- {ex._alias_slot_key(inst.slot_key)} | {_weekday(inst.date_iso)} | "
            f"{ex.section_names.get(inst.section_id, inst.section_id)} | {inst.location_id} | "
            f"{_span(inst.start, inst.end)} | open {missing} | prio {inst.order_weight} | "
            f"legal: {', '.join(legal) if legal else 'nobody'}"
        )
    return lines


def range_targets(executor) -> Dict[Tuple[str, Tuple[int, int]], Tuple[float, float, float]]:
    """(target h, tolerance h, fixed h in the range) per person and ISO week,
    computed exactly like the hours deviation of the quality gate
    (backend/scoring.py plan_stats): contract and tolerance pro rata for the
    range days of that week the person is not on vacation."""
    ctx = executor.ctx
    week_days: Dict[Tuple[int, int], int] = {}
    for day in ctx.target_day_isos:
        week = _iso_week(day)
        week_days[week] = week_days.get(week, 0) + 1
    start = date.fromisoformat(ctx.start_iso)
    end = date.fromisoformat(ctx.end_iso) + timedelta(days=1)
    fixed_minutes: Dict[Tuple[str, Tuple[int, int]], int] = {}
    for a in ctx.fixed_assignments:
        inst = ctx.instances[f"{a.rowId}__{a.dateISO}"]
        key = (a.clinicianId, _iso_week(a.dateISO))
        fixed_minutes[key] = fixed_minutes.get(key, 0) + max(0, inst.end - inst.start)
    targets = {}
    for clinician in ctx.state.clinicians:
        cid = clinician.id
        contract = ctx.contract_hours.get(cid)
        if contract is None:
            continue
        vacation = {}
        for day in vacation_dates_in_range(clinician, start, end):
            vacation[day.isocalendar()[:2]] = vacation.get(day.isocalendar()[:2], 0) + 1
        for week, days in week_days.items():
            available = days - vacation.get(week, 0)
            if available <= 0:
                continue
            scale = available / 7.0
            targets[(cid, week)] = (contract * scale, ctx.tolerance_hours[cid] * scale,
                                    fixed_minutes.get((cid, week), 0) / 60)
    return targets


def build_direct_digest(executor) -> str:
    ex = executor
    ctx = ex.ctx
    settings = ctx.settings
    weeks = sorted({_iso_week(day) for day in ctx.target_day_isos})
    lines: List[str] = [
        f"PLAN {ctx.start_iso} to {ctx.end_iso} ({len(ctx.target_day_isos)} days) in one answer.",
        "",
        "Rules: same site per day "
        + ("ENFORCED" if settings.enforceSameLocationPerDay else "not enforced")
        + "; one contiguous block per day "
        + ("ENFORCED" if settings.preferContinuousShifts else "not enforced")
        + "; rest days around on-call "
        + (f"ENFORCED ({settings.onCallRestDaysBefore} before, {settings.onCallRestDaysAfter} after)"
           if settings.onCallRestEnabled else "not enforced")
        + ".",
        "",
        "People (name | qualified sections | per ISO week: hours booked (fixed work, also outside the range) / hard cap, "
        "and the hours target for the range days of that week ± tolerance, fixed work in the range included "
        "| preferred day h (minimum-comfortable) | year-to-date worked % (lower = behind) | vacation in range "
        "| fixed shifts in range | time windows):",
    ]
    sections = ex.section_names
    targets = range_targets(ex)
    for clinician in ex.state.clinicians:
        cid = clinician.id
        cap = None
        if isinstance(clinician.workingHoursPerWeek, (int, float)) and clinician.workingHoursPerWeek > 0:
            cap = clinician.workingHoursPerWeek + ex._tolerance_hours(clinician)
        week_parts = []
        for year, week in weeks:
            monday = date.fromisocalendar(year, week, 1).isoformat()
            booked = ex._week_hours(cid, monday)
            part = f"W{week:02d} {booked:g}/{cap:g}" if cap is not None else f"W{week:02d} {booked:g}/-"
            target = targets.get((cid, (year, week)))
            if target is not None:
                goal, tolerance, fixed_in_range = target
                part += f" target {goal:.1f}±{tolerance:.1f}"
                if fixed_in_range:
                    part += f" (fixed {fixed_in_range:g})"
            week_parts.append(part)
        vacation = [day for day in ctx.target_day_isos
                    if any(v.startISO <= day <= v.endISO for v in clinician.vacations or [])]
        fixed = sorted(
            f"{a.dateISO} {_span(*ctx.all_slot_intervals[a.rowId][:2])}"
            for a in ex.fixed_assignments
            if a.clinicianId == cid and a.dateISO in ctx.target_date_set
            and a.rowId in ctx.all_slot_intervals and not a.rowId.startswith("pool-")
        )
        # Same window on several days: one entry "Mon,Tue preference 08:00-16:00".
        by_window: Dict[Tuple[str, int, int], List[str]] = {}
        for day in ctx.target_day_isos:
            window = ctx.window_by_clinician_date.get((cid, day))
            if window and window[0] in ("mandatory", "preference"):
                by_window.setdefault((window[0], window[1], window[2]), []).append(_weekday(day))
        windows = [f"{','.join(days)} {kind} {_hhmm(start)}-{_hhmm(end)}"
                   for (kind, start, end), days in by_window.items()]
        if vacation and len(vacation) == len(ctx.target_day_isos):
            vacation = ["whole range"]
        first_day = ctx.target_day_isos[0]
        minimum = ex._daily_min_minutes(cid, first_day)
        comfort = ex._daily_comfort_minutes(cid, first_day)
        preferred = ex._daily_target_minutes(cid, first_day)
        ytd = ex.ytd_completion_pct(cid, ctx.start_iso)
        lines.append(
            f"- {ex._alias(cid)} | {', '.join(sections.get(s, s) for s in clinician.qualifiedClassIds) or '-'} | "
            f"{'; '.join(week_parts)} | {preferred / 60:.1f} ({(minimum or 0) / 60:.1f}-{comfort / 60:.1f}) | "
            f"{ytd if ytd is not None else '-'} | {', '.join(vacation) or '-'} | {'; '.join(fixed) or '-'} | "
            f"{'; '.join(windows) or '-'}"
        )
    lines += ["", "Open places (slot | weekday | section | site | time | open | priority, higher first | "
                  "legal people given the fixed shifts):"]
    lines += open_place_lines(ex)
    return "\n".join(lines)


def parse_direct_reply(text: Optional[str]) -> Tuple[List[Tuple[str, str]], List[Tuple[str, str]], int]:
    """(placements, removals, unparsed lines) from the model's ```plan block;
    without a block, every matching line of the reply counts."""
    if not text:
        return [], [], 0
    match = re.search(r"```(?:plan)?\s*\n(.*?)(?:```|$)", text, re.S)
    body = match.group(1) if match else text
    adds, removes, unparsed = [], [], 0
    for raw in body.splitlines():
        if not raw.strip():
            continue
        line = _LINE.match(raw)
        if not line:
            unparsed += 1
            continue
        pair = (line.group("slot"), line.group("name").strip().strip('"'))
        (removes if line.group("remove") else adds).append(pair)
    return adds, removes, unparsed


# Passes over the placements: a placement the gate refuses only because of
# the ORDER (one contiguous block per day: a later slot before the one that
# joins it to a fixed shift) is accepted once its neighbour is in.
APPLY_PASSES = 3


def _placement_order(executor, pair: Tuple[str, str]) -> Tuple[str, str, int]:
    """Day, person, start time: each person's day is built from its first
    slot on, so every intermediate state of a contiguous block is one."""
    slot_key, name = pair
    try:
        resolved = executor._resolve_slot_key(slot_key)
        _slot_id, date_iso = resolved.rsplit("__", 1)
    except (ValueError, AttributeError):
        return ("~", name, 0)
    inst = executor.ctx.instances.get(resolved)
    return (date_iso, executor._resolve_clinician(name), inst.start if inst else 0)


def _apply_one(executor, action: str, slot_key: str, name: str) -> Optional[List[str]]:
    """None when the gate applied the move, else the reasons it gave."""
    result = executor._tool_apply_moves({"moves": [
        {"action": action, "slot_key": slot_key, "clinicianId": name}]})
    if result.get("applied"):
        return None
    reasons = [str(item.get("reason", item)) for item in result.get("rejected") or []]
    reasons += [str(v.get("code")) for v in result.get("new_hard_violations") or [] if isinstance(v, dict)]
    return reasons[:3] or [str(result.get("hint") or result.get("error") or "rejected")[:120]]


def apply_direct_plan(executor, adds, removes) -> Dict[str, object]:
    """Apply removals, then placements through the gate, one move at a time.

    Placements go by day, person and start time, and refused ones are tried
    again while a pass still placed something, so only placements that break
    a rule in the final plan stay dropped."""
    accepted, rejected = 0, []
    for slot_key, name in removes:
        reasons = _apply_one(executor, "unassign", slot_key, name)
        if reasons is None:
            accepted += 1
        else:
            rejected.append({"action": "unassign", "slot": slot_key, "name": name, "reasons": reasons})
    pending = [(pair, []) for pair in sorted(adds, key=lambda pair: _placement_order(executor, pair))]
    for _pass in range(APPLY_PASSES):
        refused = []
        for (slot_key, name), _reasons in pending:
            reasons = _apply_one(executor, "assign", slot_key, name)
            if reasons is None:
                accepted += 1
            else:
                refused.append(((slot_key, name), reasons))
        progressed = len(refused) < len(pending)
        pending = refused
        if not pending or not progressed:
            break
    rejected += [{"action": "assign", "slot": slot_key, "name": name, "reasons": reasons}
                 for (slot_key, name), reasons in pending]
    return {"accepted": accepted, "rejected": rejected}


def build_direct_feedback(executor, applied: Dict[str, object]) -> str:
    rejected = applied["rejected"]
    lines = [f"The checker accepted {applied['accepted']} change(s) and dropped {len(rejected)}."]
    if rejected:
        lines.append("Dropped (slot = name: reasons):")
        lines += [f"- {r['slot']} = {r['name']}: {'; '.join(r['reasons'])}" for r in rejected[:60]]
    lines += ["", "Still open (current plan; legal people for each place now):"]
    lines += open_place_lines(executor) or ["- none"]
    lines += ["", "Answer with one ```plan block of CHANGES only: new placements as 'slot = name', removals as "
                  "'- slot = name'. An empty block keeps the plan."]
    return "\n".join(lines)


def summarize_direct(stats: Dict[str, object]) -> str:
    return json.dumps(stats, ensure_ascii=False)
