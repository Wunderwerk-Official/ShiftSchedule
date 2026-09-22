"""Draft generation and application must agree about replaceable input."""

import pytest

from backend.state import _save_state
from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot, solve_via_endpoint
from .test_agent_integration import MON, USER, solve_client


@pytest.mark.parametrize("mode", ["cpsat", "heuristic"])
def test_legacy_replan_preserves_coverage_manual_locked_and_boundary_work(solve_client, mode):
    unlocked = make_assignment("old-solver", "slot-a__mon", MON, "a", "solver")
    manual = make_assignment("manual", "slot-a__mon", MON, "b", "manual")
    locked = make_assignment("locked", "slot-a__mon", MON, "c", "solver")
    locked.locked = True
    boundary = make_assignment("boundary", "sun", "2026-01-04", "a", "solver")
    state = make_app_state(
        clinicians=[make_clinician(cid, cid) for cid in ("a", "b", "c")],
        slots=[make_template_slot("slot-a__mon", required_slots=3),
               make_template_slot("sun", col_band_id="col-sun-1")],
        assignments=[unlocked, manual, locked, boundary],
    )
    _save_state(state, USER)
    run = solve_via_endpoint(solve_client, {
        "startISO": MON, "endISO": MON, "only_fill_required": True,
        "solver_mode": mode, "timeout_seconds": 5,
    })
    assert run["status"] == "finished", run
    assert [(a["clinicianId"], a["rowId"]) for a in run["result"]["assignments"]] == [
        ("a", "slot-a__mon"),
    ]
    # Starting a draft must not edit saved input.
    assert {a["id"] for a in solve_client.get("/v1/state").json()["assignments"]} == {
        "old-solver", "manual", "locked", "boundary",
    }
    applied = solve_client.post(f"/v1/solve/runs/{run['id']}/apply")
    assert applied.status_code == 200, applied.text
    assignments = solve_client.get("/v1/state").json()["assignments"]
    assert len(assignments) == 4
    by_id = {a["id"]: a for a in assignments}
    assert "old-solver" not in by_id
    assert by_id["manual"] == manual.model_dump()
    assert by_id["locked"] == locked.model_dump()
    assert by_id["boundary"] == boundary.model_dump()


@pytest.mark.parametrize("mode", ["cpsat", "heuristic"])
def test_legacy_default_range_is_stored_and_applied_as_a_full_week(solve_client, mode):
    state = make_app_state(slots=[
        make_template_slot("slot-a__mon"),
        make_template_slot("fri", col_band_id="col-fri-1"),
    ])
    _save_state(state, USER)
    run = solve_via_endpoint(solve_client, {
        "startISO": MON, "only_fill_required": True,
        "solver_mode": mode, "timeout_seconds": 5,
    })
    assert run["status"] == "finished", run
    assert run["end_iso"] == "2026-01-11"
    assert run["params"]["endISO"] == "2026-01-11"
    assert {a["dateISO"] for a in run["result"]["assignments"]} == {MON, "2026-01-09"}
    applied = solve_client.post(f"/v1/solve/runs/{run['id']}/apply")
    assert applied.status_code == 200, applied.text
    assert {a["dateISO"] for a in solve_client.get("/v1/state").json()["assignments"]} == {
        MON, "2026-01-09",
    }
