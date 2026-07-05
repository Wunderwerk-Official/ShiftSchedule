"""Unit tests for the agent tool layer (working copy, guardrails, snapshots)."""

from __future__ import annotations

import json

from backend.agent.tools import PlanToolExecutor, _split_slot_key
from backend.models import Assignment
from backend.scoring import build_scoring_context

from .conftest import (
    make_app_state,
    make_assignment,
    make_clinician,
    make_template_slot,
)

MON = "2026-01-05"
TUE = "2026-01-06"


def _seed(slot_id: str, date_iso: str, cid: str) -> Assignment:
    return Assignment(
        id=f"seed-{slot_id}-{date_iso}-{cid}",
        rowId=slot_id,
        dateISO=date_iso,
        clinicianId=cid,
        source="solver",
    )


def _make_executor(state, seed=None, *, only_fill_required=True, start=MON, end=MON):
    ctx = build_scoring_context(state, start, end, only_fill_required=only_fill_required)
    return PlanToolExecutor(state, ctx, seed or [])


def _run(executor, name, args):
    result = executor.execute(name, args, "call-1")
    return json.loads(result.content), result.is_error


def test_split_slot_key_handles_double_underscore_slot_ids():
    assert _split_slot_key("slot-a__mon__2026-01-05") == ("slot-a__mon", "2026-01-05")
    assert _split_slot_key("simple__2026-01-05") == ("simple", "2026-01-05")


def test_assign_fills_open_slot_and_updates_best_snapshot():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    executor = _make_executor(state)
    seed_score = executor.best_score

    payload, is_error = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"}]},
    )
    assert not is_error
    assert payload["applied"] is True
    assert executor.moves_accepted == 1
    assert executor.best_score < seed_score
    assert len(executor.best_assignments) == 1
    assert executor.best_assignments[0].source == "solver"
    assert executor.best_assignments[0].id == f"agent-slot-a__mon-{MON}-clin-1"


def test_unassign_of_fixed_assignment_is_rejected():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"}]},
    )
    assert payload["applied"] is False
    assert "Fixed" in payload["rejected"][0]["reason"]
    assert executor.moves_rejected == 1


def test_capacity_exceeding_assign_is_rejected():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
    )
    seed = [_seed("slot-a__mon", MON, "clin-1")]
    executor = _make_executor(state, seed)  # only_fill_required: capacity == 1
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-2"}]},
    )
    assert payload["applied"] is False
    assert "capacity" in payload["rejected"][0]["reason"]


def test_batch_creating_hard_violation_rolls_back_atomically():
    # Two overlapping Monday slots; assigning the same clinician to both
    # creates an OVERLAP violation -> whole batch must roll back.
    slots = [
        make_template_slot("slot-x", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
        make_template_slot("slot-y", col_band_id="col-mon-1",
                           start_time="11:00", end_time="15:00"),
    ]
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")], slots=slots)
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {
            "moves": [
                {"action": "assign", "slot_key": f"slot-x__{MON}", "clinicianId": "clin-1"},
                {"action": "assign", "slot_key": f"slot-y__{MON}", "clinicianId": "clin-1"},
            ]
        },
    )
    assert payload["applied"] is False
    assert any(v["code"] == "OVERLAP" for v in payload["new_hard_violations"])
    assert executor.current == {}  # nothing committed
    assert executor.best_assignments == []


