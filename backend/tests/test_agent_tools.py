"""Unit tests for the agent tool layer (working copy, guardrails, snapshots)."""

from __future__ import annotations

import json

from backend.agent.tools import PlanToolExecutor, _split_slot_key
from backend.models import Assignment, TemplateBlock
from backend.scoring import build_scoring_context

from .conftest import (
    make_app_state,
    make_assignment,
    make_clinician,
    make_pool_row,
    make_template_slot,
    make_workplace_row,
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
    assert gaps["open_slots"][0]["slot_key"] == f"S1__{MON}"

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
# LLM-facing identifiers: real names + short slot codes, never raw ids
# ---------------------------------------------------------------------------


def test_llm_facing_outputs_use_names_but_never_raw_ids():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-secret-1", "Dr. Annette Geheimnis", qualified_class_ids=["other"]),
            make_clinician("clin-secret-2", "Dr. Bernd Vertraulich"),
        ],
        assignments=[make_assignment("m1", "slot-a__mon", MON, "clin-secret-1")],
    )
    executor = _make_executor(state)
    assert executor.alias_by_id == {
        "clin-secret-1": "Dr. Annette Geheimnis",
        "clin-secret-2": "Dr. Bernd Vertraulich",
    }

    for tool, args in [
        ("get_violations", {}),
        ("list_candidates_for_slot", {"slot_key": f"slot-a__mon__{MON}"}),
        ("get_clinician_summary", {"clinicianId": "Dr. Bernd Vertraulich"}),
        ("get_plan_overview", {}),
        ("list_open_slots", {}),
    ]:
        result = executor.execute(tool, args, "call-x")
        # Raw ids never surface; clinicians are addressed by real name.
        assert "clin-secret" not in result.content, f"{tool}: {result.content}"
    candidates = executor.execute(
        "list_candidates_for_slot", {"slot_key": f"slot-a__mon__{MON}"}, "call-y"
    )
    assert "Dr. Bernd Vertraulich" in candidates.content


def test_apply_moves_accepts_names_and_returns_real_ids():
    state = make_app_state(
        clinicians=[make_clinician("clin-real-id", "Dr. Alice")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "apply_moves",
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Dr. Alice"}]},
    )
    assert payload["applied"] is True
    # The working copy stores the REAL id — the returned plan needs no
    # de-pseudonymization step.
    assert list(executor.current.keys()) == [("slot-a__mon", MON, "clin-real-id")]


def test_problem_digest_uses_names_and_slot_codes():
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
        alias_slot_key=executor._alias_slot_key,
    )
    assert "Dr. Carola Verborgen" in digest
    assert "clin-secret" not in digest
    assert "S1__" in digest and "slot-a__mon" not in digest


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
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Dr. Alice"}]},
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
        {"moves": [{"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Dr. Alice"}]},
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
    # Result keys are the short LLM-facing codes (raw ids resolve on input)
    assert set(slots) == {f"S1__{MON}", f"S2__{MON}", "bogus__2026-01-05"}
    good = slots[f"S1__{MON}"]
    assert {c["clinicianId"] for c in good["eligible"]} == set(executor.alias_by_id.values())
    assert good["ineligible"] == {}
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
                       "clinicianId": "Alice"}],
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
                       "clinicianId": "Alice"}],
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
                {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"},
                {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Bob"},
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
    assert payload["clinicians"][0]["clinicianId"] == "Alice"  # most underworked first
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
    assert slot["slot_key"] == f"S1__{MON}"
    assert slot["missing"] == 0
    assignees = {(a["clinicianId"], a["fixed"]) for a in slot["assigned"]}
    assert assignees == {("Dr. Alice", True), ("Bob", False)}
    assert "clin-1" not in json.dumps(payload)  # raw ids never surface

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
                {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"},
                {"action": "assign", "slot_key": f"slot-b__{MON}", "clinicianId": "Bob"},
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
                    "clinicianId": "Alice"}]},
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
                    "clinicianId": "Alice"}]},
    )
    assert payload["applied"] is True
    assert executor.best_quality[2] == 0  # day extended past the minimum
    assert executor.best_quality < executor.seed_quality


