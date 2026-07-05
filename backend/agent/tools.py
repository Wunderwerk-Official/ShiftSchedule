"""Tool layer for the planning agent: schemas + executor with guardrails.

The executor owns the working copy of the plan. Guardrails are structural,
not prompt-based:

- pre-existing assignments (anything already in app state — manual edits and
  prior solver output alike, exactly what both solvers treat as fixed) can
  never be unassigned
- per-instance capacity is enforced on assign
- a batch of moves that would introduce NEW hard violations (relative to the
  seed baseline) is rolled back atomically, returning the would-be violations
  so the model can adjust
- the best-scoring violation-free plan is snapshotted; the harness returns
  that snapshot, so the model cannot make the final result worse than the seed

Violation semantics: the plan is validated as (fixed context + working copy).
Pre-existing manual data may legitimately violate e.g. weekly hours; the
guardrail therefore compares against the SEED baseline violation set instead
of demanding an empty report.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ..models import AppState, Assignment, Clinician
from ..scoring import ScoringContext, open_slots, plan_stats, score_plan
from ..validation import (
    VIOLATION_WEEKLY_HOURS,
    Violation,
    validate_assignments,
    validate_solver_rules,
)

AGENT_ASSIGNMENT_SOURCE = "solver"

TOOL_SPECS_RAW = [
    {
        "name": "get_plan_overview",
        "description": (
            "Current plan status: objective score (lower is better), coverage "
            "statistics, violation counts by code (hard and soft), and the "
            "number of open slot instances. Call this to orient yourself and "
            "after applying moves."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_violations",
        "description": (
            "List current violations of the full plan (fixed context + your "
            "working copy). 'new' marks violations not present in the seed "
            "baseline — only those block acceptance. Soft violations "
            "(SOLVER_RULE) never block but improve the plan when fixed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "severity": {"type": "string", "enum": ["hard", "soft"]},
                "code": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_open_slots",
        "description": (
            "Slot instances still below their required staffing, sorted by "
            "date then priority. slot_key identifies an instance "
            "('<slotId>__<dateISO>') and is what apply_moves expects."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dateISO": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_candidates_for_slot",
        "description": (
            "Evaluate every clinician for open slot instances: whether "
            "assigning them would be legal (eligible=true) and if not, which "
            "violation codes it would create. Includes week hours vs "
            "contract, ytd_worked_pct (percent of year-to-date target hours "
            "already worked up to the slot's day — lower = further behind), "
            "and preference/time-window fit. day_hours = hours they already "
            "work that day; adjacent_to_existing = the slot directly touches "
            "one of their shifts (prefer these for short edge slots, so "
            "nobody comes in for a 1-2h stint). Eligible candidates are "
            "sorted most-behind first: prefer the top of the list. "
            "PREFER slot_keys (up to 8 slots in ONE call, compact response) "
            "over repeated single-slot calls — it saves iterations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "slot_key": {"type": "string"},
                "slot_keys": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 8,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_clinician_summary",
        "description": (
            "One clinician's schedule in the solve range: assignments per "
            "day (fixed vs yours), weekly hours vs contract+tolerance, "
            "ytd_worked_pct, preferred sections, time windows, vacations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"clinicianId": {"type": "string"}},
            "required": ["clinicianId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_short_days",
        "description": (
            "Find mini work days: clinician-days in the solve range whose "
            "total assigned time stays below the person's daily minimum "
            "(e.g. a single 1-2h morning stint). Returns assigned vs minimum "
            "hours and the slot_keys involved, flagged fixed (immutable) vs "
            "movable. Fix by extending the day with adjacent slots, or by "
            "moving the stint to a candidate with adjacent_to_existing=true."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_ytd_progress",
        "description": (
            "Year-to-date fairness snapshot: for every clinician, the percent "
            "of their year-to-date target hours already worked as of a date "
            "(default: the range start), counting your working copy. 100 = "
            "exactly on target, below 100 = behind. Sorted most-behind first "
            "— give extra hours to clinicians at the top so everyone "
            "converges to the same percentage of their contract."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"dateISO": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "apply_moves",
        "description": (
            "Apply a batch of assignment changes to your working copy. "
            "Assign adds a clinician to a slot instance; unassign removes one "
            "of YOUR assignments (fixed/manual assignments cannot be "
            "removed). The batch is atomic: if it would create new hard "
            "violations or break capacity, nothing is applied and the "
            "violations are returned so you can adjust. Batch related moves "
            "(e.g. unassign+assign swaps) together."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "moves": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["assign", "unassign"]},
                            "slot_key": {"type": "string"},
                            "clinicianId": {"type": "string"},
                        },
                        "required": ["action", "slot_key", "clinicianId"],
                        "additionalProperties": False,
                    },
                },
                "comment": {"type": "string"},
            },
            "required": ["moves"],
            "additionalProperties": False,
        },
    },
]


def _dump(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def _violation_key(v: Violation) -> Tuple:
    if v.code == VIOLATION_WEEKLY_HOURS and v.context:
        # Keyed by ISO week (not the first assignment date, which shifts when
        # earlier-in-week assignments change) so the baseline diff is stable.
        return (v.code, v.clinician_id, v.context.get("iso_year"), v.context.get("iso_week"))
    return (v.code, v.clinician_id, v.date_iso, v.slot_id)


def _split_slot_key(slot_key: str) -> Tuple[str, str]:
    """'<slotId>__<dateISO>' -> (slotId, dateISO). Slot ids may themselves
    contain '__', so split on the LAST separator (dates never contain it)."""
    if "__" not in slot_key:
        raise ValueError(f"Invalid slot_key: {slot_key!r}")
    slot_id, date_iso = slot_key.rsplit("__", 1)
    return slot_id, date_iso


def build_clinician_aliases(state: AppState) -> Dict[str, str]:
    """Stable pseudonyms (D1, D2, ...) for clinicians, in roster order.

    Everything the LLM sees uses these aliases: real names never leave the
    backend, and short aliases beat long UUID-ish ids on token count. The
    mapping lives only in this process; tool inputs are translated back, so
    the returned plan carries real ids and the UI never sees an alias.
    """
    return {c.id: f"D{i + 1}" for i, c in enumerate(state.clinicians)}


class PlanToolExecutor:
    """Owns the working copy and executes tool calls against it."""

    def __init__(
        self,
        state: AppState,
        ctx: ScoringContext,
        seed_assignments: List[Assignment],
        *,
        on_improvement: Optional[Callable[[float, List[Assignment]], None]] = None,
        on_activity: Optional[Callable[[str, dict], None]] = None,
    ):
        self.state = state
        self.ctx = ctx
        self.on_improvement = on_improvement
        # Live-activity hook for the UI: called with (kind, payload) for
        # human-readable progress (applied/rejected move batches).
        self.on_activity = on_activity
        self.clinicians_by_id: Dict[str, Clinician] = {c.id: c for c in state.clinicians}
        self.section_names: Dict[str, str] = {r.id: r.name for r in state.rows}
        # Pseudonymization boundary: the LLM only ever sees aliases.
        self.alias_by_id: Dict[str, str] = build_clinician_aliases(state)
        self.id_by_alias: Dict[str, str] = {v: k for k, v in self.alias_by_id.items()}

        # Fixed context: everything already in app state. Kept in full so
        # boundary checks (overlap/rest across the range edges) see it.
        self.fixed_assignments: List[Assignment] = list(state.assignments)
        self.fixed_identity: Set[Tuple[str, str, str]] = {
            (a.rowId, a.dateISO, a.clinicianId) for a in self.fixed_assignments
        }

        # Working copy: only agent-controlled (seed + agent) assignments.
        self.current: Dict[Tuple[str, str, str], Assignment] = {}
        for a in seed_assignments:
            self.current[(a.rowId, a.dateISO, a.clinicianId)] = a

        self.moves_accepted = 0
        self.moves_rejected = 0
        # Human-readable log of every ACCEPTED move (real names) — surfaced
        # in the run summary of the solver history after the run.
        self.accepted_move_log: List[dict] = []

        # Baseline = violations of the seed plan. Only NEW hard violations
        # beyond this set block acceptance. For magnitude-typed violations
        # (weekly hours) also record the baseline magnitude: piling MORE hours
        # onto an already-over week keeps the same violation key and would
        # otherwise be masked by the set diff.
        baseline = self._hard_violations(self._full_plan())
        self.baseline_hard_keys: Set[Tuple] = {_violation_key(v) for v in baseline}
        self.baseline_week_minutes: Dict[Tuple, int] = {
            _violation_key(v): int((v.context or {}).get("assigned_minutes") or 0)
            for v in baseline
            if v.code == VIOLATION_WEEKLY_HOURS
        }

        seed_score = score_plan(ctx, self._working_list())
        self.best_score: float = seed_score.total
        self.best_assignments: List[Assignment] = self._working_list()
        self.seed_score: float = seed_score.total

    # ------------------------------------------------------------------
    # plan state helpers
    # ------------------------------------------------------------------

    def _working_list(self) -> List[Assignment]:
        return list(self.current.values())

    def _full_plan(self, working: Optional[List[Assignment]] = None) -> List[Assignment]:
        return self.fixed_assignments + (
            working if working is not None else self._working_list()
        )

    def _hard_violations(self, full_plan: List[Assignment]) -> List[Violation]:
        report = validate_assignments(
            self.state,
            full_plan,
            skip_references=True,
            only_fill_required=self.ctx.only_fill_required,
        )
        return report.violations

    def _is_new_hard(self, v: Violation, extra_baseline: Optional[Set[Tuple]] = None) -> bool:
        """True when a violation is NEW (or worsened) relative to the seed baseline."""
        key = _violation_key(v)
        if extra_baseline is not None and key in extra_baseline:
            return False
        if key not in self.baseline_hard_keys:
            return True
        if v.code == VIOLATION_WEEKLY_HOURS:
            baseline_minutes = self.baseline_week_minutes.get(key)
            current_minutes = int((v.context or {}).get("assigned_minutes") or 0)
            if baseline_minutes is not None and current_minutes > baseline_minutes:
                return True  # same violating week, but worsened
        return False

    def _counts_by_instance(self, working: List[Assignment]) -> Dict[str, int]:
        counts: Dict[str, int] = dict(self.ctx.fixed_counts)
        for a in working:
            key = f"{a.rowId}__{a.dateISO}"
            if key in self.ctx.instances:
                counts[key] = counts.get(key, 0) + 1
        return counts

    def _overview(self) -> dict:
        working = self._working_list()
        full = self._full_plan(working)
        hard = self._hard_violations(full)
        soft = validate_solver_rules(self.state, full)
        score = score_plan(self.ctx, working)
        stats = plan_stats(self.ctx, working)
        hard_counts: Dict[str, int] = {}
        for v in hard:
            hard_counts[v.code] = hard_counts.get(v.code, 0) + 1
        new_hard = [v for v in hard if self._is_new_hard(v)]
        return {
            "score": score.total,
            "score_components": score.components,
            "seed_score": self.seed_score,
            "best_score": self.best_score,
            "stats": stats.model_dump(),
            "hard_violations_by_code": hard_counts,
            "new_hard_violations": len(new_hard),
            "soft_rule_violations": len(soft),
            "open_slot_count": stats.open_slots,
            "your_assignments": len(working),
        }

    # ------------------------------------------------------------------
    # tool dispatch
    # ------------------------------------------------------------------

    def execute(self, name: str, arguments: dict, tool_call_id: str):
        from .provider import ToolResult

        handlers = {
            "get_plan_overview": self._tool_overview,
            "get_violations": self._tool_violations,
            "list_open_slots": self._tool_open_slots,
            "list_candidates_for_slot": self._tool_candidates,
            "get_clinician_summary": self._tool_clinician_summary,
            "get_ytd_progress": self._tool_ytd_progress,
            "list_short_days": self._tool_short_days,
            "apply_moves": self._tool_apply_moves,
        }
        handler = handlers.get(name)
        if handler is None:
            return ToolResult(tool_call_id, _dump({"error": f"Unknown tool: {name}"}), True)
        try:
            return ToolResult(tool_call_id, _dump(handler(arguments or {})))
        except Exception as exc:  # tool bugs must not kill the solve
            return ToolResult(tool_call_id, _dump({"error": str(exc)}), True)

    # ------------------------------------------------------------------
    # individual tools
    # ------------------------------------------------------------------

    def _tool_overview(self, args: dict) -> dict:
        return self._overview()

    def _tool_violations(self, args: dict) -> dict:
        severity = args.get("severity")
        code_filter = args.get("code")
        limit = min(int(args.get("limit") or 20), 100)
        offset = max(int(args.get("offset") or 0), 0)

        full = self._full_plan()
        items: List[dict] = []
        if severity in (None, "hard"):
            for v in self._hard_violations(full):
                items.append(
                    {
                        "severity": "hard",
                        "code": v.code,
                        "message": self._scrub(v.message),
                        "clinicianId": self._alias(v.clinician_id),
                        "dateISO": v.date_iso,
                        "slot_id": v.slot_id,
                        "new": self._is_new_hard(v),
                    }
                )
        if severity in (None, "soft"):
            for v in validate_solver_rules(self.state, full):
                items.append(
                    {
                        "severity": "soft",
                        "code": v.code,
                        "message": self._scrub(v.message),
                        "clinicianId": self._alias(v.clinician_id),
                        "dateISO": v.date_iso,
                        "slot_id": v.slot_id,
                        "new": False,
                    }
                )
        if code_filter:
            items = [i for i in items if i["code"] == code_filter]
        return {
            "total": len(items),
            "offset": offset,
            "violations": items[offset : offset + limit],
        }

    def _tool_open_slots(self, args: dict) -> dict:
        limit = min(int(args.get("limit") or 25), 100)
        offset = max(int(args.get("offset") or 0), 0)
        date_filter = args.get("dateISO")
        gaps = open_slots(self.ctx, self._working_list())
        if date_filter:
            gaps = [g for g in gaps if g.dateISO == date_filter]
        return {
            "total": len(gaps),
            "offset": offset,
            "open_slots": [g.model_dump() for g in gaps[offset : offset + limit]],
        }

    def _tool_candidates(self, args: dict) -> dict:
        # Batched form: several slots in one call, compact per-slot output —
        # one round-trip instead of N (each round costs wall clock and grows
        # the conversation the model re-reads every iteration).
        slot_keys = args.get("slot_keys")
        if slot_keys:
            out = {}
            for key in list(slot_keys)[:8]:
                result = self._candidates_for_slot(key)
                if "candidates" in result:
                    eligible = [c for c in result["candidates"] if c["eligible"]][:8]
                    ineligible_counts: Dict[str, int] = {}
                    for c in result["candidates"]:
                        if not c["eligible"]:
                            for reason in c["reasons"] or ["OTHER"]:
                                ineligible_counts[reason] = ineligible_counts.get(reason, 0) + 1
                    result = {
                        "capacity_left": result["capacity_left"],
                        "eligible": eligible,
                        "ineligible_counts": ineligible_counts,
                    }
                out[key] = result
            return {"slots": out}
        if not args.get("slot_key"):
            return {"error": "Provide slot_key or slot_keys"}
        return self._candidates_for_slot(args["slot_key"])

    def _candidates_for_slot(self, slot_key: str) -> dict:
        inst = self.ctx.instances.get(slot_key)
        if inst is None:
            return {"error": f"Unknown or inactive slot instance: {slot_key}"}

        working = self._working_list()
        counts = self._counts_by_instance(working)
        capacity_left = inst.capacity - counts.get(slot_key, 0)
        current_hard_keys = {
            _violation_key(v) for v in self._hard_violations(self._full_plan(working))
        }

        candidates = []
        for clinician in self.state.clinicians:
            already = (inst.slot_id, inst.date_iso, clinician.id) in self.current or (
                inst.slot_id,
                inst.date_iso,
                clinician.id,
            ) in self.fixed_identity
            if already:
                candidates.append(
                    {"clinicianId": self._alias(clinician.id),
                     "eligible": False, "reasons": ["ALREADY_ASSIGNED"]}
                )
                continue
            trial = working + [self._make_assignment(inst.slot_id, inst.date_iso, clinician.id)]
            new_codes = sorted(
                {
                    v.code
                    for v in self._hard_violations(self._full_plan(trial))
                    if self._is_new_hard(v, extra_baseline=current_hard_keys)
                }
            )
            day_intervals = self._day_intervals(clinician.id, inst.date_iso)
            entry = {
                "clinicianId": self._alias(clinician.id),
                "eligible": not new_codes and capacity_left > 0,
                "reasons": new_codes if new_codes else ([] if capacity_left > 0 else ["CAPACITY_EXCEEDED"]),
                # Hours this clinician already works on the slot's day, and
                # whether the slot directly touches one of those shifts —
                # the key signals for avoiding 1-2h mini-days on edge slots.
                "day_hours": round(sum(e - s for s, e in day_intervals) / 60.0, 1),
                "adjacent_to_existing": any(
                    e == inst.start or inst.end == s for s, e in day_intervals
                ),
                "week_hours": round(self._week_hours(clinician.id, inst.date_iso), 1),
                "contract_hours": clinician.workingHoursPerWeek,
                # % of YTD target worked up to THIS slot's day, including the
                # working copy — lower = further behind = should be preferred.
                "ytd_worked_pct": self.ytd_completion_pct(clinician.id, inst.date_iso),
                "prefers_section": inst.section_id in (clinician.preferredClassIds or []),
            }
            window = self.ctx.window_by_clinician_date.get((clinician.id, inst.date_iso))
            if window is not None:
                entry["window_fit"] = (
                    "fit" if inst.start >= window[1] and inst.end <= window[2] else "outside"
                )
            candidates.append(entry)
        candidates.sort(
            key=lambda c: (
                not c["eligible"],
                c.get("ytd_worked_pct") if c.get("ytd_worked_pct") is not None else 999,
            )
        )
        return {"slot_key": slot_key, "capacity_left": capacity_left, "candidates": candidates}

    def _tool_clinician_summary(self, args: dict) -> dict:
        cid = self._resolve_clinician(args["clinicianId"])
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return {"error": f"Unknown clinician: {args['clinicianId']}"}
        by_date: Dict[str, List[dict]] = {}
        for a in self.fixed_assignments:
            if a.dateISO in self.ctx.target_date_set and a.clinicianId == cid:
                by_date.setdefault(a.dateISO, []).append(
                    {"slot_key": f"{a.rowId}__{a.dateISO}", "fixed": True}
                )
        for (row_id, date_iso, c), _a in self.current.items():
            if c == cid and date_iso in self.ctx.target_date_set:
                by_date.setdefault(date_iso, []).append(
                    {"slot_key": f"{row_id}__{date_iso}", "fixed": False}
                )
        weeks: Dict[str, float] = {}
        for date_iso in self.ctx.target_day_isos:
            week_key = self._week_key(date_iso)
            if week_key not in weeks:
                weeks[week_key] = round(self._week_hours(cid, date_iso), 1)
        _tol = clinician.workingHoursToleranceHours
        return {
            "clinicianId": self._alias(cid),
            "contract_hours_per_week": clinician.workingHoursPerWeek,
            "tolerance_hours": _tol if _tol is not None else 5,
            "week_hours": weeks,
            "ytd_worked_pct": self.ytd_completion_pct(cid, self.ctx.start_iso),
            "qualified_sections": clinician.qualifiedClassIds,
            "preferred_sections": clinician.preferredClassIds or [],
            "preferred_working_times": {
                day: {
                    "start": w.startTime,
                    "end": w.endTime,
                    "requirement": w.requirement,
                }
                for day, w in (clinician.preferredWorkingTimes or {}).items()
            },
            "vacations": [
                {"startISO": v.startISO, "endISO": v.endISO}
                for v in clinician.vacations or []
            ],
            "assignments_by_date": by_date,
        }

    def _tool_short_days(self, args: dict) -> dict:
        by_cd: Dict[Tuple[str, str], List[Assignment]] = {}
        for a in self._full_plan():
            if a.dateISO not in self.ctx.target_date_set:
                continue
            if a.rowId.startswith("pool-"):
                continue
            by_cd.setdefault((a.clinicianId, a.dateISO), []).append(a)

        cases = []
        for (cid, date_iso), assignments in sorted(
            by_cd.items(), key=lambda kv: (kv[0][1], kv[0][0])
        ):
            clinician = self.clinicians_by_id.get(cid)
            if clinician is None:
                continue
            window = self.ctx.window_by_clinician_date.get((cid, date_iso))
            contract = clinician.workingHoursPerWeek
            if window is not None:
                min_minutes = max(1, (window[2] - window[1]) // 2)
            elif isinstance(contract, (int, float)) and contract > 0:
                min_minutes = max(1, int(round(contract * 60 / 5)) // 2)
            else:
                continue
            total = 0
            slots = []
            for a in assignments:
                inst = self.ctx.instances.get(f"{a.rowId}__{a.dateISO}")
                if inst is not None:
                    duration = max(0, inst.end - inst.start)
                else:
                    interval = self.ctx.all_slot_intervals.get(a.rowId)
                    duration = max(0, interval[1] - interval[0]) if interval else 0
                total += duration
                slots.append(
                    {
                        "slot_key": f"{a.rowId}__{a.dateISO}",
                        "fixed": (a.rowId, a.dateISO, a.clinicianId) in self.fixed_identity,
                    }
                )
            if total >= min_minutes:
                continue
            cases.append(
                {
                    "clinicianId": self._alias(cid),
                    "dateISO": date_iso,
                    "assigned_hours": round(total / 60.0, 1),
                    "min_hours": round(min_minutes / 60.0, 1),
                    "slots": slots,
                }
            )
        return {
            "total": len(cases),
            "note": "Days below the daily minimum. Extend the day with "
            "adjacent work, or move non-fixed stints to someone whose "
            "existing shift they touch.",
            "short_days": cases[:20],
        }

    def _tool_ytd_progress(self, args: dict) -> dict:
        as_of = args.get("dateISO") or self.ctx.start_iso
        entries = []
        for clinician in self.state.clinicians:
            entries.append(
                {
                    "clinicianId": self._alias(clinician.id),
                    "ytd_worked_pct": self.ytd_completion_pct(clinician.id, as_of),
                    "contract_hours_per_week": clinician.workingHoursPerWeek,
                }
            )
        entries.sort(
            key=lambda e: e["ytd_worked_pct"] if e["ytd_worked_pct"] is not None else 999
        )
        return {
            "as_of": as_of,
            "note": "100 = exactly on target; lower = behind (prefer these). "
            "Includes your working copy. null = no contract or no history yet.",
            "clinicians": entries,
        }

    def _tool_apply_moves(self, args: dict) -> dict:
        moves = args.get("moves") or []
        rejected: List[dict] = []
        trial: Dict[Tuple[str, str, str], Assignment] = dict(self.current)
        trial_counts = self._counts_by_instance(list(trial.values()))

        for index, move in enumerate(moves):
            action = move.get("action")
            try:
                slot_id, date_iso = _split_slot_key(move.get("slot_key") or "")
            except ValueError as exc:
                rejected.append({"index": index, "reason": str(exc)})
                continue
            raw_cid = move.get("clinicianId") or ""
            cid = self._resolve_clinician(raw_cid)
            identity = (slot_id, date_iso, cid)
            slot_key = f"{slot_id}__{date_iso}"

            if cid not in self.clinicians_by_id:
                rejected.append({"index": index, "reason": f"Unknown clinician: {raw_cid}"})
            elif action == "assign":
                inst = self.ctx.instances.get(slot_key)
                if inst is None:
                    rejected.append(
                        {"index": index, "reason": f"No active slot instance {slot_key}"}
                    )
                elif identity in trial or identity in self.fixed_identity:
                    rejected.append(
                        {"index": index, "reason": f"{raw_cid} is already assigned to {slot_key}"}
                    )
                elif trial_counts.get(slot_key, 0) >= inst.capacity:
                    rejected.append(
                        {"index": index,
                         "reason": f"{slot_key} is at capacity ({inst.capacity})"}
                    )
                else:
                    trial[identity] = self._make_assignment(slot_id, date_iso, cid)
                    trial_counts[slot_key] = trial_counts.get(slot_key, 0) + 1
            elif action == "unassign":
                if identity in trial:
                    del trial[identity]
                    trial_counts[slot_key] = max(0, trial_counts.get(slot_key, 0) - 1)
                elif identity in self.fixed_identity:
                    rejected.append(
                        {"index": index,
                         "reason": "Fixed (manual/pre-existing) assignments cannot be removed"}
                    )
                else:
                    rejected.append(
                        {"index": index, "reason": f"No such assignment: {raw_cid} @ {slot_key}"}
                    )
            else:
                rejected.append({"index": index, "reason": f"Unknown action: {action!r}"})

        if rejected:
            self.moves_rejected += len(moves)
            self._emit_activity(
                "moves_rejected",
                {
                    "count": len(moves),
                    "reason": self._unscrub(rejected[0].get("reason", "invalid move")),
                },
            )
            return {"applied": False, "rejected": rejected}

        trial_list = list(trial.values())
        new_hard = [
            {"code": v.code, "message": v.message}
            for v in self._hard_violations(self._full_plan(trial_list))
            if self._is_new_hard(v)
        ]
        if new_hard:
            self.moves_rejected += len(moves)
            self._emit_activity(
                "moves_rejected",
                {
                    "count": len(moves),
                    "reason": "would violate " + ", ".join(
                        sorted({v["code"] for v in new_hard})
                    ),
                },
            )
            return {
                "applied": False,
                "new_hard_violations": new_hard,
                "hint": "The batch was rolled back. Adjust the moves to avoid these violations.",
            }

        self.current = trial
        self.moves_accepted += len(moves)
        score = score_plan(self.ctx, trial_list)
        improved = score.total < self.best_score
        if improved:
            self.best_score = score.total
            self.best_assignments = list(trial_list)
            if self.on_improvement is not None:
                self.on_improvement(score.total, list(trial_list))
        described = [self._describe_move(m) for m in moves]
        self.accepted_move_log.extend(described)
        self._emit_activity(
            "moves_applied",
            {
                "moves": described,
                "improved": improved,
                "score": score.total,
            },
        )
        return {"applied": True, "verification": self._overview()}

    # ------------------------------------------------------------------
    # small helpers
    # ------------------------------------------------------------------

    def _emit_activity(self, kind: str, payload: dict) -> None:
        if self.on_activity is None:
            return
        try:
            self.on_activity(kind, payload)
        except Exception:
            pass  # UI hook failures must never affect the solve

    def _resolve_clinician(self, alias_or_id: str) -> str:
        """Translate an LLM-facing alias (D1, ...) back to the real id.
        Real ids are accepted too, so in-process callers/tests keep working."""
        return self.id_by_alias.get(alias_or_id, alias_or_id)

    def _alias(self, clinician_id: Optional[str]) -> Optional[str]:
        if clinician_id is None:
            return None
        return self.alias_by_id.get(clinician_id, clinician_id)

    def _unscrub(self, text: str) -> str:
        """Replace aliases (D1, ...) with real names for the UI-facing feed
        (the reverse of :meth:`_scrub`; never applied to LLM-facing output)."""
        import re

        def replace(match: "re.Match[str]") -> str:
            cid = self.id_by_alias.get(match.group(0))
            clinician = self.clinicians_by_id.get(cid) if cid else None
            return clinician.name if clinician else match.group(0)

        return re.sub(r"\bD\d+\b", replace, text)

    def _scrub(self, text: str) -> str:
        """Replace clinician names and ids in free text with their aliases.

        Applied to every LLM-facing string that can embed identity: violation
        messages and the admin's free-text instructions. Matching is
        case-insensitive on word boundaries and also covers the name without
        a leading academic title plus the bare surname, so "Dr. Tom Braun",
        "tom braun" and "Braun" all become the same alias. Over-scrubbing is
        safe (stays private); under-scrubbing would leak a name. Longest
        needles run first so partial matches don't clobber longer ones.
        """
        import re

        replacements: List[Tuple[str, str]] = []
        for cid, alias in self.alias_by_id.items():
            clinician = self.clinicians_by_id.get(cid)
            replacements.append((cid, alias))
            if clinician and clinician.name:
                name = clinician.name.strip()
                replacements.append((name, alias))
                bare = name
                while True:
                    stripped = re.sub(
                        r"^(dr\.?|prof\.?|pd|med\.?)\s+", "", bare, flags=re.IGNORECASE
                    )
                    if stripped == bare:
                        break
                    bare = stripped.strip()
                if bare and bare != name:
                    replacements.append((bare, alias))
                surname = bare.split()[-1] if bare else ""
                if len(surname) >= 3:
                    replacements.append((surname, alias))
        replacements.sort(key=lambda pair: len(pair[0]), reverse=True)
        for needle, alias in replacements:
            if needle:
                text = re.sub(
                    r"(?<!\w)" + re.escape(needle) + r"(?!\w)",
                    alias,
                    text,
                    flags=re.IGNORECASE,
                )
        return text

    def scrub_text(self, text: str) -> str:
        """Public entry point for pseudonymizing LLM-bound free text."""
        return self._scrub(text)

    def unscrub_text(self, text: str) -> str:
        """Public entry point for restoring real names in UI-bound text."""
        return self._unscrub(text)

    def _day_intervals(self, clinician_id: str, date_iso: str) -> List[Tuple[int, int]]:
        """(start, end) minutes of everything this clinician already works on
        date_iso (fixed context + working copy)."""
        out: List[Tuple[int, int]] = []
        for a in self._full_plan():
            if a.clinicianId != clinician_id or a.dateISO != date_iso:
                continue
            if a.rowId.startswith("pool-"):
                continue
            inst = self.ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is not None:
                out.append((inst.start, inst.end))
                continue
            interval = self.ctx.all_slot_intervals.get(a.rowId)
            if interval is not None:
                out.append((interval[0], interval[1]))
        return out

    def _describe_move(self, move: dict) -> dict:
        """Humanize one accepted move for the live UI feed (real names are
        fine here: this goes to the user's browser, never to the LLM)."""
        try:
            slot_id, date_iso = _split_slot_key(move.get("slot_key") or "")
        except ValueError:
            slot_id, date_iso = move.get("slot_key") or "?", ""
        cid = self._resolve_clinician(move.get("clinicianId") or "")
        clinician = self.clinicians_by_id.get(cid)
        inst = self.ctx.instances.get(f"{slot_id}__{date_iso}")
        section = ""
        start = end = ""
        if inst is not None:
            section = self.section_names.get(inst.section_id, inst.section_id)
            start = f"{inst.start // 60:02d}:{inst.start % 60:02d}"
            end = f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}"
        return {
            "action": move.get("action"),
            "clinician": clinician.name if clinician else cid,
            "section": section,
            "dateISO": date_iso,
            "start": start,
            "end": end,
        }

    def _make_assignment(self, slot_id: str, date_iso: str, clinician_id: str) -> Assignment:
        return Assignment(
            id=f"agent-{slot_id}-{date_iso}-{clinician_id}",
            rowId=slot_id,
            dateISO=date_iso,
            clinicianId=clinician_id,
            source=AGENT_ASSIGNMENT_SOURCE,
        )

    @staticmethod
    def _week_key(date_iso: str) -> str:
        from datetime import date

        year, week, _ = date.fromisoformat(date_iso).isocalendar()
        return f"{year}-W{week:02d}"

    def _week_hours(self, clinician_id: str, date_iso: str) -> float:
        """Assigned hours (fixed + working copy) in the ISO week of date_iso."""
        from datetime import date

        target_week = date.fromisoformat(date_iso).isocalendar()[:2]
        minutes = 0
        for a in self._full_plan():
            if a.clinicianId != clinician_id:
                continue
            if a.rowId.startswith("pool-"):
                continue
            if date.fromisoformat(a.dateISO).isocalendar()[:2] != target_week:
                continue
            inst = self.ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is not None:
                minutes += max(0, inst.end - inst.start)
                continue
            # Fixed assignments OUTSIDE the solve range have no instance but
            # still count toward the week (validate_weekly_hours counts them,
            # so the advisory number must too or the model proposes moves that
            # then get rejected).
            interval = self.ctx.all_slot_intervals.get(a.rowId)
            if interval is not None:
                start, end, _loc = interval
                minutes += max(0, end - start)
        return minutes / 60.0

    def ytd_completion_pct(self, clinician_id: str, as_of_iso: str) -> Optional[int]:
        """Percent of the clinician's year-to-date target hours actually
        worked before ``as_of_iso`` (100 = exactly on plan, 80 = 20% behind).

        Counts fixed history plus the current working copy, so the number
        shifts while the agent fills earlier days of the range — assigning
        someone on Monday raises their percentage for Friday's decision.
        Vacation days reduce the target (same crediting as the CP-SAT YTD
        balance in solver._compute_ytd_deficit_hours). Returns None when the
        clinician has no positive contract or the year has less than one
        week of history at ``as_of_iso``.
        """
        from datetime import date, timedelta

        clinician = self.clinicians_by_id.get(clinician_id)
        if clinician is None:
            return None
        contract = clinician.workingHoursPerWeek
        if not isinstance(contract, (int, float)) or contract <= 0:
            return None
        try:
            as_of = date.fromisoformat(as_of_iso)
        except (TypeError, ValueError):
            return None
        year_start = date(as_of.year, 1, 1)
        weeks_elapsed = (as_of - year_start).days / 7.0
        if weeks_elapsed < 1.0:
            return None

        vacation_days = 0
        for vacation in clinician.vacations or []:
            try:
                v_start = date.fromisoformat(vacation.startISO)
                v_end = date.fromisoformat(vacation.endISO)
            except (TypeError, ValueError, AttributeError):
                continue
            overlap_start = max(v_start, year_start)
            overlap_end = min(v_end, as_of - timedelta(days=1))
            if overlap_end >= overlap_start:
                vacation_days += (overlap_end - overlap_start).days + 1
        effective_weeks = max(0.0, weeks_elapsed - vacation_days / 7.0)
        expected_minutes = contract * 60 * effective_weeks
        if expected_minutes <= 0:
            return None

        year_start_iso = year_start.isoformat()
        minutes = 0
        for a in self._full_plan():
            if a.clinicianId != clinician_id:
                continue
            if a.rowId.startswith("pool-"):
                continue
            if not (year_start_iso <= a.dateISO < as_of_iso):
                continue
            inst = self.ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is not None:
                minutes += max(0, inst.end - inst.start)
                continue
            interval = self.ctx.all_slot_intervals.get(a.rowId)
            if interval is not None:
                start, end, _loc = interval
                minutes += max(0, end - start)
        return max(0, min(200, round(minutes / expected_minutes * 100)))
