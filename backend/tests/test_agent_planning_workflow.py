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
    # B ranks above A: without Bob, moving Alice up from B is no strict
    # improvement either (v1.82), so the day really has no rescue.
    sections = [f"impossible-{i:02}" for i in range(16)] + ["B", "A"]
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
    quality = ex.quality_dict(ex.best_quality)
    assert (quality["hard_violations_in_range"], quality["open_required_slots"], quality["short_days"]) == (0, 0, 0)


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


def test_final_audit_repair_skips_follow_up_search_but_model_apply_keeps_it():
    from threading import Event

    state = make_app_state(slots=[
        make_template_slot("mon"), make_template_slot("tue", col_band_id="col-tue-1"),
    ])
    ex = executor(state, end=TUE)
    calls = []
    original = ex.execute

    def recording_execute(name, args, call_id):
        calls.append(call_id)
        return original(name, args, call_id)

    ex.execute = recording_execute
    options = run(ex, "suggest_day_blocks", dateISO=MON)
    applied = run(ex, "apply_proposal", proposal_id=options["candidates"][0]["proposal_id"])
    assert applied["applied"] and "next" in applied
    assert "proposal-followup" in calls

    calls.clear()
    result = ex.workflow.final_audit([MON, TUE], Event())
    assert result["repairs"] >= 1
    assert "final-checked-repair" in calls
    assert "proposal-followup" not in calls


@pytest.mark.parametrize("rest_enabled", [False, True])
def test_duty_pass_follow_up_uses_the_on_call_section_only_while_rest_rule_is_on(rest_enabled):
    # v1.75: the duty pass follows executor.on_call_class like the harness;
    # with the rule off there is no on-call section, so nothing is left.
    state = make_app_state(slots=[
        make_template_slot("mon"), make_template_slot("tue", col_band_id="col-tue-1"),
    ])
    state.solverSettings.update(onCallRestClassId="section-a", onCallRestEnabled=rest_enabled,
                                onCallRestDaysBefore=0, onCallRestDaysAfter=0)
    ex = executor(state, end=TUE)
    offers = run(ex, "suggest_day_blocks", slot_key=f"mon__{MON}", single=True)
    assert offers.get("on_call", False) is rest_enabled
    applied = run(ex, "apply_proposal", proposal_id=offers["candidates"][0]["proposal_id"])
    assert applied["applied"]
    follow_up = applied["next"]["result"]
    if rest_enabled:
        assert follow_up["slot_key"] == ex._alias_slot_key(f"tue__{TUE}") and follow_up["on_call"]
    else:
        assert follow_up == {"duty_complete": True}


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


def chain_fixture(order=("A", "B", "C")):
    state = section_state([
        make_clinician("a", "Alice", ["A", "B"], working_hours_per_week=40),
        make_clinician("b", "Bob", ["B", "C"], working_hours_per_week=40),
        make_clinician("c", "Cara", ["C"], working_hours_per_week=40),
    ], [make_template_slot(s, block_id=s) for s in ("A", "B", "C")], list(order))
    state.solverSettings["agentNeighborhoodSearch"] = True
    return executor(state, [make_assignment("draft-1", "B", MON, "a", source="solver"),
                            make_assignment("draft-2", "C", MON, "b", source="solver")])


def test_shallow_rescue_reports_search_scope_instead_of_infeasibility():
    # A ranks lowest: moving Alice up from B would leave a higher section
    # open, so the shallow search has nothing to offer.
    ex = chain_fixture(order=("B", "C", "A"))
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert result["rescues"] == []
    assert result["no_rescue_found"]
    assert "truly_unfillable" not in result
    assert result["search_scope"]["relocated_assignments"] == 1


def test_rescue_moves_a_person_up_to_a_higher_section_without_a_substitute():
    """v1.82, strict section order: nobody can take over Alice's B slot, but
    A ranks above B, so Alice moving up is an improvement that leaves B
    open (a 2-move batch, leaves_open)."""
    ex = chain_fixture()
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert len(result["rescues"]) == 1
    rescue = result["rescues"][0]
    assert rescue["substitute"] is None and rescue["leaves_open"] == rescue["vacated_slot"]
    assert [move["action"] for move in rescue["batch"]] == ["unassign", "assign"]
    assert rescue["improves_best"]
    assert run(ex, "apply_proposal", proposal_id=rescue["proposal_id"])["applied"]
    assert ex.quality_dict(ex.best_quality)["open_by_section_order"] == [0, 1, 0]


