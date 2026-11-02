"""Cross-day coverage repair (backend/agent/cross_day.py, solver repair mode).

The production case (week 2026-W45): day-by-day planning gave a scarce
person's last weekly hours to a long LOW-priority Thursday slot, so the
Friday slots only they could cover stayed open, and every repair search
looked at one day only. Here: Laurain has 12.5h left (32h + 8h cap, 27.5h
booked Mon-Wed), is the only one for Thursday's 10h COR slot and for two 4h
Friday slots. Greedy Thursday covers 1 of 3; the right plan covers 2 of 3.
"""
from __future__ import annotations

import json
import threading
import time

from backend.agent import cross_day
from backend.agent.config import AgentConfig
from backend.agent.harness import agent_solve_range
from backend.agent.provider import LLMProvider, ProviderResponse, ToolCall
from backend.agent.tools import PlanToolExecutor
from backend.models import (AppState, Assignment, Clinician, Location, SolveRangeRequest, TemplateBlock,
                            TemplateColBand, TemplateRowBand, TemplateSlot, WeeklyCalendarTemplate,
                            WeeklyTemplateLocation, WorkplaceRow)
from backend.scoring import build_scoring_context
from backend.solver import _solve_range_impl, section_tier_by_slot_id

THU, FRI = "2026-11-05", "2026-11-06"
DAY_TYPES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"]
GREEDY_THURSDAY = ("slot-cor-thu", THU, "laurain")
FRIDAY_PLAN = {("slot-echo-fri", FRI, "laurain"), ("slot-seno-fri", FRI, "laurain")}


def trap_state() -> AppState:
    # Block order is slot priority: seno > echo > history > cor (lowest).
    sections = ["sec-seno", "sec-echo", "sec-hist", "sec-cor"]
    rows = [WorkplaceRow(id=s, name=s[4:].upper(), kind="class", dotColorClass="bg-slate-200",
                         locationId="loc-default") for s in sections]
    rows += [WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool", dotColorClass="bg-slate-200"),
             WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool", dotColorClass="bg-emerald-500")]
    slot = lambda sid, band, col, block, req, start, end: TemplateSlot(  # noqa: E731
        id=sid, locationId="loc-default", rowBandId=band, colBandId=col, blockId=block,
        requiredSlots=req, startTime=start, endTime=end, endDayOffset=0)
    slots = [
        slot("slot-seno-fri", "rb-seno", "col-fri-1", "block-seno", 1, "07:30", "11:30"),
        slot("slot-echo-fri", "rb-echo", "col-fri-1", "block-echo", 1, "11:30", "15:30"),
        slot("slot-cor-thu", "rb-cor", "col-thu-1", "block-cor", 1, "08:00", "18:00"),
    ] + [slot(f"slot-hist-{d}", "rb-hist", f"col-{d}-1", "block-hist", 0, "08:00", "17:10")
         for d in ("mon", "tue", "wed")]
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id=f"block-{s[4:]}", sectionId=s, requiredSlots=0) for s in sections],
        locations=[WeeklyTemplateLocation(
            locationId="loc-default",
            rowBands=[TemplateRowBand(id=f"rb-{s[4:]}", label=s[4:], order=i + 1) for i, s in enumerate(sections)],
            colBands=[TemplateColBand(id=f"col-{d}-1", label="", order=1, dayType=d) for d in DAY_TYPES],
            slots=slots)])
    clinicians = [
        Clinician(id="laurain", name="Marie Laurain", qualifiedClassIds=sections, vacations=[],
                  workingHoursPerWeek=32, workingHoursToleranceHours=8),
        Clinician(id="other", name="Other Person", qualifiedClassIds=["sec-hist"], vacations=[],
                  workingHoursPerWeek=40, workingHoursToleranceHours=5),
    ]
    history = [Assignment(id=f"h-{iso}", rowId=f"slot-hist-{day}", dateISO=iso, clinicianId="laurain",
                          source="manual")
               for day, iso in (("mon", "2026-11-02"), ("tue", "2026-11-03"), ("wed", "2026-11-04"))]
    return AppState(locations=[Location(id="loc-default", name="Site")], locationsEnabled=True, rows=rows,
                    clinicians=clinicians, assignments=history, minSlotsByRowId={}, slotOverridesByKey={},
                    weeklyTemplate=template, holidays=[],
                    solverSettings={"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
                    solverRules=[])


def repair_with_solver(reference, seconds=20.0, state=None):
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=seconds)
    result = _solve_range_impl(payload, None, cancel_event=threading.Event(), on_progress=lambda *_: None,
                               start_time=time.time(), state_override=state or trap_state(),
                               repair_reference=reference)
    return {(a.rowId, a.dateISO, a.clinicianId) for a in result.assignments}


def cor_first_state() -> AppState:
    """The same people and slots, but Thursday's COR is the TOP section of the
    list: trading it for the two Friday slots of lower sections fills one more
    place, yet leaves the highest-ranked section open (v1.80: not allowed)."""
    state = trap_state()
    by_id = {block.id: block for block in state.weeklyTemplate.blocks}
    state.weeklyTemplate.blocks = [by_id[b] for b in ("block-cor", "block-seno", "block-echo", "block-hist")]
    return state


def greedy_executor(state=None):
    state = state or trap_state()
    executor = PlanToolExecutor(state, build_scoring_context(state, THU, FRI, only_fill_required=True), [])
    applied = executor._tool_apply_moves({"moves": [
        {"action": "assign", "slot_key": f"slot-cor-thu__{THU}", "clinicianId": "laurain"}]})
    assert applied["applied"]
    return executor


def identities(executor):
    return {(a.rowId, a.dateISO, a.clinicianId) for a in executor._working_list()}


def test_solver_repair_mode_moves_weekly_hours_to_the_higher_value_day():
    assert repair_with_solver({GREEDY_THURSDAY}) == FRIDAY_PLAN


