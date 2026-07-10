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
    assert any("improved over the seed" in n.lower() for n in result["notes"])
    # Run-log diagnostics: seed gaps, final plan with origins, violations list.
    agent_debug = result["debugInfo"]["agent"]
    # distribute-all seed already covers the required target -> no open slots
    assert agent_debug["open_slots_seed"] == []
    assert any(line.endswith("|agent") for line in agent_debug["final_plan"])
    assert isinstance(agent_debug["violations_final"], list)
    assert agent_debug["thoughts"]


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


def test_agent_activity_events_flow_through_progress():
    state = _two_clinician_state()
    slot_key = f"slot-a__mon__{MON}"
    script = [
        {"text": "Filling the open extra slot.", "tool_calls": [{"name": "apply_moves", "arguments": {
            "moves": [{"action": "assign", "slot_key": slot_key, "clinicianId": "Bob"}]}}]},
        {"text": "Done."},
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
    agent_events = [data for etype, data in progress.events if etype == "agent"]
    kinds = [e["kind"] for e in agent_events]
    # Lifecycle: seed -> improve -> iteration ticks -> applied moves -> finalize
    assert kinds[0] == "stage" and agent_events[0]["stage"] == "seed"
    assert ("stage", "improve") in [(e["kind"], e.get("stage")) for e in agent_events]
    assert "iteration" in kinds
    assert "thought" in kinds
    applied = [e for e in agent_events if e["kind"] == "moves_applied"]
    assert applied and applied[0]["moves"][0]["action"] == "assign"
    # The move description carries the real clinician name for the UI
    assert applied[0]["moves"][0]["clinician"] in ("Alice", "Bob")
    assert kinds[-1] == "stage" and agent_events[-1]["stage"] == "finalize"
    # Aliases resolved: the plan carries real ids
    assert {a["clinicianId"] for a in result["assignments"]} == {"clin-1", "clin-2"}


def test_server_injected_model_wins_and_user_setting_is_ignored():
    state = _two_clinician_state()
    # The model became an admin-only GLOBAL setting, injected into the payload
    # by the solve endpoint. The per-user solverSettings.agentModel relic must
    # be ignored.
    state.solverSettings = {"agentModel": "claude-haiku-4-5"}
    payload = _payload()
    payload.agent_model = "claude-sonnet-5"
    result = agent_solve_range(
        payload,
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider(),
        config=_config(model="claude-opus-4-8"),
    )
    assert result["debugInfo"]["agent"]["model"] == "claude-sonnet-5"


def test_exhausted_budget_skips_llm_and_returns_draft():
    state = _two_clinician_state()
    payload = _payload()
    payload.agent_budget_exhausted = True
    result = agent_solve_range(
        payload,
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider(),
        config=_config(),
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("AI budget" in n for n in result["notes"])
    assert result["debugInfo"]["agent"]["iterations"] == 0


def test_agent_debug_reports_model_and_token_fields():
    state = _two_clinician_state()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider(),
        config=_config(),
    )
    agent = result["debugInfo"]["agent"]
    assert agent["model"] == _config().model
    for key in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                "cache_creation_input_tokens"):
        assert key in agent


class CapturingProvider(MockProvider):
    """MockProvider that records the messages of every complete() call."""

    def __init__(self, script=None):
        super().__init__(script)
        self.seen_messages = []

    def complete(self, *, system, messages, tools, timeout_seconds):
        self.seen_messages.append(list(messages))
        return super().complete(
            system=system, messages=messages, tools=tools,
            timeout_seconds=timeout_seconds,
        )


def test_admin_instructions_pass_through_with_real_names():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Tom Braun"),
            make_clinician("clin-2", "Dr. Anna Becker"),
        ]
    )
    state.solverSettings = {
        "agentInstructions": "braun must never work Fridays; prefer Dr. Anna Becker."
    }
    provider = CapturingProvider()
    agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    digest = provider.seen_messages[0][0].content
    assert "ADMIN INSTRUCTIONS" in digest
    # Instructions pass through verbatim: the LLM works with real names.
    assert "braun must never work Fridays" in digest
    assert "Dr. Anna Becker" in digest


