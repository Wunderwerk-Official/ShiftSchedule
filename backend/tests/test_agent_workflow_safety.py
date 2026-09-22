"""Regression tests for calendar safety at agent workflow boundaries.

All state lives in temporary SQLite databases. No external model is called.
"""
import importlib
import threading
import time

import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.solver as solver
from backend import solver_runs
from backend.agent.config import AgentConfig
from backend.agent.harness import agent_solve_range
from backend.agent.mock_provider import MockProvider
from backend.auth import _get_current_user, _create_user
from backend.main import app
from backend.models import Holiday, SolveRangeRequest, UserPublic, VacationRange
from backend.state import _load_state, _save_state
from backend.tests.conftest import make_app_state, make_assignment, make_clinician, make_template_slot

MON = "2026-01-05"
TUE = "2026-01-06"
USER = "isolated-workflow-review"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "review.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    current_user = _create_user(USER, "workflow-test-password", "admin")
    app.dependency_overrides[_get_current_user] = lambda: current_user
    yield TestClient(app)
    app.dependency_overrides.pop(_get_current_user, None)


def seed_run(state, assignments, *, end=MON, status="finished", debug=None):
    _save_state(state, USER)
    # Normalize before capturing the run's input, exactly as real planning does.
    _load_state(USER)
    solver_runs.create_run(
        "review-run", USER, MON, end, {"solver_mode": "agent"},
        input_fingerprint=solver._range_fingerprint(USER, MON, end),
    )
    result = {
        "startISO": MON, "endISO": end,
        "assignments": [a.model_dump() for a in assignments], "notes": [],
    }
    if debug is not None:
        result["debugInfo"] = debug
    solver_runs.finish_run("review-run", status, result=result)


def draft(date=MON, slot="slot-a__mon"):
    return make_assignment("draft-" + date, slot, date, "clin-1", "solver")


def test_actual_application_start_invokes_recovery(client, monkeypatch):
    main = importlib.import_module("backend.main")
    called = []
    monkeypatch.setattr(main, "_check_port_available", lambda *_args: None)
    monkeypatch.setattr(main, "_ensure_admin_user", lambda: None)
    monkeypatch.setattr(main, "_ensure_test_user", lambda: None)
    monkeypatch.setattr(solver, "recover_interrupted_runs", lambda: called.append(True))
    with TestClient(app) as running_client:
        assert running_client.get("/health").status_code == 200
    assert called == [True]


@pytest.mark.parametrize("change", ["vacation", "qualification"])
def test_stale_plan_is_revalidated_after_roster_change(client, change):
    seed_run(make_app_state(), [draft()])
    state = _load_state(USER)
    if change == "vacation":
        state.clinicians[0].vacations = [VacationRange(id="v", startISO=MON, endISO=MON)]
    else:
        state.clinicians[0].qualifiedClassIds = []
        state.clinicians[0].preferredClassIds = []
    _save_state(state, USER)
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "plan_invalid"
    forced = client.post("/v1/solve/runs/review-run/apply?force=true&allow_partial=true")
    assert forced.status_code == 409
    assert _load_state(USER).assignments == []
    assert solver_runs.get_run("review-run", USER)["status"] == "finished"


@pytest.mark.parametrize("change", ["holiday", "slot_day"])
def test_template_changes_cannot_silently_drop_applied_assignments(client, change):
    seed_run(make_app_state(), [draft()])
    state = _load_state(USER)
    if change == "holiday":
        state.holidays = [Holiday(dateISO=MON, name="New holiday")]
    else:
        state.weeklyTemplate.locations[0].slots[0].colBandId = "col-tue-1"
    _save_state(state, USER)
    response = client.post("/v1/solve/runs/review-run/apply?force=true&allow_partial=true")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "plan_invalid"
    assert _load_state(USER).assignments == []


def test_existing_manual_violation_does_not_block_unrelated_valid_draft(client):
    state = make_app_state(clinicians=[
        make_clinician("clin-1", "Alice", vacations=[VacationRange(id="v", startISO=MON, endISO=MON)]),
        make_clinician("clin-2", "Bob"),
    ], slots=[make_template_slot("slot-a__mon", required_slots=2)], assignments=[
        make_assignment("manual", "slot-a__mon", MON, "clin-1", "manual"),
    ])
    seed_run(state, [make_assignment("new", "slot-a__mon", MON, "clin-2", "solver")])
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 200, response.text
    assignments = _load_state(USER).assignments
    assert len(assignments) == 2
    assert next(a for a in assignments if a.id == "manual").source == "manual"


