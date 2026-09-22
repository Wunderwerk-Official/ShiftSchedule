"""Exercise the isolated benchmark through the real harness without an API."""
import json
import sys

import pytest

from backend.agent.mock_provider import MockProvider
from backend.arena import prompt_eval
from .conftest import make_app_state, make_clinician


@pytest.mark.parametrize("variant", ["baseline", "focused"])
def test_trace_matches_real_plan_and_restores_harness(monkeypatch, capsys, variant):
    state = make_app_state(clinicians=[make_clinician("clin-1", "Alice")])
    script = [
        {"tool_calls": [
            {"name": "apply_moves", "arguments": {"moves": [
                {"action": "assign", "slot_key": "slot-a__mon__2026-01-05", "clinicianId": "clin-1"},
            ]}},
            {"name": "get_plan_overview", "arguments": {}},
        ]},
        {"text": "Complete."},
    ]
    originals = (prompt_eval.harness.PlanToolExecutor, prompt_eval.harness.DAY_SYSTEM_PROMPT,
                 prompt_eval.harness.REVIEW_SYSTEM_PROMPT)
    monkeypatch.setattr(prompt_eval, "load_state", lambda: state)
    monkeypatch.setattr(prompt_eval, "get_provider", lambda _: MockProvider(script))
    monkeypatch.setattr(sys, "argv", ["prompt_eval", "--mock", "--start", "2026-01-05", "--variant", variant])
    prompt_eval.main()
    lines = capsys.readouterr().out.splitlines()
    report = next(json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_REPORT "))
    plan = next(json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_PLAN "))
    assert report["best_quality"]["open_required_slots"] == 0
    assert report["moves_accepted"] == 1
    assert report["multi_tool_calls"] == 1
    assert report["tool_counts"]["apply_moves"] == 1
    assert len(plan["assignments"]) == 1
    assert originals == (prompt_eval.harness.PlanToolExecutor, prompt_eval.harness.DAY_SYSTEM_PROMPT,
                         prompt_eval.harness.REVIEW_SYSTEM_PROMPT)


def test_provider_error_is_not_a_successful_comparison(monkeypatch, capsys):
    monkeypatch.setattr(prompt_eval, "load_state", lambda: make_app_state())
    monkeypatch.setattr(prompt_eval, "get_provider", lambda _: MockProvider([
        {"error": "test unavailable", "status": 400},
    ]))
    monkeypatch.setattr(sys, "argv", ["prompt_eval", "--mock", "--start", "2026-01-05"])
    original = prompt_eval.harness.PlanToolExecutor
    with pytest.raises(SystemExit, match="Model errors/fallback detected"):
        prompt_eval.main()
    assert prompt_eval.harness.PlanToolExecutor is original
    assert '"error": "test unavailable"' in capsys.readouterr().out


def test_zero_move_fallback_reports_returned_coverage_and_is_not_model_success(monkeypatch, capsys):
    # The model ends cleanly without placing anything. A successful heuristic
    # draft must not be scored as successful model planning.
    monkeypatch.setattr(prompt_eval, "load_state", lambda: make_app_state())
    monkeypatch.setattr(prompt_eval, "get_provider", lambda _: MockProvider())
    monkeypatch.setattr(sys, "argv", ["prompt_eval", "--mock", "--start", "2026-01-05"])
    with pytest.raises(SystemExit, match="Model errors/fallback detected"):
        prompt_eval.main()
    lines = capsys.readouterr().out.splitlines()
    report = next(json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_REPORT "))
    plan = next(json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_PLAN "))
    assert report["fallback"]
    assert report["result_producer"] == "heuristic_v2"
    assert len(plan["assignments"]) == report["stats"]["total_assignments"] == 1
    assert report["stats"]["open_slots"] == report["best_quality"]["open_required_slots"] == 0
    assert report["completion"]["coverage_complete"]
    assert not report["completion"]["required_checks_complete"]


def test_named_model_evaluation_disables_switching_and_reports_injected_replacement(monkeypatch, capsys):
    requested, actual = "requested-flash", "unexpected-replacement"
    monkeypatch.setattr(prompt_eval, "load_state", lambda: make_app_state())

    class UnexpectedReplacement(MockProvider):
        def complete(self, **kwargs):
            # The tracing wrapper must forward cancellation to its delegate.
            assert self.cancel_event is not None
            response = super().complete(**kwargs)
            response.model = actual
            response.model_selection = {
                "requested_model": requested, "selected_model": actual,
                "attempts": [{"model": requested, "status": "unavailable"},
                             {"model": actual, "status": "selected"}],
            }
            return response

    def get_provider(config):
        assert config.model == requested
        assert config.allow_model_fallback is False
        return UnexpectedReplacement([
            {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
                {"action": "assign", "slot_key": "slot-a__mon__2026-01-05", "clinicianId": "clin-1"},
            ]}}]},
            {"text": "Complete."},
        ])

    monkeypatch.setattr(prompt_eval, "get_provider", get_provider)
    monkeypatch.setattr(sys, "argv", ["prompt_eval", "--mock", "--start", "2026-01-05", "--model", requested])
    with pytest.raises(SystemExit, match="Model selection changed"):
        prompt_eval.main()
    lines = capsys.readouterr().out.splitlines()
    report = next(json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_REPORT "))
    calls = [json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("PROMPT_EVAL_CALL ")]
    assert report["requested_model"] == requested and report["model"] == actual
    assert report["model_selection"]["selected_model"] == actual
    assert report["fallback"] is None
    assert report["stats"]["filled_slots"] == 1
    assert all(call["model"] == actual for call in calls)