def test_swap_batch_unassign_then_assign_succeeds():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
    )
    seed = [_seed("slot-a__mon", MON, "clin-1")]
    executor = _make_executor(state, seed)
    payload, _ = _run(
        executor,
        "apply_moves",
        {
            "moves": [
                {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"},
                {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-2"},
            ]
        },
    )
    assert payload["applied"] is True
    assert list(executor.current.keys()) == [("slot-a__mon", MON, "clin-2")]


def test_best_snapshot_does_not_update_on_worse_plan():
    # Unassigning the only filled slot makes the plan worse; the best
    # snapshot must keep the seed.
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    seed = [_seed("slot-a__mon", MON, "clin-1")]
    executor = _make_executor(state, seed)
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"}]},
    )
    assert payload["applied"] is True  # legal, just worse
    assert executor.current == {}
    assert [a.id for a in executor.best_assignments] == [seed[0].id]
    assert executor.best_score == executor.seed_score


def test_pre_existing_violations_do_not_block_moves():
    # Manual data violates weekly hours (8h contract, 3x8h fixed). The agent
    # must still be able to fill an unrelated open slot for someone else.
    slots = [
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
        make_template_slot("slot-a__wed", col_band_id="col-wed-1"),
        make_template_slot("slot-b", col_band_id="col-mon-1",
                           start_time="08:00", end_time="12:00"),
    ]
    state = make_app_state(
        clinicians=[
            make_clinician("clin-over", "Alice", working_hours_per_week=8.0),
            make_clinician("clin-free", "Bob"),
        ],
        slots=slots,
        assignments=[
            make_assignment("m1", "slot-a__mon", "2026-01-05", "clin-over"),
            make_assignment("m2", "slot-a__tue", "2026-01-06", "clin-over"),
            make_assignment("m3", "slot-a__wed", "2026-01-07", "clin-over"),
        ],
    )
    executor = _make_executor(state, start="2026-01-05", end="2026-01-07")
    assert executor.baseline_hard_keys  # seed baseline includes the manual violation
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-b__{MON}", "clinicianId": "clin-free"}]},
    )
    assert payload["applied"] is True


def test_list_candidates_reports_rejection_reasons():
    slots = [
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-b", col_band_id="col-mon-1",
                           start_time="10:00", end_time="14:00", block_id="block-a"),
    ]
    state = make_app_state(
        clinicians=[
            make_clinician("clin-ok", "Alice"),
            make_clinician("clin-unqualified", "Bob", qualified_class_ids=["other-section"]),
            make_clinician("clin-busy", "Cara"),
        ],
        slots=slots,
    )
    seed = [_seed("slot-a__mon", MON, "clin-busy")]  # 08-16 overlaps 10-14
    executor = _make_executor(state, seed)
    payload, _ = _run(executor, "list_candidates_for_slot", {"slot_key": f"slot-b__{MON}"})
    # The LLM only ever sees pseudonymous aliases (roster order: D1, D2, D3)
    by_alias = {c["clinicianId"]: c for c in payload["candidates"]}
    assert by_alias[executor.alias_by_id["clin-ok"]]["eligible"] is True
    assert "QUALIFICATION" in by_alias[executor.alias_by_id["clin-unqualified"]]["reasons"]
    assert "OVERLAP" in by_alias[executor.alias_by_id["clin-busy"]]["reasons"]
    assert not any("name" in c for c in payload["candidates"])


def test_get_violations_pagination_and_new_flag():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", qualified_class_ids=["other"])],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    executor = _make_executor(state)
    payload, _ = _run(executor, "get_violations", {"limit": 1, "offset": 0})
    assert payload["total"] >= 1
    assert len(payload["violations"]) == 1
    # Pre-existing manual violation is baseline, not "new"
    assert payload["violations"][0]["new"] is False


def test_open_slots_and_overview_shapes():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    executor = _make_executor(state)
    gaps, _ = _run(executor, "list_open_slots", {})
    assert gaps["total"] == 1
    assert gaps["open_slots"][0]["slot_key"] == f"slot-a__mon__{MON}"

    overview, _ = _run(executor, "get_plan_overview", {})
    assert overview["open_slot_count"] == 1
    assert overview["new_hard_violations"] == 0
    assert "score" not in overview  # the scalar score is gone from the LLM payload
    assert overview["quality"]["open_required_slots"] == 1
    assert overview["quality_of_best_snapshot"]["open_required_slots"] == 1

    summary, _ = _run(executor, "get_clinician_summary", {"clinicianId": "clin-1"})
    assert summary["qualified_sections"] == ["section-a"]

    unknown, is_error = _run(executor, "get_clinician_summary", {"clinicianId": "nope"})
    assert "error" in unknown and not is_error

    _, is_error = _run(executor, "no_such_tool", {})
    assert is_error


# ---------------------------------------------------------------------------
# Pseudonymization: real names/ids must never reach the LLM
# ---------------------------------------------------------------------------