def test_solver_repair_never_trades_a_higher_section_for_lower_ones():
    # Without the section order the solver returns FRIDAY_PLAN (2 of 3 filled).
    assert repair_with_solver({GREEDY_THURSDAY}, state=cor_first_state()) == {GREEDY_THURSDAY}


def test_solver_repair_moves_a_gap_within_one_section():
    """Thursday or Friday of the same section is no priority question."""
    state = cor_first_state()
    for location in state.weeklyTemplate.locations:
        for template_slot in location.slots:
            if template_slot.id in ("slot-seno-fri", "slot-echo-fri"):
                template_slot.blockId = "block-cor"
    assert repair_with_solver({GREEDY_THURSDAY}, state=state) == FRIDAY_PLAN


def two_block_cor_state(friday_block_first: bool) -> AppState:
    """cor_first_state with the Friday slots on a second COR block, as a
    pre-v4 template has one block per sub-shift and day type."""
    state = cor_first_state()
    for location in state.weeklyTemplate.locations:
        for template_slot in location.slots:
            if template_slot.id in ("slot-seno-fri", "slot-echo-fri"):
                template_slot.blockId = "block-cor-fri"
    state.weeklyTemplate.blocks.insert(0 if friday_block_first else 1,
                                       TemplateBlock(id="block-cor-fri", sectionId="sec-cor", requiredSlots=0))
    return state


def test_solver_repair_moves_a_gap_between_blocks_of_one_section():
    """Review of v1.80: the tier is the section's rank, not its block's
    position; Thursday's and Friday's block of one section never outrank
    each other, whichever comes first in the list."""
    for friday_block_first in (False, True):
        state = two_block_cor_state(friday_block_first)
        tiers = section_tier_by_slot_id(state)
        assert tiers["slot-cor-thu"] == tiers["slot-seno-fri"] == tiers["slot-echo-fri"] == 0
        assert tiers["slot-hist-mon"] == 4
        assert repair_with_solver({GREEDY_THURSDAY}, state=state) == FRIDAY_PLAN
        executor = greedy_executor(state)
        report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
        assert (report["status"], report["open_before"], report["open_after"]) == ("applied", 2, 1), report
        assert identities(executor) == FRIDAY_PLAN


def test_section_tier_of_a_pre_v4_template_is_the_sections_rank():
    """backend/state.py turns a calendar without a v4 template into one block
    per sub-shift and day type; every slot of a section keeps one tier."""
    from backend.models import MinSlots, SubShift
    from backend.state import _normalize_state

    rows = [WorkplaceRow(id=s, name=s.upper(), kind="class", dotColorClass="bg-slate-200", locationId="loc-default",
                         subShifts=[SubShift(id="s1", name="Early", order=1, startTime="07:30", endTime="11:30"),
                                    SubShift(id="s2", name="Late", order=2, startTime="11:30", endTime="15:30")])
            for s in ("cor", "seno")]
    state = AppState(locations=[Location(id="loc-default", name="Site")], rows=rows, clinicians=[], assignments=[],
                     minSlotsByRowId={f"{s}::{sub}": MinSlots(weekday=1, weekend=0)
                                      for s in ("cor", "seno") for sub in ("s1", "s2")},
                     weeklyTemplate=None)
    state, _changed = _normalize_state(state)
    assert len(state.weeklyTemplate.blocks) > 2  # one per sub-shift and day type
    tiers = section_tier_by_slot_id(state)
    by_section = {s: {tier for sid, tier in tiers.items() if sid.startswith(f"{s}::")} for s in ("cor", "seno")}
    assert len(by_section["cor"]) == len(by_section["seno"]) == 1
    assert min(by_section["cor"]) < min(by_section["seno"])


MON_W45, TUE_W45 = "2026-11-02", "2026-11-03"
EQUAL_REFERENCE = {("slot-w-mon", MON_W45, "pat"), ("slot-w-tue", TUE_W45, "rae")}
# Fills Friday's X; Thursday's COR (the top section) stays open. 3 changes.
EQUAL_CHEAP = {("slot-w-mon", MON_W45, "pat"), ("slot-x-fri", FRI, "rae"), ("slot-w-tue", TUE_W45, "sam")}
# Staffs COR and X; Monday's W (the lowest section) stays open. 5 changes.
EQUAL_ORDERED = {("slot-cor-thu", THU, "pat"), ("slot-x-fri", FRI, "rae"), ("slot-w-tue", TUE_W45, "sam")}


