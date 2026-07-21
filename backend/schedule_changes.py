"""Per-user schedule change log: run applications and manual edits.

Users apply an agent/solver run and then fix the plan by hand; this table
records both so the timeline "run_applied(X) -> manual_edit -> ..." can be
reconstructed per user (each manual edit carries ``after_run_id``, the most
recently applied run at the time of the edit).

Two row kinds:
    run_applied  - a solver run was written into the schedule; ``diff`` holds
                   {run_id, range, assignments_added, assignments_replaced}.
    manual_edit  - a POST /v1/state save changed the schedule; ``diff`` holds
                   compact added/removed sets (shape below).

Diff scope is deliberately limited to what matters for plan diagnosis:
assignments, clinician vacations, holidays, and minSlotsByRowId. Structural
config edits (template, rows, solver settings/rules) produce NO row - a save
can legitimately log nothing.

Consecutive manual edits coalesce: the debounced client saves every 500ms
while a user drags things around, so within COALESCE_WINDOW_SECONDS the
latest manual_edit row is merged in place (add-then-remove cancels out)
instead of spraying one row per save.

Caveats for readers: ``run_id``/``after_run_id`` may reference runs that
``solver_runs`` has since pruned - never assume the join resolves. Two
concurrent saves by the same account can diff against the same old blob;
the schedule write itself is last-writer-wins (pre-existing), and the rare
duplicate change row is acceptable for a diagnostic log.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Query

from .auth import UserPublic, _require_admin
from .db import _get_connection, _utcnow, _utcnow_iso

KEPT_CHANGES_PER_USER = 1000
MAX_CHANGE_AGE_DAYS = 180
COALESCE_WINDOW_SECONDS = 120

router = APIRouter()


def _new_change_id() -> str:
    return f"chg-{int(time.time() * 1000):x}-{secrets.token_hex(3)}"


# ---------------------------------------------------------------------------
# Diffing (pure functions over raw AppState dict blobs)


def _clinician_names(old_blob: Dict[str, Any], new_blob: Dict[str, Any]) -> Dict[str, str]:
    names: Dict[str, str] = {}
    for blob in (old_blob, new_blob):  # new blob wins on rename
        for clinician in blob.get("clinicians") or []:
            if clinician.get("id") and clinician.get("name"):
                names[clinician["id"]] = clinician["name"]
    return names


def _assignment_map(blob: Dict[str, Any]) -> Dict[Tuple[Any, Any, Any], str]:
    # Keyed by (rowId, dateISO, clinicianId): the client regenerates
    # assignment ids, so identity by value is what makes diffs stable.
    out: Dict[Tuple[Any, Any, Any], str] = {}
    for assignment in blob.get("assignments") or []:
        key = (assignment.get("rowId"), assignment.get("dateISO"), assignment.get("clinicianId"))
        out[key] = assignment.get("source") or "unknown"
    return out


def _vacation_set(blob: Dict[str, Any]) -> set:
    out = set()
    for clinician in blob.get("clinicians") or []:
        for vacation in clinician.get("vacations") or []:
            out.add((clinician.get("id"), vacation.get("startISO"), vacation.get("endISO")))
    return out


def _holiday_set(blob: Dict[str, Any]) -> set:
    return {
        (holiday.get("dateISO"), holiday.get("name"))
        for holiday in blob.get("holidays") or []
    }


def compute_diff(old_blob: Dict[str, Any], new_blob: Dict[str, Any]) -> Dict[str, Any]:
    """Compact diff between two AppState blobs. Empty dict = nothing relevant
    changed. All categories are value-keyed sets so merge_diffs can cancel
    add-then-remove pairs exactly."""
    names = _clinician_names(old_blob, new_blob)
    diff: Dict[str, Any] = {}

    old_assignments = _assignment_map(old_blob)
    new_assignments = _assignment_map(new_blob)

    def assignment_entry(key: Tuple[Any, Any, Any], source: str) -> Dict[str, Any]:
        row_id, date_iso, clinician_id = key
        return {
            "row": row_id,
            "date": date_iso,
            "clinician_id": clinician_id,
            "clinician": names.get(clinician_id, clinician_id),
            "source": source,
        }

    added_keys = sorted(new_assignments.keys() - old_assignments.keys(), key=str)
    removed_keys = sorted(old_assignments.keys() - new_assignments.keys(), key=str)
    if added_keys or removed_keys:
        assignments: Dict[str, Any] = {}
        if added_keys:
            assignments["added"] = [assignment_entry(k, new_assignments[k]) for k in added_keys]
        if removed_keys:
            assignments["removed"] = [assignment_entry(k, old_assignments[k]) for k in removed_keys]
        diff["assignments"] = assignments

    old_vacations = _vacation_set(old_blob)
    new_vacations = _vacation_set(new_blob)

    def vacation_entry(item: Tuple[Any, Any, Any]) -> Dict[str, Any]:
        clinician_id, start_iso, end_iso = item
        return {
            "clinician_id": clinician_id,
            "clinician": names.get(clinician_id, clinician_id),
            "start": start_iso,
            "end": end_iso,
        }

    vac_added = sorted(new_vacations - old_vacations, key=str)
    vac_removed = sorted(old_vacations - new_vacations, key=str)
    if vac_added or vac_removed:
        vacations: Dict[str, Any] = {}
        if vac_added:
            vacations["added"] = [vacation_entry(v) for v in vac_added]
        if vac_removed:
            vacations["removed"] = [vacation_entry(v) for v in vac_removed]
        diff["vacations"] = vacations

    old_holidays = _holiday_set(old_blob)
    new_holidays = _holiday_set(new_blob)
    hol_added = sorted(new_holidays - old_holidays, key=str)
    hol_removed = sorted(old_holidays - new_holidays, key=str)
    if hol_added or hol_removed:
        holidays: Dict[str, Any] = {}
        if hol_added:
            holidays["added"] = [{"date": d, "name": n} for d, n in hol_added]
        if hol_removed:
            holidays["removed"] = [{"date": d, "name": n} for d, n in hol_removed]
        diff["holidays"] = holidays

    old_min_slots = old_blob.get("minSlotsByRowId") or {}
    new_min_slots = new_blob.get("minSlotsByRowId") or {}
    min_slots_changed = {}
    for row_id in set(old_min_slots) | set(new_min_slots):
        if old_min_slots.get(row_id) != new_min_slots.get(row_id):
            min_slots_changed[row_id] = {
                "old": old_min_slots.get(row_id),
                "new": new_min_slots.get(row_id),
            }
    if min_slots_changed:
        diff["minSlots"] = {"changed": min_slots_changed}

    return diff


_SET_CATEGORIES: Dict[str, Tuple[str, ...]] = {
    # category -> entry fields forming the identity key
    "assignments": ("row", "date", "clinician_id"),
    "vacations": ("clinician_id", "start", "end"),
    "holidays": ("date", "name"),
}


def merge_diffs(first: Dict[str, Any], second: Dict[str, Any]) -> Dict[str, Any]:
    """Merge two consecutive diffs into their net effect. For value-keyed
    sets: net_added = (A.added | B.added) - (A.removed | B.removed) and
    vice versa, so add-then-remove and remove-then-re-add both cancel."""
    merged: Dict[str, Any] = {}
    for category, key_fields in _SET_CATEGORIES.items():
        a_cat = first.get(category) or {}
        b_cat = second.get(category) or {}

        def entry_key(entry: Dict[str, Any]) -> Tuple[Any, ...]:
            return tuple(entry.get(field) for field in key_fields)

        added = {entry_key(e): e for e in (a_cat.get("added") or [])}
        added.update({entry_key(e): e for e in (b_cat.get("added") or [])})
        removed = {entry_key(e): e for e in (a_cat.get("removed") or [])}
        removed.update({entry_key(e): e for e in (b_cat.get("removed") or [])})
        net_added = {k: e for k, e in added.items() if k not in removed}
        net_removed = {k: e for k, e in removed.items() if k not in added}
        if net_added or net_removed:
            out: Dict[str, Any] = {}
            if net_added:
                out["added"] = [net_added[k] for k in sorted(net_added, key=str)]
            if net_removed:
                out["removed"] = [net_removed[k] for k in sorted(net_removed, key=str)]
            merged[category] = out

    a_min = (first.get("minSlots") or {}).get("changed") or {}
    b_min = (second.get("minSlots") or {}).get("changed") or {}
    min_changed = {}
    for row_id in set(a_min) | set(b_min):
        old_value = a_min[row_id]["old"] if row_id in a_min else b_min[row_id]["old"]
        new_value = b_min[row_id]["new"] if row_id in b_min else a_min[row_id]["new"]
        if old_value != new_value:
            min_changed[row_id] = {"old": old_value, "new": new_value}
    if min_changed:
        merged["minSlots"] = {"changed": min_changed}

    return merged


# ---------------------------------------------------------------------------
# Persistence


def last_applied_run_id(conn, username: str) -> Optional[str]:
    row = conn.execute(
        """
        SELECT run_id FROM schedule_changes
        WHERE username = ? AND kind = 'run_applied'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (username,),
    ).fetchone()
    return row["run_id"] if row else None


