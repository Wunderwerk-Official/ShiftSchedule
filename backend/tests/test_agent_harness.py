"""In-process tests for the agent harness loop, driven by MockProvider."""

from __future__ import annotations

import json
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
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(), time.time(),
        provider=provider, config=_config(),
    )
    agent = result["debugInfo"]["agent"]
    assert agent["strategy"] == "day_by_day"
    assert agent["moves_accepted"] == 2
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


def test_day_by_day_zero_moves_never_returns_an_empty_plan():
    """An empty day-by-day result would WIPE the range's previous solver
    plan when applied — every zero-progress exit (no time for a single
    call, first-call LLM error) must return the heuristic draft instead."""

    # (a) Time budget too short for any call.
    state = _two_day_state()
    payload = _payload(endISO=TUE, timeout_seconds=1.0)
    payload.agent_strategy = "day_by_day"
    result = agent_solve_range(
        payload, state, MockCancelEvent(), ProgressRecorder(),
        time.time() - 100.0,  # deadline already passed
        provider=MockProvider(), config=_config(),
    )
    assert len(result["assignments"]) == 2  # heuristic filled both days
    assert result["debugInfo"]["solver_status"] == "AGENT_FALLBACK_SEED"
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


def test_iteration_budget_scales_with_slot_count():
    """Admin rule: the iteration budget is total slot instances x 10,
    superseding the configured flat cap — here: 2 slots -> 20 iterations."""
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
    assert unsolved == {
        "open_slots": [],
        "short_days": [],
        "overlong_days": [],
        "outside_preferred_times": [],
    }


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
    them — here it places the slot the day conversation left open."""
    from .conftest import make_template_slot

    state = make_app_state(
        clinicians=[
            make_clinician("clin-1", "Alice"),
            make_clinician("clin-2", "Bob"),
        ],
        slots=[
            make_template_slot(slot_id="slot-a__mon", col_band_id="col-mon-1",
                               start_time="08:00", end_time="16:00"),
            make_template_slot(slot_id="slot-b__mon", col_band_id="col-mon-1",
                               start_time="16:00", end_time="18:00"),
        ],
    )
    script = [
        # Day conversation: places one slot, then (prematurely) closes the day.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-a__mon__{MON}",
             "clinicianId": "Alice"},
        ]}}]},
        {"text": "Day done."},
        # Range review: sees the open slot in the digest and fixes it.
        {"tool_calls": [{"name": "apply_moves", "arguments": {"moves": [
            {"action": "assign", "slot_key": f"slot-b__mon__{MON}",
             "clinicianId": "Bob"},
        ]}}]},
        {"text": "Review done: filled the remaining open slot."},
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
        n.startswith("Final range review: 1 additional change") for n in result["notes"]
    )
    assert any(n.startswith("No unresolved issues") for n in result["notes"])
