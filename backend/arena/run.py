"""Agent test arena: run the agent solver against a hard, realistic state
and print comparable metrics.

The fixture is an anonymized export of a large radiology practice (24
clinicians, 35 sections, 163 weekly template slots, 4 locations) — the
kind of case the agent must eventually handle well.

Runs IN-PROCESS against whatever provider the environment / admin settings
resolve to (same path as the real solver), so executing it inside the
production backend container benchmarks the actual self-hosted model:

    python -m backend.arena.run --start 2026-02-02 --days 1 --timeout 600

No HTTP, no writes: state comes from the fixture, results go to stdout.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date, timedelta
from multiprocessing import Event
from pathlib import Path

from ..agent.config import AgentConfig
from ..agent.harness import agent_solve_range
from ..agent_budget import resolve_agent_runtime_config
from ..models import AppState, SolveRangeRequest

FIXTURE = Path(__file__).with_name("fixture_complex.json")


def load_state() -> AppState:
    return AppState.model_validate(json.loads(FIXTURE.read_text())["state"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-02-02")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--max-iterations", type=int, default=None)
    parser.add_argument("--model", default=None, help="override the configured model")
    args = parser.parse_args()

    end = date.fromisoformat(args.start) + timedelta(days=args.days - 1)
    state = load_state()
    payload = SolveRangeRequest(
        startISO=args.start,
        endISO=end.isoformat(),
        only_fill_required=True,
        timeout_seconds=args.timeout,
        solver_mode="agent",
    )
    config = resolve_agent_runtime_config(AgentConfig.from_env())
    if args.model:
        config.model = args.model
    if args.max_iterations:
        config.max_iterations = args.max_iterations

    def on_progress(kind: str, data: dict) -> None:
        # One line per iteration: progress for the human AND keepalive
        # traffic for the SSH channel (slow models are silent for minutes,
        # which killed a 122B run after 20 idle minutes).
        if kind == "agent" and data.get("kind") == "iteration":
            print(
                f"[arena] iteration {data.get('iteration')} "
                f"moves={data.get('moves_accepted')}",
                flush=True,
            )

    started = time.time()
    result = agent_solve_range(
        payload, state, Event(), on_progress, started, config=config,
    )
    duration = time.time() - started

    debug = result.get("debug_info") or result.get("debugInfo") or {}
    agent = debug.get("agent") or {}
    report = {
        "case": f"complex-practice {args.start} +{args.days}d",
        "model": agent.get("model"),
        "duration_seconds": round(duration, 1),
        "iterations": agent.get("iterations"),
        "moves_accepted": agent.get("moves_accepted"),
        "moves_rejected": agent.get("moves_rejected"),
        "input_tokens": agent.get("input_tokens"),
        "output_tokens": agent.get("output_tokens"),
        "open_slots_seed": len(agent.get("open_slots_seed") or []),
        "open_slots_final": len(agent.get("open_slots_final") or []),
        "notes": result.get("notes"),
        "assignments": len(result.get("assignments") or []),
    }
    print("ARENA_REPORT " + json.dumps(report, ensure_ascii=False))
    # Reasoning tail for qualitative review (what did the model struggle with)
    for t in (agent.get("thoughts") or [])[-3:]:
        print("--- thought ---")
        print(t[:1500])


if __name__ == "__main__":
    main()