def _within_coalesce_window(previous_iso: str, now_iso: str) -> bool:
    try:
        previous = datetime.fromisoformat(previous_iso)
        now = datetime.fromisoformat(now_iso)
    except (TypeError, ValueError):
        return False
    return (now - previous).total_seconds() <= COALESCE_WINDOW_SECONDS


def _prune(conn, username: str) -> None:
    conn.execute(
        """
        DELETE FROM schedule_changes
        WHERE username = ? AND id NOT IN (
            SELECT id FROM schedule_changes
            WHERE username = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        )
        """,
        (username, username, KEPT_CHANGES_PER_USER),
    )
    cutoff = (_utcnow() - timedelta(days=MAX_CHANGE_AGE_DAYS)).isoformat()
    conn.execute(
        "DELETE FROM schedule_changes WHERE username = ? AND created_at < ?",
        (username, cutoff),
    )


def record_run_applied(
    username: str,
    run_id: str,
    start_iso: str,
    end_iso: str,
    added: int,
    replaced: int,
) -> str:
    now = _utcnow_iso()
    payload = {
        "run_id": run_id,
        "range": [start_iso, end_iso],
        "assignments_added": added,
        "assignments_replaced": replaced,
    }
    change_id = _new_change_id()
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO schedule_changes
                (id, username, kind, run_id, after_run_id, diff, created_at, updated_at)
            VALUES (?, ?, 'run_applied', ?, NULL, ?, ?, ?)
            """,
            (change_id, username, run_id, json.dumps(payload), now, now),
        )
        _prune(conn, username)
        conn.commit()
    return change_id


def record_manual_edit(
    username: str,
    old_blob: Dict[str, Any],
    new_blob: Dict[str, Any],
) -> Optional[str]:
    """Diff two state blobs and log the result. Returns the change row id,
    or None when nothing relevant changed."""
    diff = compute_diff(old_blob, new_blob)
    if not diff:
        return None
    now = _utcnow_iso()
    with _get_connection() as conn:
        after_run_id = last_applied_run_id(conn, username)
        latest = conn.execute(
            """
            SELECT id, kind, after_run_id, diff, updated_at FROM schedule_changes
            WHERE username = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (username,),
        ).fetchone()
        if (
            latest
            and latest["kind"] == "manual_edit"
            and latest["after_run_id"] == after_run_id
            and _within_coalesce_window(latest["updated_at"], now)
        ):
            merged = merge_diffs(json.loads(latest["diff"]), diff)
            if not merged:
                # The user undid everything since the previous save.
                conn.execute("DELETE FROM schedule_changes WHERE id = ?", (latest["id"],))
                conn.commit()
                return None
            conn.execute(
                "UPDATE schedule_changes SET diff = ?, updated_at = ? WHERE id = ?",
                (json.dumps(merged), now, latest["id"]),
            )
            conn.commit()
            return latest["id"]
        change_id = _new_change_id()
        conn.execute(
            """
            INSERT INTO schedule_changes
                (id, username, kind, run_id, after_run_id, diff, created_at, updated_at)
            VALUES (?, ?, 'manual_edit', NULL, ?, ?, ?, ?)
            """,
            (change_id, username, after_run_id, json.dumps(diff), now, now),
        )
        _prune(conn, username)
        conn.commit()
    return change_id


