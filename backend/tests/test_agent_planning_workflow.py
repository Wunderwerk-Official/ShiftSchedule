"""Behavioral regressions for proposal selection, revisions and search scope."""
import json

import pytest

from backend.agent.tools import PlanToolExecutor
from backend.models import TemplateBlock
from backend.scoring import build_scoring_context
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot, make_workplace_row

MON = "2026-01-05"
TUE = "2026-01-06"


def test_direct_inspections_share_exact_checks_but_apply_revalidates(monkeypatch):
    ex = executor()
    original = ex._hard_violations
    calls = []
    def counted(plan):
        calls.append(1)
        return original(plan)
    monkeypatch.setattr(ex, "_hard_violations", counted)
    entries = ex._day_open_entries(MON)
    count = len(calls)
    candidates = run(ex, "list_candidates_for_slot", slot_key=entries[0]["slot_key"])
    assert len(calls) == count
    assert candidates["candidates"][0]["eligible"]
    # Returned lists must not let a caller corrupt the cached validator result.
    ex._direct_addition_codes("slot-a__mon", MON, "clin-1").append("corrupted")
    assert ex._direct_addition_codes("slot-a__mon", MON, "clin-1") == []
    run(ex, "apply_moves", moves=[{"action": "assign", "slot_key": entries[0]["slot_key"], "clinicianId": "clin-1"}], dry_run=True)
    assert len(calls) > count
    assert not ex.current


def test_direct_checks_invalidate_when_other_day_consumes_weekly_hours():
    clinician = make_clinician("a", "Alice", working_hours_per_week=8)
    clinician.workingHoursToleranceHours = 0
    ex = executor(make_app_state(clinicians=[clinician], slots=[
        make_template_slot("mon"), make_template_slot("tue", col_band_id="col-tue-1"),
    ]), end=TUE)
    assert ex._direct_addition_codes("mon", MON, "a") == []
    run(ex, "apply_moves", moves=[{"action": "assign", "slot_key": f"tue__{TUE}", "clinicianId": "a"}])
    assert "WEEKLY_HOURS" in ex._direct_addition_codes("mon", MON, "a")


def test_cached_inspection_can_never_authorize_an_illegal_assignment():
    state = make_app_state(slots=[make_template_slot("first"), make_template_slot("overlap")])
    ex = executor(state, [make_assignment("draft", "first", MON, "clin-1", source="solver")])
    # Even a deliberately corrupted inspection entry must not bypass acceptance.
    ex.workflow.direct_checks[("overlap", MON, "clin-1")] = ()
    assert ex._direct_addition_codes("overlap", MON, "clin-1") == []
    result = run(ex, "apply_moves", moves=[{"action": "assign", "slot_key": f"overlap__{MON}", "clinicianId": "clin-1"}])
    assert not result["applied"] and result["new_hard_violations"]
    assert len(ex.current) == 1 and len(ex.best_assignments) == 1


def paginated_rescue_fixture(*, repair_at_tail=True):
    # Sixteen impossible positions sort before a seventeenth repairable one.
    sections = [f"impossible-{i:02}" for i in range(16)] + ["A", "B"]
    clinicians = [make_clinician("a", "Alice", ["A", "B"], working_hours_per_week=40)]
    if repair_at_tail:
        clinicians.append(make_clinician("b", "Bob", ["B"], working_hours_per_week=40))
    state = section_state(clinicians, [make_template_slot(s, block_id=s) for s in sections], sections)
    return executor(state, [make_assignment("draft", "B", MON, "a", source="solver")])


def test_rescue_continuation_reaches_seventeenth_slot_without_plan_change():
    ex = paginated_rescue_fixture()
    page1 = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert len(page1["searched_slots"]) == 16 and not page1["rescues"]
    assert page1["search_status"] == "incomplete"
    page2 = run(ex, "suggest_rescue_moves", dateISO=MON, cursor=page1["next_cursor"])
    assert page2["rescues"] and page2["search_status"] == "completed"
    assert set(page1["searched_slots"]).isdisjoint(page2["searched_slots"])
    assert len(page2["searched_slots"]) == 1
    assert ex.workflow.review_day(MON)["proposals"] == [page2["rescues"][0]["proposal_id"]]
    applied = run(ex, "apply_proposal", proposal_id=page2["rescues"][0]["proposal_id"])
    assert applied["applied"] and len(ex.current) == 2
    stale = ex.execute("suggest_rescue_moves", {"dateISO": MON, "cursor": page1["next_cursor"]}, "test")
    assert "stale" in json.loads(stale.content)["error"]