def test_neighborhood_finds_joint_chain_that_shallow_rescue_misses():
    ex = chain_fixture()
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert result["search_status"] == "improvement_found"
    assert len(ex.current) == 2  # searching itself never edits the draft
    applied = run(ex, "apply_proposal", proposal_id=result["proposals"][0]["proposal_id"])
    assert applied["applied"]
    assert (ex.quality_dict(ex.best_quality)["hard_violations_in_range"],
            ex.quality_dict(ex.best_quality)["open_required_slots"]) == (0, 0)
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
    assert (ex.quality_dict(ex.best_quality)["hard_violations_in_range"],
            ex.quality_dict(ex.best_quality)["open_required_slots"]) == (0, 0)
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


def test_neighborhood_never_proposes_a_person_on_a_rest_day(monkeypatch):
    # v1.75: a Rest Day row entry removes the person from the candidate model
    # (like vacation), so no preview is even spent on them.
    def fixture(rest_for):
        state = section_state([make_clinician("a", "Alice", ["A"], working_hours_per_week=40),
                               make_clinician("b", "Bob", ["A"], working_hours_per_week=40)],
                              [make_template_slot("A", block_id="A")], ["A"])
        state.solverSettings["agentNeighborhoodSearch"] = True
        state.assignments = [make_assignment(f"rest-{c}", "pool-rest-day", MON, c, source="manual")
                             for c in rest_for]
        ex = executor(state)
        previews = []
        original = ex._tool_apply_moves

        def recorded(arguments):
            previews.append(arguments["moves"])
            return original(arguments)
        monkeypatch.setattr(ex, "_tool_apply_moves", recorded)
        return ex, previews

    ex, previews = fixture(["a", "b"])
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert result["proposals"] == [] and previews == []
    ex, previews = fixture(["a"])
    result = run(ex, "repair_neighborhood", dateISO=MON)
    assert result["search_status"] == "improvement_found"
    assert {move["clinicianId"] for moves in previews for move in moves} == {"b"}


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


@pytest.mark.parametrize("profile", ["classic", "balanced"])
def test_day_block_candidates_follow_the_strict_section_order(profile):
    """v1.82: the selected slot X ranks below A. P's block also reaches A's
    open slot, Q's does not; Q is otherwise first (P's block misses the
    daily minimum by stretching into a short stint, Q's meets it). Both
    profiles list P first: A ranks above X's section."""
    clinicians = [make_clinician("p", "P (A+X)", ["A", "X"], working_hours_per_week=40),
                  make_clinician("q", "Q (X)", ["X"], working_hours_per_week=40)]
    slots = [make_template_slot("X1", block_id="X", row_band_id="row-1", start_time="08:00", end_time="12:00"),
             make_template_slot("X2", block_id="X", row_band_id="row-1", start_time="12:00", end_time="14:00"),
             make_template_slot("A1", block_id="A", row_band_id="row-1", start_time="12:00", end_time="13:00")]
    state = section_state(clinicians, slots, ["A", "X"])
    state.solverSettings["agentQualityProfile"] = profile
    ex = executor(state)
    out = run(ex, "suggest_day_blocks", slot_key=f"X1__{MON}")
    order = [c["clinicianId"] for c in out["candidates"]]
    assert order[0] == "P (A+X)", out["candidates"]


def test_classic_candidates_keep_the_day_order_inside_lower_sections():
    """Review of v1.82: reaching more or other LOWER sections does not move a
    block ahead; the day-length and fairness order decides (ranking every
    reached section first cost short days in the first-offer baseline)."""
    clinicians = [make_clinician("p", "P (A+B)", ["A", "B"], working_hours_per_week=40),
                  make_clinician("q", "Q (A+C)", ["A", "C"], working_hours_per_week=40)]
    slots = [make_template_slot("X", block_id="A", row_band_id="row-1", start_time="08:00", end_time="10:00"),
             make_template_slot("B1", block_id="B", row_band_id="row-1", start_time="10:00", end_time="12:00"),
             make_template_slot("C1", block_id="C", row_band_id="row-1", start_time="10:00", end_time="12:00"),
             make_template_slot("C2", block_id="C", row_band_id="row-1", start_time="12:00", end_time="14:00")]
    state = section_state(clinicians, slots, ["A", "B", "C"])
    ex = executor(state)
    out = run(ex, "suggest_day_blocks", slot_key=f"X__{MON}")
    # Both blocks meet the daily minimum and fit; Q's is longer (6 h against
    # 4 h), so the v1.80 order puts Q first although P's block reaches B,
    # which ranks above C: both lie below the selected slot's section A.
    assert [c["clinicianId"] for c in out["candidates"]] == ["Q (A+C)", "P (A+B)"]
