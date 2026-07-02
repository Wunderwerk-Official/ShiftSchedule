"""In-process tests for the agent harness loop, driven by MockProvider."""

from __future__ import annotations

import time

from backend.agent.config import AgentConfig
from backend.agent.harness import agent_solve_range
from backend.agent.mock_provider import MockProvider
from backend.agent.provider import LLMProvider, ProviderResponse
from backend.models import SolveRangeRequest

from .conftest import make_app_state, make_clinician

MON = "2026-01-05"


class MockCancelEvent:
    def __init__(self, set_after_calls: int = -1):
        self._set = False

    def is_set(self):
        return self._set

    def set(self):
        self._set = True


class ProgressRecorder:
    def __init__(self):
        self.events = []

    def __call__(self, event_type: str, data: dict):
        self.events.append((event_type, data))

    def solutions(self):
        return [data for etype, data in self.events if etype == "solution"]


def _payload(**kwargs) -> SolveRangeRequest:
    defaults = dict(startISO=MON, endISO=MON, only_fill_required=True, timeout_seconds=60.0)
    defaults.update(kwargs)
    return SolveRangeRequest(**defaults)


def _config(**kwargs) -> AgentConfig:
    defaults = dict(provider="mock", max_iterations=10)
    defaults.update(kwargs)
    return AgentConfig(**defaults)


def _two_clinician_state():
    """One required Monday slot; heuristic seed will fill it with someone."""
    return make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice"),
            make_clinician("clin-2", "Bob"),
        ]
    )


def test_inspection_only_script_keeps_seed_and_reports_iterations():
    state = _two_clinician_state()
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        {"tool_calls": [{"name": "list_open_slots", "arguments": {}}]},
        {"text": "No further improvements."},
    ]
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider(script),
        config=_config(),
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert result["debugInfo"]["agent"]["iterations"] == 3
    # Seed filled the required slot; agent kept it
    assert len(result["assignments"]) == 1
    assert result["assignments"][0]["source"] == "solver"
    # Seed was emitted as solution #1
    solutions = progress.solutions()
    assert solutions and solutions[0]["solution_num"] == 1


def test_agent_move_improves_plan_and_emits_solution():
    # Distribute-all mode gives the slot +1 capacity headroom; the heuristic
    # fills only the required position, the agent adds a second assignment
    # for the free clinician -> a real improvement. One of the two scripted
    # assigns targets the clinician the heuristic already used and must be
    # rejected; the other succeeds.
    state = _two_clinician_state()
    slot_key = f"slot-a__mon__{MON}"
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        # Try to add whichever clinician is free (heuristic took one of them)
        {"tool_calls": [{"name": "apply_moves", "arguments": {
            "moves": [{"action": "assign", "slot_key": slot_key, "clinicianId": "clin-1"}]}}]},
        {"tool_calls": [{"name": "apply_moves", "arguments": {
            "moves": [{"action": "assign", "slot_key": slot_key, "clinicianId": "clin-2"}]}}]},
        {"text": "Filled the extra capacity."},
    ]
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(only_fill_required=False),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider(script),
        config=_config(),
    )
    # One of the two assigns was legal (the free clinician), one rejected
    assert result["debugInfo"]["agent"]["moves_accepted"] == 1
    assert len(result["assignments"]) == 2
    solutions = progress.solutions()
    assert len(solutions) == 2  # seed + improvement
    assert solutions[1]["objective"] < solutions[0]["objective"]
    assert result["debugInfo"]["agent"]["best_score"] < result["debugInfo"]["agent"]["seed_score"]
    assert any("Score improved" in n for n in result["notes"])


def test_illegal_moves_leave_seed_untouched():
    state = _two_clinician_state()
    slot_key = f"slot-a__mon__{MON}"
    script = [
        # Try to double-book the slot beyond capacity (only_fill_required)
        {"tool_calls": [{"name": "apply_moves", "arguments": {
            "moves": [{"action": "assign", "slot_key": slot_key, "clinicianId": "clin-1"},
                      {"action": "assign", "slot_key": slot_key, "clinicianId": "clin-2"}]}}]},
        {"text": "Could not improve."},
    ]
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider(script),
        config=_config(),
    )
    assert result["debugInfo"]["agent"]["moves_accepted"] == 0
    assert len(result["assignments"]) == 1  # untouched seed
    assert any("No improvement" in n for n in result["notes"])


class ErroringProvider(LLMProvider):
    """First call inspects, second call errors."""

    def __init__(self):
        self.calls = 0

    def complete(self, *, system, messages, tools, timeout_seconds) -> ProviderResponse:
        self.calls += 1
        if self.calls == 1:
            return MockProvider(
                [{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}]
            ).complete(system=system, messages=messages, tools=tools,
                       timeout_seconds=timeout_seconds)
        return ProviderResponse(
            text=None, tool_calls=[], stop_reason="error", error="boom"
        )


def test_provider_error_returns_best_so_far_with_note():
    state = _two_clinician_state()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=ErroringProvider(),
        config=_config(),
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert any("LLM error" in n for n in result["notes"])
    assert len(result["assignments"]) == 1  # seed preserved


def test_missing_provider_falls_back_to_seed(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("AGENT_PROVIDER", "anthropic")
    state = _two_clinician_state()
    result = agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), 0.0
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("Agent LLM unavailable" in n for n in result["notes"])
    assert len(result["assignments"]) == 1


def test_iteration_budget_is_honored():
    state = _two_clinician_state()
    endless = [{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}] * 50
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider(endless),
        config=_config(max_iterations=3),
    )
    assert result["debugInfo"]["agent"]["iterations"] == 3
    assert any("iteration budget exhausted" in n for n in result["notes"])


def test_wall_clock_budget_is_honored():
    state = _two_clinician_state()
    # start_time far in the past -> deadline already passed
    result = agent_solve_range(
        _payload(timeout_seconds=1.0),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time() - 100.0,
        provider=MockProvider([{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}]),
        config=_config(),
    )
    assert result["debugInfo"]["agent"]["iterations"] == 0
    assert any("time budget exhausted" in n for n in result["notes"])


class CancellingProvider(LLMProvider):
    def __init__(self, cancel_event):
        self.cancel_event = cancel_event

    def complete(self, *, system, messages, tools, timeout_seconds) -> ProviderResponse:
        self.cancel_event.set()
        return ProviderResponse(
            text=None,
            tool_calls=[],
            stop_reason="tool_use",
        )


def test_cancel_between_iterations_returns_aborted_best():
    state = _two_clinician_state()
    cancel = MockCancelEvent()
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
    ]

    class CancelAfterFirst(MockProvider):
        def complete(self, **kwargs):
            response = super().complete(**kwargs)
            cancel.set()
            return response

    result = agent_solve_range(
        _payload(),
        state,
        cancel,
        ProgressRecorder(),
        time.time(),
        provider=CancelAfterFirst(script),
        config=_config(),
    )
    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert len(result["assignments"]) == 1  # best-so-far == seed


def test_determinism_same_script_same_output():
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        {"text": "done"},
    ]
    results = []
    for _ in range(2):
        results.append(
            agent_solve_range(
                _payload(),
                _two_clinician_state(),
                MockCancelEvent(),
                ProgressRecorder(),
                time.time(),
                provider=MockProvider([dict(s) for s in script]),
                config=_config(),
            )
        )
    a, b = results
    assert a["assignments"] == b["assignments"]
    assert a["notes"] == b["notes"]