def test_day_review_finishes_all_pages_before_accepting_no_rescue():
    ex = paginated_rescue_fixture(repair_at_tail=False)
    assert ex.workflow.review_day(MON)["complete"]
    searches = [r for r in ex.workflow.searches if r["tool"] == "suggest_rescue_moves"]
    assert len(searches) == 2
    assert searches[-1]["status"] == "completed"


@pytest.mark.parametrize("cursor", ["garbage", f"rescue:{TUE}:0:16", f"rescue:{MON}:99:16", f"rescue:{MON}:0:999", f"rescue:{MON}:0:0"])
def test_invalid_rescue_cursor_is_actionable(cursor):
    ex = paginated_rescue_fixture()
    reply = ex.execute("suggest_rescue_moves", {"dateISO": MON, "cursor": cursor}, "test")
    assert "Start again" in json.loads(reply.content)["error"]
    assert len(ex.current) == 1


def test_partial_search_still_returns_checked_improvements_to_harness(monkeypatch):
    ex = paginated_rescue_fixture()
    actual = ex._tool_suggest_rescue_moves({"dateISO": MON, "cursor": f"rescue:{MON}:0:16"})
    actual.update(search_status="incomplete", not_searched=["uninspected"])
    monkeypatch.setattr(ex, "_tool_suggest_rescue_moves", lambda _: actual)
    review = ex.workflow.review_day(MON)
    assert not review["complete"] and review["proposals"]
    assert run(ex, "apply_proposal", proposal_id=review["proposals"][0])["applied"]


def test_budget_cut_cannot_be_mistaken_for_a_completed_rescue_page(monkeypatch):
    ex = paginated_rescue_fixture()
    monkeypatch.setattr(ex, "_tool_seconds_left", lambda: 20)
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert result["search_status"] == "incomplete" and not result["searched_slots"]
    assert len(result["not_searched"]) == 17 and "next_cursor" not in result
    assert not ex.workflow.review_day(MON)["complete"]


def run(executor, name, **arguments):
    response = executor.execute(name, arguments, "test")
    assert not response.is_error, response.content
    return json.loads(response.content)


def executor(state=None, seed=None, end=MON):
    state = state or make_app_state()
    return PlanToolExecutor(state, build_scoring_context(state, MON, end, only_fill_required=True), seed or [])


def section_state(clinicians, slots, sections):
    state = make_app_state(clinicians=clinicians, slots=slots,
                           rows=[make_workplace_row(s, s) for s in sections])
    state.weeklyTemplate.blocks = [TemplateBlock(id=s, sectionId=s, requiredSlots=0) for s in sections]
    return state


def test_blocks_rank_seventh_candidate_before_limiting_response():
    clinicians = [make_clinician(f"a{i}", f"A-only {i}", ["A"], working_hours_per_week=40) for i in range(6)]
    clinicians += [make_clinician("ab", "Full block", ["A", "B"], working_hours_per_week=40)]
    clinicians += [make_clinician(f"b{i}", f"B-only {i}", ["B"], working_hours_per_week=40) for i in range(7)]
    ex = executor(section_state(clinicians, [
        make_template_slot("A", block_id="A", start_time="08:00", end_time="09:00"),
        make_template_slot("B", block_id="B", start_time="09:00", end_time="12:00"),
    ], ["A", "B"]))
    options = run(ex, "suggest_day_blocks", dateISO=MON)
    assert options["section"] == "A"
    assert options["evaluated_candidates"] == 7
    assert len(options["candidates"]) == 6
    best = options["candidates"][0]
    assert best["clinicianId"] == "Full block"
    assert best["block_hours"] == 4
    accepted = run(ex, "apply_proposal", proposal_id=best["proposal_id"])
    assert accepted["applied"]
    assert accepted["next"]["result"]["day_complete"]
    assert ex.best_quality[:3] == (0, 0, 0)


def test_proposal_retry_never_reapplies_changes_or_reuses_old_next_options():
    ex = executor()
    options = run(ex, "suggest_day_blocks", dateISO=MON)
    proposal_id = options["candidates"][0]["proposal_id"]
    first = run(ex, "apply_proposal", proposal_id=proposal_id)
    accepted_count = ex.moves_accepted
    again = run(ex, "apply_proposal", proposal_id=proposal_id)
    assert first["applied"] and not again["applied"]
    assert again["already_applied"]
    assert ex.moves_accepted == accepted_count
    assert "next" not in again