def test_rescue_in_distribute_all_mode_moves_a_person_off_a_slot_above_its_target():
    """Review of v1.82: when the vacated slot keeps its target without the
    person (distribute-all headroom), the 2-move rescue opens nothing: it is
    offered whatever the ranks are, and without leaves_open."""
    state = section_state([make_clinician("a", "Alice", ["A", "B"], working_hours_per_week=40),
                           make_clinician("b", "Bob", ["B"], working_hours_per_week=40)],
                          [make_template_slot(s, block_id=s) for s in ("A", "B")], ["B", "A"])
    ex = PlanToolExecutor(state, build_scoring_context(state, MON, MON, only_fill_required=False),
                          [make_assignment("d1", "B", MON, "a", source="solver"),
                           make_assignment("d2", "B", MON, "b", source="solver")])
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert len(result["rescues"]) == 1
    rescue = result["rescues"][0]
    assert rescue["substitute"] is None and rescue["leaves_open"] is None
    assert rescue["improves_best"]


def test_two_sections_of_one_day_are_worked_top_section_first():
    """Review of v1.82: across two ordinary sections the section rank
    decides before scarcity and start time, in the tools, the open-slot list
    and the direct strategy's digest."""
    from backend.agent import direct
    from backend.scoring import open_slots

    clinicians = [make_clinician(f"c{i}", f"Person {i}", ["TOP", "LOW"], working_hours_per_week=40) for i in range(3)]
    slots = [make_template_slot("LOW", block_id="LOW", start_time="08:00", end_time="12:00"),
             make_template_slot("TOP", block_id="TOP", start_time="12:00", end_time="16:00")]
    ex = executor(section_state(clinicians, slots, ["TOP", "LOW"]))
    priorities = run(ex, "get_day_priorities", dateISO=MON)
    assert [(e["section"], e["section_rank"]) for e in priorities["slots"]] == [("TOP", 1), ("LOW", 2)]
    assert run(ex, "suggest_day_blocks", dateISO=MON)["section"] == "TOP"
    assert [o.slot_id for o in open_slots(ex.ctx, [])] == ["TOP", "LOW"]
    lines = direct.open_place_lines(ex)
    assert "| TOP |" in lines[0] and "| rank 1 |" in lines[0] and "| rank 2 |" in lines[1]


def test_rescue_never_moves_a_person_inside_one_section_without_a_substitute():
    """A 2-move rescue only helps when the vacated slot ranks lower; inside
    one section it would just move the gap."""
    state = section_state([make_clinician("a", "Alice", ["A"], working_hours_per_week=40)],
                          [make_template_slot("A1", block_id="A", start_time="08:00", end_time="12:00"),
                           make_template_slot("A2", block_id="A", start_time="10:00", end_time="14:00")], ["A"])
    ex = executor(state, [make_assignment("d1", "A1", MON, "a", source="solver")])
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert result["rescues"] == [] and result["no_rescue_found"]


def upward_trap_fixture(*, second_b_holder):
    """Sections A > B > C, one day. S (A) is open. Cara (A, B) holds B1,
    Eve (A, C) holds C1, Finn (C only) is free: Eve -> S with Finn on C1
    fills everything. Moving Cara up instead leaves B1 open for good."""
    clinicians = [make_clinician("cara", "Cara", ["A", "B"], working_hours_per_week=40)]
    if second_b_holder:
        clinicians.append(make_clinician("dan", "Dan", ["A", "B"], working_hours_per_week=40))
    clinicians += [make_clinician("eve", "Eve", ["A", "C"], working_hours_per_week=40),
                   make_clinician("finn", "Finn", ["C"], working_hours_per_week=40)]
    slots = [make_template_slot("S", block_id="A", row_band_id="row-1"),
             make_template_slot("B1", block_id="B", row_band_id="row-2"),
             make_template_slot("C1", block_id="C", row_band_id="row-4")]
    seed = [make_assignment("d1", "B1", MON, "cara", source="solver"),
            make_assignment("d3", "C1", MON, "eve", source="solver")]
    if second_b_holder:
        slots.append(make_template_slot("B2", block_id="B", row_band_id="row-3"))
        seed.append(make_assignment("d2", "B2", MON, "dan", source="solver"))
    return executor(section_state(clinicians, slots, ["A", "B", "C"]), seed)


@pytest.mark.parametrize("second_b_holder", [False, True])
def test_substitute_rescue_wins_over_upward_moves(second_b_holder):
    """Review of v1.82: upward 2-moves (Cara, Dan) are offered only when no
    rescue with a substitute exists, and they never use up the two offers
    per slot, so Eve -> S with Finn on C1 is found and comes first."""
    ex = upward_trap_fixture(second_b_holder=second_b_holder)
    result = run(ex, "suggest_rescue_moves", dateISO=MON)
    assert [(r["frees"], r["substitute"]) for r in result["rescues"]] == [("Eve", "Finn")]
    assert result["rescues"][0]["quality_after"]["open_by_section_order"] == [0, 0, 0]