def test_partial_result_requires_explicit_confirmation_and_creates_backup(client):
    state = make_app_state(slots=[
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
    ], assignments=[draft(), draft(TUE, "slot-a__tue")])
    seed_run(state, [draft()], end=TUE, debug={"agent": {"daysSkipped": [TUE]}})
    assert len(_load_state(USER).assignments) == 2
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "partial_result"
    assert detail["removed_assignments"] == 1
    assert TUE in detail["dates"]
    assert len(_load_state(USER).assignments) == 2
    accepted = client.post("/v1/solve/runs/review-run/apply", params={
        "allow_partial": True, "expected_revision": detail["revision"],
    })
    assert accepted.status_code == 200, accepted.text
    assert {a.dateISO for a in _load_state(USER).assignments} == {MON}
    snapshots = client.get("/v1/state/snapshots").json()
    assert len(snapshots) == 1
    assert "applying plan" in snapshots[0]["name"]
    restored = client.post(f"/v1/state/snapshots/{snapshots[0]['id']}/restore", json={})
    assert restored.status_code == 200
    assert len(restored.json()["assignments"]) == 2


def test_empty_aborted_result_cannot_erase_previous_plan(client):
    seed_run(make_app_state(assignments=[draft()]), [], status="aborted")
    assert len(_load_state(USER).assignments) == 1
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "empty_result"
    assert len(_load_state(USER).assignments) == 1
    forced = client.post("/v1/solve/runs/review-run/apply?force=true&allow_partial=true")
    assert forced.status_code == 409
    summary = client.get("/v1/solve/runs").json()["runs"][0]
    assert summary["apply_blocked_reason"]


def test_late_autosave_cannot_undo_applied_result(client):
    seed_run(make_app_state(), [draft()])
    stale_browser_payload = _load_state(USER).model_dump()
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 200, response.text
    assert len(_load_state(USER).assignments) == 1
    # A previously prepared browser autosave arrives after the apply.
    response = client.post("/v1/state", json=stale_browser_payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "state_changed"
    assert len(_load_state(USER).assignments) == 1
    assert solver_runs.get_run("review-run", USER)["status"] == "applied"


def test_control_assignment_change_is_detected(client):
    seed_run(make_app_state(), [draft()])
    state = _load_state(USER)
    state.assignments = [make_assignment("manual", "slot-a__mon", MON, "clin-1", "manual")]
    _save_state(state, USER)
    response = client.post("/v1/solve/runs/review-run/apply")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "calendar_changed"


def test_premature_day_end_is_repaired_and_verified_before_reporting_completion(client):
    state = make_app_state(slots=[
        make_template_slot("slot-a__mon", col_band_id="col-mon-1"),
        make_template_slot("slot-a__tue", col_band_id="col-tue-1"),
    ])
    provider = MockProvider([
        {"text": "I will start planning Monday now."},
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [{
            "action": "assign", "slot_key": f"slot-a__tue__{TUE}",
            "clinicianId": "clin-1",
        }]}}]},
        {"text": "Tuesday complete."},
        {"text": "Review complete."},
    ])
    result = agent_solve_range(
        SolveRangeRequest(startISO=MON, endISO=TUE, solver_mode="agent"),
        state, threading.Event(), lambda *args: None, time.time(),
        provider=provider, config=AgentConfig(provider="mock"),
    )
    assert {a["dateISO"] for a in result["assignments"]} == {MON, TUE}
    meta = result["debugInfo"]["agent"]
    assert meta["daysPlanned"] == 2
    assert meta["daysSkipped"] == meta["daysIncomplete"] == []
    assert meta["stopReason"] == "completed"
    assert meta["final_audit"]["repairs"] == 1
    assert meta["completion"]["required_checks_complete"] and meta["completion"]["coverage_complete"]
    assert not meta["unsolved"]["open_slots"]


def test_equal_quality_latest_plan_is_streamed_for_abort_recovery(client):
    from backend.agent.tools import PlanToolExecutor
    from backend.scoring import build_scoring_context
    state = make_app_state(clinicians=[
        make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob"),
    ])
    ctx = build_scoring_context(state, MON, MON, only_fill_required=True)
    streamed = []
    executor = PlanToolExecutor(state, ctx, [], on_improvement=lambda score, plan: streamed.append(plan))
    executor.execute("apply_moves", {"moves": [{
        "action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1",
    }]}, "a")
    executor.execute("apply_moves", {"moves": [
        {"action": "unassign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"},
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-2"},
    ]}, "b")
    assert executor.best_assignments[0].clinicianId == "clin-2"
    assert streamed[-1][0].clinicianId == "clin-2"


def test_concurrent_saves_cannot_silently_overwrite_each_other(client):
    from concurrent.futures import ThreadPoolExecutor
    seed_run(make_app_state(), [draft()])
    payload = _load_state(USER).model_dump()
    def save(name):
        import copy
        updated = copy.deepcopy(payload)
        updated["clinicians"][0]["name"] = name
        return client.post("/v1/state", json=updated)
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(save, ["Alice", "Bob"]))
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r.json()["clinicians"][0]["name"] for r in responses if r.status_code == 200)
    assert _load_state(USER).clinicians[0].name == winner