def test_unrepairable_fixed_violations_leave_the_quality_tier():
    """Hard violations among FIXED assignments alone (e.g. a manually
    double-booked clinician) cannot be repaired by the agent: they must not
    count in quality tier 1 and get flagged repairable=false."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice")],
        assignments=[
            make_assignment("m1", "slot-a__mon", MON, "clin-1"),
            make_assignment("m2", "slot-b__mon", MON, "clin-1"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                               start_time="09:00", end_time="13:00"),
        ],
    )
    executor = _make_executor(state)
    # The manual overlap exists but is nobody's job to fix:
    assert executor.seed_quality[0] == 0
    payload, _ = _run(executor, "get_violations", {"severity": "hard"})
    overlap = [v for v in payload["violations"] if v["code"] == "OVERLAP"]
    assert overlap and all(v["repairable"] is False for v in overlap)


def test_short_days_precompute_fix_options():
    """list_short_days must precompute adjacent fix options so the model
    need not re-derive them, and mark structurally unfixable cases (no
    adjacent qualified slot) with an empty option list."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob", qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
        ],
        slots=[
            # Alice: 3h (below her 4h daily minimum) -> short day.
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="11:00"),
            # slot-b touches slot-a at 11:00 and Bob holds it (as a movable
            # seed assignment, not a fixed manual one).
            make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                               start_time="11:00", end_time="15:00"),
            make_template_slot(slot_id="slot-c__mon", col_band_id="col-mon-1",
                               start_time="15:00", end_time="19:00"),
        ],
    )
    executor = _make_executor(
        state,
        seed=[
            _seed("slot-a__mon", MON, "clin-1"),
            _seed("slot-b__mon", MON, "clin-2"),
            _seed("slot-c__mon", MON, "clin-2"),
        ],
    )
    payload, _ = _run(executor, "list_short_days", {})
    assert "fixable" in payload
    alice = next(c for c in payload["short_days"] if c["clinicianId"] == "Alice")
    opts = alice["fix_options"]
    assert any(o["take_from"] == "Bob" for o in opts)
    # The direct swap (unassign Bob, assign Alice) is legal here, so the
    # option must NOT carry a blocked_by marker and the case counts fixable.
    assert all("blocked_by" not in o for o in opts if o["take_from"] == "Bob")
    assert payload["fixable"] >= 1


def _blocked_option_state(with_legal_option: bool):
    """Alice: 08:00-10:00 (seed) + FIXED 11:00-12:00 -> 3h < 4h minimum.
    slot-b (10:00-14:00, held by Bob) touches her day but overlaps her fixed
    11:00-12:00 stint -> the direct swap is illegal (OVERLAP). slot-c
    (10:00-11:00, open) bridges the gap into one contiguous 08:00-12:00
    block and is the optional legal fix."""
    slots = [
        make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                           start_time="08:00", end_time="10:00"),
        make_template_slot(slot_id="slot-x__mon", col_band_id="col-mon-1",
                           start_time="11:00", end_time="12:00"),
        make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                           start_time="10:00", end_time="14:00"),
    ]
    if with_legal_option:
        slots.append(
            make_template_slot(slot_id="slot-c__mon", col_band_id="col-mon-1",
                               start_time="10:00", end_time="11:00")
        )
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Bob", working_hours_per_week=40),
        ],
        slots=slots,
        assignments=[make_assignment("m1", "slot-x__mon", MON, "clin-1")],
    )
    seed = [
        _seed("slot-a__mon", MON, "clin-1"),
        _seed("slot-b__mon", MON, "clin-2"),
    ]
    return _make_executor(state, seed=seed)


def test_fix_options_flag_illegal_swaps_with_blocked_by():
    """An adjacent option whose direct swap would create a hard violation
    must carry the violation codes in blocked_by and sort after legal
    options — the model must not have to falsify it via dry runs."""
    executor = _blocked_option_state(with_legal_option=True)
    payload, _ = _run(executor, "list_short_days", {})
    alice = next(c for c in payload["short_days"] if c["clinicianId"] == "Alice")
    opts = alice["fix_options"]
    blocked = next(o for o in opts if o["slot_key"].endswith(MON) and o.get("blocked_by"))
    legal = next(o for o in opts if not o.get("blocked_by"))
    assert "OVERLAP" in blocked["blocked_by"]
    assert opts.index(legal) < opts.index(blocked)  # legal options first
    assert payload["fixable"] == 1  # the legal option keeps the case fixable


def test_all_options_blocked_counts_as_unfixable():
    """A case whose every option is illegal must not count as fixable —
    arena runs showed models chasing such cases for dozens of iterations."""
    executor = _blocked_option_state(with_legal_option=False)
    payload, _ = _run(executor, "list_short_days", {})
    alice = next(c for c in payload["short_days"] if c["clinicianId"] == "Alice")
    assert alice["fix_options"], "the blocked option should still be listed"
    assert all(o.get("blocked_by") for o in alice["fix_options"])
    assert payload["fixable"] == 0


