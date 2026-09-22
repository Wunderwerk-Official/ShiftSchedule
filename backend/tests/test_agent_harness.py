"""In-process tests for the agent harness loop, driven by MockProvider."""

from __future__ import annotations

import json
import time

import pytest

from backend.agent.config import AgentConfig
from backend.agent.harness import agent_solve_range
from backend.agent.mock_provider import MockProvider
from backend.agent.provider import LLMProvider, ProviderResponse, ToolCall
from backend.models import SolveRangeRequest

from .conftest import make_app_state, make_assignment, make_clinician, make_template_slot


class ResponseProvider(LLMProvider):
    def __init__(self, responses):
        self.responses = iter(responses)

    def complete(self, **kwargs):
        return next(self.responses, ProviderResponse(text=None, tool_calls=[], stop_reason="end_turn"))

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
    # Most tests here exercise the REPAIR loop explicitly — since v1.38 the
    # harness defaults to day_by_day, so the strategy must be named.
    defaults = dict(
        startISO=MON, endISO=MON, only_fill_required=True,
        timeout_seconds=60.0, agent_strategy="repair",
    )
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


@pytest.fixture
def seed_with_optional_capacity(monkeypatch):
    """Exercise the repair loop with an intentionally improvable valid seed.

    The real heuristic now fills optional capacity itself; repair-loop/event
    tests should not depend on an earlier heuristic's underfilling bug.
    """
    def controlled_seed(payload, state, cancel_event, on_progress, start_time):
        assert payload.only_fill_required is False
        return {
            "startISO": payload.startISO, "endISO": payload.endISO,
            "assignments": [make_assignment("seed-alice", "slot-a__mon", MON,
                                             "clin-1", source="solver").model_dump()],
            "notes": [],
        }

    monkeypatch.setattr("backend.agent.harness.heuristic_solve_range_v2", controlled_seed)


def test_long_model_text_is_complete_in_live_events_and_saved_log():
    answer = "\nANSWER START Äé🩺\n" + "complete answer\n" * 3000 + "ANSWER END\n"
    reasoning = "REASONING START\n" + "complete reasoning\n" * 3000 + "REASONING END"
    progress = ProgressRecorder()
    result = agent_solve_range(_payload(), _two_clinician_state(), MockCancelEvent(), progress,
                              time.time(), config=_config(), provider=ResponseProvider([
                                  ProviderResponse(text=answer, reasoning=reasoning, tool_calls=[], stop_reason="end_turn")]))
    thoughts = [data for kind, data in progress.events if kind == "agent" and data["kind"] == "thought"]
    assert [row["text"] for row in thoughts] == [reasoning, answer]
    assert not any(row["output_truncated"] for row in thoughts)
    assert result["debugInfo"]["agent"]["thoughts"] == [
        f"[iteration 1] (reasoning) {reasoning}", f"[iteration 1] {answer}"]


def test_saved_log_keeps_model_responses_after_the_eightieth_entry(monkeypatch):
    # Keep this transport/log test running past the old cap independently of
    # the idle-search guard (which is covered by its own scheduling tests).
    monkeypatch.setattr("backend.agent.harness.ProgressGuard.observe", lambda *_: "continue")
    responses = [ProviderResponse(text=f"Answer {i}", reasoning=f"Reasoning {i}",
                                  tool_calls=[ToolCall(str(i), "get_plan_overview", {})], stop_reason="tool_use")
                 for i in range(1, 42)]
    # Five weekly instances give the harness a budget beyond 41 responses.
    result = agent_solve_range(_payload(endISO="2026-02-02"), _two_clinician_state(), MockCancelEvent(), ProgressRecorder(),
                              time.time(), config=_config(max_iterations=42), provider=ResponseProvider(responses))
    thoughts = result["debugInfo"]["agent"]["thoughts"]
    assert len(thoughts) == 82
    assert thoughts[0] == "[iteration 1] (reasoning) Reasoning 1"
    assert thoughts[-1] == "[iteration 41] Answer 41"


def test_provider_response_limit_is_explicit_in_live_events_and_saved_log():
    text = "All received text, including an unfinished sen"
    for stop, tool_calls in [("max_tokens", []), ("tool_use", [ToolCall("c", "get_plan_overview", {})])]:
        progress = ProgressRecorder()
        result = agent_solve_range(_payload(), _two_clinician_state(), MockCancelEvent(), progress,
                                  time.time(), config=_config(), provider=ResponseProvider([
                                      ProviderResponse(text=text, tool_calls=tool_calls, stop_reason=stop,
                                                       output_truncated=stop == "tool_use")]))
        thought = next(d for kind, d in progress.events if kind == "agent" and d["kind"] == "thought")
        assert thought["text"] == text
        assert thought["output_truncated"] is True
        log = result["debugInfo"]["agent"]["thoughts"]
        assert "Model reached its response limit" in log[0]
        assert log[1] == f"[iteration 1] {text}"


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