def equal_coverage_state() -> AppState:
    """Review of v1.80: sections COR (top), X, W (lowest), one 8 h slot each
    on Mon (W), Tue (W), Thu (COR) and Fri (X); everyone may work one shift a
    week (8 h contract, no tolerance). Pat: COR or W; Rae: X or W; Sam: W
    only, away Monday. Day by day Pat takes Monday's W and Rae Tuesday's W,
    so COR and X stay open. Three people for four slots: one stays open in
    every plan, and the section order decides which."""
    from backend.models import VacationRange

    sections = ["sec-cor", "sec-x", "sec-w"]
    rows = [WorkplaceRow(id=s, name=s[4:].upper(), kind="class", dotColorClass="bg-slate-200",
                         locationId="loc-default") for s in sections]
    rows += [WorkplaceRow(id="pool-rest-day", name="Rest Day", kind="pool", dotColorClass="bg-slate-200"),
             WorkplaceRow(id="pool-vacation", name="Vacation", kind="pool", dotColorClass="bg-emerald-500")]
    slot = lambda sid, band, col, block: TemplateSlot(  # noqa: E731
        id=sid, locationId="loc-default", rowBandId=band, colBandId=col, blockId=block,
        requiredSlots=1, startTime="08:00", endTime="16:00", endDayOffset=0)
    template = WeeklyCalendarTemplate(
        version=4,
        blocks=[TemplateBlock(id=f"block-{s[4:]}", sectionId=s, requiredSlots=0) for s in sections],
        locations=[WeeklyTemplateLocation(
            locationId="loc-default",
            rowBands=[TemplateRowBand(id=f"rb-{s[4:]}", label=s[4:], order=i + 1) for i, s in enumerate(sections)],
            colBands=[TemplateColBand(id=f"col-{d}-1", label="", order=1, dayType=d) for d in DAY_TYPES],
            slots=[slot("slot-w-mon", "rb-w", "col-mon-1", "block-w"),
                   slot("slot-w-tue", "rb-w", "col-tue-1", "block-w"),
                   slot("slot-cor-thu", "rb-cor", "col-thu-1", "block-cor"),
                   slot("slot-x-fri", "rb-x", "col-fri-1", "block-x")])])
    person = lambda cid, name, sections, vacations=(): Clinician(  # noqa: E731
        id=cid, name=name, qualifiedClassIds=list(sections), vacations=list(vacations),
        workingHoursPerWeek=8, workingHoursToleranceHours=0)
    clinicians = [person("pat", "Pat Prior", ["sec-cor", "sec-w"]),
                  person("rae", "Rae Rowe", ["sec-x", "sec-w"]),
                  person("sam", "Sam Stone", ["sec-w"], [VacationRange(id="v1", startISO=MON_W45, endISO=MON_W45)])]
    return AppState(locations=[Location(id="loc-default", name="Site")], locationsEnabled=True, rows=rows,
                    clinicians=clinicians, assignments=[], minSlotsByRowId={}, slotOverridesByKey={},
                    weeklyTemplate=template, holidays=[],
                    solverSettings={"enforceSameLocationPerDay": False, "onCallRestEnabled": False},
                    solverRules=[])


def test_solver_repair_staffs_the_higher_section_when_coverage_ties():
    """Review of v1.80: with as many positions filled either way, the section
    order decides before the change count (5 changes instead of 3)."""
    payload = SolveRangeRequest(startISO=MON_W45, endISO=FRI, only_fill_required=True, timeout_seconds=20)
    result = _solve_range_impl(payload, None, cancel_event=threading.Event(), on_progress=lambda *_: None,
                               start_time=time.time(), state_override=equal_coverage_state(),
                               repair_reference=EQUAL_REFERENCE, repair_max_changes=cross_day.MAX_CHANGES)
    assert {(a.rowId, a.dateISO, a.clinicianId) for a in result.assignments} == EQUAL_ORDERED
    state = equal_coverage_state()
    executor = PlanToolExecutor(state, build_scoring_context(state, MON_W45, FRI, only_fill_required=True), [])
    assert executor._tool_apply_moves({"moves": [
        {"action": "assign", "slot_key": f"{slot}__{day}", "clinicianId": cid}
        for slot, day, cid in sorted(EQUAL_REFERENCE)]})["applied"]
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert (report["status"], report["open_before"], report["open_after"]) == ("applied", 2, 1), report
    assert identities(executor) == EQUAL_ORDERED and EQUAL_ORDERED != EQUAL_CHEAP


def test_priority_trade_down_compares_running_totals_from_the_top():
    trade_down = cross_day.priority_trade_down
    assert trade_down({3: 2}, {3: 1}) is None            # one gap fewer
    assert trade_down({1: 2}, {3: 1}) is None            # gaps moved to a lower section
    assert trade_down({1: 1, 2: 1}, {1: 1, 2: 1}) is None
    assert trade_down({3: 2}, {0: 1}) == 0               # one top gap for two lower ones
    assert trade_down({2: 1}, {1: 1}) == 1               # a gap moved up


def test_coverage_repair_refuses_a_trade_down_from_the_solver(monkeypatch):
    """The CP-SAT model is not the authority on the section order either."""
    from backend.models import SolveRangeResponse, SolverDebugInfo

    def trade_down(*_args, **_kwargs):
        return SolveRangeResponse(
            startISO=THU, endISO=FRI, notes=[],
            assignments=[Assignment(id=f"x{i}", rowId=row, dateISO=FRI, clinicianId="laurain", source="solver")
                         for i, row in enumerate(["slot-seno-fri", "slot-echo-fri"])],
            debugInfo=SolverDebugInfo(timing={}, solver_status="FEASIBLE"))

    monkeypatch.setattr("backend.solver._solve_range_impl", trade_down)
    executor = greedy_executor(cor_first_state())
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert report["status"] == "rejected" and not report["applied"]
    assert report["reason"] == "higher-ranked section left open" and report["section"] == "COR"
    assert identities(executor) == {GREEDY_THURSDAY}


def test_coverage_repair_keeps_a_top_section_staffed():
    executor = greedy_executor(cor_first_state())
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert report["status"] == "no_improvement" and not report["applied"], report
    assert identities(executor) == {GREEDY_THURSDAY}


def test_solver_repair_mode_keeps_an_already_best_plan():
    # Nothing to gain: zero changes is the cheapest optimum.
    assert repair_with_solver(set(FRIDAY_PLAN)) == FRIDAY_PLAN


def test_same_day_searches_cannot_fix_the_trap():
    executor = greedy_executor()
    rescue = json.loads(executor.execute("suggest_rescue_moves", {"dateISO": FRI}, "t").content)
    assert rescue["rescues"] == []
    assert cross_day.open_positions(executor) == 2


def test_coverage_repair_fills_friday_and_keeps_fixed_history():
    executor = greedy_executor()
    fixed_before = list(executor.fixed_assignments)
    before = executor.best_quality

    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)

    assert report["status"] == "applied", report
    assert (report["open_before"], report["open_after"], report["changes"]) == (2, 1, 3)
    assert identities(executor) == FRIDAY_PLAN
    assert executor.fixed_assignments == fixed_before
    assert executor.best_quality < before
    assert "filled 1 more required position(s) by changing 3 assignment(s)" in cross_day.repair_note(report)