# ---------------------------------------------------------------------------
# Day-by-day strategy helpers
# ---------------------------------------------------------------------------


def test_day_priorities_sorts_scarcest_slot_first():
    """A slot only one clinician can take must rank above a slot everyone
    can take — that is the 'which slots need filling first' step."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-b"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "Section B"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            # Flexible: both are qualified. Starts EARLIER than the scarce
            # slot, so ordering by scarcity is distinguishable from ordering
            # by time.
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
            # Scarce: section-b, only Alice is qualified.
            make_template_slot(slot_id="slot-x__mon", col_band_id="col-mon-1",
                               block_id="block-b",
                               start_time="09:00", end_time="13:00"),
        ],
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0)
    )
    executor = _make_executor(state)
    payload, is_error = _run(executor, "get_day_priorities", {"dateISO": MON})
    assert not is_error
    assert payload["open_positions"] == 2
    assert [s["eligible_count"] for s in payload["slots"]] == [1, 2]
    scarce = payload["slots"][0]
    assert scarce["section"] == "Section B"
    assert scarce["eligible_preview"] == ["Alice"]
    # Outside the range -> explicit error, not an empty list.
    outside, _ = _run(executor, "get_day_priorities", {"dateISO": "2027-01-01"})
    assert "error" in outside


def test_suggest_day_blocks_chains_adjacent_open_slots():
    """The block for a candidate must chain adjacent open slots up to the
    preferred daily hours — the 'Anschlussverwendung' the human procedure
    demands, ready to apply as one batch."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=[
            make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="10:00"),
            make_template_slot(slot_id="slot-2__mon", col_band_id="col-mon-1",
                               start_time="10:00", end_time="13:00"),
            make_template_slot(slot_id="slot-3__mon", col_band_id="col-mon-1",
                               start_time="13:00", end_time="16:00"),
        ],
    )
    executor = _make_executor(state)
    payload, is_error = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-1__mon__{MON}"}
    )
    assert not is_error
    alice = next(c for c in payload["candidates"] if c["clinicianId"] == "Alice")
    expected = [
        executor._alias_slot_key(f"slot-{i}__mon__{MON}") for i in (1, 2, 3)
    ]
    assert alice["block"] == expected  # 8h chain == contract/5 target
    assert alice["block_hours"] == 8.0
    assert alice["meets_daily_minimum"] is True

    # Applying the suggested block verbatim must succeed.
    moves = [
        {"action": "assign", "slot_key": key, "clinicianId": "Alice"}
        for key in alice["block"]
    ]
    applied, _ = _run(executor, "apply_moves", {"moves": moves})
    assert applied["applied"] is True


def test_suggest_day_blocks_stops_at_occupied_slot():
    """An occupied middle slot breaks the chain: the block must not jump the
    gap (that would be a split shift), and a fully staffed start slot is an
    explicit error."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Bob", working_hours_per_week=40),
        ],
        slots=[
            make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="10:00"),
            make_template_slot(slot_id="slot-2__mon", col_band_id="col-mon-1",
                               start_time="10:00", end_time="13:00"),
            make_template_slot(slot_id="slot-3__mon", col_band_id="col-mon-1",
                               start_time="13:00", end_time="16:00"),
        ],
    )
    executor = _make_executor(state, seed=[_seed("slot-2__mon", MON, "clin-2")])
    payload, _ = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-1__mon__{MON}"}
    )
    alice = next(c for c in payload["candidates"] if c["clinicianId"] == "Alice")
    assert alice["block"] == [executor._alias_slot_key(f"slot-1__mon__{MON}")]
    assert alice["block_hours"] == 2.0
    assert alice["meets_daily_minimum"] is False

    occupied, _ = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-2__mon__{MON}"}
    )
    assert "error" in occupied


def _scarce_flexible_state():
    """Two open Monday slots: a flexible section-a slot (Alice + Bob) and a
    scarce section-b slot (only Alice qualified)."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-b"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "Section B"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
            make_template_slot(slot_id="slot-x__mon", col_band_id="col-mon-1",
                               block_id="block-b",
                               start_time="09:00", end_time="13:00"),
        ],
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0)
    )
    return state


