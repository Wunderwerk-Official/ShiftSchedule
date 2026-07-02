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
    by_id = {c["clinicianId"]: c for c in payload["candidates"]}
    assert by_id["clin-ok"]["eligible"] is True
    assert "QUALIFICATION" in by_id["clin-unqualified"]["reasons"]
    assert "OVERLAP" in by_id["clin-busy"]["reasons"]


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
    assert overview["score"] == executor.seed_score

    summary, _ = _run(executor, "get_clinician_summary", {"clinicianId": "clin-1"})
    assert summary["qualified_sections"] == ["section-a"]

    unknown, is_error = _run(executor, "get_clinician_summary", {"clinicianId": "nope"})
    assert "error" in unknown and not is_error

    _, is_error = _run(executor, "no_such_tool", {})
    assert is_error