def test_coverage_repair_has_nothing_to_do_on_a_complete_plan():
    state = trap_state()
    for location in state.weeklyTemplate.locations:
        for template_slot in location.slots:
            if template_slot.id == "slot-cor-thu":
                template_slot.requiredSlots = 0  # nothing required on Thursday
    executor = PlanToolExecutor(state, build_scoring_context(state, THU, FRI, only_fill_required=True), [])
    executor._tool_apply_moves({"moves": [
        {"action": "assign", "slot_key": f"slot-seno-fri__{FRI}", "clinicianId": "laurain"},
        {"action": "assign", "slot_key": f"slot-echo-fri__{FRI}", "clinicianId": "laurain"}]})
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert report["status"] == "complete" and not report["applied"]
    assert cross_day.repair_note(report) is None


def test_coverage_repair_never_applies_what_the_gate_rejects(monkeypatch):
    """The CP-SAT model is not the authority: an illegal plan is dropped."""
    from backend.models import SolveRangeResponse, SolverDebugInfo

    def illegal_plan(*_args, **_kwargs):
        # "other" is not qualified for either Friday section.
        return SolveRangeResponse(
            startISO=THU, endISO=FRI, notes=["Solver completed in 1ms."],
            assignments=[Assignment(id=f"x{i}", rowId=row, dateISO=FRI, clinicianId="other", source="solver")
                         for i, row in enumerate(["slot-seno-fri", "slot-echo-fri"])],
            debugInfo=SolverDebugInfo(timing={}, solver_status="FEASIBLE"))

    monkeypatch.setattr("backend.solver._solve_range_impl", illegal_plan)
    executor = greedy_executor()
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert report["status"] == "rejected" and not report["applied"]
    assert identities(executor) == {GREEDY_THURSDAY}


def test_coverage_repair_skips_without_time():
    executor = greedy_executor()
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=1)
    assert report["status"] == "no_time" and identities(executor) == {GREEDY_THURSDAY}


class ScriptedProvider(LLMProvider):
    """Thursday: take Laurain for the COR slot (what a greedy day does).
    Every other turn: end the conversation without tool calls."""

    def __init__(self):
        self.calls = 0

    def complete(self, **kwargs):
        self.calls += 1
        first = kwargs["messages"][0].content if kwargs.get("messages") else ""
        if self.calls == 1 and THU in first:
            return ProviderResponse(text=None, stop_reason="tool_use", tool_calls=[ToolCall(
                id="t1", name="apply_moves", arguments={"moves": [
                    {"action": "assign", "slot_key": f"slot-cor-thu__{THU}", "clinicianId": "Marie Laurain"}]})])
        return ProviderResponse(text="Done.", tool_calls=[], stop_reason="end_turn")


def test_day_by_day_runs_the_cross_day_repair_before_the_review():
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="day_by_day")
    result = agent_solve_range(payload, trap_state(), threading.Event(), lambda *_: None, time.time(),
                               provider=ScriptedProvider(), config=AgentConfig(provider="mock", max_iterations=40))
    plan = {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in result["assignments"]}
    assert FRIDAY_PLAN <= plan and GREEDY_THURSDAY not in plan
    repair = result["debugInfo"]["agent"]["cross_day_repair"]
    assert repair["status"] == "applied" and repair["open_after"] == 1
    assert any(note.startswith("Cross-day repair filled 1 more required position") for note in result["notes"])


def test_day_by_day_keeps_the_top_section_when_only_lower_ones_could_gain():
    """End to end with COR on top: the repair finds nothing it may do, the
    Thursday COR stays staffed and Friday's lower sections stay open."""
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="day_by_day")
    result = agent_solve_range(payload, cor_first_state(), threading.Event(), lambda *_: None, time.time(),
                               provider=ScriptedProvider(), config=AgentConfig(provider="mock", max_iterations=40))
    plan = {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in result["assignments"]}
    assert GREEDY_THURSDAY in plan and not (FRIDAY_PLAN & plan)
    repair = result["debugInfo"]["agent"]["cross_day_repair"]
    assert repair["status"] == "no_improvement" and not repair["applied"]


def test_blocked_candidates_keep_the_weekly_hours_magnitude():
    """A near miss (1.5h over: 27.5 + 10 + 4 of 40) must not read like a
    hopeless case in the batched candidate list or in explain_unfilled."""
    executor = greedy_executor()
    batched = json.loads(executor.execute(
        "list_candidates_for_slot", {"slot_keys": [f"slot-seno-fri__{FRI}"]}, "t").content)
    (slot,) = batched["slots"].values()
    assert slot["ineligible"]["Marie Laurain"] == ["WEEKLY_HOURS"]
    assert slot["week_over_cap_hours"] == {"Marie Laurain": 1.5}

    explained = json.loads(executor.execute("explain_unfilled", {"dateISO": FRI}, "t").content)
    blockers = [b for e in explained["explanations"] for b in e["blocking_reasons"]]
    assert blockers and all(b["week_over_cap_hours"] == 1.5 for b in blockers
                            if b["clinicianId"] == "Marie Laurain")


# ---------------------------------------------------------------------------
# "direct" strategy (experiment): the whole range in one answer, no tools.

def test_parse_direct_reply_reads_the_plan_block():
    from backend.agent.direct import parse_direct_reply

    adds, removes, unparsed = parse_direct_reply(
        "Thinking out loud.\n```plan\nS1__2026-11-06 = Marie Laurain\n- S3__2026-11-05 = Marie Laurain\n"
        "not a placement\n```\nS9__2026-11-06 = After The Block")
    assert adds == [("S1__2026-11-06", "Marie Laurain")]
    assert removes == [("S3__2026-11-05", "Marie Laurain")]
    assert unparsed == 1