def test_suggest_day_blocks_auto_selects_scarcest_slot():
    """Without slot_key the tool must pick the scarcest still-fillable slot
    of dateISO itself (same ranking as get_day_priorities), so the model can
    pipeline apply_moves + suggest_day_blocks in one round."""
    executor = _make_executor(_scarce_flexible_state())
    payload, is_error = _run(executor, "suggest_day_blocks", {"dateISO": MON})
    assert not is_error
    assert payload["auto_selected"] is True
    # The scarce Section B slot (only Alice) outranks the flexible one.
    assert payload["section"] == "Section B"
    assert payload["day_open_positions"] == 2
    assert payload["other_open_slots"] == 1
    assert [c["clinicianId"] for c in payload["candidates"]] == ["Alice"]

    # Neither slot_key nor a usable dateISO -> explicit error, not a guess.
    bad, _ = _run(executor, "suggest_day_blocks", {})
    assert "error" in bad
    outside, _ = _run(executor, "suggest_day_blocks", {"dateISO": "2027-01-01"})
    assert "error" in outside


def test_suggest_day_blocks_auto_skips_unfillable_and_reports_day_complete():
    """Auto-select must skip eligible_count=0 slots (nobody can take them)
    and, once nothing fillable remains, return day_complete=true with the
    unfillable slots named — the model's signal to write the day summary."""
    state = _scarce_flexible_state()
    # Nobody is qualified for section-b anymore: its slot is unfillable.
    for c in state.clinicians:
        c.qualifiedClassIds = ["section-a"]
    executor = _make_executor(state)

    payload, _ = _run(executor, "suggest_day_blocks", {"dateISO": MON})
    assert payload["auto_selected"] is True
    assert payload["section"] == "Section A"  # skipped the unfillable slot
    assert payload["unfillable_slots"] == [
        executor._alias_slot_key(f"slot-x__mon__{MON}")
    ]

    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"},
    ]})
    assert applied["applied"] is True
    done, is_error = _run(executor, "suggest_day_blocks", {"dateISO": MON})
    assert not is_error
    assert done["day_complete"] is True
    assert done["open_positions"] == 1
    assert done["unfillable_slots"] == [
        executor._alias_slot_key(f"slot-x__mon__{MON}")
    ]


def test_day_priorities_caps_slot_list_but_counts_everything():
    """The priorities list is orientation: at most 20 entries are shown, the
    rest is summarized in more_open_slots while open_positions stays exact."""
    slots = [
        make_template_slot(slot_id=f"slot-{i}__mon", col_band_id="col-mon-1",
                           start_time=f"{6 + (i % 12):02d}:00",
                           end_time=f"{7 + (i % 12):02d}:00")
        for i in range(23)
    ]
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=slots,
    )
    executor = _make_executor(state)
    payload, is_error = _run(executor, "get_day_priorities", {"dateISO": MON})
    assert not is_error
    assert payload["open_positions"] == 23
    assert len(payload["slots"]) == 20
    assert payload["more_open_slots"] == 3
    assert all("raw_slot_key" not in s for s in payload["slots"])


def test_day_priorities_processing_order_oncall_and_priority_first():
    """The day is worked in processing order, not chronologically: on-call
    duties first (rest days ripple into neighbouring days), then the
    practice's slot priority (template order), scarcest within a tier. A
    slot with only ONE legal candidate jumps the whole queue."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-b", "section-c"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a", "section-b"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "On Call"),
            make_workplace_row("section-c", "Scarce"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            # Template order = priority order: earliest slot in the template
            # has the highest order weight.
            make_template_slot(slot_id="slot-hi__mon", col_band_id="col-mon-1",
                               start_time="13:00", end_time="17:00"),
            make_template_slot(slot_id="slot-lo__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
            make_template_slot(slot_id="slot-oc__mon", col_band_id="col-mon-1",
                               block_id="block-oc",
                               start_time="19:00", end_time="23:00"),
            make_template_slot(slot_id="slot-scarce__mon", col_band_id="col-mon-1",
                               block_id="block-scarce",
                               start_time="09:00", end_time="13:00"),
        ],
        solver_settings={
            "onCallRestEnabled": True,
            "onCallRestClassId": "section-b",
            "onCallRestDaysBefore": 0,
            "onCallRestDaysAfter": 0,
        },
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-oc", sectionId="section-b", requiredSlots=0)
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-scarce", sectionId="section-c", requiredSlots=0)
    )
    executor = _make_executor(state)
    payload, is_error = _run(executor, "get_day_priorities", {"dateISO": MON})
    assert not is_error
    order = [s["slot_key"] for s in payload["slots"]]
    key = lambda sid: executor._alias_slot_key(f"{sid}__{MON}")  # noqa: E731
    # Scarce (only Alice) jumps the queue, then the on-call duty, then the
    # two flexible section-a slots by template priority — the later-starting
    # high-priority slot BEFORE the earlier-starting low-priority one.
    assert order == [
        key("slot-scarce__mon"), key("slot-oc__mon"),
        key("slot-hi__mon"), key("slot-lo__mon"),
    ]
    oc_entry = payload["slots"][1]
    assert oc_entry["on_call"] is True
    priorities = [s["priority"] for s in payload["slots"][2:]]
    assert priorities == sorted(priorities, reverse=True)

    # Auto-select follows the same order: the scarce slot comes out first.
    auto, _ = _run(executor, "suggest_day_blocks", {"dateISO": MON})
    assert auto["auto_selected"] is True
    assert auto["slot_key"] == key("slot-scarce__mon")


def test_suggest_day_blocks_exposes_personal_weekly_limit():
    """Candidates must carry week_hours_max (contract + PERSONAL tolerance):
    in the real data tolerances differ per clinician (up to 10h), and
    without the limit models wrongly avoid legal above-contract candidates."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=36)],
        slots=[make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1")],
    )
    state.clinicians[0].workingHoursToleranceHours = 10
    executor = _make_executor(state)
    payload, _ = _run(executor, "suggest_day_blocks", {"dateISO": MON})
    alice = payload["candidates"][0]
    assert alice["contract_hours"] == 36
    assert alice["week_hours_max"] == 46