def test_default_instructions_apply_when_unset_and_empty_disables():
    from backend.agent.prompts import DEFAULT_AGENT_INSTRUCTIONS

    state = _two_clinician_state()
    provider = CapturingProvider()
    agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert DEFAULT_AGENT_INSTRUCTIONS[:40] in provider.seen_messages[0][0].content

    state2 = _two_clinician_state()
    state2.solverSettings = {"agentInstructions": "   "}
    provider2 = CapturingProvider()
    agent_solve_range(
        _payload(), state2, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider2, config=_config(),
    )
    assert "ADMIN INSTRUCTIONS" not in provider2.seen_messages[0][0].content


def test_adaptive_thinking_only_for_supported_models():
    from backend.agent.anthropic_provider import supports_adaptive_thinking

    assert supports_adaptive_thinking("claude-opus-4-8")
    assert supports_adaptive_thinking("claude-sonnet-5")
    assert supports_adaptive_thinking("claude-sonnet-4-6")
    assert supports_adaptive_thinking("claude-fable-5")
    # Haiku, older models, and unknown ids must NOT get the thinking param
    assert not supports_adaptive_thinking("claude-haiku-4-5")
    assert not supports_adaptive_thinking("claude-haiku-4-5-20251001")
    assert not supports_adaptive_thinking("claude-sonnet-4-5")
    assert not supports_adaptive_thinking("claude-opus-4-5")
    assert not supports_adaptive_thinking("")
    assert not supports_adaptive_thinking("some-future-model")


def test_tool_use_activity_is_emitted():
    state = _two_clinician_state()
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        {"text": "Done."},
    ]
    progress = ProgressRecorder()
    agent_solve_range(
        _payload(), state, MockCancelEvent(), progress, time.time(),
        provider=MockProvider(script), config=_config(),
    )
    tool_events = [
        data for etype, data in progress.events
        if etype == "agent" and data["kind"] == "tool_use"
    ]
    assert tool_events and tool_events[0]["tools"] == ["get_plan_overview"]


def test_convert_messages_places_cache_breakpoint_on_last_block():
    from backend.agent.anthropic_provider import AnthropicProvider
    from backend.agent.provider import ChatMessage, ToolCall, ToolResult

    convert = AnthropicProvider._convert_messages
    msgs = [
        ChatMessage(role="user", content="digest"),
        ChatMessage(
            role="assistant",
            content=None,
            tool_calls=[ToolCall(id="c1", name="get_plan_overview", arguments={})],
        ),
        ChatMessage(
            role="tool",
            tool_results=[ToolResult("c1", "{}", False)],
        ),
    ]
    out = convert(msgs)
    # only the LAST message's last block carries the cache breakpoint
    assert out[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in out[0]["content"][-1]
    # a digest-only conversation gets the breakpoint on the digest itself
    single = convert([ChatMessage(role="user", content="digest")])
    assert single[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}


def test_tool_history_is_compacted_in_one_chunk():
    from backend.agent.harness import (
        TOOL_HISTORY_BUDGET_CHARS,
        TOOL_RESULT_STUB,
        _compact_tool_history,
    )
    from backend.agent.provider import ChatMessage, ToolResult

    big = "x" * (TOOL_HISTORY_BUDGET_CHARS // 4)
    messages = [ChatMessage(role="user", content="digest")]
    for i in range(8):
        messages.append(ChatMessage(role="assistant", content=None, tool_calls=[]))
        messages.append(
            ChatMessage(role="tool", tool_results=[ToolResult(f"c{i}", big, False)])
        )
    _compact_tool_history(messages)
    tool_msgs = [m for m in messages if m.role == "tool"]
    assert all(r.content == TOOL_RESULT_STUB for m in tool_msgs[:-4] for r in m.tool_results)
    assert all(r.content == big for m in tool_msgs[-4:] for r in m.tool_results)
    # under budget: nothing happens
    small = [ChatMessage(role="tool", tool_results=[ToolResult("c", "tiny", False)])]
    _compact_tool_history(small)
    assert small[0].tool_results[0].content == "tiny"