def test_final_audit_applies_checked_day_block_larger_than_model_move_limit():
    from threading import Event

    slots = []
    for index in range(24):
        start = 8 * 60 + index * 15
        end = start + 15
        slots.append(make_template_slot(f"quarter-{index:02}",
                                       start_time=f"{start // 60:02}:{start % 60:02}",
                                       end_time=f"{end // 60:02}:{end % 60:02}"))
    ex = executor(make_app_state(clinicians=[make_clinician("a", "Alice")], slots=slots))
    options = run(ex, "suggest_day_blocks", dateISO=MON)
    proposal = ex.workflow.proposals[options["candidates"][0]["proposal_id"]]
    assert len(proposal["moves"]) == 24
    # Keep the public model payload bound, while accepting the internally
    # checked proposal atomically through the normal proposal-ID contract.
    reply = ex.execute("apply_moves", {"moves": proposal["moves"]}, "model-call")
    assert reply.is_error and not ex.current
    result = ex.workflow.final_audit([MON], Event())
    assert result["repairs"] == 1
    assert len(ex.current) == len(ex.best_assignments) == 24
    assert result["checks"][MON]["complete"]


def test_other_day_change_invalidates_proposal_and_negative_search_cache():
    state = make_app_state(slots=[
        make_template_slot("mon"), make_template_slot("tue", col_band_id="col-tue-1"),
    ])
    ex = executor(state, end=TUE)
    old = run(ex, "suggest_day_blocks", dateISO=MON)
    repeated = run(ex, "suggest_day_blocks", dateISO=MON)
    assert repeated["cached"]
    assert repeated["candidates"][0]["proposal_id"] == old["candidates"][0]["proposal_id"]
    run(ex, "apply_moves", moves=[{"action": "assign", "slot_key": f"tue__{TUE}", "clinicianId": "clin-1"}])
    stale = run(ex, "apply_proposal", proposal_id=old["candidates"][0]["proposal_id"])
    assert stale["stale_proposal"] and not stale["applied"]
    current = run(ex, "suggest_day_blocks", dateISO=MON)
    assert not current["cached"]
    assert current["plan_revision"] > old["plan_revision"]
    history = run(ex, "get_search_history")
    assert any(not item["current"] for item in history["searches"])


def chain_fixture():
    state = section_state([
        make_clinician("a", "Alice", ["A", "B"], working_hours_per_week=40),
        make_clinician("b", "Bob", ["B", "C"], working_hours_per_week=40),
        make_clinician("c", "Cara", ["C"], working_hours_per_week=40),
    ], [make_template_slot(s, block_id=s) for s in ("A", "B", "C")], ["A", "B", "C"])
    state.solverSettings["agentNeighborhoodSearch"] = True
    return executor(state, [make_assignment("draft-1", "B", MON, "a", source="solver"),
                            make_assignment("draft-2", "C", MON, "b", source="solver")])


def test_shallow_rescue_reports_search_scope_instead_of_infeasibility():
    ex = chain_fixture()
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert result["rescues"] == []
    assert result["no_rescue_found"]
    assert "truly_unfillable" not in result
    assert result["search_scope"]["relocated_assignments"] == 1


def test_neighborhood_finds_joint_chain_that_shallow_rescue_misses():
    ex = chain_fixture()
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert result["search_status"] == "improvement_found"
    assert len(ex.current) == 2  # searching itself never edits the draft
    applied = run(ex, "apply_proposal", proposal_id=result["proposals"][0]["proposal_id"])
    assert applied["applied"]
    assert ex.best_quality[:2] == (0, 0)
    assert len(ex.current) == 3


def test_neighborhood_releases_weekly_hours_across_days_atomically():
    clinicians = [make_clinician("a", "Alice", ["A", "B"], working_hours_per_week=8),
                  make_clinician("b", "Bob", ["B", "C"], working_hours_per_week=8),
                  make_clinician("c", "Cara", ["C"], working_hours_per_week=8)]
    for clinician in clinicians:
        clinician.workingHoursToleranceHours = 0
    state = section_state(clinicians, [
        make_template_slot("A", block_id="A", col_band_id="col-tue-1"),
        make_template_slot("B", block_id="B"),
        make_template_slot("C", block_id="C", col_band_id="col-tue-1"),
    ], ["A", "B", "C"])
    state.solverSettings["agentNeighborhoodSearch"] = True
    ex = executor(state, [make_assignment("draft-1", "B", MON, "a", source="solver"),
                          make_assignment("draft-2", "C", TUE, "b", source="solver")], end=TUE)
    assert run(ex, "suggest_rescue_moves", dateISO=TUE)["rescues"] == []
    result = run(ex, "repair_neighborhood", dateISO=TUE)
    assert result["proposals"]
    assert run(ex, "apply_proposal", proposal_id=result["proposals"][0]["proposal_id"])["applied"]
    assert ex.best_quality[:2] == (0, 0)
    assert all(ex._week_hours(c.id, MON) == 8 for c in clinicians)