# ---------------------------------------------------------------------------
# Reading


def _derive_moves(diff: Dict[str, Any]) -> Dict[str, Any]:
    """Read-time view: pair up removed+added assignments with the same
    clinician and date (a move between rows). Stored diffs stay canonical
    add/remove sets so coalescing merges losslessly."""
    assignments = diff.get("assignments")
    if not assignments:
        return diff
    added = list(assignments.get("added") or [])
    removed_by_key: Dict[Tuple[Any, Any], List[Dict[str, Any]]] = {}
    for entry in assignments.get("removed") or []:
        removed_by_key.setdefault((entry.get("clinician_id"), entry.get("date")), []).append(entry)
    moves = []
    remaining_added = []
    for entry in added:
        candidates = removed_by_key.get((entry.get("clinician_id"), entry.get("date")))
        if candidates:
            source = candidates.pop(0)
            moves.append(
                {
                    "clinician_id": entry.get("clinician_id"),
                    "clinician": entry.get("clinician"),
                    "date": entry.get("date"),
                    "from_row": source.get("row"),
                    "to_row": entry.get("row"),
                }
            )
        else:
            remaining_added.append(entry)
    if not moves:
        return diff
    remaining_removed = [e for entries in removed_by_key.values() for e in entries]
    shaped = dict(diff)
    shaped_assignments: Dict[str, Any] = {"moved": moves}
    if remaining_added:
        shaped_assignments["added"] = remaining_added
    if remaining_removed:
        shaped_assignments["removed"] = remaining_removed
    shaped["assignments"] = shaped_assignments
    return shaped