def test_llm_facing_outputs_contain_no_real_names_or_ids():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-secret-1", "Dr. Annette Geheimnis", qualified_class_ids=["other"]),
            make_clinician("clin-secret-2", "Dr. Bernd Vertraulich"),
        ],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-secret-1")],
    )
    executor = _make_executor(state)
    assert executor.alias_by_id == {"clin-secret-1": "D1", "clin-secret-2": "D2"}

    for tool, args in [
        ("get_violations", {}),
        ("list_candidates_for_slot", {"slot_key": f"slot-a__mon__{MON}"}),
        ("get_clinician_summary", {"clinicianId": "D2"}),
        ("get_plan_overview", {}),
        ("list_open_slots", {}),
    ]:
        result = executor.execute(tool, args, "call-x")
        for secret in ("Annette", "Geheimnis", "Bernd", "Vertraulich", "clin-secret"):
            assert secret not in result.content, f"{tool} leaked {secret!r}: {result.content}"


def test_apply_moves_accepts_aliases_and_returns_real_ids():
    state = make_app_state(
        clinicians=[make_clinician("clin-real-id", "Dr. Alice")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D1"}]},
    )
    assert payload["applied"] is True
    # The working copy stores the REAL id — the returned plan needs no
    # de-pseudonymization step.
    assert list(executor.current.keys()) == [("slot-a__mon", MON, "clin-real-id")]


def test_problem_digest_uses_aliases_only():
    from backend.agent.prompts import build_problem_digest
    from backend.scoring import open_slots, plan_stats

    state = make_app_state(
        clinicians=[make_clinician("clin-secret", "Dr. Carola Verborgen")],
    )
    executor = _make_executor(state)
    digest = build_problem_digest(
        state,
        executor.ctx,
        plan_stats(executor.ctx, []),
        open_slots(executor.ctx, []),
        new_hard_violation_count=0,
        soft_violation_count=0,
        max_iterations=10,
        clinician_aliases=executor.alias_by_id,
    )
    assert "D1" in digest
    assert "Carola" not in digest and "Verborgen" not in digest and "clin-secret" not in digest


def test_activity_feed_uses_real_names_for_the_ui():
    events = []
    state = make_app_state(clinicians=[make_clinician("clin-1", "Dr. Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    executor = PlanToolExecutor(
        state, ctx, [], on_activity=lambda kind, payload: events.append((kind, payload))
    )
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D1"}]},
    )
    assert payload["applied"] is True
    kinds = [k for k, _ in events]
    assert "moves_applied" in kinds
    applied = next(p for k, p in events if k == "moves_applied")
    assert applied["improved"] is True
    move = applied["moves"][0]
    assert move["clinician"] == "Dr. Alice"  # UI feed shows real names
    assert move["section"] == "Section A"
    assert move["start"] == "08:00" and move["end"] == "16:00"


def test_rejected_batch_emits_activity():
    events = []
    state = make_app_state(clinicians=[make_clinician("clin-1", "Dr. Alice")])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    executor = PlanToolExecutor(
        state, ctx, [_seed("slot-a__mon", MON, "clin-1")],
        on_activity=lambda kind, payload: events.append((kind, payload)),
    )
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D1"}]},
    )
    assert payload["applied"] is False
    assert events and events[-1][0] == "moves_rejected"
    assert events[-1][1]["count"] == 1


# ---------------------------------------------------------------------------
# YTD progress (percent of target hours worked up to a given day)
# ---------------------------------------------------------------------------

MAR_MON = "2026-03-02"


def _ytd_state(**clin_kwargs):
    """One 8h Monday slot; clin-1 has an 8h contract and one 8h shift on
    2026-01-05 in the books."""
    return make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Alice", working_hours_per_week=8, **clin_kwargs),
            make_clinician("clin-2", "Dr. Bob", working_hours_per_week=8),
        ],
        assignments=[make_assignment("hist-1", "slot-a__mon", "2026-01-05", "clin-1")],
    )


def test_ytd_completion_pct_math():
    state = _ytd_state()
    executor = _make_executor(state, start=MAR_MON, end=MAR_MON)
    # 2026-01-15: 2 weeks elapsed -> target 16h; worked 8h -> 50%
    assert executor.ytd_completion_pct("clin-1", "2026-01-15") == 50
    # clin-2 never worked -> 0%
    assert executor.ytd_completion_pct("clin-2", "2026-01-15") == 0
    # less than one week of history -> None
    assert executor.ytd_completion_pct("clin-1", "2026-01-05") is None
    # no contract -> None
    state2 = make_app_state(clinicians=[make_clinician("clin-3", "Dr. C")])
    executor2 = _make_executor(state2, start=MAR_MON, end=MAR_MON)
    assert executor2.ytd_completion_pct("clin-3", "2026-01-15") is None