def test_direct_plan_retries_placements_refused_only_because_of_the_order():
    """A gate that, like one-block-per-day, refuses a placement until the
    slot joining it to the person's block is in: a refused placement gets
    another pass once its neighbour is in; one that is never legal stays
    refused."""
    from types import SimpleNamespace

    from backend.agent.direct import apply_direct_plan

    class OrderGate:
        def __init__(self):
            self.placed = []
            self.ctx = SimpleNamespace(instances={
                "early__2026-11-06": SimpleNamespace(start=450),
                "late__2026-11-06": SimpleNamespace(start=690),
                "other__2026-11-06": SimpleNamespace(start=900)})

        def _resolve_slot_key(self, key):
            return key

        def _resolve_clinician(self, name):
            return name

        def _tool_apply_moves(self, args):
            key = args["moves"][0]["slot_key"]
            # "early" only joins her fixed afternoon shift through "late";
            # "other" is never legal.
            if key == "other__2026-11-06" or (key == "early__2026-11-06" and "late__2026-11-06" not in self.placed):
                return {"applied": False, "new_hard_violations": [{"code": "SPLIT_SHIFT"}]}
            self.placed.append(key)
            return {"applied": True}

    gate = OrderGate()
    applied = apply_direct_plan(gate, [("other__2026-11-06", "Marie Laurain"), ("late__2026-11-06", "Marie Laurain"),
                                       ("early__2026-11-06", "Marie Laurain")], [])
    assert gate.placed == ["late__2026-11-06", "early__2026-11-06"]
    assert applied["accepted"] == 2
    assert applied["rejected"] == [{"action": "assign", "slot": "other__2026-11-06", "name": "Marie Laurain",
                                    "reasons": ["SPLIT_SHIFT"]}]


class DirectProvider(LLMProvider):
    """Reads the slot keys of the Friday places from the digest and answers
    with a plan, plus one illegal line (Other is not qualified)."""

    def __init__(self):
        self.calls = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        digest = kwargs["messages"][0].content
        keys = {line.split(" | ")[2]: line[2:].split(" | ")[0]
                for line in digest.splitlines() if line.startswith("- S")}
        if len(self.calls) > 1:  # correction round: keep the plan
            return ProviderResponse(text="```plan\n```", replay_text="```plan\n```", tool_calls=[],
                                    stop_reason="end_turn")
        plan = ("```plan\n"
                f"{keys['SENO']} = Marie Laurain\n{keys['ECHO']} = Marie Laurain\n{keys['COR']} = Other Person\n```")
        return ProviderResponse(text=plan, replay_text=plan, tool_calls=[], stop_reason="end_turn")


def test_direct_strategy_plans_without_tools_and_drops_illegal_lines():
    provider = DirectProvider()
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="direct")
    result = agent_solve_range(payload, trap_state(), threading.Event(), lambda *_: None, time.time(),
                               provider=provider, config=AgentConfig(provider="mock", max_iterations=10))
    plan = {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in result["assignments"]}
    assert plan == FRIDAY_PLAN
    assert all(not call["tools"] for call in provider.calls)  # no tools, ever
    direct = result["debugInfo"]["agent"]["direct"]
    assert (direct["proposed"], direct["accepted"], direct["dropped"]) == (3, 2, 1)
    assert direct["open_after_round"][0] == 1
    # The cross-day repair runs after the plan too; Thursday's long slot
    # stays open (nobody has 10 h left), so it changes nothing.
    repair = result["debugInfo"]["agent"]["cross_day_repair"]
    assert (repair["status"], repair["open_before"], repair["open_after"]) == ("no_improvement", 1, 1)
    assert repair["quality_before"]["open_required_slots"] == 1
    assert result["debugInfo"]["agent"]["strategy"] == "direct"
    assert any("direct, no tools" in note for note in result["notes"])
    # The digest gave the model everything: weekly hours and the legal people.
    digest = provider.calls[0]["messages"][0].content
    assert "W45 27.5/40" in digest and "legal: Marie Laurain" in digest
    # v2: her hours target for Thu+Fri (32 h x 2/7 = 9.1 h, tolerance 8 x 2/7)
    # and her preferred day, as the quality gate's hours deviation measures it.
    assert "target 9.1±2.3" in digest


def test_direct_answer_text_never_reads_the_reasoning():
    """Both adapters promote reasoning into .text when a reply has no answer
    text; a draft line in the reasoning must not count as the plan."""
    from backend.agent.direct import answer_text

    draft = "Maybe S1__2026-11-05 = Marie Laurain? No."
    # Anthropic: content blocks; only text blocks are the answer.
    thinking_only = ProviderResponse(text=draft, replay_text=draft, tool_calls=[], stop_reason="max_tokens",
                                     raw_content=[{"type": "thinking", "thinking": draft, "signature": "x"}])
    assert answer_text(thinking_only) == ""
    both = ProviderResponse(text="```plan\nS2__2026-11-06 = Marie Laurain\n```", tool_calls=[], stop_reason="end_turn",
                            raw_content=[{"type": "thinking", "thinking": draft, "signature": "x"},
                                         {"type": "text", "text": "```plan\nS2__2026-11-06 = Marie Laurain\n```"}])
    assert answer_text(both) == "```plan\nS2__2026-11-06 = Marie Laurain\n```"
    # OpenAI adapter: replay_text is the answer content alone (None here).
    reasoning_only = ProviderResponse(text=draft, tool_calls=[], stop_reason="max_tokens", replay_text=None)
    assert answer_text(reasoning_only) == ""


def test_direct_abort_during_the_model_call_applies_nothing():
    class AbortingProvider(DirectProvider):
        def __init__(self, cancel):
            super().__init__()
            self.cancel = cancel

        def complete(self, **kwargs):
            response = super().complete(**kwargs)
            self.cancel.set()  # the abort arrives while the call is in flight
            return response

    cancel = threading.Event()
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="direct")
    result = agent_solve_range(payload, trap_state(), cancel, lambda *_: None, time.time(),
                               provider=AbortingProvider(cancel), config=AgentConfig(provider="mock", max_iterations=10))
    agent = result["debugInfo"]["agent"]
    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert agent["moves_accepted"] == 0
    assert agent["direct"]["rounds"] == 0 and agent["cross_day_repair"] is None