def test_agent_move_improves_plan_and_emits_solution(seed_with_optional_capacity):
    # Distribute-all gives the controlled seed +1 capacity. Alice is already
    # assigned; assigning her again is rejected, while adding Bob must improve
    # the actual quality score and emit a fresh solution.
    state = _two_clinician_state()
    slot_key = f"slot-a__mon__{MON}"
    script = [
        {"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]},
        # The controlled seed already assigned Alice, while Bob remains free.
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
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time()
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("Agent LLM unavailable" in n for n in result["notes"])
    assert len(result["assignments"]) == 1


def test_iteration_budget_is_honored():
    """The budget follows the admin rule (slot instances x 10, floor 10) and
    supersedes any configured flat cap — here: 1 slot -> 10 iterations."""
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
    assert result["debugInfo"]["agent"]["iterations"] == 10
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


def test_agent_activity_events_flow_through_progress(seed_with_optional_capacity):
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
    assert kinds.index("tool_start") < kinds.index("moves_applied") < kinds.index("tool_result")
    assert [e["sequence"] for e in agent_events] == list(range(1, len(agent_events) + 1))
    assert all(e["stage"] == "improve" for e in agent_events if e["kind"] == "tool_start")
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


def test_clinician_wishes_pass_through_to_the_digest():
    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Dr. Tom Braun",
                           planning_wishes="Prefers early shifts; no Fridays."),
            make_clinician("clin-2", "Dr. Anna Becker"),
        ]
    )
    provider = CapturingProvider()
    agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    digest = provider.seen_messages[0][0].content
    assert "CLINICIAN WISHES" in digest
    assert "Dr. Tom Braun: Prefers early shifts; no Fridays." in digest
    # Only clinicians WITH a wish get a bullet.
    assert "Dr. Anna Becker:" not in digest.split("CLINICIAN WISHES")[1]


def test_no_wishes_means_no_wishes_block():
    state = _two_clinician_state()
    provider = CapturingProvider()
    agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert "CLINICIAN WISHES" not in provider.seen_messages[0][0].content


def test_clinician_wishes_reach_every_day_conversation():
    """day_by_day opens a fresh conversation per day — the wishes block
    must travel with EACH day digest, not just the first."""
    from .conftest import make_template_slot

    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice", planning_wishes="Late starts please."),
            make_clinician("clin-2", "Bob"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot(slot_id="slot-b__tue", col_band_id="col-tue-1"),
        ],
    )
    script = [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Alice"}]}}]},
        {"text": "Day 1 done."},
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-b__tue__2026-01-06",
             "clinicianId": "Bob"}]}}]},
        {"text": "Day 2 done."},
    ]
    provider = CapturingProvider(script)
    payload = _payload(endISO="2026-01-06")
    payload.agent_strategy = "day_by_day"
    agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    day1_digest = provider.seen_messages[0][0].content
    day2_digest = provider.seen_messages[2][0].content
    assert "Late starts please." in day1_digest
    assert "Late starts please." in day2_digest


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


def test_in_range_solver_assignments_are_replaced_not_fixed():
    """Previous solver output inside the range is replan material: it must
    not sit in the fixed set (double-booking the seed) — real practice data
    produced 29 duplicate drafts before this rule."""
    from backend.models import Assignment

    state = _two_clinician_state()
    state.assignments = list(state.assignments) + [
        Assignment(id="old-solver", rowId="slot-a__mon", dateISO=MON,
                   clinicianId="clin-1", source="solver"),
        Assignment(id="manual-keep", rowId="slot-a__mon", dateISO=MON,
                   clinicianId="clin-2", source="manual"),
    ]
    provider = CapturingProvider()
    result = agent_solve_range(
        _payload(), state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    # The old solver assignment was dropped from the fixed context and the
    # slot re-planned; the manual one stays fixed (never in the agent's
    # returned assignments) and no returned row carries the old id.
    assert all(a["id"] != "old-solver" for a in result["assignments"])
    returned = {(a["rowId"], a["clinicianId"]) for a in result["assignments"]}
    assert ("slot-a__mon", "clin-2") not in returned


# ---------------------------------------------------------------------------
# Day-by-day strategy
# ---------------------------------------------------------------------------

TUE = "2026-01-06"


def _two_day_state():
    from .conftest import make_template_slot

    return make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice"),
            make_clinician("clin-2", "Bob"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot(slot_id="slot-b__tue", col_band_id="col-tue-1"),
        ],
    )