def test_missing_revision_is_rejected_for_an_existing_calendar(client):
    seed_run(make_app_state(), [draft()])
    payload = _load_state(USER).model_dump(exclude={"revision"})
    assert client.post("/v1/state", json=payload).status_code == 409


def test_concurrent_apply_commits_once_and_keeps_original_backup(client):
    from concurrent.futures import ThreadPoolExecutor
    seed_run(make_app_state(), [draft()])
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda _: client.post("/v1/solve/runs/review-run/apply"), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert len(_load_state(USER).assignments) == 1
    import json
    with db._get_connection() as conn:
        backup = conn.execute("SELECT data FROM calendar_snapshots WHERE username = ?", (USER,)).fetchone()
        assert json.loads(backup[0])["assignments"] == []


def test_apply_failure_rolls_back_calendar_backup_and_run_status(client, monkeypatch):
    import backend.run_apply as applying
    seed_run(make_app_state(), [draft()])
    original = applying._save_state
    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("simulated write failure")
    monkeypatch.setattr(applying, "_save_state", fail_after_write)
    with pytest.raises(RuntimeError, match="simulated write failure"):
        client.post("/v1/solve/runs/review-run/apply")
    assert _load_state(USER).assignments == []
    assert solver_runs.get_run("review-run", USER)["status"] == "finished"
    assert client.get("/v1/state/snapshots").json() == []


def test_confirmation_is_invalidated_by_another_calendar_change(client):
    seed_run(make_app_state(), [draft()])
    old_revision = _load_state(USER).revision
    state = _load_state(USER)
    state.clinicians[0].planningWishes = "Prefer Mondays"
    _save_state(state, USER)
    response = client.post("/v1/solve/runs/review-run/apply", params={
        "force": True, "allow_partial": True, "expected_revision": old_revision,
    })
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "calendar_changed"


def test_premature_summary_gets_a_chance_to_finish_the_day(client):
    provider = MockProvider([
        {"text": "I will start now."},
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [{
            "action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1",
        }]}}]},
        {"text": "The day is complete."},
        {"text": "Review complete."},
    ])
    result = agent_solve_range(
        SolveRangeRequest(startISO=MON, endISO=MON, solver_mode="agent"),
        make_app_state(), threading.Event(), lambda *args: None, time.time(),
        provider=provider, config=AgentConfig(provider="mock"),
    )
    assert len(result["assignments"]) == 1
    assert result["debugInfo"]["agent"]["daysPlanned"] == 1
    assert result["debugInfo"]["agent"]["daysIncomplete"] == []


def test_final_review_keeps_rounds_when_construction_exhausts_its_share(client):
    from backend.agent.prompts import REVIEW_SYSTEM_PROMPT
    class RecordingProvider(MockProvider):
        systems = []
        def complete(self, **kwargs):
            self.systems.append(kwargs["system"])
            return super().complete(**kwargs)
    provider = RecordingProvider([{"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [{
        "action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1",
    }]}}]}] + [{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}] * 7
        + [{"text": "Review complete."}])
    result = agent_solve_range(
        SolveRangeRequest(startISO=MON, endISO=MON, solver_mode="agent"),
        make_app_state(), threading.Event(), lambda *args: None, time.time(),
        provider=provider, config=AgentConfig(provider="mock"),
    )
    assert len(result["assignments"]) == 1
    assert result["debugInfo"]["agent"]["iterations"] == 9
    assert provider.systems[-1] == REVIEW_SYSTEM_PROMPT


def test_stagnation_guard_allows_exploration_but_bounds_cycles():
    from backend.agent.progress import ProgressGuard
    guard = ProgressGuard("a", nudge_after=3, stop_after=5)
    assert guard.observe("b") == "continue"
    assert guard.observe("a") == "continue"
    assert guard.observe("b") == "continue"
    assert guard.observe("a") == "nudge"
    assert guard.observe("b") == "continue"
    assert guard.observe("a") == "stop"
    assert guard.observe("c") == "continue"


def test_assignment_fixed_after_run_start_survives_forced_apply(client):
    a = draft()
    seed_run(make_app_state(assignments=[a]), [])
    state = _load_state(USER)
    state.assignments[0].locked = True
    _save_state(state, USER)
    response = client.post('/v1/solve/runs/review-run/apply')
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'calendar_changed'
    revision = _load_state(USER).revision
    response = client.post('/v1/solve/runs/review-run/apply', params={'force': 'true', 'expected_revision': revision})
    assert response.status_code == 200, response.text
    saved = _load_state(USER)
    assert len(saved.assignments) == 1
    assert saved.assignments[0].locked and saved.assignments[0].source == 'solver'
