"""Revision-bound proposals and bounded search memory for one planning run.

Only the executor owns assignments. This module stores instructions for
already checked moves, never a second mutable copy of the calendar.
"""
from collections import OrderedDict, deque
from copy import deepcopy
import json
import time


SEARCH_TOOLS = {
    "suggest_day_blocks", "suggest_rescue_moves", "suggest_balance_moves",
    "repair_neighborhood", "analyze_bottlenecks", "explain_unfilled",
}


class InspectionBudgetExhausted(Exception):
    def __init__(self, day):
        self.result = {"search_status": "incomplete", "not_searched": [day],
                       "note": "Inspection time budget exhausted. Candidate counts and completion were not established."}


class PlanningWorkflow:
    def __init__(self, executor):
        self.executor = executor
        self.revision = 0
        self.proposals = OrderedDict()
        self.proposal_counter = 0
        self.search_counter = 0
        self.searches = deque(maxlen=80)
        self.day_checks = {}
        self.cache = OrderedDict()
        self.cache_budgets = {}
        self.direct_checks = OrderedDict()
        self.direct_check_hits = 0
        self.direct_check_misses = 0

    def changed(self):
        self.revision += 1
        # Deliberately conservative: even a change on another day can alter
        # weekly hours or rest constraints. Never reuse old negative results.
        self.cache.clear()
        self.cache_budgets.clear()
        self.direct_checks.clear()

    def search(self, name, arguments, handler):
        key = (name, json.dumps(arguments, sort_keys=True, separators=(",", ":")))
        budget_before = self.executor._tool_seconds_left()
        if key in self.cache:
            result = deepcopy(self.cache[key])
            def ids(value):
                if isinstance(value, dict):
                    if "proposal_id" in value:
                        yield value["proposal_id"]
                    for child in value.values():
                        yield from ids(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from ids(child)
            more_budget = (result.get("search_status") in ("incomplete", "budget_exhausted")
                           and budget_before > self.cache_budgets[key] + 1)
            if not more_budget and all(proposal_id in self.proposals for proposal_id in ids(result)):
                result["cached"] = True
                return result
            # Bounded proposal storage may evict an old offer before its
            # cached search. Regenerate it instead of returning unusable IDs.
            del self.cache[key]
        try:
            result = handler(arguments)
        except InspectionBudgetExhausted as exc:
            result = dict(exc.result)
            field = {"suggest_day_blocks": "candidates", "suggest_rescue_moves": "rescues",
                     "suggest_balance_moves": "offers", "repair_neighborhood": "proposals",
                     "analyze_bottlenecks": "bottlenecks", "explain_unfilled": "explanations"}.get(name)
            if field:
                result[field] = []
        if "error" in result:
            return result
        self.search_counter += 1
        result = {**result, "plan_revision": self.revision,
                  "search_id": f"search-{self.search_counter}", "cached": False}
        self.searches.append({
            "search_id": result["search_id"], "tool": name,
            "arguments": deepcopy(arguments), "plan_revision": self.revision,
            "status": result.get("search_status", "completed"),
            "offers": len(result.get("candidates", result.get("rescues", result.get("offers", result.get("proposals", []))))),
            "not_searched": result.get("not_searched", []),
        })
        # Repeating the same incomplete search with LESS remaining time
        # cannot extend it. Changed parameters, plan or an increased budget
        # allow another attempt without treating repetition as progress.
        self.cache[key] = deepcopy(result)
        self.cache_budgets[key] = budget_before
        while len(self.cache) > 80:
            expired, _ = self.cache.popitem(last=False)
            self.cache_budgets.pop(expired, None)
        return result

    def propose(self, moves, *, next_tool, next_args, preview=None):
        if preview is None:
            preview = self.executor._tool_apply_moves({"moves": moves, "dry_run": True})
        if not preview.get("valid"):
            return {}
        self.proposal_counter += 1
        proposal_id = f"proposal-{self.proposal_counter}"
        self.proposals[proposal_id] = {
            "revision": self.revision, "moves": deepcopy(moves),
            "next_tool": next_tool, "next_args": deepcopy(next_args),
            "applied": False,
        }
        while len(self.proposals) > 256:
            self.proposals.popitem(last=False)
        return {"proposal_id": proposal_id, "plan_revision": self.revision,
                "quality_after": preview.get("quality_after"),
                "improves_best": preview.get("improves_best", False)}

    def apply(self, arguments):
        proposal_id = arguments.get("proposal_id")
        proposal = self.proposals.get(proposal_id)
        if proposal is None:
            return {"applied": False, "error": "Unknown or expired proposal; request fresh suggestions."}
        if proposal["applied"]:
            return {"applied": False, "already_applied": True, "proposal_id": proposal_id,
                    "plan_revision": self.revision, "verification": self.executor._overview()}
        if proposal["revision"] != self.revision:
            return {"applied": False, "stale_proposal": True,
                    "plan_revision": self.revision,
                    "note": "The plan changed. Request fresh suggestions before applying this proposal."}
        result = self.executor._tool_apply_moves({"moves": proposal["moves"]})
        if not result.get("applied"):
            return result
        proposal["applied"] = True
        result.update({"proposal_id": proposal_id, "plan_revision": self.revision})
        next_args = proposal["next_args"]
        if next_args.get("duty_pass"):
            ex = self.executor
            counts = ex._counts_by_instance(ex._working_list())
            duties = sorted((inst for inst in ex.ctx.instances.values()
                             if inst.section_id == ex.ctx.settings.onCallRestClassId
                             and counts.get(inst.slot_key, 0) < inst.target),
                            key=lambda inst: (inst.date_iso, inst.start, inst.slot_key))
            if not duties:
                result["next"] = {"tool": "suggest_day_blocks", "result": {"duty_complete": True}}
                return result
            next_args = {"slot_key": ex._alias_slot_key(duties[0].slot_key), "single": True}
        # A failed follow-up inspection must never disguise a successful
        # mutation as a failed tool call (which would invite an unsafe retry).
        from .provider import ToolResult
        followup: ToolResult = self.executor.execute(
            proposal["next_tool"], next_args, "proposal-followup"
        )
        result["next"] = {"tool": proposal["next_tool"],
                          "result": json.loads(followup.content)}
        return result

    def summary(self, *, current_only=False):
        rows = [dict(row, current=row["plan_revision"] == self.revision)
                for row in self.searches]
        if current_only:
            rows = [row for row in rows if row["current"]]
        return {"plan_revision": self.revision, "searches": rows[-30:],
                "note": "Only current=true results describe this plan. No bounded search proves global infeasibility."}

    def review_day(self, day):
        result = {**self._review_day(day), "plan_revision": self.revision}
        self.day_checks[day] = result
        return result

    def _review_day(self, day):
        """Run required checks in code before accepting a model's end-turn."""
        ex = self.executor
        if ex._tool_seconds_left() <= 5:
            return {"complete": False, "reason": "Review budget exhausted", "proposals": []}
        counts = ex._counts_by_instance(ex._working_list())
        gaps = any(i.date_iso == day and counts.get(i.slot_key, 0) < i.target for i in ex.ctx.instances.values())
        checks = []
        if gaps:
            checks.append(("suggest_rescue_moves", "rescues"))
            if ex.ctx.settings.agentNeighborhoodSearch:
                checks.append(("repair_neighborhood", "proposals"))
        checks.append(("suggest_balance_moves", "offers"))
        for name, field in checks:
            arguments = {"dateISO": day}
            seen_cursors = set()
            while True:
                reply = ex.execute(name, arguments, "required-day-review")
                data = json.loads(reply.content)
                if reply.is_error or "error" in data:
                    return {"complete": False, "reason": f"{name} failed", "proposals": []}
                # A partial search can still contain fully validated offers.
                proposals = [p["proposal_id"] for p in data.get(field, []) if p.get("proposal_id") and p.get("improves_best")]
                if proposals:
                    return {"complete": False, "reason": f"{name} found a checked improvement",
                            "proposals": proposals[:3]}
                cursor = data.get("next_cursor")
                if name == "suggest_rescue_moves" and cursor and cursor not in seen_cursors and ex._tool_seconds_left() >= 25:
                    seen_cursors.add(cursor)
                    arguments = {"dateISO": day, "cursor": cursor}
                    continue
                if data.get("search_status") in ("incomplete", "budget_exhausted") or cursor:
                    return {"complete": False, "reason": f"{name} was not fully checked", "proposals": []}
                break
        return {"complete": True, "reason": "Required bounded checks completed", "proposals": []}

    def tasks(self):
        """Generate the worklist from current assignments, never from model claims."""
        from .quality import extra_metrics
        ex = self.executor
        working = ex._working_list()
        counts = ex._counts_by_instance(working)
        rows = []
        for day in ex.ctx.target_day_isos:
            check = self.day_checks.get(day, {})
            current = check.get("plan_revision") == self.revision
            rows.append({"id": f"review:{day}", "kind": "required_check", "dateISO": day,
                         "status": "complete" if current and check.get("complete") else "pending",
                         "reason": check.get("reason", "Not checked") if current else "Plan changed or not checked",
                         "proposal_ids": check.get("proposals", []) if current else []})
        for inst in ex.ctx.instances.values():
            missing = max(0, inst.target - counts.get(inst.slot_key, 0))
            if missing:
                rows.append({"id": f"coverage:{inst.slot_key}", "kind": "coverage", "dateISO": inst.date_iso,
                             "slot_key": ex._alias_slot_key(inst.slot_key), "status": "open", "missing": missing})
        metrics = extra_metrics(ex, working)
        for detail in metrics["day_shape_details"]:
            rows.append({"id": f"day-shape:{detail['clinicianId']}:{detail['dateISO']}",
                         "kind": "day_shape", **detail, "status": "fixed" if detail["fixed_excess_minutes"] and detail["fixed_minutes"] == detail["minutes"] else "review"})
        for detail in metrics["workday_patterns"]:
            if detail["deviation_days"] or detail["assessment"] != "complete_week":
                rows.append({"id": f"workdays:{detail['clinicianId']}:{detail['weekStartISO']}",
                             "kind": "workday_pattern", **detail,
                             "status": "fixed" if detail["fixed_excess_days"] >= detail["deviation_days"] > 0 else "review"})
        for detail in metrics["workday_averages"]:
            if detail["additional_deviation_days"]:
                rows.append({"id": f"workday-average:{detail['clinicianId']}", "kind": "workday_average",
                             **detail, "status": "review"})
        return {"plan_revision": self.revision,
                "required_checks_complete": all(r["status"] == "complete" for r in rows if r["kind"] == "required_check"),
                "coverage_complete": not any(r["kind"] == "coverage" for r in rows),
                "tasks": [dict(row, plan_revision=self.revision) for row in rows],
                "note": "Fixed load stays in the plan. Review tasks are soft wishes, not permission to move fixed duties. A complete bounded check does not prove optimality."}

    def final_audit(self, days, cancel_event, *, max_repairs=None, max_seconds=60):
        """Audit the returned best; repair only fresh, strictly better checked offers.

        Any mutation restarts the full audit. Both repairs and elapsed time are
        bounded, including runs with no user time limit. Never repair after abort.
        """
        days = list(days)
        if max_repairs is None:
            max_repairs = min(24, max(4, 2 * len(days)))
        ex = self.executor
        old_deadline = ex.wall_deadline
        ex.wall_deadline = min(old_deadline or float("inf"), time.time() + max_seconds)
        repairs = 0
        try:
            while True:
                changed = False
                checks = {}
                counts = ex._counts_by_instance(ex._working_list())
                gap_days = {inst.date_iso for inst in ex.ctx.instances.values()
                            if counts.get(inst.slot_key, 0) < inst.target}
                # Cover missing positions before polishing already staffed days.
                for day in sorted(days, key=lambda d: (d not in gap_days, d)):
                    if cancel_event.is_set() or ex._tool_seconds_left() <= 5:
                        result = {"complete": False, "reason": "Cancelled or final check budget exhausted", "proposals": []}
                    else:
                        pending = ex.next_fillable_slot(day)
                        if pending:
                            result = {"complete": False, "reason": "Direct placements remain or inspection incomplete", "proposals": []}
                            if not pending.get("check_incomplete"):
                                reply = ex.execute("suggest_day_blocks", {"slot_key": pending["slot_key"]}, "final-placement-check")
                                data = json.loads(reply.content)
                                result["proposals"] = [p["proposal_id"] for p in data.get("candidates", [])
                                                       if p.get("proposal_id") and p.get("improves_best")][:3]
                        else:
                            result = self.review_day(day)
                    result = {**result, "plan_revision": self.revision}
                    checks[day] = self.day_checks[day] = result
                    for pid in result.get("proposals", []):
                        if repairs >= max_repairs or cancel_event.is_set() or ex._tool_seconds_left() <= 5:
                            break
                        proposal = self.proposals.get(pid)
                        if not proposal or proposal["revision"] != self.revision or proposal["applied"]:
                            continue
                        preview = ex._tool_apply_moves({"moves": proposal["moves"], "dry_run": True})
                        if cancel_event.is_set() or ex._tool_seconds_left() <= 5 or not preview.get("valid") or not preview.get("improves_best"):
                            continue
                        # Checked proposals can contain a whole fine-grained
                        # day block, larger than the model's 20-move payload
                        # limit. Use the same proposal contract as the model.
                        reply = ex.execute("apply_proposal", {"proposal_id": pid}, "final-checked-repair")
                        applied = json.loads(reply.content)
                        if applied.get("applied"):
                            proposal["applied"] = True
                            repairs += 1
                            changed = True
                            break
                    if changed:
                        break  # every earlier check is stale after this mutation
                if not changed:
                    return {"checks": checks, "repairs": repairs, "plan_revision": self.revision,
                            "repair_limit": max_repairs, "time_limit_seconds": max_seconds}
        finally:
            ex.wall_deadline = old_deadline