def test_day_by_day_runs_one_conversation_per_day():
    """Each day gets a FRESH conversation (day digest as the only user
    message) and the working copy carries across days."""
    state = _two_day_state()
    script = [
        # Day 1: inspect priorities, place Alice, declare the day done.
        {"tool_calls": [{"name": "get_day_priorities", "arguments": {"dateISO": MON}}]},
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"}]}}]},
        {"text": "Day 1 staffed."},
        # Day 2: place Bob, done.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-b__tue__{TUE}", "clinicianId": "Bob"}]}}]},
        {"text": "Day 2 staffed."},
    ]
    provider = CapturingProvider(script)
    payload = _payload(endISO=TUE)
    payload.agent_strategy = "day_by_day"
    progress = ProgressRecorder()
    result = agent_solve_range(
        payload, state, MockCancelEvent(), progress, time.time(),
        provider=provider, config=_config(),
    )
    agent = result["debugInfo"]["agent"]
    assert agent["strategy"] == "day_by_day"
    assert agent["moves_accepted"] == 2
    live = [data for kind, data in progress.events if kind == "agent"]
    second_day = next(e for e in live if e["kind"] == "iteration" and e.get("planning_date") == TUE)
    assert second_day["day_index"] == 2 and second_day["total_days"] == 2
    assert any(e.get("phase_label") == "Verify the final plan and remaining gaps" for e in live)
    assert {(a["rowId"], a["clinicianId"]) for a in result["assignments"]} == {
        ("slot-a__mon", "clin-1"),
        ("slot-b__tue", "clin-2"),
    }
    assert any("day-by-day" in n for n in result["notes"])
    # No heuristic seed: the empty start counts every position as open, so
    # filling both is a measured improvement.
    assert any("improved over the seed" in n for n in result["notes"])
    # Fresh conversation per day: the first message of the first call is the
    # day-1 digest; the day-2 conversation starts over with a new digest.
    first_day1 = provider.seen_messages[0][0].content
    first_day2 = provider.seen_messages[3][0].content
    assert "Build day 1 of 2" in first_day1 and MON in first_day1
    assert "Build day 2 of 2" in first_day2 and TUE in first_day2
    assert len(provider.seen_messages[3]) == 1  # history did not carry over
    # The day-2 digest reports what day 1 achieved.
    assert "Days already built in this run" in first_day2


def test_day_by_day_is_default_and_repair_stays_selectable():
    """day_by_day is the STANDARD since v1.38 (a payload without a strategy
    gets it); 'repair' remains reachable for benchmarks/API calls and keeps
    its own tool list without the day-only tools."""
    from backend.agent.harness import DAY_TOOL_SPECS, TOOL_SPECS

    repair_names = {t.name for t in TOOL_SPECS}
    day_names = {t.name for t in DAY_TOOL_SPECS}
    assert "get_day_priorities" not in repair_names
    assert "suggest_day_blocks" not in repair_names
    assert "suggest_rescue_moves" not in repair_names
    assert {"get_day_priorities", "suggest_day_blocks", "suggest_rescue_moves"} <= day_names

    default_payload = _payload()
    default_payload.agent_strategy = None
    script = [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Alice"}]}}]},
        {"text": "Day complete."},
    ]
    result = agent_solve_range(
        default_payload, _two_clinician_state(), MockCancelEvent(),
        ProgressRecorder(), time.time(),
        provider=MockProvider(script), config=_config(),
    )
    assert result["debugInfo"]["agent"]["strategy"] == "day_by_day"

    result_repair = agent_solve_range(
        _payload(), _two_clinician_state(), MockCancelEvent(),
        ProgressRecorder(), time.time(),
        provider=MockProvider(), config=_config(),
    )
    assert result_repair["debugInfo"]["agent"]["strategy"] == "repair"


def test_day_by_day_budget_exhausted_falls_back_to_heuristic():
    """Day mode has no draft to return when the LLM cannot start — it must
    fall back to a fresh heuristic plan instead of an empty range."""
    state = _two_day_state()
    payload = _payload(endISO=TUE)
    payload.agent_strategy = "day_by_day"
    payload.agent_budget_exhausted = True
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=MockProvider(), config=_config(),
    )
    assert any("AI budget" in n for n in result["notes"])
    # The heuristic filled both required slots.
    assert len(result["assignments"]) == 2


def test_fallback_preserves_paid_usage_and_reports_the_returned_heuristic_plan():
    from backend.agent_budget import estimate_cost_usd
    from backend.models import Assignment
    from backend.scoring import build_scoring_context, plan_stats

    state = _two_day_state()
    provider = ResponseProvider([
        ProviderResponse(text="Still thinking.", replay_text="Still thinking.", tool_calls=[], stop_reason="end_turn",
                         usage={"input_tokens": 500, "output_tokens": 50, "cache_read_input_tokens": 20}),
        ProviderResponse(text=None, tool_calls=[], stop_reason="error", error="Invalid model", error_status=400),
        ProviderResponse(text=None, tool_calls=[], stop_reason="error", error="Invalid model", error_status=400),
    ])
    result = agent_solve_range(_payload(endISO=TUE, agent_strategy="day_by_day"), state,
                              MockCancelEvent(), ProgressRecorder(), time.time(), provider=provider,
                              config=_config(model="claude-sonnet-5"))
    agent = result["debugInfo"]["agent"]
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert agent["result_producer"] == "heuristic_v2"
    assert agent["fallback"]["model_stop_reason"] == "provider_error"
    assert agent["input_tokens"] == 500 and agent["output_tokens"] == 50
    assert agent["cache_read_input_tokens"] == 20
    assert estimate_cost_usd(agent["model"], agent) > 0
    assignments = [Assignment.model_validate(a) for a in result["assignments"]]
    expected = plan_stats(build_scoring_context(state, MON, TUE, only_fill_required=True), assignments).model_dump()
    assert agent["stats"] == expected
    assert agent["stats"]["open_slots"] == 0
    assert agent["completion"]["coverage_complete"] is True
    assert agent["completion"]["required_checks_complete"] is False
    assert not any("returning an empty plan" in note for note in result["notes"])


