"""The shared gate: new or worse violations against a baseline."""

from dataclasses import asdict
from typing import Any, List

import backend.constraint_policy as constraint_policy
from backend.constraint_policy import (
    baseline_index,
    classify_violations,
    is_new_or_worsened,
    new_violations,
    resolved_violations,
    violation_key,
)
from backend.models import AppState, Assignment
from backend.run_apply import _new_violations
from backend.validation import (
    VIOLATION_OVERLAP,
    VIOLATION_SPLIT_SHIFT,
    VIOLATION_UNKNOWN_SLOT,
    VIOLATION_WEEKLY_HOURS,
    ValidationReport,
    build_validation_context,
    validate_assignments,
)

from .conftest import DAY_TYPES, make_app_state, make_assignment, make_template_slot
from .swap_fixtures import MON, WEEK, asg, make_swap_state


def _split_block_state() -> AppState:
    # The scenario of test_stored_apply_accepts_partial_repair_but_rejects_more_split_blocks.
    return make_app_state(
        slots=[make_template_slot("a", start_time="08:00", end_time="09:00"),
               make_template_slot("b", start_time="10:00", end_time="11:00"),
               make_template_slot("c", start_time="12:00", end_time="13:00")],
        assignments=[make_assignment(slot, slot, "2026-01-05") for slot in ("a", "b", "c")],
        solver_settings={"preferContinuousShifts": True, "enforceSameLocationPerDay": False},
    )


def _reference_gate(state: AppState, baseline: List[Assignment], candidate: List[Assignment],
                    only_required: bool) -> List[dict]:
    """run_apply's gate as written before it moved to constraint_policy."""
    check = lambda plan: validate_assignments(state, plan, only_fill_required=only_required).violations
    index = {violation_key(v): v.context for v in check(baseline)}
    return [asdict(v) for v in check(candidate) if is_new_or_worsened(v, index)]


def test_new_violations_is_run_applys_gate():
    state = _split_block_state()
    repair, worse = state.assignments[1:], state.assignments
    for baseline, candidate in ((state.assignments, repair), (repair, worse)):
        for only_required in (True, False):
            expected = _reference_gate(state, baseline, candidate, only_required)
            assert [asdict(v) for v in new_violations(state, baseline, candidate,
                                                      only_fill_required=only_required)] == expected
            assert _new_violations(state, baseline, candidate, only_required) == expected
    assert _new_violations(state, state.assignments, repair, True) == []
    assert [v["code"] for v in _new_violations(state, repair, worse, True)] == [VIOLATION_SPLIT_SHIFT]


def _over_limit_state() -> AppState:
    """Ben works 48 h in week 2 (limit 45 h) before any change."""
    ben_week = [asg(f"ben-{day}", f"ct-{day}", date, "clin-ben") for day, date in zip(DAY_TYPES[:6], WEEK)]
    return make_swap_state(ben_week + [asg("a", "ct-mon", MON, "clin-anna")])


def test_classify_splits_the_candidate_violations_into_new_and_carried():
    state = _over_limit_state()
    # Ben's Saturday CT moves to Sunday (same week, same hours); Anna gets an overlap.
    candidate = [a for a in state.assignments if a.id != "ben-sat"] + [
        asg("ben-sun", "ct-sun", "2026-01-11", "clin-ben"),
        asg("a2", "early-mon", MON, "clin-anna"),
    ]
    new, carried = classify_violations(state, state.assignments, candidate)
    full = validate_assignments(state, candidate).violations
    assert sorted(map(repr, new + carried)) == sorted(map(repr, full))
    assert [(v.code, v.clinician_id) for v in new] == [(VIOLATION_OVERLAP, "clin-anna")]
    assert [(v.code, v.clinician_id) for v in carried] == [(VIOLATION_WEEKLY_HOURS, "clin-ben")]
    assert carried[0].context["assigned_minutes"] == 48 * 60


def test_a_growing_weekly_overload_is_new():
    state = _over_limit_state()
    candidate = state.assignments + [asg("ben-sun", "ct-sun", "2026-01-11", "clin-ben")]
    new, carried = classify_violations(state, state.assignments, candidate)
    assert [(v.code, v.context["assigned_minutes"]) for v in new] == [(VIOLATION_WEEKLY_HOURS, 56 * 60)]
    assert carried == []


def test_flags_and_context_are_passed_to_the_validator():
    state = _over_limit_state()
    candidate = state.assignments + [asg("x", "nope-mon", MON, "clin-anna")]
    assert [v.code for v in new_violations(state, state.assignments, candidate)] == [VIOLATION_UNKNOWN_SLOT]
    assert new_violations(state, state.assignments, candidate, skip_references=True) == []
    context = build_validation_context(state)
    assert (classify_violations(state, state.assignments, candidate, context=context)
            == classify_violations(state, state.assignments, candidate))


def test_precomputed_baseline_violations_skip_the_baseline_validation(monkeypatch):
    state = _over_limit_state()
    candidate = [a for a in state.assignments if a.id != "ben-mon"]
    candidate.append(asg("a2", "early-mon", MON, "clin-anna"))
    calls = []

    def counting(*args: Any, **kwargs: Any) -> ValidationReport:
        calls.append(len(args[1]))
        return validate_assignments(*args, **kwargs)

    monkeypatch.setattr(constraint_policy, "validate_assignments", counting)
    expected = classify_violations(state, state.assignments, candidate, only_fill_required=True)
    assert calls == [len(state.assignments), len(candidate)]

    calls.clear()
    baseline = validate_assignments(state, state.assignments, only_fill_required=True).violations
    assert classify_violations(state, state.assignments, candidate, only_fill_required=True,
                               baseline_violations=baseline) == expected
    assert calls == [len(candidate)]


def test_baseline_index_keys_by_violation_key():
    state = _over_limit_state()
    violations = validate_assignments(state, state.assignments).violations
    index = baseline_index(violations)
    assert index == {violation_key(v): v.context for v in violations}
    assert (VIOLATION_WEEKLY_HOURS, "clin-ben", 2026, 2) in index



def test_resolved_violations_are_what_a_revert_brings_back():
    state = _over_limit_state()
    before = validate_assignments(state, state.assignments).violations
    without_saturday = [a for a in state.assignments if a.id != "ben-sat"]

    def resolved(extra: List[Assignment]) -> List[Any]:
        after = validate_assignments(state, without_saturday + extra).violations
        return [(v.code, v.context["assigned_minutes"]) for v in resolved_violations(before, after)]

    overload = [(VIOLATION_WEEKLY_HOURS, 48 * 60)]
    assert resolved([]) == overload  # 40 h: gone
    assert resolved([asg("e", "early-sat", "2026-01-10", "clin-ben"),
                     asg("d", "demo-sun", "2026-01-11", "clin-ben")]) == overload  # 45.5 h: eased
    assert resolved([asg("n", "night-sat", "2026-01-10", "clin-ben")]) == []  # 52 h: worse
    assert resolved_violations(before, before) == []