def list_changes(
    username: Optional[str] = None,
    after_run_id: Optional[str] = None,
    since: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []
    if username:
        clauses.append("username = ?")
        params.append(username)
    if after_run_id:
        clauses.append("(after_run_id = ? OR run_id = ?)")
        params.extend([after_run_id, after_run_id])
    if since:
        clauses.append("created_at >= ?")
        params.append(since)
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)
    with _get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM schedule_changes
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    changes = []
    for row in rows:
        try:
            diff = json.loads(row["diff"])
        except (TypeError, ValueError):
            diff = {"raw": row["diff"]}
        if row["kind"] == "manual_edit":
            diff = _derive_moves(diff)
        changes.append(
            {
                "id": row["id"],
                "username": row["username"],
                "kind": row["kind"],
                "run_id": row["run_id"],
                "after_run_id": row["after_run_id"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "diff": diff,
            }
        )
    return changes


@router.get("/v1/admin/schedule-changes")
def admin_list_schedule_changes(
    username: Optional[str] = None,
    after_run_id: Optional[str] = None,
    since: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = Query(100, ge=1, le=1000),
    _: UserPublic = Depends(_require_admin),
):
    return {
        "changes": list_changes(
            username=username,
            after_run_id=after_run_id,
            since=since,
            kind=kind,
            limit=limit,
        )
    }