def test_invalid_parsed_tool_call_gets_error_and_can_be_corrected():
    invalid = ToolCall("broken", "apply_moves", {}, argument_error="Tool arguments contain invalid JSON.",
                       raw_arguments='{"moves":')
    valid = ToolCall("fixed", "apply_moves", {"moves": [
        {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "Alice"},
    ]})

    class RecoveringProvider(ResponseProvider):
        def complete(self, **kwargs):
            if len(kwargs["messages"]) > 1:
                results = [r for message in kwargs["messages"] for r in message.tool_results]
                if results and results[-1].tool_call_id == "broken":
                    assert results[-1].is_error
                    assert "invalid JSON" in results[-1].content
            return super().complete(**kwargs)

    result = agent_solve_range(_payload(agent_strategy="day_by_day"), _two_clinician_state(),
                              MockCancelEvent(), ProgressRecorder(), time.time(), config=_config(),
                              provider=RecoveringProvider([
                                  ProviderResponse(text=None, tool_calls=[invalid], stop_reason="tool_use"),
                                  ProviderResponse(text=None, tool_calls=[valid], stop_reason="tool_use"),
                              ]))
    assert [a["clinicianId"] for a in result["assignments"]] == ["clin-1"]
    assert result["debugInfo"]["agent"]["moves_accepted"] == 1


def test_day_by_day_fallback_respects_deadline_and_fills_when_time_remains():
    """Fallback uses the run's remaining time, never a new time budget."""

    # (a) Time budget too short for any call.
    state = _two_day_state()
    payload = _payload(endISO=TUE, timeout_seconds=1.0)
    payload.agent_strategy = "day_by_day"
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(),
        time.time() - 100.0,  # deadline already passed
        provider=MockProvider(), config=_config(),
    )
    assert result["assignments"] == []
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert result["debugInfo"]["agent"]["stats"]["open_slots"] == 2
    assert result["debugInfo"]["agent"]["fallback"]["model_stop_reason"] == "budget_exhausted"
    assert any("could not apply any changes" in n for n in result["notes"])

    # (b) Provider error on the very first call.
    state2 = _two_day_state()
    payload2 = _payload(endISO=TUE)
    payload2.agent_strategy = "day_by_day"

    class FirstCallError(LLMProvider):
        def complete(self, **kwargs) -> ProviderResponse:
            return ProviderResponse(
                text=None, tool_calls=[], stop_reason="error", error="boom"
            )

    result2 = agent_solve_range(
        payload2, state2, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=FirstCallError(), config=_config(),
    )
    assert len(result2["assignments"]) == 2
    assert result2["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
    assert any("LLM error" in n for n in result2["notes"])


def test_day_by_day_pipelined_turn_gets_post_apply_suggestion():
    """The prompt's step-4 pipeline: apply_moves and suggest_day_blocks in
    ONE response, in that order. The suggestion must be computed AFTER the
    batch applied — here the batch staffs the day's only slot, so the same
    turn's suggestion already reports day_complete."""
    state = _two_day_state()
    script = [
        {"tool_calls": [
            {"name": "apply_moves", "arguments": {"moves": [
                {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
                 "clinicianId": "Alice"}]}},
            {"name": "suggest_day_blocks", "arguments": {"dateISO": MON}},
        ]},
        {"text": "Day 1 complete."},
        {"tool_calls": [
            {"name": "apply_moves", "arguments": {"moves": [
                {"action": "assign", "slot_key": f"slot-b__tue__{TUE}",
                 "clinicianId": "Bob"}]}},
            {"name": "suggest_day_blocks", "arguments": {"dateISO": TUE}},
        ]},
        {"text": "Day 2 complete."},
    ]
    provider = CapturingProvider(script)
    payload = _payload(endISO=TUE)
    payload.agent_strategy = "day_by_day"
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert result["debugInfo"]["agent"]["moves_accepted"] == 2
    assert len(result["assignments"]) == 2
    # The 2nd call of day 1 sees [digest, assistant, tool results]; the
    # suggest result (2nd tool call of the turn) reflects the applied batch.
    day1_tool_msg = provider.seen_messages[1][-1]
    suggestion = json.loads(day1_tool_msg.tool_results[1].content)
    assert suggestion["day_complete"] is True
    assert suggestion["unfillable_slots"] == []


def test_duty_pre_pass_runs_before_day_planning():
    """With on-call duties in the range, a duty pre-pass conversation staffs
    them FIRST (its own digest, DUTY prompt), and only then the per-day
    conversations start — duties placed last starved on weekly hours."""
    from .conftest import make_template_slot, make_workplace_row, make_pool_row
    from backend.models import TemplateBlock

    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice",
                           qualified_class_ids=["section-a", "section-oc"],
                           working_hours_per_week=40),
            make_clinician("clin-2", "Bob",
                           qualified_class_ids=["section-a", "section-oc"],
                           working_hours_per_week=40),
        ],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-oc", "On Call"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-oc__mon", col_band_id="col-mon-1",
                               block_id="block-oc",
                               start_time="19:00", end_time="07:00",
                               end_day_offset=1),
        ],
        solver_settings={
            "onCallRestEnabled": True,
            "onCallRestClassId": "section-oc",
            "onCallRestDaysBefore": 0,
            "onCallRestDaysAfter": 0,
        },
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-oc", sectionId="section-oc", requiredSlots=0)
    )
    script = [
        # Duty pass: one round staffs the on-call duty.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-oc__mon__{MON}",
             "clinicianId": "Alice"}]}}]},
        # Day conversation: staff the ordinary slot, then done.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Bob"}]}}]},
        {"text": "Day complete."},
    ]
    provider = CapturingProvider(script)
    payload = _payload()
    payload.agent_strategy = "day_by_day"
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert result["debugInfo"]["agent"]["moves_accepted"] == 2
    duty_digest = provider.seen_messages[0][0].content
    assert "Duty pre-pass" in duty_digest
    assert "Open duty slots" in duty_digest
    # The duty pass ended as soon as every duty was staffed (no extra
    # round), so the SECOND conversation is the day-1 digest and reports
    # the pre-pass result.
    day_digest = provider.seen_messages[1][0].content
    assert "Build day 1 of 1" in day_digest
    assert "duty pre-pass: 1 of 1" in day_digest