def test_direct_marks_days_the_model_left_fillable_as_incomplete():
    """The model places Marie Laurain on Friday's SENO only and leaves ECHO
    open although she could take it: its own plan left Friday incomplete.
    The repair completes it, and the arena does not count that run as the
    model's plan."""
    from backend.arena.run import comparison_problems

    class HalfProvider(DirectProvider):
        def complete(self, **kwargs):
            self.calls.append(kwargs)
            keys = {line.split(" | ")[2]: line[2:].split(" | ")[0]
                    for line in kwargs["messages"][0].content.splitlines() if line.startswith("- S")}
            plan = "```plan\n```" if len(self.calls) > 1 else f"```plan\n{keys['SENO']} = Marie Laurain\n```"
            return ProviderResponse(text=plan, replay_text=plan, tool_calls=[], stop_reason="end_turn")

    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="direct")
    result = agent_solve_range(payload, trap_state(), threading.Event(), lambda *_: None, time.time(),
                               provider=HalfProvider(), config=AgentConfig(provider="mock", max_iterations=10))
    agent = result["debugInfo"]["agent"]
    assert agent["direct"]["open_after_round"] == [2, 2]
    assert agent["modelDaysIncomplete"] == [FRI]
    repair = agent["cross_day_repair"]
    assert (repair["status"], repair["open_before"], repair["open_after"], repair["days"]) == ("applied", 2, 1, [FRI])
    assert {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in result["assignments"]} == FRIDAY_PLAN
    assert agent["daysIncomplete"] == []
    assert (f"days the model left incomplete (completed by the cross-day repair): {FRI}"
            in comparison_problems(agent, agent.get("model")))


def test_arena_flags_days_the_repair_completed_for_the_model():
    from backend.arena.run import comparison_problems

    agent = {"result_producer": "agent", "model": "m", "model_usage": {"m": {}},
             "daysSkipped": [], "daysIncomplete": [], "modelDaysSkipped": [],
             "modelDaysIncomplete": [THU, FRI],
             "cross_day_repair": {"status": "applied", "days": [FRI]}}
    assert comparison_problems(agent, "m") == [
        f"days the model left incomplete (completed by the cross-day repair): {FRI}"]
    # A model-complete plan the repair improved across days stays valid.
    agent["modelDaysIncomplete"] = []
    assert comparison_problems(agent, "m") == []


# ---------------------------------------------------------------------------
# The repair model must accept every plan the gate accepts (review of v1.80):
# a stricter model makes the agent's legal plan an infeasible hint, and the
# repair then breaks legal placements or is rejected.
# ---------------------------------------------------------------------------


def _two_site_state(*, fixed_two_site_day: bool) -> AppState:
    """The trap plus Xavier, who can work site A 06-07 and site B 07-08 and
    16-20 on Friday (B 16-20 is required)."""
    s = trap_state()
    s.locations.append(Location(id="loc-b", name="Site B"))
    for sec, loc in (("sec-xa", "loc-default"), ("sec-xb", "loc-b")):
        s.rows.append(WorkplaceRow(id=sec, name=sec.upper(), kind="class", dotColorClass="bg-slate-200",
                                   locationId=loc))
        s.weeklyTemplate.blocks.append(TemplateBlock(id=f"block-{sec}", sectionId=sec, requiredSlots=0))
    default = s.weeklyTemplate.locations[0]
    default.rowBands.append(TemplateRowBand(id="rb-xa", label="xa", order=9))
    default.slots.append(TemplateSlot(id="slot-xa-fri", locationId="loc-default", rowBandId="rb-xa",
                                      colBandId="col-fri-1", blockId="block-sec-xa",
                                      requiredSlots=0 if fixed_two_site_day else 1,
                                      startTime="06:00", endTime="07:00", endDayOffset=0))
    s.weeklyTemplate.locations.append(WeeklyTemplateLocation(
        locationId="loc-b", rowBands=[TemplateRowBand(id="rb-xb", label="xb", order=1)],
        colBands=[TemplateColBand(id=f"colb-{d}-1", label="", order=1, dayType=d) for d in DAY_TYPES]
        + [TemplateColBand(id="colb-fri-2", label="", order=2, dayType="fri")],
        slots=[TemplateSlot(id="slot-xb1-fri", locationId="loc-b", rowBandId="rb-xb", colBandId="colb-fri-1",
                            blockId="block-sec-xb", requiredSlots=0 if fixed_two_site_day else 1,
                            startTime="07:00", endTime="08:00", endDayOffset=0),
               TemplateSlot(id="slot-xb2-fri", locationId="loc-b", rowBandId="rb-xb", colBandId="colb-fri-2",
                            blockId="block-sec-xb", requiredSlots=1 if fixed_two_site_day else 0,
                            startTime="16:00", endTime="20:00", endDayOffset=0)]))
    s.clinicians.append(Clinician(id="xavier", name="Xavier Two", qualifiedClassIds=["sec-xa", "sec-xb"],
                                  vacations=[], workingHoursPerWeek=None))
    if fixed_two_site_day:
        # A planner override: two sites on one day, fixed.
        s.assignments += [
            Assignment(id="m1", rowId="slot-xa-fri", dateISO=FRI, clinicianId="xavier", source="manual"),
            Assignment(id="m2", rowId="slot-xb1-fri", dateISO=FRI, clinicianId="xavier", source="manual"),
        ]
        s.solverSettings = {"enforceSameLocationPerDay": True, "onCallRestEnabled": False,
                            "preferContinuousShifts": False}
    else:
        s.solverSettings = {"enforceSameLocationPerDay": False, "onCallRestEnabled": False,
                            "preferContinuousShifts": True}
    return s


def _repair_with_agent_plan(state, moves):
    ctx = build_scoring_context(state, THU, FRI, only_fill_required=True)
    ex = PlanToolExecutor(state, ctx, [])
    assert ex._tool_apply_moves({"moves": moves}).get("applied")  # the gate accepts the agent's plan
    report = cross_day.coverage_repair(ex, cancel_event=threading.Event(), time_limit=10)
    return report, {(a.rowId, a.dateISO, a.clinicianId) for a in ex._working_list()}