def test_suggest_rescue_moves_frees_blocked_clinician_with_substitute():
    """The 'X could do it if Y took over X's afternoon' move: a stuck slot
    (only Alice qualified, Alice busy in an overlapping slot Bob could also
    take) must yield a pre-validated 3-move batch that applies verbatim."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-b"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "Section B"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-x__mon", col_band_id="col-mon-1",
                               block_id="block-b",
                               start_time="08:00", end_time="16:00"),
        ],
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0)
    )
    executor = _make_executor(state)
    # Alice takes the flexible slot first (the greedy trap).
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"}]})
    assert applied["applied"] is True
    stuck, _ = _run(executor, "get_day_priorities", {"dateISO": MON})
    assert stuck["slots"][0]["eligible_count"] == 0  # section-b slot is stuck

    payload, is_error = _run(executor, "suggest_rescue_moves", {"dateISO": MON})
    assert not is_error
    assert payload["truly_unfillable"] == []
    rescue = payload["rescues"][0]
    assert rescue["frees"] == "Alice"
    assert rescue["substitute"] == "Bob"
    assert rescue["fills"] == executor._alias_slot_key(f"slot-x__mon__{MON}")
    applied2, _ = _run(executor, "apply_moves", {"moves": rescue["batch"]})
    assert applied2["applied"] is True
    after, _ = _run(executor, "get_day_priorities", {"dateISO": MON})
    assert after["open_positions"] == 0

    # No stuck slots -> explicit no-op answer, not an error.
    calm, _ = _run(executor, "suggest_rescue_moves", {"dateISO": MON})
    assert calm["rescues"] == []
    outside, _ = _run(executor, "suggest_rescue_moves", {"dateISO": "2027-01-01"})
    assert "error" in outside


def _day_night_duty_state():
    """The production trap: a 12h day duty and a 12h night duty on the same
    day. Richard is free for both; stacking both would be a 24h shift."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Richard", working_hours_per_week=50),
            make_clinician("clin-2", "Bob", working_hours_per_week=40),
        ],
        slots=[
            make_template_slot(slot_id="slot-day__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="20:00"),
            make_template_slot(slot_id="slot-night__mon", col_band_id="col-mon-1",
                               start_time="20:00", end_time="08:00",
                               end_day_offset=1),
        ],
    )
    return state


def test_suggest_day_blocks_flags_24h_stacking_as_overloaded():
    executor = _make_executor(_day_night_duty_state())
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-day__mon__{MON}", "clinicianId": "Richard"}]})
    assert applied["applied"] is True

    payload, _ = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-night__mon__{MON}"}
    )
    by_name = {c["clinicianId"]: c for c in payload["candidates"]}
    assert by_name["Richard"]["overloaded"] is True   # 24h day
    assert by_name["Richard"]["day_hours_after"] == 24.0
    assert by_name["Bob"]["overloaded"] is False
    # The fresh clinician sorts FIRST even though both blocks are equal.
    assert payload["candidates"][0]["clinicianId"] == "Bob"