def test_iteration_budget_scales_with_slot_count(monkeypatch):
    """Admin rule: the iteration budget is total slot instances x 10,
    superseding the configured flat cap — here: 2 slots -> 20 iterations."""
    # Exercise the outer budget independently of the no-progress guard.
    monkeypatch.setattr("backend.agent.progress.ProgressGuard.observe", lambda *_: "continue")
    state = _two_day_state()  # 2 slot instances -> budget 20
    endless = [{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}] * 50
    result = agent_solve_range(
        _payload(endISO=TUE), state, MockCancelEvent(), ProgressRecorder(),
        time.time(),
        provider=MockProvider(endless), config=_config(max_iterations=999),
    )
    assert result["debugInfo"]["agent"]["iterations"] == 20
    assert any("iteration budget exhausted" in n for n in result["notes"])


def test_fully_staffed_day_is_skipped_without_a_conversation():
    """A day with zero open positions (fixed assignments or duty pre-pass
    covered it) must not start a conversation — the observed runs burned
    2-3 rounds per already-complete day just confirming emptiness."""
    from .conftest import make_assignment

    state = _two_day_state()
    # Monday's only slot is already covered by a manual assignment.
    state.assignments = [make_assignment("m1", "slot-a__mon", MON, "clin-1")]
    script = [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-b__tue__{TUE}",
             "clinicianId": "Bob"}]}}]},
        {"text": "Day 2 complete."},
    ]
    provider = CapturingProvider(script)
    payload = _payload(endISO=TUE)
    payload.agent_strategy = "day_by_day"
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    assert result["debugInfo"]["agent"]["moves_accepted"] == 1
    # The FIRST conversation is already day 2; day 1 was skipped and the
    # digest says so.
    first = provider.seen_messages[0][0].content
    assert "Build day 2 of 2" in first
    assert f"{MON}: already fully staffed, skipped" in first


def test_finalize_reports_unsolved_overview():
    """The closing report (admin request): a run that leaves a required slot
    open must say so in the notes AND in debugInfo.agent.unsolved — that is
    what the run log and the run inbox surface."""
    from backend.models import TemplateBlock
    from .conftest import make_pool_row, make_template_slot, make_workplace_row

    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice",
                                   qualified_class_ids=["section-a"],
                                   working_hours_per_week=40)],
        rows=[
            make_workplace_row(),
            make_workplace_row("section-b", "Section B"),
            make_pool_row("pool-rest-day", "Rest Day"),
            make_pool_row("pool-vacation", "Vacation"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1"),
            make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                               block_id="block-b",
                               start_time="09:00", end_time="13:00"),
        ],
    )
    state.weeklyTemplate.blocks.append(
        TemplateBlock(id="block-b", sectionId="section-b", requiredSlots=0)
    )
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider([{"text": "Seed accepted."}]),
        config=_config(),
    )
    # Nobody is qualified for Section B: its slot stays open.
    summary = next(
        n for n in result["notes"] if n.startswith("Unresolved after this run:")
    )
    assert "1 open slot(s)" in summary
    unsolved = result["debugInfo"]["agent"]["unsolved"]
    assert len(unsolved["open_slots"]) == 1
    assert unsolved["open_slots"][0]["section"] == "Section B"
    assert any("open: " in n and "Section B" in n for n in result["notes"])
    # Alice works one full 8h day: no short or over-long days reported.
    assert unsolved["short_days"] == []
    assert unsolved["overlong_days"] == []


def test_finalize_reports_all_clear_when_nothing_unsolved():
    state = _two_clinician_state()
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider([{"text": "Seed accepted."}]),
        config=_config(),
    )
    assert any(n.startswith("No unresolved issues") for n in result["notes"])
    unsolved = result["debugInfo"]["agent"]["unsolved"]
    assert {key: unsolved[key] for key in (
        "open_slots", "short_days", "overlong_days", "outside_preferred_times"
    )} == {
        "open_slots": [],
        "short_days": [],
        "overlong_days": [],
        "outside_preferred_times": [],
    }
    assert unsolved["quality_metrics"]["structured_wish_violations"] == 0