def test_repair_keeps_a_block_across_two_sites_the_gate_accepts():
    """Same-site rule off, one block per day on: site A 06-07 directly
    followed by site B 07-08 is one block for the gate, so the repair keeps
    it and still moves Laurain's hours to Friday."""
    report, plan = _repair_with_agent_plan(_two_site_state(fixed_two_site_day=False), [
        {"action": "assign", "slot_key": f"slot-cor-thu__{THU}", "clinicianId": "laurain"},
        {"action": "assign", "slot_key": f"slot-xa-fri__{FRI}", "clinicianId": "xavier"},
        {"action": "assign", "slot_key": f"slot-xb1-fri__{FRI}", "clinicianId": "xavier"}])
    assert (report["status"], report["open_before"], report["open_after"], report["changes"]) == ("applied", 2, 1, 3)
    assert {("slot-xa-fri", FRI, "xavier"), ("slot-xb1-fri", FRI, "xavier")} <= plan
    assert FRIDAY_PLAN <= plan


def test_repair_keeps_work_at_a_site_of_a_fixed_two_site_day():
    """Xavier's fixed Friday already spans two sites (an override); the gate
    accepts more work at one of them, so the repair must keep it."""
    report, plan = _repair_with_agent_plan(_two_site_state(fixed_two_site_day=True), [
        {"action": "assign", "slot_key": f"slot-cor-thu__{THU}", "clinicianId": "laurain"},
        {"action": "assign", "slot_key": f"slot-xb2-fri__{FRI}", "clinicianId": "xavier"}])
    assert (report["status"], report["open_before"], report["open_after"], report["changes"]) == ("applied", 2, 1, 3)
    assert ("slot-xb2-fri", FRI, "xavier") in plan
    assert FRIDAY_PLAN <= plan


def test_direct_answer_cut_off_before_the_plan_gets_another_call():
    """The thinking counts towards max_tokens: a first answer that ends there
    without a plan is told so and gets one more call, which is not the
    correction round (that one still follows the plan)."""
    class CutOffProvider(DirectProvider):
        def complete(self, **kwargs):
            self.calls.append(kwargs)
            keys = {line.split(" | ")[2]: line[2:].split(" | ")[0]
                    for line in kwargs["messages"][0].content.splitlines() if line.startswith("- S")}
            if len(self.calls) == 1:
                draft = f"Maybe {keys['COR']} = Marie Laurain"
                return ProviderResponse(text=draft, replay_text=draft, tool_calls=[], stop_reason="max_tokens",
                                        raw_content=[{"type": "thinking", "thinking": draft, "signature": "s"}])
            plan = ("```plan\n```" if len(self.calls) > 2 else
                    f"```plan\n{keys['SENO']} = Marie Laurain\n{keys['ECHO']} = Marie Laurain\n"
                    f"{keys['COR']} = Other Person\n```")
            return ProviderResponse(text=plan, replay_text=plan, tool_calls=[], stop_reason="end_turn")

    provider = CutOffProvider()
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=600,
                                agent_strategy="direct")
    result = agent_solve_range(payload, trap_state(), threading.Event(), lambda *_: None, time.time(),
                               provider=provider, config=AgentConfig(provider="mock", max_iterations=10))
    direct = result["debugInfo"]["agent"]["direct"]
    assert len(provider.calls) == 3  # cut off, plan, correction round
    assert direct["cut_off_rounds"] == 1 and direct["rounds"] == 3
    assert direct["open_after_round"][0] == 3  # the draft in the thinking was not applied
    # The conversation: digest, cut-off answer, the note about the limit, ...
    conversation = provider.calls[-1]["messages"]
    assert "output limit" in conversation[2].content and "output limit" not in conversation[4].content
    assert {(a["rowId"], a["dateISO"], a["clinicianId"]) for a in result["assignments"]} == FRIDAY_PLAN


def test_direct_plan_keeps_the_models_order_for_scarce_hours():
    """Marie Laurain has 12.5 h left in W45. The model lists Friday's two 4 h
    places before Thursday's 10 h COR: in its order she gets both Friday
    places and COR is refused (by date, COR would take her hours first)."""
    from backend.agent.direct import apply_direct_plan

    state = trap_state()
    ctx = build_scoring_context(state, THU, FRI, only_fill_required=True)
    ex = PlanToolExecutor(state, ctx, [])
    applied = apply_direct_plan(ex, [(f"slot-seno-fri__{FRI}", "laurain"), (f"slot-echo-fri__{FRI}", "laurain"),
                                     (f"slot-cor-thu__{THU}", "laurain")], [])
    assert applied["accepted"] == 2
    assert [(r["slot"], r["reasons"]) for r in applied["rejected"]] == [(f"slot-cor-thu__{THU}", ["WEEKLY_HOURS"])]
    assert {(a.rowId, a.dateISO, a.clinicianId) for a in ex._working_list()} == FRIDAY_PLAN


class _ChainGate:
    """Slots s1..s4 of one day before a fixed shift: s4 joins the fixed
    shift, each earlier slot only joins once the next one is in. Removing
    s2 from s1-s3 splits the block until s3 is gone."""

    def __init__(self, placed=()):
        from types import SimpleNamespace
        self.placed = list(placed)
        self.ctx = SimpleNamespace(instances={})

    def _tool_apply_moves(self, args):
        move = args["moves"][0]
        key = move["slot_key"]
        index = int(key[1])
        if move["action"] == "assign":
            if index < 4 and f"s{index + 1}" not in self.placed:
                return {"applied": False, "new_hard_violations": [{"code": "SPLIT_SHIFT"}]}
            self.placed.append(key)
            return {"applied": True}
        if index == 2 and "s3" in self.placed and "s1" in self.placed:
            return {"applied": False, "new_hard_violations": [{"code": "SPLIT_SHIFT"}]}
        self.placed.remove(key)
        return {"applied": True}


