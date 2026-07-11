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
from ..scoring import ScoringContext, open_slots, plan_stats
from ..validation import (
    VIOLATION_WEEKLY_HOURS,
    Violation,
    validate_assignments,
    validate_solver_rules,
)

AGENT_ASSIGNMENT_SOURCE = "solver"

# Tools that only exist for the day-by-day strategy. The repair strategy's
# tool list stays byte-identical to before the strategy split, so the two
# modes remain comparable (and repair keeps its prompt-cache prefix).
DAY_ONLY_TOOL_NAMES = {
    "get_day_priorities",
    "suggest_day_blocks",
    "suggest_rescue_moves",
    "suggest_balance_moves",
}

TOOL_SPECS_RAW = [
    {
        "name": "get_plan_overview",
        "description": (
            "Current plan status: the quality tiers in strict priority order "
            "(hard violations in range > open required slots > short days > "
            "soft-rule violations > weekly-hours deviation > preference/load "
            "bonus), coverage statistics, violation counts by code, and the "
            "quality of your best snapshot so far. Call this to orient "
            "yourself and after applying moves."
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
            "date then priority. slot_key identifies an instance like "
            "'S3__2026-07-07' "
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
            "hours, the slot_keys involved (flagged fixed vs movable), and "
            "per case the precomputed, LEGALITY-CHECKED fix_options: adjacent "
            "qualified slots that extend the day. Options without blocked_by "
            "are safe to apply directly (unassign take_from if set, then "
            "assign); options with blocked_by list the hard-violation codes "
            "the direct swap would create — skip them unless you first make "
            "a compensating move (e.g. free weekly hours elsewhere). Empty "
            "fix_options or all options blocked = do not chase this case."
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
        "name": "get_hours_overview",
        "description": (
            "Weekly-hours balance for the WHOLE roster in one call: per "
            "clinician and ISO week, assigned hours (fixed + your working "
            "copy) vs contract±tolerance, with status under/ok/over and the "
            "deviation. Sorted most-underworked first. Use it to spot who "
            "needs more or fewer hours without one get_clinician_summary "
            "call per person."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_day_schedule",
        "description": (
            "Full schedule of ONE day: every slot instance with section, "
            "times, required staffing, who is assigned (fixed vs yours) and "
            "how many are still missing. The day-level counterpart to "
            "get_clinician_summary — use it to build contiguous blocks, "
            "check adjacency, and see coverage gaps in context."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"dateISO": {"type": "string"}},
            "required": ["dateISO"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_day_priorities",
        "description": (
            "Day-by-day planning: the still-unfilled slot instances of ONE "
            "day, sorted in PROCESSING ORDER — slots with at most one legal "
            "candidate first (about to be lost), then on-call/duty slots "
            "(rest-day rules ripple into neighbouring days), then the "
            "practice's slot priority (template order), scarcest first "
            "within a tier. Staff the top entries first; flexible "
            "low-priority slots can wait. eligible_count/eligible_preview "
            "are computed against the current plan and change after every "
            "apply_moves."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"dateISO": {"type": "string"}},
            "required": ["dateISO"],
            "additionalProperties": False,
        },
    },
    {
        "name": "suggest_day_blocks",
        "description": (
            "Day-by-day planning: for ONE open slot, up to 6 clinicians who "
            "could legally take it (best first) — each with a precomputed "
            "contiguous WORK BLOCK starting at that slot (the chain of "
            "adjacent, still-open slots they could also take, up to their "
            "preferred daily hours). This answers 'who can I put here who "
            "then keeps working, instead of coming in for a short stint'. "
            "OMIT slot_key and pass dateISO to AUTO-SELECT the day's most "
            "urgent still-fillable slot (same processing order as "
            "get_day_priorities: single-candidate slots, then on-call, then "
            "slot priority; slots nobody can take are skipped); when "
            "nothing fillable remains it returns day_complete=true instead. "
            "Candidates are pre-sorted: daily minimum met first, then lowest "
            "ytd_worked_pct; when no block reaches the minimum, longest "
            "block first. Apply the WHOLE chosen block in one apply_moves "
            "batch. Blocks are validated against the current plan and go "
            "stale after apply_moves — re-query rather than reusing old "
            "suggestions (in auto mode: put apply_moves FIRST and this call "
            "SECOND in the same message, so the new suggestion already "
            "reflects the applied batch)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "slot_key": {"type": "string"},
                "dateISO": {"type": "string"},
                "single": {
                    "type": "boolean",
                    "description": "true = no Anschluss chaining, suggest "
                    "just this one slot (used for duty slots: a 12h service "
                    "is taken alone).",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "suggest_rescue_moves",
        "description": (
            "Day-by-day planning, the LAST resort before declaring a slot "
            "unfillable: for every open slot of dateISO that currently has "
            "eligible_count 0, search whether moving ONE of YOUR OWN earlier "
            "placements would free a qualified clinician for it, with a "
            "substitute taking the vacated slot. Returns ready-to-apply "
            "3-move batches (unassign the blocker, assign the substitute, "
            "assign the freed clinician to the stuck slot), each validated "
            "against the exact apply gate — apply a rescue batch EXACTLY as "
            "given, then re-check with suggest_day_blocks. Fixed/manual "
            "assignments are never touched. Use it when suggest_day_blocks "
            "reports day_complete=true but unfillable_slots remain."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"dateISO": {"type": "string"}},
            "required": ["dateISO"],
            "additionalProperties": False,
        },
    },
    {
        "name": "suggest_balance_moves",
        "description": (
            "Day-by-day planning, the FINAL REVIEW after the day is staffed "
            "('is everything in order?'): checks the finished day for "
            "fairness problems a human planner fixes on the last "
            "read-through — one person on an over-long chained day while "
            "colleagues barely work, or someone called in for a mini-stint "
            "below their daily minimum. Returns pre-validated transfer "
            "batches (unassign the donor, assign the receiver to the same "
            "slot) that keep BOTH days contiguous, never create a new "
            "over-long or new mini-stint day, and pass the exact apply "
            "gate. Apply ONE batch per round exactly as given, then call "
            "this again (other offers go stale); when it returns no offers "
            "the day is balanced — write your final summary. Fixed/manual "
            "assignments are never touched."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"dateISO": {"type": "string"}},
            "required": ["dateISO"],
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
            "(e.g. unassign+assign swaps) together. Set dry_run=true to "
            "validate the batch and preview the resulting quality tiers "
            "WITHOUT committing anything."
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
                "dry_run": {"type": "boolean"},
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
    """LLM-facing clinician identifiers: the real names.

    Pseudonymization was dropped deliberately (admin decision): real names
    are far easier for a model to track through a long plan than D1/D2
    codes, and self-hosted endpoints keep the data in-house anyway.
    Duplicate names get a numeric suffix so every identifier stays unique.
    """
    aliases: Dict[str, str] = {}
    seen: Dict[str, int] = {}
    for c in state.clinicians:
        name = (c.name or c.id).strip()
        seen[name] = seen.get(name, 0) + 1
        aliases[c.id] = name if seen[name] == 1 else f"{name} ({seen[name]})"
    return aliases


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
        # LLM-facing clinician identifiers: real (deduplicated) names.
        self.alias_by_id: Dict[str, str] = build_clinician_aliases(state)
        self.id_by_alias: Dict[str, str] = {v: k for k, v in self.alias_by_id.items()}
        # Short slot codes (S1, S2, ...): the raw template-slot ids are
        # UUIDs — token-heavy and easy for a model to mistype (one wrong
        # hex char = invalid move). Deterministic order: section name,
        # start time, id. The LLM only ever sees "S3__2026-07-07" keys;
        # raw ids are still accepted on input for robustness.
        slot_meta = {}
        for key, inst in ctx.instances.items():
            sid, _ = _split_slot_key(key)
            if sid not in slot_meta:
                slot_meta[sid] = (
                    self.section_names.get(inst.section_id, inst.section_id),
                    inst.start,
                    sid,
                )
        ordered = sorted(slot_meta, key=lambda sid: slot_meta[sid])
        self.slot_code_by_id: Dict[str, str] = {
            sid: f"S{i + 1}" for i, sid in enumerate(ordered)
        }
        self.slot_id_by_code: Dict[str, str] = {
            v: k for k, v in self.slot_code_by_id.items()
        }

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
        # Stamped by the harness before each LLM turn so accepted moves can
        # be grouped by iteration in the run-history change list.
        self.current_iteration = 0

        # Baseline = violations of the seed plan. Only NEW hard violations
        # beyond this set block acceptance. For magnitude-typed violations
        # (weekly hours) also record the baseline magnitude: piling MORE hours
        # onto an already-over week keeps the same violation key and would
        # otherwise be masked by the set diff.
        baseline = self._hard_violations(self._full_plan())
        self.baseline_hard_keys: Set[Tuple] = {_violation_key(v) for v in baseline}
        # Violations that exist among the FIXED assignments alone are not
        # repairable by the agent (it may only move drafts) — they are
        # excluded from the quality tier and flagged in get_violations so
        # the model does not burn iterations chasing them.
        self.unrepairable_hard_keys: Set[Tuple] = {
            _violation_key(v) for v in self._hard_violations(list(self.fixed_assignments))
        }
        self.baseline_week_minutes: Dict[Tuple, int] = {
            _violation_key(v): int((v.context or {}).get("assigned_minutes") or 0)
            for v in baseline
            if v.code == VIOLATION_WEEKLY_HOURS
        }

        # Formatted for the problem digest: the concrete repairable hard
        # violations the draft starts with. Arena runs showed models leaving
        # tier 1 for last (or unaddressed) when the digest only carried a
        # count — naming the cases up front lets round 1 target them.
        self.seed_repairable_violation_lines: List[str] = [
            f"- {v.code}|{self._alias(v.clinician_id) or '-'}|{v.date_iso or '-'}"
            f"|{self._scrub(v.message)[:120]}"
            for v in baseline
            if (v.date_iso is None or v.date_iso in ctx.target_date_set)
            and _violation_key(v) not in self.unrepairable_hard_keys
        ]

        self.seed_quality = self._quality(self._working_list(), hard_violations=baseline)
        self.best_quality = self.seed_quality
        self.best_assignments: List[Assignment] = self._working_list()
        # Encoded scalars kept for the live chart and run history.
        self.seed_score: float = self.encode_quality(self.seed_quality)
        self.best_score: float = self.seed_score

    # ------------------------------------------------------------------
    # plan quality
    # ------------------------------------------------------------------

    def _quality(
        self,
        working: List[Assignment],
        hard_violations: Optional[List[Violation]] = None,
    ) -> Tuple[int, int, int, int, int, int]:
        """Lexicographic plan quality — smaller is better, compared tier by
        tier: (hard violations in the solve range, open required slots, short
        days, soft-rule violations, weekly hours deviation minutes,
        -(preference fits + assignments)).

        Hard violations are the TOP tier so the agent is rewarded for
        REPAIRING what the draft breaks — unassigning a
        rest-day-violating draft assignment is an improvement even though it
        opens a slot. Only in-range violations count: year-old mismatches in
        untouchable manual data would otherwise drown the signal (they are
        constant anyway, but the numbers shown to the model stay honest).

        This replaced the hand-weighted scalar score as the best-plan gate:
        the tiers encode the human priority order directly, so no gut-feel
        weight can trade a required slot against a pile of preference wins,
        and the agent's own judgment decides everything the tiers don't
        measure (ties keep the newest state)."""
        stats = plan_stats(self.ctx, working)
        if hard_violations is None:
            hard_violations = self._hard_violations(self._full_plan(working))
        hard_in_range = sum(
            1
            for v in hard_violations
            if (v.date_iso is None or v.date_iso in self.ctx.target_date_set)
            and _violation_key(v) not in self.unrepairable_hard_keys
        )
        soft = len(validate_solver_rules(self.state, self._full_plan(working)))
        bonus = stats.section_preference_matches + stats.time_window_fits
        if not self.ctx.only_fill_required:
            bonus += stats.total_assignments
        return (
            hard_in_range,
            stats.open_slots,
            stats.short_days,
            soft,
            stats.working_hours_deviation_minutes,
            -bonus,
        )

    @staticmethod
    def encode_quality(quality: Tuple[int, int, int, int, int, int]) -> float:
        """Monotone-ish scalar for the live chart/history (lower = better).
        Saturated per tier so a huge lower tier can't visually outrank a
        higher one; NOT used for any accept/best decision."""
        hard, open_slots_, short, soft, hours_dev, neg_bonus = quality
        return float(
            hard * 100_000_000
            + open_slots_ * 1_000_000
            + short * 50_000
            + min(soft, 9) * 5_000
            + min(hours_dev, 4_999)
            + max(-4_999, neg_bonus)
        )

    def quality_dict(self, quality: Tuple[int, int, int, int, int, int]) -> dict:
        return {
            "hard_violations_in_range": quality[0],
            "open_required_slots": quality[1],
            "short_days": quality[2],
            "soft_rule_violations": quality[3],
            "hours_deviation_minutes": quality[4],
            "preference_and_load_bonus": -quality[5],
        }

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
        quality = self._quality(working, hard_violations=hard)
        stats = plan_stats(self.ctx, working)
        # Only REPAIRABLE violations INSIDE the solve range: the fixture-scale
        # history of pre-existing out-of-range violations (dozens of codes)
        # misled models into reasoning about constant, unfixable problems, and
        # unrepairable fixed-only cases made the by-code counts contradict the
        # quality tier (which excludes them) — both burned iterations.
        in_range = [
            v
            for v in hard
            if v.date_iso is None or v.date_iso in self.ctx.target_date_set
        ]
        repairable = [
            v
            for v in in_range
            if _violation_key(v) not in self.unrepairable_hard_keys
        ]
        hard_counts: Dict[str, int] = {}
        for v in repairable:
            hard_counts[v.code] = hard_counts.get(v.code, 0) + 1
        new_hard = [v for v in hard if self._is_new_hard(v)]
        return {
            "quality": {
                **self.quality_dict(quality),
                "note": "strict priority order, improve the highest tier first",
            },
            "quality_of_best_snapshot": self.quality_dict(self.best_quality),
            "stats": stats.model_dump(),
            # Matches quality.hard_violations_in_range exactly.
            "hard_violations_in_range_by_code": hard_counts,
            "hard_violations_not_yours": len(hard) - len(repairable),
            "note": "hard_violations_not_yours = pre-existing history and "
            "fixed-only cases: constant, unrepairable, ignore them",
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
            "get_hours_overview": self._tool_hours_overview,
            "get_day_schedule": self._tool_day_schedule,
            "get_day_priorities": self._tool_day_priorities,
            "suggest_day_blocks": self._tool_suggest_day_blocks,
            "suggest_rescue_moves": self._tool_suggest_rescue_moves,
            "suggest_balance_moves": self._tool_suggest_balance_moves,
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
                        # False = exists among fixed assignments alone: you
                        # cannot repair it, do not try.
                        "repairable": _violation_key(v) not in self.unrepairable_hard_keys,
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
        def _gap_out(g) -> dict:
            d = g.model_dump()
            d["slot_key"] = self._alias_slot_key(d["slot_key"])
            d["section"] = self.section_names.get(d.pop("section_id"), "?")
            return d

        return {
            "total": len(gaps),
            "offset": offset,
            "open_slots": [_gap_out(g) for g in gaps[offset : offset + limit]],
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
                    # Per-person reasons, not just counts: "who is blocked by
                    # what" is exactly the question the model asks next.
                    ineligible = {
                        c["clinicianId"]: c["reasons"] or ["OTHER"]
                        for c in result["candidates"]
                        if not c["eligible"]
                    }
                    result = {
                        "capacity_left": result["capacity_left"],
                        "eligible": eligible,
                        "ineligible": ineligible,
                    }
                out[self._alias_slot_key(self._resolve_slot_key(key))] = result
            return {"slots": out}
        if not args.get("slot_key"):
            return {"error": "Provide slot_key or slot_keys"}
        return self._candidates_for_slot(args["slot_key"])

    def _candidates_for_slot(self, slot_key: str) -> dict:
        slot_key = self._resolve_slot_key(slot_key)
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
        return {
            "slot_key": self._alias_slot_key(slot_key),
            "capacity_left": capacity_left,
            "candidates": candidates,
        }

    def _tool_clinician_summary(self, args: dict) -> dict:
        cid = self._resolve_clinician(args["clinicianId"])
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return {"error": f"Unknown clinician: {args['clinicianId']}"}
        by_date: Dict[str, List[dict]] = {}
        for a in self.fixed_assignments:
            if a.dateISO in self.ctx.target_date_set and a.clinicianId == cid:
                by_date.setdefault(a.dateISO, []).append(
                    {"slot_key": self._alias_slot_key(f"{a.rowId}__{a.dateISO}"), "fixed": True}
                )
        for (row_id, date_iso, c), _a in self.current.items():
            if c == cid and date_iso in self.ctx.target_date_set:
                by_date.setdefault(date_iso, []).append(
                    {"slot_key": self._alias_slot_key(f"{row_id}__{date_iso}"), "fixed": False}
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
                        "slot_key": self._alias_slot_key(f"{a.rowId}__{a.dateISO}"),
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
                    # Concrete ways to fix this short day, precomputed AND
                    # legality-checked so the model does not have to reason
                    # out adjacency slot by slot or falsify illegal swaps via
                    # dry runs (both dominated iteration cost on real cases).
                    # Empty list = structurally unfixable (no adjacent
                    # qualified slot), do not chase it.
                    "fix_options": self._short_day_fix_options(cid, date_iso),
                }
            )
        # Honest fixable count: only cases with at least one option whose
        # direct swap is legal. Arena runs showed 37-46% of unchecked options
        # were illegal (mostly WEEKLY_HOURS/SAME_LOCATION), and models burned
        # dozens of iterations discovering that one dry run at a time.
        fixable = sum(
            1
            for c in cases
            if any(not o.get("blocked_by") for o in c["fix_options"])
        )
        return {
            "total": len(cases),
            "fixable": fixable,
            "shown": min(len(cases), 20),
            "note": "Days below the daily minimum. fix_options lists the "
            "adjacent slots that would extend the day (take_from = who holds "
            "it now; would_shorten_holder = true means the swap just moves the "
            "problem). Options are legality-checked against the CURRENT plan: "
            "no blocked_by = the direct swap is legal right now; blocked_by "
            "lists the violation codes it would create (needs a compensating "
            "move first, usually not worth it). Empty fix_options or all "
            "blocked = skip the case. Options go stale after apply_moves - "
            "re-query instead of applying options fetched before your last "
            "batch.",
            "short_days": cases[:20],
        }

    def _short_day_fix_options(self, cid: str, date_iso: str) -> List[dict]:
        """Adjacent, qualified slots that could extend this clinician's day.

        A slot qualifies if it TOUCHES one of the clinician's existing shifts
        that day (start==prev end or end==next start), the clinician is
        qualified for its section, and either it is open OR held by a movable
        (non-fixed) clinician. For held slots we flag whether taking it would
        push the current holder below THEIR own daily minimum — the common
        "swap just moves the short day" trap.

        Every option is additionally legality-checked: the exact move batch it
        implies (unassign the holder if any, assign ``cid``) is validated
        against the full plan, and options that would create NEW hard
        violations carry their codes in ``blocked_by``. Without this, 37-46%
        of the presented options were illegal on real practice data (mostly
        WEEKLY_HOURS and SAME_LOCATION_PER_DAY) and the model spent long
        rejected-move stretches discovering that the hard way."""
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return []
        qualified = set(clinician.qualifiedClassIds or [])
        my_intervals = self._day_intervals(cid, date_iso)
        if not my_intervals:
            return []
        counts = self._counts_by_instance(self._working_list())
        options: List[dict] = []
        for key, inst in self.ctx.instances.items():
            if inst.date_iso != date_iso or inst.section_id not in qualified:
                continue
            touches = any(
                inst.start == s_end or inst.end == s_start
                for s_start, s_end in my_intervals
            )
            if not touches:
                continue
            # already mine? skip
            if any(
                a.clinicianId == cid and a.rowId == inst.slot_id
                for a in self._full_plan()
                if a.dateISO == date_iso
            ):
                continue
            slot_key = f"{inst.slot_id}__{date_iso}"
            open_room = inst.capacity - counts.get(slot_key, 0)
            holders = [
                a.clinicianId
                for a in self._full_plan()
                if a.dateISO == date_iso and a.rowId == inst.slot_id
            ]
            movable_holder = None
            would_shorten = False
            for h in holders:
                if (inst.slot_id, date_iso, h) in self.fixed_identity:
                    continue  # fixed — cannot be moved off
                movable_holder = h
                # Would losing this slot push the holder below their minimum?
                h_intervals = self._day_intervals(h, date_iso)
                h_total = sum(e - s for s, e in h_intervals)
                remaining = h_total - (inst.end - inst.start)
                would_shorten = remaining > 0 and remaining < (
                    self._daily_min_minutes(h, date_iso) or 0
                )
                break
            if open_room > 0:
                option = {
                    "slot_key": self._alias_slot_key(slot_key),
                    "section": self.section_names.get(inst.section_id, inst.section_id),
                    "take_from": None,
                    "would_shorten_holder": False,
                }
                taken_from = None
            elif movable_holder is not None:
                option = {
                    "slot_key": self._alias_slot_key(slot_key),
                    "section": self.section_names.get(inst.section_id, inst.section_id),
                    "take_from": self._alias(movable_holder),
                    "would_shorten_holder": would_shorten,
                }
                taken_from = movable_holder
            else:
                continue
            blocked = self._fix_option_blocked_by(
                cid, inst.slot_id, date_iso, taken_from
            )
            if blocked:
                option["blocked_by"] = blocked
            options.append(option)
        # Directly legal options first, then those that merely move the short
        # day, then blocked ones (kept so the model knows WHY a path is shut).
        options.sort(
            key=lambda o: (
                bool(o.get("blocked_by")),
                o["would_shorten_holder"],
                o["take_from"] is not None,
            )
        )
        return options[:6]

    def _fix_option_blocked_by(
        self,
        cid: str,
        slot_id: str,
        date_iso: str,
        taken_from: Optional[str],
    ) -> List[str]:
        """Violation codes the direct fix-option swap would create, [] if the
        move batch (unassign ``taken_from`` if set, assign ``cid``) is legal.

        Deliberately the exact same gate as apply_moves (``_is_new_hard``
        against the seed baseline, no extra allowances): "no blocked_by" must
        mean "this batch will be accepted". That includes the
        worsened-weekly-hours case — piling more hours onto an already-over
        week keeps the violation key but is still rejected on apply."""
        trial = dict(self.current)
        if taken_from is not None:
            trial.pop((slot_id, date_iso, taken_from), None)
        trial[(slot_id, date_iso, cid)] = self._make_assignment(slot_id, date_iso, cid)
        trial_hard = self._hard_violations(self._full_plan(list(trial.values())))
        return sorted(
            {v.code for v in trial_hard if self._is_new_hard(v)}
        )

    def _daily_min_minutes(self, cid: str, date_iso: str) -> Optional[int]:
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return None
        window = self.ctx.window_by_clinician_date.get((cid, date_iso))
        if window is not None:
            return max(1, (window[2] - window[1]) // 2)
        contract = clinician.workingHoursPerWeek
        if isinstance(contract, (int, float)) and contract > 0:
            return max(1, int(round(contract * 60 / 5)) // 2)
        return None

    # Chains never build days longer than this (+1h step tolerance). Longer
    # days exist — 12h/24h duty slots — but as SINGLE slots someone chose,
    # never as an auto-glued sequence of ordinary day work.
    MAX_CHAIN_TARGET_MINUTES = 10 * 60

    def _daily_target_minutes(self, cid: str, date_iso: str) -> int:
        """Preferred daily workload: contract/5 (an average workday), else
        8h. A mandatory working-time window bounds WHEN someone may work,
        not HOW MUCH — it can only shorten the target, never stretch it
        (observed in production: a 06:30-20:00 presence window was treated
        as the daily target and one person got a 13.5h auto-built chain
        while colleagues had 1h days)."""
        clinician = self.clinicians_by_id.get(cid)
        contract = clinician.workingHoursPerWeek if clinician else None
        if isinstance(contract, (int, float)) and contract > 0:
            target = max(60, int(round(contract * 60 / 5)))
        else:
            target = 480
        window = self.ctx.window_by_clinician_date.get((cid, date_iso))
        if window is not None:
            target = min(target, max(60, window[2] - window[1]))
        return min(target, self.MAX_CHAIN_TARGET_MINUTES)

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

    def _tool_hours_overview(self, args: dict) -> dict:
        # One ISO week appears once even if the range spans its boundary.
        week_sample_date: Dict[str, str] = {}
        for date_iso in self.ctx.target_day_isos:
            week_sample_date.setdefault(self._week_key(date_iso), date_iso)

        clinicians_out = []
        for clinician in self.state.clinicians:
            contract = clinician.workingHoursPerWeek
            _tol = clinician.workingHoursToleranceHours
            tolerance = _tol if _tol is not None else 5
            weeks_out: Dict[str, dict] = {}
            for week_key, sample_date in week_sample_date.items():
                hours = round(self._week_hours(clinician.id, sample_date), 1)
                entry: dict = {"hours": hours}
                if isinstance(contract, (int, float)) and contract > 0:
                    entry["deviation_h"] = round(hours - contract, 1)
                    if hours < contract - tolerance:
                        entry["status"] = "under"
                    elif hours > contract + tolerance:
                        entry["status"] = "over"
                    else:
                        entry["status"] = "ok"
                weeks_out[week_key] = entry
            clinicians_out.append(
                {
                    "clinicianId": self._alias(clinician.id),
                    "contract_hours_per_week": contract,
                    "tolerance_hours": tolerance,
                    "weeks": weeks_out,
                }
            )

        def most_under(entry: dict) -> float:
            deviations = [
                w["deviation_h"]
                for w in entry["weeks"].values()
                if w.get("status") == "under"
            ]
            return min(deviations) if deviations else 0.0

        clinicians_out.sort(key=most_under)
        return {
            "weeks": sorted(week_sample_date),
            "note": "Hours include fixed assignments and your working copy. "
            "status under/over = outside contract±tolerance; most underworked "
            "clinicians first (give them hours before anyone at ok/over).",
            "clinicians": clinicians_out,
        }

    def _tool_day_schedule(self, args: dict) -> dict:
        date_iso = args.get("dateISO")
        if date_iso not in self.ctx.target_date_set:
            return {
                "error": f"{date_iso} is outside the solve range "
                f"({self.ctx.start_iso} to {self.ctx.end_iso})."
            }
        counts = self._counts_by_instance(self._working_list())
        slots = []
        for inst in self.ctx.instances.values():
            if inst.date_iso != date_iso:
                continue
            assigned = [
                {"clinicianId": self._alias(a.clinicianId), "fixed": True}
                for a in self.fixed_assignments
                if a.dateISO == date_iso and a.rowId == inst.slot_id
            ]
            assigned.extend(
                {"clinicianId": self._alias(cid), "fixed": False}
                for (row_id, d, cid) in self.current
                if d == date_iso and row_id == inst.slot_id
            )
            slots.append(
                {
                    "slot_key": self._alias_slot_key(inst.slot_key),
                    "section": self.section_names.get(inst.section_id, inst.section_id),
                    "start": f"{inst.start // 60:02d}:{inst.start % 60:02d}",
                    "end": f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}",
                    "required": inst.target,
                    "missing": max(0, inst.target - counts.get(inst.slot_key, 0)),
                    "assigned": assigned,
                }
            )
        slots.sort(key=lambda s: (s["start"], s["section"]))
        return {"dateISO": date_iso, "slots": slots}

    # ------------------------------------------------------------------
    # day-by-day strategy helpers
    # ------------------------------------------------------------------

    def _day_open_entries(self, date_iso: str) -> List[dict]:
        """Unfilled slot instances of one day in PROCESSING ORDER. Shared by
        get_day_priorities and suggest_day_blocks' auto-select so both rank
        the day identically.

        Order (how a human planner works the day): a slot with at most one
        legal candidate first (decide it before that person is consumed),
        then on-call/duty slots (their rest-day rules constrain the
        NEIGHBOURING days, so they must be fixed before the day fills up),
        then the practice's slot priority (template order — the admin's own
        ranking of what matters), scarcest first within equal priority.
        Eligibility = number of clinicians who could legally take the slot
        against the CURRENT plan (the exact apply_moves gate)."""
        counts = self._counts_by_instance(self._working_list())
        on_call_class = (
            self.ctx.settings.onCallRestClassId
            if getattr(self.ctx.settings, "onCallRestEnabled", False)
            else None
        )
        entries = []
        for inst in self.ctx.instances.values():
            if inst.date_iso != date_iso:
                continue
            missing = max(0, inst.target - counts.get(inst.slot_key, 0))
            if missing <= 0:
                continue
            # STRICT eligibility (the exact apply_moves gate, including the
            # worsened-weekly-hours case): the day loop's "eligible_count 0 =
            # unfillable, stop chasing" exit criterion only works when 0
            # really means apply would reject everyone. Unqualified
            # clinicians are skipped before the (expensive) full-plan
            # validation — they could only ever be blocked.
            eligible = []
            for clinician in self.state.clinicians:
                if inst.section_id not in (clinician.qualifiedClassIds or []):
                    continue
                identity = (inst.slot_id, date_iso, clinician.id)
                if identity in self.current or identity in self.fixed_identity:
                    continue
                if self._fix_option_blocked_by(
                    clinician.id, inst.slot_id, date_iso, None
                ):
                    continue
                eligible.append(self._alias(clinician.id))
            entries.append(
                {
                    "raw_slot_key": inst.slot_key,
                    "slot_key": self._alias_slot_key(inst.slot_key),
                    "section": self.section_names.get(inst.section_id, inst.section_id),
                    "start": f"{inst.start // 60:02d}:{inst.start % 60:02d}",
                    "end": f"{(inst.end % 1440) // 60:02d}:{inst.end % 60:02d}",
                    "missing": missing,
                    "priority": inst.order_weight,
                    "on_call": inst.section_id == on_call_class,
                    "eligible_count": len(eligible),
                    "eligible_preview": eligible[:3],
                }
            )
        entries.sort(
            key=lambda e: (
                e["eligible_count"] > 1,
                not e["on_call"],
                -e["priority"],
                e["eligible_count"],
                e["start"],
            )
        )
        return entries

    def _tool_day_priorities(self, args: dict) -> dict:
        date_iso = args.get("dateISO")
        if date_iso not in self.ctx.target_date_set:
            return {
                "error": f"{date_iso} is outside the solve range "
                f"({self.ctx.start_iso} to {self.ctx.end_iso})."
            }
        entries = [dict(e) for e in self._day_open_entries(date_iso)]
        for entry in entries:
            entry.pop("raw_slot_key", None)
        # Orientation, not a work list: the pipeline picks slots itself via
        # suggest_day_blocks auto-select, so the tail of flexible slots only
        # costs tokens the model re-reads every round.
        shown = entries[:20]
        out = {
            "dateISO": date_iso,
            "open_positions": sum(e["missing"] for e in entries),
            "note": "PROCESSING ORDER: slots with at most one legal candidate "
            "first, then on-call duties (their rest days constrain the "
            "neighbouring days), then the practice's slot priority (higher = "
            "more important), scarcest first within a tier. eligible_count=0 "
            "means nobody can take it in the current state - staff the rest "
            "of the day first, then re-check; if it stays 0, report it as "
            "unfillable. Counts change after apply_moves.",
            "slots": shown,
        }
        if len(entries) > len(shown):
            out["more_open_slots"] = len(entries) - len(shown)
        return out

    def _tool_suggest_day_blocks(self, args: dict) -> dict:
        """For one open slot: eligible clinicians with their best contiguous
        work block starting there — the 'Anschlussverwendung' step of the
        human procedure (never place someone for a lone short stint when
        they could carry adjacent open slots too). Without slot_key the most
        urgent still-fillable slot of dateISO is chosen automatically (the
        _day_open_entries processing order), so the model can pipeline
        apply_moves + suggest_day_blocks in one turn."""
        auto_extras: dict = {}
        raw_key = str(args.get("slot_key") or "").strip()
        if raw_key:
            slot_key = self._resolve_slot_key(raw_key)
            inst = self.ctx.instances.get(slot_key)
            if inst is None:
                return {"error": f"Unknown or inactive slot instance: {args.get('slot_key')}"}
        else:
            date_iso = args.get("dateISO")
            if date_iso not in self.ctx.target_date_set:
                return {
                    "error": "Pass slot_key, or dateISO within the solve "
                    f"range ({self.ctx.start_iso} to {self.ctx.end_iso}) to "
                    "auto-select the most urgent open slot of that day."
                }
            entries = self._day_open_entries(date_iso)
            fillable = [e for e in entries if e["eligible_count"] > 0]
            unfillable = [e["slot_key"] for e in entries if e["eligible_count"] == 0]
            if not fillable:
                return {
                    "dateISO": date_iso,
                    "day_complete": True,
                    "open_positions": sum(e["missing"] for e in entries),
                    "unfillable_slots": unfillable,
                    "note": (
                        "No open slot of this day has a legal candidate "
                        "left. Call suggest_rescue_moves ONCE before "
                        "finishing — moving one of your own placements may "
                        "still free a qualified person. If it offers "
                        "nothing, run the final review "
                        "(suggest_balance_moves), then reply WITHOUT tool "
                        "calls, naming the unfillable slots (do not force "
                        "a move)."
                        if unfillable
                        else "The day is fully staffed. Run the final "
                        "review now: call suggest_balance_moves(dateISO) "
                        "and apply what it offers (one batch per round); "
                        "when it has no more offers, reply WITHOUT tool "
                        "calls with your one-paragraph day summary."
                    ),
                }
            chosen = fillable[0]
            slot_key = chosen["raw_slot_key"]
            inst = self.ctx.instances[slot_key]
            auto_extras = {
                "auto_selected": True,
                "day_open_positions": sum(e["missing"] for e in entries),
                "other_open_slots": len(entries) - 1,
            }
            if unfillable:
                auto_extras["unfillable_slots"] = unfillable
        counts = self._counts_by_instance(self._working_list())
        if inst.capacity - counts.get(slot_key, 0) <= 0:
            return {"error": f"{self._alias_slot_key(slot_key)} is already fully staffed."}

        start_candidates = self._candidates_for_slot(slot_key)
        eligible = [
            c for c in start_candidates.get("candidates", []) if c["eligible"]
        ][:6]
        single = bool(args.get("single"))
        out = []
        for cand in eligible:
            cid = self._resolve_clinician(cand["clinicianId"])
            block_keys, block_minutes = self._greedy_day_block(cid, inst, counts)
            if not block_keys:
                # The strict gate (worsened weekly hours etc.) rejects even
                # the start slot — apply_moves would too, so do not offer a
                # candidate whose every move is doomed.
                continue
            if single:
                # Duty mode: the slot is taken alone, no chained day work.
                block_keys = block_keys[:1]
                block_minutes = inst.end - inst.start
            day_before = sum(
                e - s for s, e in self._day_intervals(cid, inst.date_iso)
            )
            daily_min = self._daily_min_minutes(cid, inst.date_iso)
            # The effective weekly cap (contract + PERSONAL tolerance, which
            # differs per clinician — up to 10h in the real data). Without it
            # models see week_hours > contract_hours and wrongly agonize over
            # (or avoid) perfectly legal candidates.
            clinician = self.clinicians_by_id.get(cid)
            contract = clinician.workingHoursPerWeek if clinician else None
            week_max = None
            if isinstance(contract, (int, float)) and contract > 0:
                _tol = clinician.workingHoursToleranceHours
                week_max = contract + max(0, _tol if _tol is not None else 5)
            out.append(
                {
                    "clinicianId": cand["clinicianId"],
                    "block": [self._alias_slot_key(k) for k in block_keys],
                    "block_hours": round(block_minutes / 60.0, 1),
                    "day_hours_after": round((day_before + block_minutes) / 60.0, 1),
                    "meets_daily_minimum": (
                        daily_min is None or day_before + block_minutes >= daily_min
                    ),
                    # No human works a 24h day because two 12h duties happen
                    # to be adjacent (observed in production: day on-call +
                    # night on-call on the same person). Not a hard rule, so
                    # the gate cannot reject it — flag it and sort it last.
                    "overloaded": day_before + block_minutes > 16 * 60,
                    "week_hours": cand.get("week_hours"),
                    "contract_hours": cand.get("contract_hours"),
                    "week_hours_max": week_max,
                    "ytd_worked_pct": cand.get("ytd_worked_pct"),
                    "prefers_section": cand.get("prefers_section", False),
                }
            )
        # Overloaded days are a last resort, then long-enough blocks first
        # (the whole point of the strategy), most YTD-behind first within
        # that. Below the daily minimum the ranking flips: the LONGEST block
        # wins and fairness only breaks ties — one person on a 2h stint
        # beats two people on 1h stints (the second stays off entirely).
        # Observed in production: ytd-first put a 1h candidate above a 2h
        # candidate whose block covered BOTH remaining slots, producing two
        # mini-days instead of one.
        def _rank(c: dict) -> tuple:
            ytd = c["ytd_worked_pct"] if c["ytd_worked_pct"] is not None else 999
            if c["meets_daily_minimum"]:
                return (c["overloaded"], 0, ytd, -c["block_hours"])
            return (c["overloaded"], 1, -c["block_hours"], ytd)

        out.sort(key=_rank)
        on_call_class = (
            self.ctx.settings.onCallRestClassId
            if getattr(self.ctx.settings, "onCallRestEnabled", False)
            else None
        )
        return {
            "slot_key": self._alias_slot_key(slot_key),
            "section": self.section_names.get(inst.section_id, inst.section_id),
            **({"on_call": True} if inst.section_id == on_call_class else {}),
            **auto_extras,
            "note": "Each candidate comes with the contiguous block they "
            "could work starting at this slot (adjacent open slots chained "
            "up to their preferred daily hours, all legality-checked). "
            "Candidates are pre-sorted: daily minimum met first (lowest "
            "ytd_worked_pct among those); when NO block reaches the "
            "minimum, the LONGEST block first — one person on a longer "
            "stint beats two people on mini-stints. Take the FIRST unless "
            "you have a concrete reason. week_hours above contract_hours "
            "is LEGAL up to week_hours_max (personal tolerance) — do not "
            "avoid such candidates. Apply the chosen block as ONE "
            "apply_moves batch (all assigns together). "
            "meets_daily_minimum=false = would stay a short day - prefer "
            "candidates above it.",
            "candidates": out,
        }

    def _tool_suggest_rescue_moves(self, args: dict) -> dict:
        """Depth-1 rearrangement for the day's unfillable open slots: free a
        qualified clinician by unassigning ONE of their own working-copy
        assignments, put a substitute on the vacated slot, put the freed
        clinician on the stuck slot. Only net-gain, fully gate-validated
        batches are offered — the model applies them verbatim.

        This is what a human planner does before declaring a hole
        unfillable: 'X could do it if Y took over X's afternoon.'"""
        date_iso = args.get("dateISO")
        if date_iso not in self.ctx.target_date_set:
            return {
                "error": f"{date_iso} is outside the solve range "
                f"({self.ctx.start_iso} to {self.ctx.end_iso})."
            }
        entries = self._day_open_entries(date_iso)
        stuck_all = [e for e in entries if e["eligible_count"] == 0]
        # Search cap: a real production day showed 14 stuck slots — an
        # unexplained cap made the model puzzle over the missing ones, so
        # anything beyond it is reported as not_searched instead of silence.
        stuck = stuck_all[:16]
        not_searched = [e["slot_key"] for e in stuck_all[16:]]
        fillable_left = sum(1 for e in entries if e["eligible_count"] > 0)
        if not stuck:
            return {
                "dateISO": date_iso,
                "rescues": [],
                "note": "No unfillable open slot on this day — nothing to "
                "rescue."
                + (
                    " Fillable open slots remain: use suggest_day_blocks."
                    if fillable_left
                    else ""
                ),
            }

        def _new_hard(trial: Dict[Tuple[str, str, str], Assignment]) -> bool:
            hard = self._hard_violations(self._full_plan(list(trial.values())))
            return any(self._is_new_hard(v) for v in hard)

        rescues: List[dict] = []
        no_rescue: List[str] = []
        for entry in stuck:
            inst = self.ctx.instances[entry["raw_slot_key"]]
            found: List[dict] = []
            for clinician in self.state.clinicians:
                if len(found) >= 2:
                    break
                if inst.section_id not in (clinician.qualifiedClassIds or []):
                    continue
                cid = clinician.id
                identity = (inst.slot_id, date_iso, cid)
                if identity in self.current or identity in self.fixed_identity:
                    continue
                own_today = [
                    key
                    for key in self.current
                    if key[2] == cid and key[1] == date_iso
                ]
                if not own_today:
                    continue  # blocked by something no same-day move can fix
                # Cheap prune: if C cannot take the slot even with their
                # WHOLE day cleared, no single-move rescue exists either.
                trial_free = {
                    k: v for k, v in self.current.items() if k not in own_today
                }
                trial_free[identity] = self._make_assignment(
                    inst.slot_id, date_iso, cid
                )
                if _new_hard(trial_free):
                    continue
                for blocker in own_today:
                    trial = dict(self.current)
                    del trial[blocker]
                    trial[identity] = self._make_assignment(
                        inst.slot_id, date_iso, cid
                    )
                    if _new_hard(trial):
                        continue
                    vacated_key = f"{blocker[0]}__{date_iso}"
                    vac_inst = self.ctx.instances.get(vacated_key)
                    if vac_inst is None:
                        continue
                    # Net gain only: a substitute must cover the vacated
                    # slot in the SAME batch, else the hole just moves.
                    for sub in self.state.clinicians:
                        if vac_inst.section_id not in (sub.qualifiedClassIds or []):
                            continue
                        sub_id = (blocker[0], date_iso, sub.id)
                        if sub_id in trial or sub_id in self.fixed_identity:
                            continue
                        trial2 = dict(trial)
                        trial2[sub_id] = self._make_assignment(
                            blocker[0], date_iso, sub.id
                        )
                        if _new_hard(trial2):
                            continue
                        found.append(
                            {
                                "fills": entry["slot_key"],
                                "section": entry["section"],
                                "frees": self._alias(cid),
                                "vacated_slot": self._alias_slot_key(vacated_key),
                                "substitute": self._alias(sub.id),
                                "batch": [
                                    {
                                        "action": "unassign",
                                        "slot_key": self._alias_slot_key(vacated_key),
                                        "clinicianId": self._alias(cid),
                                    },
                                    {
                                        "action": "assign",
                                        "slot_key": self._alias_slot_key(vacated_key),
                                        "clinicianId": self._alias(sub.id),
                                    },
                                    {
                                        "action": "assign",
                                        "slot_key": entry["slot_key"],
                                        "clinicianId": self._alias(cid),
                                    },
                                ],
                            }
                        )
                        break  # one substitute per blocker is enough
                    if len(found) >= 2:
                        break
            if found:
                rescues.extend(found)
            else:
                no_rescue.append(entry["slot_key"])
        out = {
            "dateISO": date_iso,
            "note": "Each rescue is a pre-validated NET-GAIN batch: apply "
            "its 3 moves EXACTLY as given in ONE apply_moves call, then "
            "re-check with suggest_day_blocks (other rescues may have gone "
            "stale — re-query instead of applying several at once). Slots "
            "in truly_unfillable have no single-move rescue either: report "
            "them in your summary.",
            "rescues": rescues,
            "truly_unfillable": no_rescue,
        }
        if not_searched:
            out["not_searched"] = not_searched
            out["note"] += (
                " not_searched lists stuck slots beyond this call's search "
                "cap — call suggest_rescue_moves again after applying the "
                "offered rescues to cover them."
            )
        return out

    def _tool_suggest_balance_moves(self, args: dict) -> dict:
        """End-of-day review ('is everything in order?'): after the day is
        staffed, find what a human planner fixes on the final read-through —
        an over-long chained day next to colleagues who barely work, or a
        mini-stint day below the daily minimum. Offers single-handover
        batches (unassign donor, assign receiver to the same slots) that
        keep both days contiguous, never create a new over-long day or a
        new mini-stint, and pass the exact apply gate."""
        date_iso = args.get("dateISO")
        if date_iso not in self.ctx.target_date_set:
            return {
                "error": f"{date_iso} is outside the solve range "
                f"({self.ctx.start_iso} to {self.ctx.end_iso})."
            }

        def _contiguous(intervals: List[Tuple[int, int]]) -> bool:
            ivs = sorted(intervals)
            if not ivs:
                return True
            reach = ivs[0][1]
            for s, e in ivs[1:]:
                if s > reach:
                    return False
                reach = max(reach, e)
            return True

        def _new_hard(trial: Dict[Tuple[str, str, str], Assignment]) -> bool:
            hard = self._hard_violations(self._full_plan(list(trial.values())))
            return any(self._is_new_hard(v) for v in hard)

        # OUR movable assignments of the day per clinician (fixed/manual
        # ones are immutable anchors and never offered for transfer).
        own_by_cid: Dict[str, List[Tuple[Tuple[str, str, str], Any]]] = {}
        for key in self.current:
            if key[1] != date_iso:
                continue
            inst = self.ctx.instances.get(f"{key[0]}__{date_iso}")
            if inst is None:
                continue
            own_by_cid.setdefault(key[2], []).append((key, inst))

        fixed_today = {
            a.clinicianId
            for a in self.fixed_assignments
            if a.dateISO == date_iso and not a.rowId.startswith("pool-")
        }

        intervals: Dict[str, List[Tuple[int, int]]] = {}
        minutes: Dict[str, int] = {}

        def _stats(cid: str) -> Tuple[List[Tuple[int, int]], int]:
            if cid not in intervals:
                ivs = self._day_intervals(cid, date_iso)
                intervals[cid] = ivs
                minutes[cid] = sum(e - s for s, e in ivs)
            return intervals[cid], minutes[cid]

        # Problems: over-long days (auto-chains are capped, but duty
        # stacking, fixed anchors plus chains etc. still produce them) and
        # mini-stint days we could clear entirely because every piece is
        # our own placement.
        overlong: List[Tuple[int, str]] = []
        stubs: List[Tuple[int, str]] = []
        for cid in set(own_by_cid) | fixed_today:
            ivs, mins = _stats(cid)
            if mins <= 0:
                continue
            target = self._daily_target_minutes(cid, date_iso)
            if mins > target + 60:
                overlong.append((mins - (target + 60), cid))
            daily_min = self._daily_min_minutes(cid, date_iso)
            if (
                daily_min is not None
                and mins < daily_min
                and cid in own_by_cid
                and cid not in fixed_today
            ):
                stubs.append((mins, cid))
        overlong.sort(key=lambda t: (-t[0], t[1]))
        stubs.sort()

        def _receivers_for(insts: List[Any], donor: str) -> List[str]:
            ranked = []
            for clinician in self.state.clinicians:
                cid = clinician.id
                if cid == donor:
                    continue
                quals = set(clinician.qualifiedClassIds or [])
                if any(i.section_id not in quals for i in insts):
                    continue
                if any(
                    (i.slot_id, date_iso, cid) in self.current
                    or (i.slot_id, date_iso, cid) in self.fixed_identity
                    for i in insts
                ):
                    continue
                _, mins = _stats(cid)
                ytd = self.ytd_completion_pct(cid, date_iso)
                ranked.append((mins, ytd if ytd is not None else 999, cid))
            # Least-loaded first (a short-day colleague absorbing the slot
            # fixes two problems at once), most YTD-behind as tie-break.
            ranked.sort()
            return [r[-1] for r in ranked]

        def _try_transfer(
            donor: str, items: List[Tuple[Tuple[str, str, str], Any]], reason: str
        ) -> Optional[dict]:
            insts = [inst for _, inst in items]
            donor_ivs, donor_mins = _stats(donor)
            remaining = list(donor_ivs)
            for inst in insts:
                try:
                    remaining.remove((inst.start, inst.end))
                except ValueError:
                    return None
            if not _contiguous(remaining):
                return None  # would split the donor's day
            moved = sum(i.end - i.start for i in insts)
            donor_after = donor_mins - moved
            donor_min = self._daily_min_minutes(donor, date_iso)
            if (
                reason == "shorten_long_day"
                and donor_min is not None
                and 0 < donor_after < donor_min
            ):
                return None  # would trade an over-long day for a mini-stint
            for rid in _receivers_for(insts, donor):
                r_ivs, r_mins = _stats(rid)
                if not _contiguous(list(r_ivs) + [(i.start, i.end) for i in insts]):
                    continue  # receiver's day would have a gap
                r_after = r_mins + moved
                if r_after > self._daily_target_minutes(rid, date_iso) + 60:
                    continue  # would just create the next over-long day
                r_min = self._daily_min_minutes(rid, date_iso)
                if r_mins == 0 and r_min is not None and r_after < r_min:
                    continue  # calling someone in for a mini-stint solves nothing
                trial = dict(self.current)
                for identity, inst in items:
                    del trial[identity]
                    trial[(inst.slot_id, date_iso, rid)] = self._make_assignment(
                        inst.slot_id, date_iso, rid
                    )
                if _new_hard(trial):
                    continue
                batch = [
                    {
                        "action": "unassign",
                        "slot_key": self._alias_slot_key(inst.slot_key),
                        "clinicianId": self._alias(donor),
                    }
                    for _, inst in items
                ] + [
                    {
                        "action": "assign",
                        "slot_key": self._alias_slot_key(inst.slot_key),
                        "clinicianId": self._alias(rid),
                    }
                    for _, inst in items
                ]
                return {
                    "reason": reason,
                    "from": self._alias(donor),
                    "to": self._alias(rid),
                    "slots": [self._alias_slot_key(i.slot_key) for i in insts],
                    "donor_day_hours_before_after": [
                        round(donor_mins / 60.0, 1),
                        round(donor_after / 60.0, 1),
                    ],
                    "receiver_day_hours_before_after": [
                        round(r_mins / 60.0, 1),
                        round(r_after / 60.0, 1),
                    ],
                    "batch": batch,
                }
            return None

        offers: List[dict] = []
        # Mini-stints first: clearing one removes a short day outright (a
        # direct quality-tier win); the holder stays off entirely — better
        # one colleague works a little longer than someone comes in for 1h.
        for _, cid in stubs[:4]:
            offer = _try_transfer(cid, own_by_cid[cid], "clear_mini_stint")
            if offer:
                offers.append(offer)
        for _, cid in overlong[:3]:
            if len(offers) >= 6:
                break
            # Hand off an edge of the day, evening end first (contiguity
            # check rejects mid-day removals). One offer per donor per
            # call — the model re-calls after applying.
            for identity, inst in sorted(
                own_by_cid.get(cid, []), key=lambda t: (-t[1].end, t[1].slot_key)
            ):
                offer = _try_transfer(cid, [(identity, inst)], "shorten_long_day")
                if offer:
                    offers.append(offer)
                    break

        out: dict = {"dateISO": date_iso, "offers": offers}
        if overlong:
            out["overlong_days"] = [
                {
                    "clinicianId": self._alias(cid),
                    "day_hours": round(minutes[cid] / 60.0, 1),
                    "preferred_max_hours": round(
                        (self._daily_target_minutes(cid, date_iso) + 60) / 60.0, 1
                    ),
                }
                for _, cid in overlong
            ]
        if stubs:
            out["mini_stint_days"] = [
                {
                    "clinicianId": self._alias(cid),
                    "day_hours": round(minutes[cid] / 60.0, 1),
                }
                for _, cid in stubs
            ]
        if not overlong and not stubs:
            out["balanced"] = True
            out["note"] = (
                "No over-long day and no mini-stint day found — the day "
                "looks balanced. Finish with your day summary."
            )
        elif offers:
            out["note"] = (
                "Apply ONE offered batch EXACTLY as given (one apply_moves "
                "call), then call suggest_balance_moves again — the other "
                "offers go stale. Problems without an offer have no legal "
                "transfer; mention them in your summary."
            )
        else:
            out["note"] = (
                "Problems found but no legal transfer exists (contiguity, "
                "hours caps or hard rules block every handover). Mention "
                "them in your final day summary and finish."
            )
        return out

    def _greedy_day_block(
        self, cid: str, start_inst, counts: Dict[str, int]
    ) -> Tuple[List[str], int]:
        """Chain of adjacent, still-open, legal slots for ``cid`` starting at
        ``start_inst`` — forward in time first, then backward if the day is
        still below the clinician's daily target. Every extension is
        validated like a real move batch, so the returned block can be
        applied verbatim. Returns (raw slot keys, total minutes)."""
        clinician = self.clinicians_by_id.get(cid)
        if clinician is None:
            return [], 0
        qualified = set(clinician.qualifiedClassIds or [])
        date_iso = start_inst.date_iso

        target = self._daily_target_minutes(cid, date_iso)
        existing = sum(e - s for s, e in self._day_intervals(cid, date_iso))

        trial: Dict[Tuple[str, str, str], Assignment] = dict(self.current)
        taken: Dict[str, int] = {}

        def legal(inst) -> bool:
            key = (inst.slot_id, date_iso, cid)
            if key in trial or key in self.fixed_identity:
                return False
            room = inst.capacity - counts.get(inst.slot_key, 0) - taken.get(inst.slot_key, 0)
            if room <= 0:
                return False
            trial[key] = self._make_assignment(inst.slot_id, date_iso, cid)
            hard = self._hard_violations(self._full_plan(list(trial.values())))
            if any(self._is_new_hard(v) for v in hard):
                del trial[key]
                return False
            return True

        if not legal(start_inst):
            return [], 0
        taken[start_inst.slot_key] = 1
        chain = [start_inst.slot_key]
        block_start, block_end = start_inst.start, start_inst.end

        def extensions(forward: bool):
            edge = block_end if forward else block_start
            options = [
                i
                for i in self.ctx.instances.values()
                if i.date_iso == date_iso
                and i.section_id in qualified
                and (i.start == edge if forward else i.end == edge)
                and i.capacity - counts.get(i.slot_key, 0) - taken.get(i.slot_key, 0) > 0
            ]
            # Deterministic: shortest step first (finer-grained blocks give
            # the target check more chances to stop on time).
            options.sort(key=lambda i: (i.end - i.start, i.slot_key))
            return options

        for forward in (True, False):
            while existing + (block_end - block_start) < target:
                extended = False
                for inst in extensions(forward):
                    # A candidate slot may not push the day more than 1h past
                    # the preferred span — a 6h stint on top of a 7.5h block
                    # is not "Anschlussverwendung", it is a double shift.
                    span_after = (block_end - block_start) + (inst.end - inst.start)
                    if existing + span_after > target + 60:
                        continue
                    if legal(inst):
                        taken[inst.slot_key] = taken.get(inst.slot_key, 0) + 1
                        chain.append(inst.slot_key)
                        if forward:
                            block_end = inst.end
                        else:
                            block_start = inst.start
                        extended = True
                        break
                if not extended:
                    break

        return chain, block_end - block_start

    def _tool_apply_moves(self, args: dict) -> dict:
        moves = args.get("moves") or []
        rejected: List[dict] = []
        trial: Dict[Tuple[str, str, str], Assignment] = dict(self.current)
        trial_counts = self._counts_by_instance(list(trial.values()))

        for index, move in enumerate(moves):
            action = move.get("action")
            try:
                slot_id, date_iso = _split_slot_key(
                    self._resolve_slot_key(move.get("slot_key") or "")
                )
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
            if args.get("dry_run"):
                # Previews don't count as rejections and stay out of the feed.
                return {"dry_run": True, "valid": False, "rejected": rejected}
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
        trial_hard = self._hard_violations(self._full_plan(trial_list))
        new_hard = [
            {"code": v.code, "message": self._scrub(v.message)}
            for v in trial_hard
            if self._is_new_hard(v)
        ]
        if args.get("dry_run"):
            if new_hard:
                return {"dry_run": True, "valid": False, "new_hard_violations": new_hard}
            quality = self._quality(trial_list, hard_violations=trial_hard)
            return {
                "dry_run": True,
                "valid": True,
                "quality_after": self.quality_dict(quality),
                "improves_best": quality < self.best_quality,
            }
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
        quality = self._quality(trial_list, hard_violations=trial_hard)
        improved = quality < self.best_quality
        if quality <= self.best_quality:
            # Ties go to the newest state: the agent acted deliberately
            # (e.g. admin-instruction compliance the tiers don't measure).
            self.best_quality = quality
            self.best_score = self.encode_quality(quality)
            self.best_assignments = list(trial_list)
            if improved and self.on_improvement is not None:
                self.on_improvement(self.best_score, list(trial_list))
        described = [self._describe_move(m) for m in moves]
        self.accepted_move_log.extend(described)
        # Small models miss regressions in the raw counters: say it plainly
        # when the working copy just got worse than the snapshot that will
        # actually be returned.
        quality_note = None
        if quality > self.best_quality:
            quality_note = (
                "WARNING: this state is WORSE than the best snapshot "
                "(more open slots, short days or hours deviation). The run "
                "returns the best snapshot, not this state - revert these "
                "moves or improve beyond the previous best."
            )
        self._emit_activity(
            "moves_applied",
            {
                "moves": described,
                "improved": improved,
                "score": self.encode_quality(quality),
            },
        )
        result = {"applied": True, "verification": self._overview()}
        if quality_note:
            result["note"] = quality_note
        return result

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

    def _alias_slot_key(self, slot_key: str) -> str:
        """Raw "slot-<uuid>__date" -> LLM-facing "S3__date"."""
        try:
            sid, date_iso = _split_slot_key(slot_key)
        except ValueError:
            return slot_key
        return f"{self.slot_code_by_id.get(sid, sid)}__{date_iso}"

    def _resolve_slot_key(self, slot_key: str) -> str:
        """LLM-facing "S3__date" (or raw id) -> canonical raw key."""
        try:
            sid, date_iso = _split_slot_key(str(slot_key))
        except ValueError:
            return str(slot_key)
        return f"{self.slot_id_by_code.get(sid, sid)}__{date_iso}"

    def _resolve_clinician(self, alias_or_id: str) -> str:
        """Translate an LLM-facing alias (D1, ...) back to the real id.
        Real ids are accepted too, so in-process callers/tests keep working."""
        return self.id_by_alias.get(alias_or_id, alias_or_id)

    def _alias(self, clinician_id: Optional[str]) -> Optional[str]:
        if clinician_id is None:
            return None
        return self.alias_by_id.get(clinician_id, clinician_id)

    def _unscrub(self, text: str) -> str:
        """Kept for the harness contract: with real names as the LLM-facing
        identifiers there is nothing to restore — raw ids (should one ever
        appear in free text) are still mapped to names."""
        for cid, name in self.alias_by_id.items():
            if cid in text:
                text = text.replace(cid, name)
        return text

    def _scrub(self, text: str) -> str:
        """LLM-bound free text passes through with real names (the admin
        chose to drop pseudonymization); only raw ids are replaced by names
        so the model never has to deal with UUID-ish identifiers."""
        return self._unscrub(text)

    def scrub_text(self, text: str) -> str:
        """Public entry point for preparing LLM-bound free text."""
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
            slot_id, date_iso = _split_slot_key(
                self._resolve_slot_key(move.get("slot_key") or "")
            )
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
            "iteration": self.current_iteration,
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