def test_ytd_completion_pct_counts_working_copy():
    state = _ytd_state()
    # Working copy: the agent's own assignment for clin-2 on 2026-01-05...
    seed = [_seed("slot-a__mon", MAR_MON, "clin-2")]
    executor = _make_executor(state, seed, start=MAR_MON, end=MAR_MON)
    # ...does NOT count before its date, but counts for a later as_of:
    day_after = "2026-03-03"
    with_copy = executor.ytd_completion_pct("clin-2", day_after)
    assert with_copy is not None and with_copy > 0
    assert executor.ytd_completion_pct("clin-2", MAR_MON) == 0


def test_candidates_sorted_most_behind_first_and_tool_lists_progress():
    state = _ytd_state()
    executor = _make_executor(state, start=MAR_MON, end=MAR_MON, only_fill_required=False)
    payload, is_error = _run(
        executor, "list_candidates_for_slot", {"slot_key": f"slot-a__mon__{MAR_MON}"}
    )
    assert not is_error
    eligible = [c for c in payload["candidates"] if c["eligible"]]
    # clin-2 (0% worked) must rank before clin-1 (ahead of target)
    pcts = [c["ytd_worked_pct"] for c in eligible]
    assert pcts == sorted(pcts)

    progress, is_error = _run(executor, "get_ytd_progress", {})
    assert not is_error
    aliases = [e["clinicianId"] for e in progress["clinicians"]]
    assert aliases[0] == executor.alias_by_id["clin-2"]  # most behind first
    assert all(e["clinicianId"].startswith("D") for e in progress["clinicians"])


# ---------------------------------------------------------------------------
# Short days + adjacency signals
# ---------------------------------------------------------------------------


def test_candidates_report_day_hours_and_adjacency():
    early = make_template_slot(
        slot_id="slot-early__mon", col_band_id="col-mon-1",
        start_time="06:30", end_time="08:00",
    )
    main = make_template_slot(
        slot_id="slot-a__mon", col_band_id="col-mon-1",
        start_time="08:00", end_time="16:00",
    )
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Alice"),
            make_clinician("clin-2", "Dr. Bob"),
        ],
        slots=[early, main],
    )
    seed = [_seed("slot-a__mon", MON, "clin-1")]
    executor = _make_executor(state, seed)
    payload, is_error = _run(
        executor, "list_candidates_for_slot", {"slot_key": f"slot-early__mon__{MON}"}
    )
    assert not is_error
    by_alias = {c["clinicianId"]: c for c in payload["candidates"]}
    a1 = executor.alias_by_id["clin-1"]
    a2 = executor.alias_by_id["clin-2"]
    # clin-1 works 08:00-16:00: the early slot touches their shift
    assert by_alias[a1]["adjacent_to_existing"] is True
    assert by_alias[a1]["day_hours"] == 8.0
    assert by_alias[a2]["adjacent_to_existing"] is False
    assert by_alias[a2]["day_hours"] == 0.0


def test_plan_stats_counts_short_days():
    from backend.scoring import plan_stats

    early = make_template_slot(
        slot_id="slot-early__mon", col_band_id="col-mon-1",
        start_time="06:30", end_time="07:30",
    )
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Dr. Alice", working_hours_per_week=40)],
        slots=[early],
    )
    executor = _make_executor(state)
    # 1h assigned vs derived minimum (40h/5days/2 = 4h) -> one short day
    stats = plan_stats(executor.ctx, [_seed("slot-early__mon", MON, "clin-1")])
    assert stats.short_days == 1
    stats_empty = plan_stats(executor.ctx, [])
    assert stats_empty.short_days == 0


def test_accepted_moves_are_logged_for_the_run_summary():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Dr. Alice")],
    )
    executor = _make_executor(state, only_fill_required=False)
    payload, is_error = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}",
                    "clinicianId": "clin-1"}]},
    )
    assert not is_error and payload["applied"]
    assert executor.accepted_move_log[0]["action"] == "assign"
    assert executor.accepted_move_log[0]["clinician"] == "Dr. Alice"