def test_suggest_day_blocks_single_mode_skips_chaining():
    """Duty mode: single=true must suggest exactly the requested slot, no
    Anschluss chain."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=[
            make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="10:00"),
            make_template_slot(slot_id="slot-2__mon", col_band_id="col-mon-1",
                               start_time="10:00", end_time="13:00"),
        ],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor,
        "suggest_day_blocks",
        {"slot_key": f"slot-1__mon__{MON}", "single": True},
    )
    alice = payload["candidates"][0]
    assert alice["block"] == [executor._alias_slot_key(f"slot-1__mon__{MON}")]
    assert alice["block_hours"] == 2.0


def test_greedy_day_block_treats_wide_window_as_bound_not_target():
    """A mandatory working-time window says WHEN someone may work, not how
    much: a 06:00-20:00 presence window must not turn into a 14h auto-built
    chain (observed in production — one clinician got 13.5h while colleagues
    had 1h days). The chain target stays the contract workday."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=[
            make_template_slot(slot_id=f"slot-{i}__mon", col_band_id="col-mon-1",
                               start_time=start, end_time=end)
            for i, (start, end) in enumerate(
                [("06:00", "09:00"), ("09:00", "12:00"), ("12:00", "15:00"),
                 ("15:00", "18:00"), ("18:00", "20:00")]
            )
        ],
    )
    executor = _make_executor(state)
    executor.ctx.window_by_clinician_date[("clin-1", MON)] = ("mandatory", 360, 1200)

    payload, is_error = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-0__mon__{MON}"}
    )
    assert not is_error
    alice = next(c for c in payload["candidates"] if c["clinicianId"] == "Alice")
    # Contract workday 8h (+1h step tolerance) caps the chain — never the
    # 14h window span.
    assert alice["block_hours"] <= 9.0
    assert alice["meets_daily_minimum"] is True


def test_suggest_day_blocks_prefers_longest_block_when_all_below_minimum():
    """When no candidate reaches the daily minimum, the LONGEST block must
    sort first even if someone else is further behind on YTD: one person on
    a 2h stint beats two people on 1h stints (the second stays off)."""
    # A March Monday: far enough into the year for YTD percentages to exist
    # (in the first ISO week they are None and could not steer the sort).
    day = "2026-03-02"
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-b"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "Section B"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            make_template_slot(slot_id="slot-uro__mon", col_band_id="col-mon-1",
                               start_time="17:00", end_time="18:00"),
            make_template_slot(slot_id="slot-gyn__mon", col_band_id="col-mon-1",
                               block_id="block-b",
                               start_time="18:00", end_time="19:00"),
            # History-only slot: carries Alice's past workload, and on the
            # solve day itself it neither touches 17:00 nor 19:00, so it
            # cannot extend either candidate's chain.
            make_template_slot(slot_id="slot-hist", col_band_id="col-mon-1",
                               start_time="08:00", end_time="16:00"),
        ],
        assignments=[
            # Alice already worked full days this year -> her YTD is AHEAD
            # of Bob's, so a ytd-first order would wrongly put Bob (1h
            # block) on top of Alice (2h block).
            make_assignment(f"m-prev-{d}", "slot-hist", f"2026-02-{d:02d}", "clin-1")
            for d in range(2, 21)
        ],
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0)
    )
    executor = _make_executor(state, start=day, end=day)
    payload, is_error = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-uro__mon__{day}"}
    )
    assert not is_error
    by_name = {c["clinicianId"]: c for c in payload["candidates"]}
    assert by_name["Alice"]["block_hours"] == 2.0   # covers both staff slots
    assert by_name["Bob"]["block_hours"] == 1.0
    # The YTD numbers exist and would have flipped the old (ytd-first)
    # order; below the daily minimum the longer block must win regardless.
    assert by_name["Alice"]["ytd_worked_pct"] > by_name["Bob"]["ytd_worked_pct"]
    assert all(not c["meets_daily_minimum"] for c in payload["candidates"])
    assert payload["candidates"][0]["clinicianId"] == "Alice"


