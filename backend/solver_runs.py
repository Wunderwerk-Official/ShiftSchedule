"""Persistent solver-run records: the backbone of background solving.

A solve used to live and die with one long HTTP request — every layer
between browser and backend (proxy timeouts, deploys, browser closes)
could kill it, and the result evaporated with the connection. Now every
run is a ROW: created when the run starts, updated by the monitor thread,
and the finished plan stays here until the admin APPLIES it to the
schedule (or discards it). The UI's run inbox reads this table.

Statuses:
    running    - subprocess alive (or restarted after a backend restart)
    finished   - plan computed and stored in `result`, awaiting apply
    aborted    - stopped by the user; a salvaged partial result may exist
    failed     - crashed / errored; `error` says why
    crashed    - interrupted by a backend restart and NOT auto-restarted
    applied    - result written into the schedule
    discarded  - result rejected by the admin
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .db import _get_connection, _utcnow_iso

# Terminal states that still carry an applicable result.
APPLICABLE_STATUSES = {"finished", "aborted"}
# Keep the run inbox bounded per user; older terminal runs are pruned.
KEPT_RUNS_PER_USER = 20


def create_run(
    run_id: str,
    username: str,
    start_iso: str,
    end_iso: str,
    params: Dict[str, Any],
    attempt: int = 1,
    input_fingerprint: Optional[str] = None,
) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO solver_runs
                (id, username, status, start_iso, end_iso, params, attempt,
                 created_at, input_fingerprint)
            VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                username,
                start_iso,
                end_iso,
                json.dumps(params),
                attempt,
                _utcnow_iso(),
                input_fingerprint,
            ),
        )
        _prune(conn, username)
        conn.commit()


def set_fingerprint(run_id: str, input_fingerprint: str) -> None:
    """Restarted runs replan against the CURRENT calendar - the change
    check at apply time must compare against that, not the original."""
    with _get_connection() as conn:
        conn.execute(
            "UPDATE solver_runs SET input_fingerprint = ? WHERE id = ?",
            (input_fingerprint, run_id),
        )
        conn.commit()


def finish_run(
    run_id: str,
    status: str,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    note: Optional[str] = None,
) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            UPDATE solver_runs
            SET status = ?, finished_at = ?, result = ?, error = ?,
                notes = COALESCE(notes, '') || ?
            WHERE id = ?
            """,
            (
                status,
                _utcnow_iso(),
                json.dumps(result) if result is not None else None,
                error,
                (note + "\n") if note else "",
                run_id,
            ),
        )
        conn.commit()


def mark_run(run_id: str, status: str, note: Optional[str] = None) -> None:
    with _get_connection() as conn:
        applied_at = _utcnow_iso() if status == "applied" else None
        conn.execute(
            """
            UPDATE solver_runs
            SET status = ?,
                applied_at = COALESCE(?, applied_at),
                notes = COALESCE(notes, '') || ?
            WHERE id = ?
            """,
            (status, applied_at, (note + "\n") if note else "", run_id),
        )
        conn.commit()


def bump_attempt(run_id: str, note: str) -> None:
    with _get_connection() as conn:
        conn.execute(
            """
            UPDATE solver_runs
            SET attempt = attempt + 1, status = 'running',
                finished_at = NULL,
                notes = COALESCE(notes, '') || ?
            WHERE id = ?
            """,
            (note + "\n", run_id),
        )
        conn.commit()


def get_run(run_id: str, username: str) -> Optional[Dict[str, Any]]:
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM solver_runs WHERE id = ? AND username = ?",
            (run_id, username),
        ).fetchone()
    return _row_to_dict(row) if row else None


def get_run_any_user(run_id: str) -> Optional[Dict[str, Any]]:
    """Admin access: fetch a run regardless of owner (for reviewing runs
    that users sent feedback about)."""
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM solver_runs WHERE id = ?", (run_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_runs(username: str, limit: int = KEPT_RUNS_PER_USER) -> List[Dict[str, Any]]:
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM solver_runs
            WHERE username = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (username, limit),
        ).fetchall()
    return [_row_to_dict(r, include_result=False) for r in rows]


def interrupted_runs() -> List[Dict[str, Any]]:
    """Runs still marked 'running' — after a backend (re)start none of them
    can have a live subprocess; the caller decides restart vs crashed."""
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM solver_runs WHERE status = 'running'"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def _prune(conn, username: str) -> None:
    # Runs a user commented on stay around so the admin can still open
    # the log the comment refers to.
    conn.execute(
        """
        DELETE FROM solver_runs
        WHERE username = ? AND status != 'running'
          AND id NOT IN (SELECT run_id FROM run_feedback)
          AND id NOT IN (
            SELECT id FROM solver_runs
            WHERE username = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        )
        """,
        (username, username, KEPT_RUNS_PER_USER),
    )


# Small slice of debugInfo.agent shipped with LIST responses so the inbox
# can show per-run token usage / cost without downloading full results.
_AGENT_USAGE_KEYS = (
    "model",
    "iterations",
    "moves_accepted",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


def _row_to_dict(row, include_result: bool = True) -> Dict[str, Any]:
    d = dict(row)
    d["params"] = json.loads(d["params"]) if d.get("params") else {}
    raw_result = d.pop("result", None)
    d["has_result"] = bool(raw_result)
    if raw_result:
        parsed = None
        try:
            parsed = json.loads(raw_result)
        except (ValueError, TypeError):
            d["has_result"] = False
        if parsed is not None:
            if include_result:
                d["result"] = parsed
            agent = (parsed.get("debugInfo") or {}).get("agent")
            if isinstance(agent, dict):
                d["agent_usage"] = {
                    k: agent.get(k) for k in _AGENT_USAGE_KEYS if agent.get(k) is not None
                }
    return d


# ---------------------------------------------------------------------------
# Run feedback: a user attaches a comment to a run and it lands with the
# admin, who reads it next to the run's log.

FEEDBACK_MAX_LENGTH = 4000


def add_feedback(feedback_id: str, run_id: str, username: str, comment: str) -> Dict[str, Any]:
    created_at = _utcnow_iso()
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO run_feedback (id, run_id, username, comment, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (feedback_id, run_id, username, comment, created_at),
        )
        conn.commit()
    return {
        "id": feedback_id,
        "run_id": run_id,
        "username": username,
        "comment": comment,
        "created_at": created_at,
    }


def list_feedback(limit: int = 100) -> List[Dict[str, Any]]:
    """All feedback entries (admin view), newest first, with the run's
    range/status joined in so the list is readable without extra fetches."""
    with _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT f.id, f.run_id, f.username, f.comment, f.created_at,
                   r.start_iso, r.end_iso, r.status AS run_status,
                   r.result IS NOT NULL AS run_has_result
            FROM run_feedback f
            LEFT JOIN solver_runs r ON r.id = f.run_id
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    out = []
    for row in rows:
        d = dict(row)
        d["run_has_result"] = bool(d.get("run_has_result"))
        out.append(d)
    return out


def delete_feedback(feedback_id: str) -> bool:
    with _get_connection() as conn:
        cur = conn.execute("DELETE FROM run_feedback WHERE id = ?", (feedback_id,))
        conn.commit()
    return cur.rowcount > 0