def test_unsolved_overview_counts_placements_outside_preferred_times():
    """The closing report lists placements outside someone's PREFERRED
    working time (the wish; mandatory windows can never be violated)."""
    from backend.models import PreferredWorkingTime

    state = _two_clinician_state()
    # Alice prefers 08:00-12:00 on Mondays; the default slot runs 08-16.
    state.clinicians[0].preferredWorkingTimes = {
        "mon": PreferredWorkingTime(
            startTime="08:00", endTime="12:00", requirement="preference"
        )
    }
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider([{"text": "Seed accepted."}]),
        config=_config(),
    )
    unsolved = result["debugInfo"]["agent"]["unsolved"]
    if unsolved["outside_preferred_times"]:
        entry = unsolved["outside_preferred_times"][0]
        assert entry["clinician"] == "Alice"
        assert entry["preferred"] == "08:00-12:00"
        assert any(
            "outside preferred time" in n for n in result["notes"]
        )
    else:
        # The seed picked Bob (no wish) - then the report must be all clear.
        assert any(n.startswith("No unresolved issues") for n in result["notes"])


def test_day_by_day_runs_final_range_review():
    """After the last day the harness opens ONE more conversation over the
    whole range (admin request): it sees the remaining issues and may fix
    them — here it joins two half-days into one continuous full day."""
    from .conftest import make_template_slot

    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice"),
            make_clinician("clin-2", "Bob"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="12:00"),
            make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                               start_time="12:00", end_time="16:00"),
        ],
    )
    script = [
        # Day conversation covers both required slots.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Alice"},
            {"action": "assign", "slot_key": f"slot-b__mon__{MON}", "clinicianId": "Bob"},
        ]}}]},
        {"text": "Day done."},
        # Range review keeps coverage and joins the adjacent half-days.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "unassign", "slot_key": f"slot-b__mon__{MON}", "clinicianId": "Bob"},
            {"action": "assign", "slot_key": f"slot-b__mon__{MON}", "clinicianId": "Alice"},
        ]}}]},
        {"text": "Review done: joined the half-days."},
    ]
    progress = ProgressRecorder()
    result = agent_solve_range(
        _payload(agent_strategy=None),
        state,
        MockCancelEvent(),
        progress,
        time.time(),
        provider=MockProvider(script),
        config=_config(max_iterations=40),
    )
    assert result["debugInfo"]["solver_status"] == "AGENT_COMPLETE"
    assert len(result["assignments"]) == 2
    assert any(
        n.startswith("Final range review: 2 additional change") for n in result["notes"]
    )
    assert any(n.startswith("No unresolved issues") for n in result["notes"])


def test_final_review_bounds_fresh_searches_without_changing_the_retained_plan():
    state = make_app_state()
    script = [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}", "clinicianId": "clin-1"},
        ]}}]}, {"text": "Day complete."},
    ] + [{"tool_calls": [{"name": name, "arguments": {"dateISO": MON}}]}
         for name in ["analyze_bottlenecks", "explain_unfilled", "suggest_rescue_moves", "suggest_balance_moves"]] * 3
    provider = MockProvider(script)
    result = agent_solve_range(_payload(agent_strategy="day_by_day"), state,
                              MockCancelEvent(), ProgressRecorder(), time.time(),
                              provider=provider, config=_config(max_iterations=40))
    assert provider.turn == 6  # two construction rounds and four review rounds
    assert len(result["assignments"]) == 1
    assert result["debugInfo"]["agent"]["daysIncomplete"] == []
    assert any("unsearched improvements may remain" in n for n in result["notes"])


def test_cancel_during_final_review_generation_keeps_pre_abort_plan():
    from backend.agent.prompts import REVIEW_SYSTEM_PROMPT

    cancel = MockCancelEvent()
    slot_key = f"slot-a__mon__{MON}"

    class CancelInReview(MockProvider):
        def complete(self, **kwargs):
            if kwargs["system"] == REVIEW_SYSTEM_PROMPT:
                cancel.set()
                return ProviderResponse(text=None, stop_reason="tool_use", tool_calls=[
                    ToolCall("swap", "apply_moves", {"moves": [
                        {"action": "unassign", "slot_key": slot_key, "clinicianId": "Alice"},
                        {"action": "assign", "slot_key": slot_key, "clinicianId": "Bob"},
                    ]}),
                ])
            return super().complete(**kwargs)

    provider = CancelInReview([
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": slot_key, "clinicianId": "Alice"},
        ]}}]}, {"text": "Day complete."},
    ])
    result = agent_solve_range(_payload(agent_strategy="day_by_day"), _two_clinician_state(),
                              cancel, ProgressRecorder(), time.time(), provider=provider, config=_config())
    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert result["debugInfo"]["agent"]["stopReason"] == "aborted"
    assert [a["clinicianId"] for a in result["assignments"]] == ["clin-1"]