def test_batched_candidates_returns_compact_per_slot_results():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Alice"),
            make_clinician("clin-2", "Dr. Bob"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot(
                slot_id="slot-b__mon", col_band_id="col-mon-1",
                start_time="16:00", end_time="20:00",
            ),
        ],
    )
    executor = _make_executor(state)
    payload, is_error = _run(
        executor,
        "list_candidates_for_slot",
        {"slot_keys": [f"slot-a__mon__{MON}", f"slot-b__mon__{MON}", "bogus__2026-01-05"]},
    )
    assert not is_error
    slots = payload["slots"]
    assert set(slots) == {f"slot-a__mon__{MON}", f"slot-b__mon__{MON}", "bogus__2026-01-05"}
    good = slots[f"slot-a__mon__{MON}"]
    assert {c["clinicianId"] for c in good["eligible"]} == set(executor.alias_by_id.values())
    assert good["ineligible_counts"] == {}
    assert "error" in slots["bogus__2026-01-05"]
    # single-slot legacy shape unchanged
    single, _ = _run(executor, "list_candidates_for_slot", {"slot_key": f"slot-a__mon__{MON}"})
    assert "candidates" in single


def test_list_short_days_flags_mini_days():
    early = make_template_slot(
        slot_id="slot-early__mon", col_band_id="col-mon-1",
        start_time="06:30", end_time="07:30",
    )
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Dr. Bob", working_hours_per_week=40),
        ],
        slots=[early],
    )
    executor = _make_executor(state, [_seed("slot-early__mon", MON, "clin-1")])
    payload, is_error = _run(executor, "list_short_days", {})
    assert not is_error
    assert payload["total"] == 1
    case = payload["short_days"][0]
    assert case["clinicianId"] == executor.alias_by_id["clin-1"]
    assert case["assigned_hours"] == 1.0
    assert case["min_hours"] == 4.0
    assert case["slots"][0]["fixed"] is False


# ---------------------------------------------------------------------------
# Quality-tuple gate, dry runs, and the roster/day inspection tools
# ---------------------------------------------------------------------------


def test_dry_run_previews_without_committing():
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    executor = _make_executor(state)
    payload, is_error = _run(
        executor,
        "apply_moves",
        {
            "moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}",
                       "clinicianId": "D1"}],
            "dry_run": True,
        },
    )
    assert not is_error
    assert payload["dry_run"] is True and payload["valid"] is True
    assert payload["improves_best"] is True
    assert payload["quality_after"]["open_required_slots"] == 0
    # Nothing was committed and no counters moved.
    assert executor.current == {}
    assert executor.moves_accepted == 0
    assert executor.best_assignments == []


def test_dry_run_reports_structural_rejection_without_counting_it():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {
            "moves": [{"action": "unassign", "slot_key": f"slot-a__mon__{MON}",
                       "clinicianId": "D1"}],
            "dry_run": True,
        },
    )
    assert payload["dry_run"] is True and payload["valid"] is False
    assert "Fixed" in payload["rejected"][0]["reason"]
    assert executor.moves_rejected == 0  # previews are free


def test_equal_quality_swap_updates_best_snapshot():
    # Swapping equally-suited clinicians leaves every quality tier unchanged;
    # the tie must keep the agent's NEWEST state (its judgment on goals the
    # tiers don't measure, e.g. YTD fairness or admin instructions).
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
    )
    executor = _make_executor(state, [_seed("slot-a__mon", MON, "clin-1")])
    payload, _ = _run(
        executor,
        "apply_moves",
        {
            "moves": [
                {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D1"},
                {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D2"},
            ]
        },
    )
    assert payload["applied"] is True
    assert executor.best_quality == executor.seed_quality
    assert [a.clinicianId for a in executor.best_assignments] == ["clin-2"]


def test_hours_overview_flags_underworked_first():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Bob", working_hours_per_week=1),
        ],
    )
    # Bob works the 8h Monday slot -> well over his 1h contract; Alice has
    # nothing -> far under her 40h contract.
    executor = _make_executor(state, [_seed("slot-a__mon", MON, "clin-2")])
    payload, is_error = _run(executor, "get_hours_overview", {})
    assert not is_error
    assert payload["weeks"] == ["2026-W02"]
    assert payload["clinicians"][0]["clinicianId"] == "D1"  # most underworked first
    alice_week = payload["clinicians"][0]["weeks"]["2026-W02"]
    assert alice_week["status"] == "under" and alice_week["hours"] == 0.0
    bob_week = payload["clinicians"][1]["weeks"]["2026-W02"]
    assert bob_week["status"] == "over"