def _balance_state(*, third_clinician=False):
    clinicians = [
        make_clinician("clin-1", "Alice", working_hours_per_week=40),
        make_clinician("clin-2", "Bob", working_hours_per_week=40),
    ]
    if third_clinician:
        clinicians.append(make_clinician("clin-3", "Cara", working_hours_per_week=40))
    return make_app_state(
        clinicians=clinicians,
        slots=[
            make_template_slot(slot_id="slot-am__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
            make_template_slot(slot_id="slot-pm__mon", col_band_id="col-mon-1",
                               start_time="12:00", end_time="16:00"),
            make_template_slot(slot_id="slot-eve__mon", col_band_id="col-mon-1",
                               start_time="16:00", end_time="17:00"),
        ],
    )


def test_suggest_balance_moves_clears_mini_stint_day():
    """The final review must offer to hand a mini-stint (1h day, below the
    daily minimum) to an adjacent colleague so its holder stays off entirely
    — the admin's 'better one person covers a longer block' rule."""
    executor = _make_executor(_balance_state())
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-am__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-pm__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-eve__mon__{MON}", "clinicianId": "Bob"},
    ]})
    assert applied["applied"] is True

    payload, is_error = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    assert not is_error
    assert [m["clinicianId"] for m in payload["mini_stint_days"]] == ["Bob"]
    offer = payload["offers"][0]
    assert offer["reason"] == "clear_mini_stint"
    assert offer["from"] == "Bob" and offer["to"] == "Alice"
    assert offer["donor_day_hours_before_after"] == [1.0, 0.0]
    assert offer["receiver_day_hours_before_after"] == [8.0, 9.0]

    applied, _ = _run(executor, "apply_moves", {"moves": offer["batch"]})
    assert applied["applied"] is True
    done, _ = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    assert done.get("balanced") is True
    assert done["offers"] == []


def test_suggest_balance_moves_shortens_overlong_day_until_balanced():
    """An over-long chained day must shed edge slots to less-loaded
    colleagues, keeping BOTH days contiguous, and the review must reach a
    balanced state (no infinite offer loop)."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Bob", working_hours_per_week=40),
        ],
        slots=[
            make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1",
                               start_time="06:00", end_time="10:00"),
            make_template_slot(slot_id="slot-2__mon", col_band_id="col-mon-1",
                               start_time="10:00", end_time="14:00"),
            make_template_slot(slot_id="slot-3__mon", col_band_id="col-mon-1",
                               start_time="14:00", end_time="17:00"),
            make_template_slot(slot_id="slot-4__mon", col_band_id="col-mon-1",
                               start_time="17:00", end_time="20:00"),
        ],
    )
    executor = _make_executor(state)
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-{i}__mon__{MON}", "clinicianId": "Alice"}
        for i in (1, 2, 3, 4)
    ]})
    assert applied["applied"] is True  # 14h day (the gate has no daily cap)

    payload, _ = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    assert payload["overlong_days"][0]["clinicianId"] == "Alice"
    offer = payload["offers"][0]
    assert offer["reason"] == "shorten_long_day"
    assert offer["from"] == "Alice" and offer["to"] == "Bob"
    # 17-20 to a zero-hours Bob would be a new 3h mini-stint (min 4h) and
    # 10-14/14-17 would split Alice's day -> the legal handover is 06-10.
    assert offer["slots"] == [executor._alias_slot_key(f"slot-1__mon__{MON}")]

    # Apply offers until the review reports balance; must terminate.
    for _ in range(5):
        payload, _ = _run(executor, "suggest_balance_moves", {"dateISO": MON})
        if payload.get("balanced"):
            break
        if not payload["offers"]:
            break
        applied, _ = _run(
            executor, "apply_moves", {"moves": payload["offers"][0]["batch"]}
        )
        assert applied["applied"] is True
    assert payload.get("balanced") is True

    # End state: nobody over-long, nobody split, everything still covered.
    alice_day = sorted(executor._day_intervals("clin-1", MON))
    bob_day = sorted(executor._day_intervals("clin-2", MON))
    assert sum(e - s for s, e in alice_day) <= 9 * 60
    assert sum(e - s for s, e in bob_day) <= 9 * 60
    open_now, _ = _run(executor, "list_open_slots", {"dateISO": MON})
    assert open_now["open_slots"] == []


def test_suggest_balance_moves_leaves_fixed_stints_alone():
    """A mini-stint that exists because the ADMIN pinned it is not ours to
    clear: no offer, no nagging — the review reports the day as balanced."""
    state = _balance_state()
    state.assignments = [make_assignment("m1", "slot-eve__mon", MON, "clin-2")]
    executor = _make_executor(state)
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-am__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-pm__mon__{MON}", "clinicianId": "Alice"},
    ]})
    assert applied["applied"] is True

    payload, is_error = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    assert not is_error
    assert payload.get("balanced") is True
    assert payload["offers"] == []

    outside, _ = _run(executor, "suggest_balance_moves", {"dateISO": "2027-01-01"})
    assert "error" in outside


def test_blocked_candidate_reports_week_overage_magnitude():
    """A candidate blocked by WEEKLY_HOURS must say HOW FAR over the cap the
    move would land — 0.5h over reads very differently from 20h over (the
    admin's ask: verdicts should be graded, not 0/1)."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=8)],
        slots=[
            make_template_slot(slot_id="slot-mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-tue", col_band_id="col-tue-1",
                               start_time="08:00", end_time="16:00"),
        ],
    )
    executor = _make_executor(state, start=MON, end=TUE)
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-mon__{MON}", "clinicianId": "Alice"},
    ]})
    assert applied["applied"] is True  # 8h of a 13h cap (8 contract + 5 tol)

    result, _ = _run(
        executor, "list_candidates_for_slot", {"slot_key": f"slot-tue__{TUE}"}
    )
    alice = next(c for c in result["candidates"] if c["clinicianId"] == "Alice")
    assert alice["eligible"] is False
    assert "WEEKLY_HOURS" in alice["reasons"]
    assert alice["week_over_cap_hours"] == 3.0  # 16h assigned vs 13h cap

    # The same magnitude on a rejected batch.
    rejected, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-tue__{TUE}", "clinicianId": "Alice"},
    ]})
    assert rejected["applied"] is False
    weekly = next(
        v for v in rejected["new_hard_violations"] if v["code"] == "WEEKLY_HOURS"
    )
    assert weekly["over_by_hours"] == 3.0


