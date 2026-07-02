"""Unit tests for backend.scoring plus seed-parity tests.

The seed-parity tests are the contract that makes an LLM repair loop sound:
plans produced by the heuristic solver v2 must (a) pass
``validation.validate_assignments`` and (b) never score worse than the empty
plan. They reuse the realistic scenarios from
``test_heuristic_v2_integration.py`` so the contract is checked against the
same states the solver tests use.
"""

from __future__ import annotations

import pytest

from backend.models import Assignment, PreferredWorkingTime, SolveRangeRequest
from backend.scoring import (
    build_scoring_context,
    open_slots,
    plan_stats,
    score_plan,
)
from backend.validation import validate_assignments

from .conftest import (
    make_app_state,
    make_assignment,
    make_clinician,
    make_template_slot,
)
# Aliased so pytest does not re-collect the imported scenario classes here
from .test_heuristic_v2_integration import (
    MockCancelEvent,
    TestFullWeekMixedContracts as FullWeekScenario,
    TestMultipleLocationsEnforcement as MultiLocationScenario,
    TestOvernightOnCallNoCrossing as OvernightOnCallScenario,
    mock_progress,
)
from backend.heuristic.solver_v2 import heuristic_solve_range_v2

MON = "2026-01-05"


def _solver_assignment(slot_id: str, date_iso: str, clinician_id: str) -> Assignment:
    return Assignment(
        id=f"test-{slot_id}-{date_iso}-{clinician_id}",
        rowId=slot_id,
        dateISO=date_iso,
        clinicianId=clinician_id,
        source="solver",
    )


# ---------------------------------------------------------------------------
# Score behaviour
# ---------------------------------------------------------------------------


def test_score_improves_when_filling_open_slot():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    empty = score_plan(ctx, [])
    filled = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    assert filled.total < empty.total
    assert filled.components["slack"] == 0
    assert empty.components["slack"] > 0


def test_score_weight_plumbing_zeroes_components():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    state.solverSettings = {"weightCoverage": 0, "weightSlack": 0}
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    empty = score_plan(ctx, [])
    filled = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    assert empty.components["coverage"] == 0
    assert empty.components["slack"] == 0
    # With coverage/slack neutralized and no other signals, both plans tie
    assert filled.total == empty.total


def test_score_prefers_preferred_section_assignee():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-pref", "Alice", preferred_class_ids=["section-a"]),
            make_clinician("clin-neutral", "Bob"),
        ]
    )
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    preferred = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-pref")])
    neutral = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-neutral")])
    assert preferred.total < neutral.total
    assert preferred.components["section_preference"] < 0
    assert neutral.components["section_preference"] == 0


def test_score_rewards_preference_time_window_fit():
    fitting = make_clinician("clin-1", "Alice")
    fitting.preferredWorkingTimes = {
        "mon": PreferredWorkingTime(startTime="06:00", endTime="18:00", requirement="preference")
    }
    state = make_app_state(clinicians=[fitting])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    score = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    assert score.components["time_window"] < 0


def test_score_penalizes_working_hours_deviation():
    # 40h contract, 5h tolerance, scale 1/7 for a single day: target ~343min,
    # tolerance ~43min. One 8h shift (480min) overshoots.
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40.0)]
    )
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    empty = score_plan(ctx, [])
    filled = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    # Under-hours penalty for the empty plan, over-hours penalty when filled
    assert empty.components["working_hours"] > 0
    assert filled.components["working_hours"] > 0


def test_distribute_all_rewards_total_assignments_and_priority():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=False)
    filled = score_plan(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    assert filled.components["total_assignments"] < 0
    assert filled.components["slot_priority"] < 0
    ctx_required = build_scoring_context(state, MON, MON, only_fill_required=True)
    required_score = score_plan(ctx_required, [_solver_assignment("slot-a__mon", MON, "clin-1")])
    assert "total_assignments" not in required_score.components


def test_fixed_state_assignments_count_as_context():
    # A manual assignment already covering the slot: empty candidate plan has
    # no slack, and score matches a fully-covered plan.
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    empty = score_plan(ctx, [])
    assert empty.components["slack"] == 0
    assert empty.components["coverage"] < 0
    assert open_slots(ctx, []) == []


# ---------------------------------------------------------------------------
# Open slots + stats
# ---------------------------------------------------------------------------


def test_open_slots_lists_missing_then_clears():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    gaps = open_slots(ctx, [])
    assert len(gaps) == 1
    gap = gaps[0]
    assert gap.slot_key == f"slot-a__mon__{MON}"
    assert gap.missing == 1
    assert gap.section_id == "section-a"
    assert gap.start == "08:00"
    assert gap.end == "16:00"
    assert open_slots(ctx, [_solver_assignment("slot-a__mon", MON, "clin-1")]) == []


def test_plan_stats_counts_fill_and_split_shifts():
    slots = [
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-late", col_band_id="col-mon-1",
                           start_time="13:00", end_time="17:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=slots,
    )
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    stats = plan_stats(
        ctx,
        [
            _solver_assignment("slot-morning", MON, "clin-1"),
            _solver_assignment("slot-late", MON, "clin-1"),
        ],
    )
    assert stats.total_required_slots == 2
    assert stats.filled_slots == 2
    assert stats.open_slots == 0
    assert stats.total_assignments == 2
    assert stats.split_shifts == 1  # 08-12 and 13-17 leave a gap


def test_plan_stats_ignores_assignments_outside_active_instances():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    stats = plan_stats(
        ctx,
        [
            _solver_assignment("pool-rest-day", MON, "clin-1"),
            # Tuesday date for a Monday slot: no active instance
            _solver_assignment("slot-a__mon", "2026-01-06", "clin-1"),
        ],
    )
    assert stats.total_assignments == 0
    assert stats.open_slots == 1


def test_scoring_context_rejects_invalid_dates():
    state = make_app_state()
    with pytest.raises(ValueError):
        build_scoring_context(state, "not-a-date")
    with pytest.raises(ValueError):
        build_scoring_context(state, MON, "2026-01-01")  # end before start


# ---------------------------------------------------------------------------
# Seed parity: heuristic v2 output must validate cleanly and beat the empty plan
# ---------------------------------------------------------------------------


def _run_heuristic(state, start_iso: str, end_iso: str):
    payload = SolveRangeRequest(
        startISO=start_iso,
        endISO=end_iso,
        only_fill_required=True,
        use_heuristic=True,
    )
    result = heuristic_solve_range_v2(payload, state, MockCancelEvent(), mock_progress, 0.0)
    return [Assignment.model_validate(a) for a in result["assignments"]]


@pytest.mark.parametrize(
    "scenario, start_iso, end_iso",
    [
        (FullWeekScenario, "2026-01-05", "2026-01-09"),
        (OvernightOnCallScenario, "2026-01-05", "2026-01-06"),
        (MultiLocationScenario, "2026-01-05", "2026-01-05"),
    ],
    ids=["full-week", "overnight-oncall", "multi-location"],
)
def test_heuristic_seed_passes_validation_and_beats_empty_plan(
    scenario, start_iso, end_iso
):
    state, _slots = scenario()._build_state()
    seed = _run_heuristic(state, start_iso, end_iso)
    assert seed, "expected the heuristic to produce assignments"

    full_plan = state.assignments + seed
    report = validate_assignments(
        state, full_plan, only_fill_required=True
    )
    assert report.is_valid, [v.message for v in report.violations]

    ctx = build_scoring_context(state, start_iso, end_iso, only_fill_required=True)
    assert score_plan(ctx, seed).total < score_plan(ctx, []).total