def test_final_audit_takes_the_substitute_rescue_over_the_upward_move():
    from threading import Event

    ex = upward_trap_fixture(second_b_holder=False)
    audit = ex.workflow.final_audit([MON], Event())
    assert audit["repairs"] == 1 and audit["checks"][MON]["complete"]
    assert ex.quality_dict(ex.best_quality)["open_by_section_order"] == [0, 0, 0]
    assert sorted((a.rowId, a.clinicianId) for a in ex.best_assignments) == [
        ("B1", "cara"), ("C1", "finn"), ("S", "eve")]


def test_final_audit_fills_the_higher_section_first_when_its_blocks_are_apart():
    """Review of v1.82: A's blocks are not next to each other in the
    template (A-mon, B-tue, A-tue), so the instances of Tuesday come in block
    order B1, B2, A. The final audit still fills A first: [0, 2], not [1, 0]."""
    from threading import Event

    tue = TUE
    clinicians = [make_clinician("p", "Pat", ["A", "B"], working_hours_per_week=40)]
    slots = [make_template_slot("A-mon", block_id="A-mon", row_band_id="row-1", col_band_id="col-mon-1"),
             make_template_slot("B1-tue", block_id="B-tue", row_band_id="row-2", col_band_id="col-tue-1",
                                start_time="08:00", end_time="12:00"),
             make_template_slot("B2-tue", block_id="B-tue", row_band_id="row-2", col_band_id="col-tue-1",
                                start_time="12:00", end_time="16:00"),
             make_template_slot("A-tue", block_id="A-tue", row_band_id="row-1", col_band_id="col-tue-1")]
    state = make_app_state(clinicians=clinicians, slots=slots,
                           rows=[make_workplace_row("A", "A"), make_workplace_row("B", "B")])
    state.weeklyTemplate.blocks = [TemplateBlock(id="A-mon", sectionId="A", requiredSlots=0),
                                   TemplateBlock(id="B-tue", sectionId="B", requiredSlots=0),
                                   TemplateBlock(id="A-tue", sectionId="A", requiredSlots=0)]
    ex = PlanToolExecutor(state, build_scoring_context(state, tue, tue, only_fill_required=True), [])
    assert [ex.ctx.instances[k].slot_id for k in ex.ctx.instances] == ["B1-tue", "B2-tue", "A-tue"]
    assert ex.next_fillable_slot(tue)["slot_key"] == ex._alias_slot_key(f"A-tue__{tue}")
    audit = ex.workflow.final_audit([tue], Event())
    assert audit["repairs"] == 1
    assert ex.quality_dict(ex.best_quality)["open_by_section_order"] == [0, 2]
    assert [a.rowId for a in ex.best_assignments] == ["A-tue"]


def test_classic_candidates_inside_one_section_keep_the_fairness_order():
    """Review of v1.82: inside one section the number of filled positions does
    not decide first. Quinn (YTD 0 %) has a shorter block that meets her
    daily minimum; it beats Pat's longer block (YTD 140 %)."""
    from datetime import date, timedelta

    day = "2026-03-02"  # a Monday nine weeks into the year: YTD exists
    clinicians = [make_clinician("p", "Pat (ahead)", ["A"], working_hours_per_week=40),
                  make_clinician("q", "Quinn (behind)", ["A"], working_hours_per_week=20)]
    slots = [make_template_slot("X", block_id="A", row_band_id="row-1", start_time="08:00", end_time="12:00"),
             make_template_slot("Y", block_id="A", row_band_id="row-2", start_time="12:00", end_time="16:00")]
    state = section_state(clinicians, slots, ["A"])
    history, current = [], date(2026, 1, 1)
    while current.isoformat() < day:
        for slot in ("X", "Y"):
            history.append(make_assignment(f"h-{slot}-{current}", slot, current.isoformat(), "p", source="manual"))
        current += timedelta(days=1)
    state.assignments = history
    ex = PlanToolExecutor(state, build_scoring_context(state, day, day, only_fill_required=True), [])
    out = run(ex, "suggest_day_blocks", slot_key=f"X__{day}")
    first, second = out["candidates"][:2]
    assert first["clinicianId"] == "Quinn (behind)" and first["meets_daily_minimum"]
    assert second["clinicianId"] == "Pat (ahead)" and second["block_hours"] > first["block_hours"]