def test_day_schedule_lists_slots_with_assignees():
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Dr. Alice"), make_clinician("clin-2", "Bob")],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    executor = _make_executor(state, [_seed("slot-a__mon", MON, "clin-2")])
    payload, is_error = _run(executor, "get_day_schedule", {"dateISO": MON})
    assert not is_error
    assert payload["dateISO"] == MON
    slot = payload["slots"][0]
    assert slot["slot_key"] == f"slot-a__mon__{MON}"
    assert slot["missing"] == 0
    assignees = {(a["clinicianId"], a["fixed"]) for a in slot["assigned"]}
    assert assignees == {("D1", True), ("D2", False)}
    assert "Alice" not in json.dumps(payload)  # aliases only

    outside, is_error = _run(executor, "get_day_schedule", {"dateISO": "2027-01-01"})
    assert not is_error and "error" in outside


def test_mixed_batch_touching_fixed_assignment_rejects_atomically():
    # A batch that mixes one illegal move (unassigning a MANUAL assignment)
    # with a perfectly legal assign must reject as a whole: manual pills are
    # untouchable and no partial state may leak in around them.
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob")],
        slots=[
            make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot("slot-b", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
        ],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-1")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {
            "moves": [
                {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "D1"},
                {"action": "assign", "slot_key": f"slot-b__{MON}", "clinicianId": "D2"},
            ]
        },
    )
    assert payload["applied"] is False
    assert "Fixed" in payload["rejected"][0]["reason"]
    assert executor.current == {}  # the legal half was NOT applied
    # The agent's output never contains (or re-issues) the manual assignment.
    assert executor.best_assignments == []


def test_repairing_seed_violation_by_unassign_counts_as_improvement():
    # The seed hands clin-1 work on Monday AND Tuesday while section-a is the
    # on-call class with 1 rest day each side -> the seed itself carries
    # ON_CALL_REST violations. Unassigning the Tuesday draft assignment must
    # count as an improvement (hard violations are the TOP quality tier),
    # even though it opens a slot.
    slots = [
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        slots=slots,
        solver_settings={
            "enforceSameLocationPerDay": False,
            "onCallRestEnabled": True,
            "onCallRestClassId": "section-a",
            "onCallRestDaysBefore": 1,
            "onCallRestDaysAfter": 1,
            "workingHoursToleranceHours": 5,
        },
    )
    seed = [_seed("slot-a__mon", MON, "clin-1"), _seed("slot-a__tue", TUE, "clin-1")]
    executor = _make_executor(state, seed, start=MON, end=TUE)
    assert executor.seed_quality[0] > 0, "seed must carry in-range hard violations"

    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "unassign", "slot_key": f"slot-a__tue__{TUE}",
                    "clinicianId": "D1"}]},
    )
    assert payload["applied"] is True
    assert executor.best_quality[0] == 0  # violations repaired
    assert executor.best_quality[1] == 1  # one slot honestly open now
    assert [a.rowId for a in executor.best_assignments] == ["slot-a__mon"]
    assert executor.best_quality < executor.seed_quality  # improvement, not tie


def test_extending_a_fixed_short_day_counts_as_improvement():
    # A manually pinned 1h stint is a short day even though the agent placed
    # nothing there — and extending that person's day with the adjacent slot
    # must register as a measured improvement (short_days tier drops).
    slots = [
        make_template_slot("slot-early", col_band_id="col-mon-1",
                           start_time="06:30", end_time="07:30"),
        make_template_slot("slot-morning", col_band_id="col-mon-1",
                           start_time="07:30", end_time="12:00"),
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=slots,
        assignments=[make_assignment("m1", "slot-early", MON, "clin-1")],
    )
    executor = _make_executor(state)
    # Fixed-only 1h day, minimum 4h -> visible to the quality metric.
    assert executor.seed_quality[2] == 1, f"seed quality: {executor.seed_quality}"

    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-morning__{MON}",
                    "clinicianId": "D1"}]},
    )
    assert payload["applied"] is True
    assert executor.best_quality[2] == 0  # day extended past the minimum
    assert executor.best_quality < executor.seed_quality