def test_cancel_during_final_review_tool_batch_stops_before_next_tool():
    cancel = MockCancelEvent()
    slot_key = f"slot-a__mon__{MON}"
    progress = ProgressRecorder()

    def cancel_after_inspection(event_type, data):
        progress(event_type, data)
        if event_type == "agent" and data.get("kind") == "tool_result" and data.get("tool") == "get_plan_overview":
            cancel.set()

    provider = MockProvider([
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": slot_key, "clinicianId": "Alice"},
        ]}}]}, {"text": "Day complete."},
        {"tool_calls": [
            {"name": "get_plan_overview", "arguments": {}},
            {"name": "apply_moves", "arguments": {"moves": [
                {"action": "unassign", "slot_key": slot_key, "clinicianId": "Alice"},
                {"action": "assign", "slot_key": slot_key, "clinicianId": "Bob"},
            ]}},
        ]},
    ])
    result = agent_solve_range(_payload(agent_strategy="day_by_day"), _two_clinician_state(),
                              cancel, cancel_after_inspection, time.time(), provider=provider, config=_config())
    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert result["debugInfo"]["agent"]["moves_accepted"] == 1
    assert [a["clinicianId"] for a in result["assignments"]] == ["clin-1"]


def test_cancel_during_text_only_response_is_reported_as_aborted():
    cancel = MockCancelEvent()

    class CancelOnCompletion(MockProvider):
        def complete(self, **kwargs):
            response = super().complete(**kwargs)
            cancel.set()
            return response

    result = agent_solve_range(_payload(), _two_clinician_state(), cancel,
                              ProgressRecorder(), time.time(),
                              provider=CancelOnCompletion([{"text": "Done."}]), config=_config())
    assert result["debugInfo"]["solver_status"] == "ABORTED"
    assert result["debugInfo"]["agent"]["stopReason"] == "aborted"


def test_final_review_last_chance_can_apply_a_useful_joint_change():
    from .conftest import make_template_slot
    state = make_app_state(clinicians=[make_clinician("a", "Alice"), make_clinician("b", "Bob")], slots=[
        make_template_slot("first", start_time="08:00", end_time="12:00"),
        make_template_slot("second", start_time="12:00", end_time="16:00"),
    ])
    script = [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"first__{MON}", "clinicianId": "Alice"},
            {"action": "assign", "slot_key": f"second__{MON}", "clinicianId": "Bob"},
        ]}}]}, {"text": "Day complete."},
    ] + [{"tool_calls": [{"name": "get_plan_overview", "arguments": {}}]}] * 3 + [
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "unassign", "slot_key": f"second__{MON}", "clinicianId": "Bob"},
            {"action": "assign", "slot_key": f"second__{MON}", "clinicianId": "Alice"},
        ]}}]}, {"text": "Joint change complete."},
    ]
    provider = MockProvider(script)
    result = agent_solve_range(_payload(agent_strategy="day_by_day"), state,
                              MockCancelEvent(), ProgressRecorder(), time.time(),
                              provider=provider, config=_config(max_iterations=40))
    assert provider.turn == 7
    assert any(n.startswith("Final range review: 2 additional change") for n in result["notes"])
    assert not any("unsearched improvements may remain" in n for n in result["notes"])


class SlowGeneratingProvider(LLMProvider):
    """Each call takes measurable wall time and reports output tokens, so the
    harness can compute a non-zero generation speed."""

    def __init__(self, delay_s: float = 0.05, out_tokens: int = 40):
        self.calls = 0
        self._delay = delay_s
        self._out = out_tokens

    def complete(self, *, system, messages, tools, timeout_seconds) -> ProviderResponse:
        self.calls += 1
        time.sleep(self._delay)
        usage = {"input_tokens": 200, "output_tokens": self._out}
        if self.calls == 1:
            return ProviderResponse(
                text=None,
                tool_calls=[ToolCall(id="c1", name="get_plan_overview", arguments={})],
                stop_reason="tool_use",
                usage=usage,
            )
        return ProviderResponse(
            text="done", tool_calls=[], stop_reason="end_turn", usage=usage,
        )


def test_reports_endpoint_generation_speed():
    """debug_info.agent exposes generation_seconds and output_tokens_per_second
    computed from the summed generation time of successful calls."""
    state = _two_clinician_state()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=SlowGeneratingProvider(delay_s=0.05, out_tokens=40),
        config=_config(),
    )
    agent = result["debugInfo"]["agent"]
    # Two calls * 40 output tokens, each ~0.05 s of generation.
    assert agent["output_tokens"] == 80
    assert agent["generation_seconds"] > 0
    tps = agent["output_tokens_per_second"]
    assert tps is not None and tps > 0
    # 80 output tokens over ~0.1 s of generation -> on the order of hundreds
    # (exact value depends on scheduling jitter; generation_seconds is rounded
    # in the payload, so compare loosely rather than to the derived quotient).
    assert 80 / (agent["generation_seconds"] + 0.05) <= tps <= 80 / max(
        agent["generation_seconds"] - 0.05, 1e-6
    )


