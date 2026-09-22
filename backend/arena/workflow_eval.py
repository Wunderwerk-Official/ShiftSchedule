"""Deterministic first-offer baseline. Never reads credentials or saves state.

This measures tool/controller behavior, not language-model intelligence.
Use the same script with an older checkout to compare the old tool layer.
"""
import argparse
from collections import Counter
from datetime import date, timedelta
import json
import hashlib
import time

from backend.assignment_policy import is_protected_assignment
from backend.agent.tools import PlanToolExecutor
from backend.arena.run import FIXTURE, load_state, apply_scenario
from backend.scoring import build_scoring_context, plan_stats


def evaluate(start, days, scenario="base", profile="classic", neighborhood=False, seconds=120):
    state = load_state()
    end = (date.fromisoformat(start)+timedelta(days=days-1)).isoformat()
    apply_scenario(state, scenario, start, end)
    state.solverSettings.update(agentQualityProfile=profile, agentNeighborhoodSearch=neighborhood)
    reference = [a for a in state.assignments if start <= a.dateISO <= end
                 and not is_protected_assignment(a) and not a.rowId.startswith("pool-")]
    state.assignments = [a for a in state.assignments if a not in reference]
    ctx = build_scoring_context(state, start, end, only_fill_required=True)
    begun = time.monotonic()
    ex = PlanToolExecutor(state, ctx, [])
    if hasattr(ex, "reference_assignments"):
        ex.reference_assignments = reference
    ex.wall_deadline = time.time()+seconds
    calls = Counter()

    def call(name, **arguments):
        calls[name] += 1
        result = ex.execute(name, arguments, "controller")
        data = json.loads(result.content)
        if result.is_error or "error" in data:
            raise RuntimeError(f"{name}: {data}")
        return data

    def apply(offer):
        if offer.get("proposal_id"):
            return call("apply_proposal", proposal_id=offer["proposal_id"]).get("next", {}).get("result")
        moves = offer.get("moves") or offer.get("batch") or [{"action": "assign", "slot_key": key, "clinicianId": offer["clinicianId"]}
                                      for key in offer["block"]]
        result = call("apply_moves", moves=moves)
        if not result.get("applied"):
            raise RuntimeError(f"Rejected offered moves: {result}")
        return None

    # Staff on-call slots first, mirroring the harness's duty pre-pass.
    duties = sorted((i for i in ctx.instances.values() if i.section_id == ctx.settings.onCallRestClassId),
                    key=lambda i: (i.date_iso, i.start, i.slot_key))
    for inst in duties:
        if ex._tool_seconds_left() <= 5:
            break
        while ex._counts_by_instance(ex._working_list()).get(inst.slot_key, 0) < inst.target:
            data = call("suggest_day_blocks", slot_key=inst.slot_key, single=True)
            if not data.get("candidates"):
                break
            apply(data["candidates"][0])
    visited = []
    incomplete = []
    search_limits = []
    for day in ctx.target_day_isos:
        if ex._tool_seconds_left() <= 5:
            incomplete.append(day)
            continue
        visited.append(day)
        data = call("suggest_day_blocks", dateISO=day)
        for _ in range(100):
            if ex._tool_seconds_left() <= 5:
                incomplete.append(day)
                break
            if data.get("candidates"):
                data = apply(data["candidates"][0]) or call("suggest_day_blocks", dateISO=day)
                continue
            chosen = None
            checks_incomplete = False
            checks = [("suggest_rescue_moves", "rescues"), ("suggest_balance_moves", "offers")]
            counts = ex._counts_by_instance(ex._working_list())
            if neighborhood and any(i.date_iso == day and counts.get(i.slot_key, 0) < i.target for i in ctx.instances.values()):
                checks.insert(1, ("repair_neighborhood", "proposals"))
            for name, field in checks:
                arguments = {"dateISO": day}
                seen_cursors = set()
                while True:
                    checked = call(name, **arguments)
                    if checked.get("search_status") in ("incomplete", "budget_exhausted") and not checked.get("next_cursor"):
                        checks_incomplete = True
                        search_limits.append({"tool": name, "dateISO": day,
                                              "status": checked["search_status"],
                                              "scope": checked.get("search_scope"),
                                              "note": checked.get("note"),
                                              "not_searched": checked.get("not_searched")})
                    for offer in checked.get(field, []):
                        better = offer.get("improves_best")
                        if better is None:
                            better = call("apply_moves", moves=offer.get("moves") or offer["batch"], dry_run=True).get("improves_best")
                        if better:
                            chosen = offer
                            break
                    cursor = checked.get("next_cursor")
                    if chosen or not cursor:
                        break
                    if cursor in seen_cursors or ex._tool_seconds_left() < 25:
                        checks_incomplete = True
                        break
                    seen_cursors.add(cursor)
                    arguments = {"dateISO": day, "cursor": cursor}
                if chosen:
                    break
            if not chosen:
                if checks_incomplete:
                    incomplete.append(day)
                break
            data = apply(chosen) or call("suggest_day_blocks", dateISO=day)
        else:
            incomplete.append(day)
    best = ex.best_assignments
    hard = ex._hard_violations(ex._full_plan(best))
    result = {"start": start, "days": days, "scenario": scenario, "profile": profile,
              "fixture_version": json.loads(FIXTURE.read_text()).get("fixtureVersion", "legacy-export-v1"),
              "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
              "neighborhood": neighborhood, "seconds": round(time.monotonic()-begun, 3),
              "quality": ex.quality_dict(ex.best_quality), "stats": plan_stats(ctx, best).model_dump(),
              "new_hard_violations": sum(ex._is_new_hard(v) for v in hard),
              "fixed_unchanged": ex.fixed_assignments == state.assignments,
              "visited_days": len(visited), "incomplete_days": sorted(set(incomplete)),
              "tool_calls": dict(calls), "controller_calls": sum(calls.values()),
              "search_limits_encountered": search_limits[-20:]}
    if hasattr(ex, "reference_assignments"):
        from backend.agent.quality import extra_metrics
        result["additional_metrics"] = extra_metrics(ex, best)
    if hasattr(ex, "workflow") and hasattr(ex.workflow, "direct_checks"):
        result["candidate_validation_cache"] = {
            "hits": ex.workflow.direct_check_hits, "misses": ex.workflow.direct_check_misses,
        }
    # Hash identities, not generated assignment IDs, for exact outcome comparisons.
    identities = sorted((a.rowId, a.dateISO, a.clinicianId) for a in best)
    result["plan_identity_hash"] = hashlib.sha256(json.dumps(identities).encode()).hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2026-02-02")
    parser.add_argument("--days", type=int, default=5)
    parser.add_argument("--scenario", default="base")
    parser.add_argument("--profile", default="classic", choices=["classic", "balanced"])
    parser.add_argument("--neighborhood", action="store_true")
    parser.add_argument("--seconds", type=float, default=120)
    args = parser.parse_args()
    print(json.dumps(evaluate(**vars(args)), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