def test_direct_plan_retries_while_a_pass_makes_progress():
    """A block that grows backwards from a fixed shift needs one pass per
    slot; a fixed number of passes would drop legal placements."""
    from backend.agent.direct import apply_direct_plan

    gate = _ChainGate()
    applied = apply_direct_plan(gate, [(f"s{i}", "ann") for i in (1, 2, 3, 4)], [])
    assert (applied["accepted"], applied["rejected"]) == (4, [])
    assert gate.placed == ["s4", "s3", "s2", "s1"]


def test_direct_plan_retries_removals_refused_only_because_of_the_order():
    from backend.agent.direct import apply_direct_plan

    gate = _ChainGate(placed=["s1", "s2", "s3"])
    applied = apply_direct_plan(gate, [], [("s2", "ann"), ("s3", "ann")])
    assert (applied["accepted"], applied["rejected"]) == (2, [])
    assert gate.placed == ["s1"]


def test_parse_direct_reply_reads_every_plan_block_and_only_those():
    from backend.agent.direct import parse_direct_reply

    adds, removes, unparsed = parse_direct_reply(
        "A note:\n```\nS9__2026-11-05 = Not A Plan\n```\n"
        "```Plan\nS1__2026-11-05 = Ann\n```\nWeek two:\n``` plan\nS2__2026-11-12 = Bob\n* S3__2026-11-12 = Cy\n```")
    assert adds == [("S1__2026-11-05", "Ann"), ("S2__2026-11-12", "Bob")]
    assert removes == [] and unparsed == 1


# ---------------------------------------------------------------------------
# Rest Day row entries (main's v1.75 rule REST_DAY, merged in v1.80): CP-SAT
# has no variable on such a date, the shared gate refuses it.
# ---------------------------------------------------------------------------


def rest_day_state() -> AppState:
    """The trap with Laurain placed in the Rest Day row on Friday."""
    state = trap_state()
    state.assignments.append(Assignment(id="rest-fri", rowId="pool-rest-day", dateISO=FRI,
                                        clinicianId="laurain", source="manual"))
    return state


def _repair_result(reference, max_changes=None):
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=20)
    result = _solve_range_impl(payload, None, cancel_event=threading.Event(), on_progress=lambda *_: None,
                               start_time=time.time(), state_override=rest_day_state(),
                               repair_reference=reference, repair_max_changes=max_changes)
    return result.debugInfo.solver_status, {(a.rowId, a.dateISO, a.clinicianId) for a in result.assignments}


def test_solver_repair_mode_never_moves_hours_onto_a_rest_day():
    status, plan = _repair_result({GREEDY_THURSDAY})
    assert status in cross_day.SOLVED_STATUSES and plan == {GREEDY_THURSDAY}


def test_solver_repair_reference_without_a_variable_is_not_a_change():
    """A reference placement the model has no variable for (here: on her rest
    day) neither breaks the repair nor counts as a change: with no change
    allowed the model stays solvable, it just cannot hold that placement."""
    status, plan = _repair_result(set(FRIDAY_PLAN), max_changes=0)
    assert status in cross_day.SOLVED_STATUSES and plan == set()
    status, plan = _repair_result(set(FRIDAY_PLAN), max_changes=1)
    assert status in cross_day.SOLVED_STATUSES and plan == {GREEDY_THURSDAY}


def test_coverage_repair_leaves_a_rest_day_alone():
    executor = greedy_executor(rest_day_state())
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    # The model knows the rest day: nothing to propose, nothing for the gate to refuse.
    assert (report["status"], report["open_before"], report["open_after"]) == ("no_improvement", 2, 2), report
    assert identities(executor) == {GREEDY_THURSDAY}


def test_coverage_repair_gate_refuses_work_on_a_rest_day(monkeypatch):
    from backend.models import SolveRangeResponse, SolverDebugInfo

    def onto_the_rest_day(*_args, **_kwargs):
        return SolveRangeResponse(
            startISO=THU, endISO=FRI, notes=[],
            assignments=[Assignment(id=f"x{i}", rowId=row, dateISO=day, clinicianId=cid, source="solver")
                         for i, (row, day, cid) in enumerate(sorted(FRIDAY_PLAN))],
            debugInfo=SolverDebugInfo(timing={}, solver_status="OPTIMAL"))

    monkeypatch.setattr("backend.solver._solve_range_impl", onto_the_rest_day)
    executor = greedy_executor(rest_day_state())
    report = cross_day.coverage_repair(executor, cancel_event=threading.Event(), time_limit=20)
    assert (report["status"], report["reason"]) == ("rejected", "invalid")
    assert any("REST_DAY" in item for item in report["sample"]), report["sample"]
    assert identities(executor) == {GREEDY_THURSDAY}


def test_direct_legal_people_and_open_reasons_leave_out_a_rest_day():
    from backend.agent import direct, open_reasons
    from backend.scoring import open_slots

    state = rest_day_state()
    executor = PlanToolExecutor(state, build_scoring_context(state, THU, FRI, only_fill_required=True), [])
    legal = {inst.slot_key: people for inst, _missing, people in direct.open_places(executor)}
    assert legal == {f"slot-cor-thu__{THU}": ["Marie Laurain"],
                     f"slot-seno-fri__{FRI}": [], f"slot-echo-fri__{FRI}": []}
    assert direct._apply_one(executor, "assign", f"slot-seno-fri__{FRI}", "Marie Laurain") == ["REST_DAY"]

    blockers = open_reasons.open_slot_blockers(executor, open_slots(executor.ctx, executor._working_list()))
    seno = blockers[f"slot-seno-fri__{FRI}"]
    assert (seno["blocked_by"], seno["main"]) == ({"REST_DAY": 1}, "REST_DAY")
    assert open_reasons.blocker_text(seno) == "1 qualified; blocked by rest day 1"
