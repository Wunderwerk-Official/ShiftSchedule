"""Business-goal checks independent from a model's wording or tool order."""
from backend.models import AppState, WorkPattern
from backend.agent.quality import extra_metrics
from backend.scoring import plan_stats
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot
from .test_agent_planning_workflow import executor, run, MON, TUE


def test_explicit_two_day_pattern_changes_short_day_definition_consistently():
    clinician = make_clinician("a", "Alice", working_hours_per_week=20)
    clinician.workPattern = WorkPattern(daysPerWeek=2)
    state = make_app_state(clinicians=[clinician], slots=[make_template_slot("half", start_time="08:00", end_time="12:00")])
    ex = executor(state, [make_assignment("draft", "half", MON, "a", source="solver")])
    assert ex._daily_target_minutes("a", MON) == 600
    assert ex._daily_min_minutes("a", MON) == 300
    assert plan_stats(ex.ctx, ex.best_assignments).short_days == 1
    assert run(ex, "list_short_days")["short_days"]
    restored = AppState.model_validate(state.model_dump())
    assert restored.clinicians[0].workPattern.daysPerWeek == 2


def test_balanced_profile_rewards_removing_a_long_day_without_losing_coverage():
    state = make_app_state(clinicians=[make_clinician("a", "Alice", working_hours_per_week=40),
                                       make_clinician("b", "Bob", working_hours_per_week=40)],
                           slots=[make_template_slot("am", start_time="08:00", end_time="16:00"),
                                  make_template_slot("pm", start_time="16:00", end_time="23:00")])
    state.solverSettings["agentQualityProfile"] = "balanced"
    ex = executor(state, [make_assignment("1", "am", MON, "a", source="solver"),
                          make_assignment("2", "pm", MON, "a", source="solver")])
    before = ex.quality_dict(ex.best_quality)
    preview = run(ex, "apply_moves", dry_run=True, moves=[
        {"action": "unassign", "slot_key": f"pm__{MON}", "clinicianId": "a"},
        {"action": "assign", "slot_key": f"pm__{MON}", "clinicianId": "b"},
    ])
    assert before["uncomfortable_days"] == 1
    assert preview["quality_after"]["uncomfortable_days"] == 0
    assert preview["quality_after"]["open_required_slots"] == 0
    assert preview["improves_best"]


def test_structured_day_off_is_measured_without_becoming_a_hard_rule():
    alice = make_clinician("a", "Alice", working_hours_per_week=40)
    alice.workPattern = WorkPattern(preferredDaysOff=["mon"])
    state = make_app_state(clinicians=[alice, make_clinician("b", "Bob", working_hours_per_week=40)])
    state.solverSettings["agentQualityProfile"] = "balanced"
    ex = executor(state)
    assert run(ex, "apply_moves", moves=[{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "a"}])["applied"]
    assert ex.quality_dict(ex.best_quality)["structured_wish_violations"] == 1
    change = run(ex, "apply_moves", dry_run=True, moves=[
        {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "a"},
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "b"},
    ])
    assert change["valid"] and change["improves_best"]
    assert change["quality_after"]["structured_wish_violations"] == 0


def test_duty_burden_penalizes_concentration_with_same_coverage():
    state = make_app_state(clinicians=[make_clinician("a", "Alice", working_hours_per_week=40),
                                       make_clinician("b", "Bob", working_hours_per_week=40)],
                           slots=[make_template_slot("mon-night", start_time="20:00", end_time="23:00"),
                                  make_template_slot("tue-night", col_band_id="col-tue-1", start_time="20:00", end_time="23:00")])
    ex = executor(state, end=TUE)
    concentrated = [make_assignment("1", "mon-night", MON, "a"), make_assignment("2", "tue-night", TUE, "a")]
    shared = [concentrated[0], make_assignment("3", "tue-night", TUE, "b")]
    assert extra_metrics(ex, shared)["duty_burden_penalty"] < extra_metrics(ex, concentrated)["duty_burden_penalty"]


def test_default_profile_preserves_existing_quality_contract():
    ex = executor()
    assert ex.ctx.settings.agentQualityProfile == "classic"
    # v1.81: the strict section vector is the first coverage tier.
    assert len(ex.best_quality) == 7
    assert ex.quality_fields[:3] == ("hard_violations_in_range", "open_by_section_order", "open_required_slots")
    assert "short_days" in ex.quality_dict(ex.best_quality)
    assert not ex.ctx.settings.agentNeighborhoodSearch


def test_balanced_suggestion_ranking_respects_structured_day_off():
    alice = make_clinician("a", "Alice", working_hours_per_week=40)
    alice.workPattern = WorkPattern(preferredDaysOff=["mon"])
    state = make_app_state(clinicians=[alice, make_clinician("b", "Bob", working_hours_per_week=40)])
    state.solverSettings["agentQualityProfile"] = "balanced"
    ex = executor(state)
    offers = run(ex, "suggest_day_blocks", dateISO=MON)["candidates"]
    assert offers[0]["clinicianId"] == "Bob"
    assert offers[0]["quality_after"]["structured_wish_violations"] == 0


def _on_call_state(rest_enabled, assignments=()):
    """Two weekday 08-16 shifts in one section, chosen as the on-call section:
    only the on_call category can carry duty burden here."""
    state = make_app_state(clinicians=[make_clinician("a", "Alice", working_hours_per_week=40),
                                       make_clinician("b", "Bob", working_hours_per_week=40)],
                           slots=[make_template_slot("mon"), make_template_slot("tue", col_band_id="col-tue-1")],
                           assignments=list(assignments))
    state.solverSettings.update(agentQualityProfile="balanced", onCallRestClassId="section-a",
                                onCallRestEnabled=rest_enabled, onCallRestDaysBefore=0, onCallRestDaysAfter=0)
    return state


def test_on_call_fairness_counts_only_while_the_rest_rule_is_on():
    # v1.75: with "Rest days around on-call duty" off the on-call section
    # select is disabled, so its stored value must not steer Balanced.
    concentrated = [make_assignment("1", "mon", MON, "a"), make_assignment("2", "tue", TUE, "a")]
    shared = [concentrated[0], make_assignment("3", "tue", TUE, "b")]
    off = executor(_on_call_state(False), end=TUE)
    assert off.on_call_class is None
    assert extra_metrics(off, concentrated)["duty_burden_penalty"] == 0
    assert extra_metrics(off, shared)["duty_burden_penalty"] == 0
    assert not any(category == "on_call" for category, _ in off._duty_opportunity_weights)
    on = executor(_on_call_state(True), end=TUE)
    assert on.on_call_class == "section-a"
    assert extra_metrics(on, shared)["duty_burden_penalty"] < extra_metrics(on, concentrated)["duty_burden_penalty"]


def test_rest_day_row_entries_count_as_unavailable_for_duty_opportunities():
    plain = executor(_on_call_state(True), end=TUE)
    rested = executor(_on_call_state(True, [make_assignment("rest", "pool-rest-day", TUE, "a", "manual")]), end=TUE)
    extra_metrics(plain, [])
    extra_metrics(rested, [])
    assert rested._duty_opportunity_weights[("on_call", "a")] < plain._duty_opportunity_weights[("on_call", "a")]
    assert rested._duty_opportunity_weights[("on_call", "b")] == plain._duty_opportunity_weights[("on_call", "b")]


def test_quality_version_marks_the_strict_section_order():
    from backend.agent.quality import QUALITY_VERSION

    ex = executor(_on_call_state(False), end=TUE)
    assert QUALITY_VERSION == 4
    assert run(ex, "get_plan_overview")["quality_version"] == 4
