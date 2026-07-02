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
            "For one open slot instance, evaluate every clinician: whether "
            "assigning them would be legal (eligible=true) and if not, which "
            "violation codes it would create. Includes week hours vs "
            "contract, YTD deficit, and preference/time-window fit to help "
            "you pick the best candidate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"slot_key": {"type": "string"}},
            "required": ["slot_key"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_clinician_summary",
        "description": (
            "One clinician's schedule in the solve range: assignments per "
            "day (fixed vs yours), weekly hours vs contract+tolerance, YTD "
            "deficit, preferred sections, time windows, vacations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"clinicianId": {"type": "string"}},
            "required": ["clinicianId"],
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
    return (v.code, v.clinician_id, v.date_iso, v.slot_id)


def _split_slot_key(slot_key: str) -> Tuple[str, str]:
    """'<slotId>__<dateISO>' -> (slotId, dateISO). Slot ids may themselves
    contain '__', so split on the LAST separator (dates never contain it)."""
    if "__" not in slot_key:
        raise ValueError(f"Invalid slot_key: {slot_key!r}")
    slot_id, date_iso = slot_key.rsplit("__", 1)
    return slot_id, date_iso


class PlanToolExecutor:
    """Owns the working copy and executes tool calls against it."""

    def __init__(
        self,
        state: AppState,
        ctx: ScoringContext,
        seed_assignments: List[Assignment],
        *,
        on_improvement: Optional[Callable[[float, List[Assignment]], None]] = None,
    ):
        self.state = state
        self.ctx = ctx
        self.on_improvement = on_improvement
        self.clinicians_by_id: Dict[str, Clinician] = {c.id: c for c in state.clinicians}

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

        # Baseline = violations of the seed plan. Only NEW hard violations
        # beyond this set block acceptance.
        self.baseline_hard_keys: Set[Tuple] = {
            _violation_key(v) for v in self._hard_violations(self._full_plan())
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
        new_hard = [v for v in hard if _violation_key(v) not in self.baseline_hard_keys]
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
                        "message": v.message,
                        "clinicianId": v.clinician_id,
                        "dateISO": v.date_iso,
                        "slot_id": v.slot_id,
                        "new": _violation_key(v) not in self.baseline_hard_keys,
                    }
                )
        if severity in (None, "soft"):
            for v in validate_solver_rules(self.state, full):
                items.append(
                    {
                        "severity": "soft",
                        "code": v.code,
                        "message": v.message,
                        "clinicianId": v.clinician_id,
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
        slot_key = args["slot_key"]
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
                    {"clinicianId": clinician.id, "name": clinician.name,
                     "eligible": False, "reasons": ["ALREADY_ASSIGNED"]}
                )
                continue
            trial = working + [self._make_assignment(inst.slot_id, inst.date_iso, clinician.id)]
            new_codes = sorted(
                {
                    v.code
                    for v in self._hard_violations(self._full_plan(trial))
                    if _violation_key(v) not in current_hard_keys
                    and _violation_key(v) not in self.baseline_hard_keys
                }
            )
            entry = {
                "clinicianId": clinician.id,
                "name": clinician.name,
                "eligible": not new_codes and capacity_left > 0,
                "reasons": new_codes if new_codes else ([] if capacity_left > 0 else ["CAPACITY_EXCEEDED"]),
                "week_hours": round(self._week_hours(clinician.id, inst.date_iso), 1),
                "contract_hours": clinician.workingHoursPerWeek,
                "ytd_deficit_pct": self.ctx.ytd_deficit_pct.get(clinician.id, 0),
                "prefers_section": inst.section_id in (clinician.preferredClassIds or []),
            }
            window = self.ctx.window_by_clinician_date.get((clinician.id, inst.date_iso))
            if window is not None:
                entry["window_fit"] = (
                    "fit" if inst.start >= window[1] and inst.end <= window[2] else "outside"
                )
            candidates.append(entry)
        candidates.sort(key=lambda c: (not c["eligible"], -c.get("ytd_deficit_pct", 0)))
        return {"slot_key": slot_key, "capacity_left": capacity_left, "candidates": candidates}

    def _tool_clinician_summary(self, args: dict) -> dict:
        cid = args["clinicianId"]
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return {"error": f"Unknown clinician: {cid}"}
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
            "clinicianId": cid,
            "name": clinician.name,
            "contract_hours_per_week": clinician.workingHoursPerWeek,
            "tolerance_hours": _tol if _tol is not None else 5,
            "week_hours": weeks,
            "ytd_deficit_pct": self.ctx.ytd_deficit_pct.get(cid, 0),
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
            cid = move.get("clinicianId") or ""
            identity = (slot_id, date_iso, cid)
            slot_key = f"{slot_id}__{date_iso}"

            if cid not in self.clinicians_by_id:
                rejected.append({"index": index, "reason": f"Unknown clinician: {cid}"})
            elif action == "assign":
                inst = self.ctx.instances.get(slot_key)
                if inst is None:
                    rejected.append(
                        {"index": index, "reason": f"No active slot instance {slot_key}"}
                    )
                elif identity in trial or identity in self.fixed_identity:
                    rejected.append(
                        {"index": index, "reason": f"{cid} is already assigned to {slot_key}"}
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
                        {"index": index, "reason": f"No such assignment: {cid} @ {slot_key}"}
                    )
            else:
                rejected.append({"index": index, "reason": f"Unknown action: {action!r}"})

        if rejected:
            self.moves_rejected += len(moves)
            return {"applied": False, "rejected": rejected}

        trial_list = list(trial.values())
        new_hard = [
            {"code": v.code, "message": v.message}
            for v in self._hard_violations(self._full_plan(trial_list))
            if _violation_key(v) not in self.baseline_hard_keys
        ]
        if new_hard:
            self.moves_rejected += len(moves)
            return {
                "applied": False,
                "new_hard_violations": new_hard,
                "hint": "The batch was rolled back. Adjust the moves to avoid these violations.",
            }

        self.current = trial
        self.moves_accepted += len(moves)
        score = score_plan(self.ctx, trial_list)
        if score.total < self.best_score:
            self.best_score = score.total
            self.best_assignments = list(trial_list)
            if self.on_improvement is not None:
                self.on_improvement(score.total, list(trial_list))
        return {"applied": True, "verification": self._overview()}

    # ------------------------------------------------------------------
    # small helpers
    # ------------------------------------------------------------------

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
            inst = self.ctx.instances.get(f"{a.rowId}__{a.dateISO}")
            if inst is None:
                continue
            if date.fromisoformat(a.dateISO).isocalendar()[:2] != target_week:
                continue
            minutes += max(0, inst.end - inst.start)
        return minutes / 60.0
