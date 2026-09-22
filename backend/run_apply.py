"""Validate and commit a stored draft against one locked calendar snapshot."""
from contextlib import closing
from dataclasses import asdict
import hashlib
import json

from fastapi import HTTPException

from . import solver_runs, schedule_changes
from .account_lifecycle import account_lock, require_current_account
from .assignment_policy import is_protected_assignment
from .db import _get_connection, _utcnow_iso
from .models import AppState, Assignment
from .snapshots import _write_auto_backup
from .state import _load_state, _normalize_state, _save_state
from .validation import validate_assignments
from .constraint_policy import violation_key, is_new_or_worsened


def planning_fingerprint(state: AppState) -> str:
    # Include boundary assignments and history: rest, weekly hours and YTD
    # fairness all depend on context outside the requested dates.
    data = state.model_dump(exclude={"revision", "publishedWeekStartISOs",
                                     "holidayCountry", "holidayYear"})
    data["solverSettings"].pop("scheduleLayout", None)
    return "v2:" + hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _candidate(state, run):
    start, end = run["start_iso"], run["end_iso"]
    vacations = {c.id: c.vacations for c in state.clinicians}
    kept = [a for a in state.assignments if (
        a.rowId.startswith("pool-") or not start <= a.dateISO <= end
        or is_protected_assignment(a)
        or any(v.startISO <= a.dateISO <= v.endISO for v in vacations.get(a.clinicianId, []))
    )]
    identity = lambda a: (a.rowId, a.dateISO, a.clinicianId)
    seen = {identity(a) for a in kept}
    additions = []
    for raw in run["result"].get("assignments", []):
        a = Assignment.model_validate(raw)
        if start <= a.dateISO <= end and identity(a) not in seen:
            seen.add(identity(a))
            additions.append(a)
    combined = kept + additions
    removed = sum(identity(a) not in seen for a in state.assignments)
    return kept, combined, len(additions), len(state.assignments) - len(kept), removed


def _new_violations(state, baseline, combined, only_required):
    check = lambda plan: validate_assignments(state, plan, only_fill_required=only_required).violations
    baseline_context = {violation_key(v): v.context for v in check(baseline)}
    return [asdict(v) for v in check(combined)
            if is_new_or_worsened(v, baseline_context)]


def result_safety(run):
    result = run.get("result") or {}
    agent = (result.get("debugInfo") or {}).get("agent") or {}
    pending_checks = [t["dateISO"] for t in (agent.get("tasks") or {}).get("tasks", [])
                      if t.get("kind") == "required_check" and t.get("status") != "complete" and t.get("dateISO")]
    dates = sorted(set(pending_checks + agent.get("daysSkipped", []) + agent.get("daysIncomplete", [])
                       + [g["dateISO"] for g in agent.get("unsolved", {}).get("open_slots", [])]))
    empty_abort = run["status"] == "aborted" and not any(
        run["start_iso"] <= a.get("dateISO", "") <= run["end_iso"]
        and not a.get("rowId", "").startswith("pool-")
        for a in result.get("assignments", [])
    )
    return empty_abort, dates


def apply_stored_run(username, run_id, *, force=False, allow_partial=False, expected_revision=None,
                     account_user=None):
    with account_lock(username), closing(_get_connection()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        if account_user is not None:
            if account_user.username != username:
                raise HTTPException(401, "Account session is no longer valid.")
            require_current_account(conn, account_user)
        row = conn.execute("SELECT * FROM solver_runs WHERE id = ? AND username = ?",
                           (run_id, username)).fetchone()
        if row is None:
            raise HTTPException(404, "No such run.")
        run = solver_runs._row_to_dict(row)
        if run["status"] not in solver_runs.APPLICABLE_STATUSES or not run.get("result"):
            raise HTTPException(409, f"Run is {run['status']} and has no applicable result.")
        empty_abort, incomplete_dates = result_safety(run)
        if empty_abort:
            raise HTTPException(409, detail={"code": "empty_result", "message":
                "This run was stopped before it produced a plan. The existing calendar has been kept."})

        state = _load_state(username, connection=conn)
        baseline, combined, added, replaced, removed = _candidate(state, run)
        # Normalization also checks day types and block/section references.
        # Refuse a draft that would silently lose assignments on the next GET.
        candidate_state = state.model_copy(deep=True)
        candidate_state.assignments = combined
        normalized, _ = _normalize_state(candidate_state)
        if normalized.assignments != combined:
            raise HTTPException(409, detail={"code": "plan_invalid", "message":
                "This draft contains assignments that no longer match the current template "
                "or holiday calendar. Please generate a new draft."})
        only_required = run.get("params", {}).get("only_fill_required", False)
        violations = _new_violations(state, baseline, combined, only_required)
        if violations:
            raise HTTPException(409, detail={"code": "plan_invalid", "message":
                "This draft conflicts with the current calendar: " +
                "; ".join(v["message"] for v in violations[:5]), "violations": violations})

        # Old fingerprints cannot prove which roster/template was used.
        stored = run.get("input_fingerprint")
        if ((expected_revision and expected_revision != state.revision)
                or (not force and stored != planning_fingerprint(state))):
            raise HTTPException(409, detail={"code": "calendar_changed", "message":
                "The calendar or planning settings changed since this draft was started. "
                f"Applying it will remove {removed} existing assignment(s) and add {added}. "
                "The draft has passed the current rule checks. Apply it anyway?",
                "revision": state.revision})

        from .scoring import build_scoring_context, open_slots
        candidate_state = state.model_copy(update={"assignments": combined})
        gaps = open_slots(build_scoring_context(candidate_state, run["start_iso"],
                          run["end_iso"], only_fill_required=only_required), [])
        incomplete_dates = sorted(set(incomplete_dates + [g.dateISO for g in gaps]))
        if not allow_partial and (run["status"] == "aborted" or incomplete_dates):
            dates = ", ".join(incomplete_dates[:12]) or "coverage not verified after interruption"
            if len(incomplete_dates) > 12:
                dates += f", and {len(incomplete_dates) - 12} more days"
            raise HTTPException(409, detail={"code": "partial_result", "message":
                f"This draft is incomplete or was stopped. {sum(g.missing for g in gaps)} required "
                f"position(s) remain open. Affected dates: {dates}. Applying replaces the entire "
                f"requested range and removes {removed} existing assignment(s). "
                "Apply this partial draft anyway?", "revision": state.revision,
                "dates": incomplete_dates, "removed_assignments": removed})

        _write_auto_backup(conn, username, state, name="Auto-backup before applying plan")
        state.assignments = combined
        _save_state(state, username, connection=conn)
        conn.execute("UPDATE solver_runs SET status = 'applied', applied_at = ?, "
                     "notes = COALESCE(notes, '') || ? WHERE id = ?",
                     (_utcnow_iso(), f"Applied {added} assignments.\n", run_id))
        schedule_changes.record_run_applied(
            username, run_id, run["start_iso"], run["end_iso"], added, replaced, connection=conn,
        )
        return run, added, replaced