def test_generation_speed_is_none_when_no_output():
    """A run that produces no output tokens (immediate end) reports None, not a
    divide-by-zero."""
    state = _two_clinician_state()
    result = agent_solve_range(
        _payload(),
        state,
        MockCancelEvent(),
        ProgressRecorder(),
        time.time(),
        provider=MockProvider([]),  # ends immediately, 0 output tokens
        config=_config(),
    )
    assert result["debugInfo"]["agent"]["output_tokens_per_second"] is None


def test_midrun_model_change_keeps_plan_history_and_reports_actual_usage():
    from copy import deepcopy
    from backend.models import Assignment
    from backend.validation import validate_assignments

    flash, replacement = "requested-flash", "replacement-27b"
    fixed = make_assignment("fixed-carol", "slot-a__mon", MON, "clin-3", source="manual")
    state = make_app_state(
        clinicians=[make_clinician("clin-1", "Alice"), make_clinician("clin-2", "Bob"),
                    make_clinician("clin-3", "Carol")],
        slots=[make_template_slot(slot_id="slot-a__mon", required_slots=3)],
        assignments=[fixed],
    )
    original = state.model_dump()
    cancel = MockCancelEvent()
    selection = {"requested_model": flash, "selected_model": flash,
                 "attempts": [{"model": flash, "status": "selected"}]}

    class SwitchingProvider(LLMProvider):
        def __init__(self):
            self.requests = []
            self.responses = []

        def complete(self, **kwargs):
            assert self.cancel_event is cancel
            self.requests.append(deepcopy(kwargs["messages"]))
            turn = len(self.requests)
            if turn == 2:
                selection["selected_model"] = replacement
                selection["attempts"].extend([
                    {"model": flash, "status": "unavailable", "reason": "model_not_found"},
                    {"model": replacement, "status": "selected"},
                ])
            calls = [ToolCall(f"move-{turn}", "apply_moves", {"moves": [{
                "action": "assign", "slot_key": f"slot-a__mon__{MON}",
                "clinicianId": f"clin-{turn}",
            }]})] if turn <= 2 else []
            response = ProviderResponse(
                text=None if calls else "Complete.", tool_calls=calls,
                stop_reason="tool_use" if calls else "end_turn",
                usage={"input_tokens": turn * 100, "output_tokens": turn * 10},
                generation_seconds=float(turn + 1),
            )
            response.model = flash if turn == 1 else replacement
            response.model_selection = deepcopy(selection)
            self.responses.append(response)
            return response

    provider, progress, config = SwitchingProvider(), ProgressRecorder(), _config(model=flash)
    result = agent_solve_range(
        _payload(agent_strategy="day_by_day"), state, cancel, progress,
        time.time(), provider=provider, config=config,
    )
    agent = result["debugInfo"]["agent"]
    assert config.model == flash
    assert agent["requested_model"] == flash and agent["model"] == replacement
    assert agent["model_selection"] == selection
    assert agent["fallback"] is None and agent["result_producer"] == "agent"
    assert agent["moves_accepted"] == 2 and agent["moves_rejected"] == 0
    assert {a["clinicianId"] for a in result["assignments"]} == {"clin-1", "clin-2"}
    assert state.model_dump() == original
    assert validate_assignments(state, state.assignments + [Assignment.model_validate(a)
                               for a in result["assignments"]], only_fill_required=True).is_valid
    # The replacement sees the first model's applied call and result, so it
    # continues the same plan instead of rebuilding or executing it twice.
    history = provider.requests[1]
    assert history[-2].tool_calls[0].id == "move-1"
    assert history[-1].tool_results[0].tool_call_id == "move-1"
    assert json.loads(history[-1].tool_results[0].content)["applied"]
    assert agent["model_usage"][flash]["output_tokens"] == 10
    assert agent["model_usage"][replacement]["output_tokens"] == sum(
        response.usage["output_tokens"] for response in provider.responses[1:]
    )
    assert agent["generation_seconds"] == sum(response.generation_seconds for response in provider.responses)
    switches = [d for kind, d in progress.events if kind == "agent" and d.get("model_change")]
    assert len(switches) == 1
    assert switches[0]["model_change"] == {"from": flash, "to": replacement}
    assert sum("Planning model changed" in note for note in result["notes"]) == 1
    selection["attempts"].clear()
    assert agent["model_selection"]["attempts"]  # a saved result is a snapshot


def test_failed_model_selection_does_not_claim_a_successful_model():
    response = ProviderResponse(text=None, tool_calls=[], stop_reason="error", error="Unavailable")
    response.model = "unavailable-flash"
    response.model_selection = {
        "requested_model": "unavailable-flash", "selected_model": None,
        "attempts": [{"model": "unavailable-flash", "status": "unavailable", "reason": "model_not_found"}],
    }
    result = agent_solve_range(
        _payload(), _two_clinician_state(), MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=ResponseProvider([response]), config=_config(model="unavailable-flash"),
    )
    agent = result["debugInfo"]["agent"]
    assert agent["model"] is None
    assert agent["requested_model"] == "unavailable-flash"
    assert agent["model_selection"] == response.model_selection
    assert agent["model_usage"] == {}
    assert not any("Planning model changed" in note for note in result["notes"])
