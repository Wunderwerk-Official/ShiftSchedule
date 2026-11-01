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
from backend.solver import _solve_range_impl

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


def repair_with_solver(reference, seconds=20.0):
    payload = SolveRangeRequest(startISO=THU, endISO=FRI, only_fill_required=True, timeout_seconds=seconds)
    result = _solve_range_impl(payload, None, cancel_event=threading.Event(), on_progress=lambda *_: None,
                               start_time=time.time(), state_override=trap_state(),
                               repair_reference=reference)
    return {(a.rowId, a.dateISO, a.clinicianId) for a in result.assignments}


def greedy_executor():
    state = trap_state()
    executor = PlanToolExecutor(state, build_scoring_context(state, THU, FRI, only_fill_required=True), [])
    applied = executor._tool_apply_moves({"moves": [
        {"action": "assign", "slot_key": f"slot-cor-thu__{THU}", "clinicianId": "laurain"}]})
    assert applied["applied"]
    return executor


def identities(executor):
    return {(a.rowId, a.dateISO, a.clinicianId) for a in executor._working_list()}


def test_solver_repair_mode_moves_weekly_hours_to_the_higher_value_day():
    assert repair_with_solver({GREEDY_THURSDAY}) == FRIDAY_PLAN


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


def test_direct_plan_is_applied_by_start_time_and_retried_when_only_the_order_failed():
    """A gate that, like one-block-per-day, refuses a placement until the
    slot joining it to the person's block is in: the plan is applied by
    day, person and start time, and a refused placement gets another pass."""
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
            return ProviderResponse(text="```plan\n```", tool_calls=[], stop_reason="end_turn")
        return ProviderResponse(text=(
            "```plan\n"
            f"{keys['SENO']} = Marie Laurain\n{keys['ECHO']} = Marie Laurain\n{keys['COR']} = Other Person\n```"),
            tool_calls=[], stop_reason="end_turn")


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