def test_suggest_day_blocks_reports_daily_min_threshold():
    """meets_daily_minimum=false alone is binary; daily_min_hours grades it
    (1h of a 4h minimum is a real stub, 3.5h is a near fit)."""
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice", working_hours_per_week=40)],
        slots=[make_template_slot(slot_id="slot-1__mon", col_band_id="col-mon-1",
                                  start_time="17:00", end_time="18:00")],
    )
    executor = _make_executor(state)
    payload, _ = _run(
        executor, "suggest_day_blocks", {"slot_key": f"slot-1__mon__{MON}"}
    )
    alice = payload["candidates"][0]
    assert alice["meets_daily_minimum"] is False
    assert alice["daily_min_hours"] == 4.0  # (40h/5)/2


def test_suggest_balance_moves_offers_tagged_overshoot():
    """Soft targets are graded, not walls: a handover that pushes the
    receiver up to 1h past their comfortable span is still offered, tagged
    with receiver_overshoot_hours so the model can weigh the trade."""
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", working_hours_per_week=40),
            make_clinician("clin-2", "Bob", working_hours_per_week=40),
        ],
        slots=[
            make_template_slot(slot_id="slot-am__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="13:00"),
            make_template_slot(slot_id="slot-pm__mon", col_band_id="col-mon-1",
                               start_time="13:00", end_time="17:00"),
            make_template_slot(slot_id="slot-eve__mon", col_band_id="col-mon-1",
                               start_time="17:00", end_time="18:00"),
        ],
    )
    executor = _make_executor(state)
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-am__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-pm__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-eve__mon__{MON}", "clinicianId": "Bob"},
    ]})
    assert applied["applied"] is True  # Alice 9h, Bob 1h stub

    payload, _ = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    offer = payload["offers"][0]
    assert offer["reason"] == "clear_mini_stint"
    assert offer["to"] == "Alice"
    # Alice lands on 10h — 1h past her 9h comfort line — and the offer says so.
    assert offer["receiver_day_hours_before_after"] == [9.0, 10.0]
    assert offer["receiver_overshoot_hours"] == 1.0

    applied, _ = _run(executor, "apply_moves", {"moves": offer["batch"]})
    assert applied["applied"] is True


def test_expensive_tools_respect_wall_deadline():
    """A run stuck inside one long tool call blew past its budget in
    production (connection cut at ~600s, plan lost). With the wall deadline
    stamped, balance and rescue cut their searches short instead."""
    import time as _time

    executor = _make_executor(_balance_state())
    applied, _ = _run(executor, "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-am__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-pm__mon__{MON}", "clinicianId": "Alice"},
        {"action": "assign", "slot_key": f"slot-eve__mon__{MON}", "clinicianId": "Bob"},
    ]})
    assert applied["applied"] is True
    executor.wall_deadline = _time.time() - 1  # budget already spent

    payload, _ = _run(executor, "suggest_balance_moves", {"dateISO": MON})
    assert payload["offers"] == []
    assert "time budget" in payload["note"]

    # Rescue: same guard — stuck slots are reported as not searched.
    state = _scarce_flexible_state()
    for c in state.clinicians:
        c.qualifiedClassIds = ["section-a"]
    rescue_executor = _make_executor(state)
    rescue_executor.wall_deadline = _time.time() - 1
    rescue, _ = _run(rescue_executor, "suggest_rescue_moves", {"dateISO": MON})
    assert rescue["rescues"] == []
    assert "time budget" in rescue["note"]
    assert rescue["not_searched"]