def test_neighborhood_preserves_fixed_entries():
    ex = chain_fixture()
    state = ex.state.model_copy(deep=True)
    state.assignments = list(ex.current.values())
    fixed = executor(state)
    result = run(fixed, "repair_neighborhood", dateISO=MON)
    assert not result["proposals"]
    assert fixed.current == {}
    assert fixed.fixed_assignments == state.assignments


def test_neighborhood_deadline_returns_unsearched_status_without_changes():
    ex = chain_fixture()
    ex.wall_deadline = 1
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert result["search_status"] == "budget_exhausted"
    assert result["not_searched"] == [MON]
    assert len(ex.current) == 2


def test_disabled_experiment_cannot_be_invoked_by_guessing_the_tool_name():
    ex = executor()
    reply = ex.execute("repair_neighborhood", {"dateISO": MON}, "test")
    assert "disabled" in json.loads(reply.content)["error"]
    assert not ex.current


def test_expired_inspection_never_claims_day_is_complete_or_candidates_impossible():
    ex = executor()
    ex.wall_deadline = 1
    result = run(ex, "suggest_day_blocks", dateISO=MON)
    assert result["search_status"] == "incomplete"
    assert not result.get("day_complete")
    assert "unfillable_slots" not in result
    repeated = run(ex, "suggest_day_blocks", dateISO=MON)
    assert repeated["cached"]
    assert repeated["search_id"] == result["search_id"]
    ex.wall_deadline = None
    result = run(ex, "suggest_day_blocks", dateISO=MON)
    assert not result["cached"] and result["candidates"]


def test_evicted_proposal_is_regenerated_on_cached_search():
    ex = executor()
    old = run(ex, "suggest_day_blocks", dateISO=MON)
    ex.workflow.proposals.clear()  # simulate bounded storage eviction
    new = run(ex, "suggest_day_blocks", dateISO=MON)
    assert not new["cached"]
    assert new["candidates"][0]["proposal_id"] != old["candidates"][0]["proposal_id"]
    assert run(ex, "apply_proposal", proposal_id=new["candidates"][0]["proposal_id"])["applied"]


def test_failure_to_get_next_suggestion_does_not_disguise_success(monkeypatch):
    ex = executor()
    offered = run(ex, "suggest_day_blocks", dateISO=MON)["candidates"][0]
    def broken(_):
        raise RuntimeError("suggestion unavailable")
    monkeypatch.setattr(ex, "_tool_suggest_day_blocks", broken)
    result = run(ex, "apply_proposal", proposal_id=offered["proposal_id"])
    assert result["applied"] and ex.current
    assert "error" in result["next"]["result"]
    assert run(ex, "apply_proposal", proposal_id=offered["proposal_id"])["already_applied"]


def test_neighborhood_gate_rejects_cross_boundary_rest_conflict():
    from backend.models import Assignment
    state = section_state([make_clinician("a", "Alice", ["A", "Duty"], working_hours_per_week=40)],
                          [make_template_slot("A", block_id="A"),
                           make_template_slot("Duty", block_id="Duty", col_band_id="col-tue-1")], ["A", "Duty"])
    state.solverSettings.update(agentNeighborhoodSearch=True, onCallRestEnabled=True,
                               onCallRestClassId="Duty", onCallRestDaysBefore=1, onCallRestDaysAfter=1)
    state.assignments = [Assignment(id="fixed-duty", rowId="Duty", dateISO=TUE, clinicianId="a", source="manual")]
    ex = executor(state)
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert not result["proposals"]
    assert not ex.current


def test_full_slot_candidate_list_does_not_claim_replacements_are_impossible():
    state = make_app_state(clinicians=[make_clinician("a", "Alice"), make_clinician("b", "Bob")])
    ex = executor(state, [make_assignment("draft", "slot-a__mon", MON, "a", source="solver")])
    candidates = run(ex, "list_candidates_for_slot", slot_key=f"slot-a__mon__{MON}")
    assert not any(c["eligible"] for c in candidates["candidates"])
    assert candidates["scope"] == "direct_additions_only"
    assert "does NOT mean no replacement exists" in candidates["note"]
    swap = run(ex, "apply_moves", dry_run=True, moves=[
        {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "a"},
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "b"},
    ])
    assert swap["valid"]
