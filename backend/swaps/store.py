"""SQL for the swap tables (swap_requests, swap_events, swap_settings).

Every function runs inside the caller's transaction and never commits.
Timestamps come from the request's injected ``now`` (``iso_utc``), so one
clock drives the stored times, retention and undo checks.
"""

import json
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from .policy import SWAP_RETENTION_DAYS

SWAP_COLUMNS = (
    "id", "username", "kind", "status", "requester_id", "partner_id", "give_items", "take_items", "summary",
    "note", "consent", "created_via", "created_by", "approver_name", "notice_override",
    "acknowledged_warnings", "starts_at", "expires_at", "client_request_id", "created_at", "updated_at",
    "decided_at", "decided_by", "applied_at", "applied_revision", "applied_patch", "change_id",
    "reverted_at", "reverted_by", "reverted_revision", "revert_change_id",
)
JSON_COLUMNS = ("give_items", "take_items", "summary", "acknowledged_warnings", "applied_patch")


def new_swap_id() -> str:
    return f"swp-{int(time.time() * 1000):x}-{secrets.token_hex(3)}"


def new_event_id() -> str:
    return f"swe-{int(time.time() * 1000):x}-{secrets.token_hex(3)}"


def iso_utc(now: datetime) -> str:
    """UTC ISO string with second resolution, the format of ``db._utcnow_iso``."""
    return now.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def read_settings(conn: sqlite3.Connection, username: str) -> Dict[str, Any]:
    """The calendar's swap_settings object; {} without a row or with a broken one."""
    row = conn.execute("SELECT data FROM swap_settings WHERE username = ?", (username,)).fetchone()
    if row is None:
        return {}
    try:
        data = json.loads(row[0])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def insert_swap(conn: sqlite3.Connection, row: Dict[str, Any]) -> None:
    """Insert one swap row (every column of swap_requests; JSON columns as
    Python values). Stage 1 only records applied planner swaps, so a row
    without partner or consent, or with another status, is refused."""
    if not row["partner_id"] or not row["consent"] or row["status"] != "applied":
        raise ValueError("A planner swap needs a partner, consent and status 'applied'.")
    values = [
        json.dumps(row[column]) if column in JSON_COLUMNS and row[column] is not None else row[column]
        for column in SWAP_COLUMNS
    ]
    placeholders = ", ".join("?" for _ in SWAP_COLUMNS)
    conn.execute(f"INSERT INTO swap_requests ({', '.join(SWAP_COLUMNS)}) VALUES ({placeholders})", values)


def _decoded(row: sqlite3.Row) -> Dict[str, Any]:
    swap = dict(row)
    for column in JSON_COLUMNS:
        if swap[column] is not None:
            swap[column] = json.loads(swap[column])
    return swap


def get_swap(conn: sqlite3.Connection, username: str, swap_id: str) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM swap_requests WHERE username = ? AND id = ?",
                       (username, swap_id)).fetchone()
    return _decoded(row) if row is not None else None


def list_swaps(
    conn: sqlite3.Connection,
    username: str,
    *,
    limit: int,
    before: Optional[str],
    before_id: Optional[str],
) -> List[Dict[str, Any]]:
    """Newest first (created_at, then id). The cursor is the last row's
    (created_at, id): created_at has second resolution, so rows sharing the
    boundary second are told apart by id and never skipped."""
    where = "username = ?"
    params: List[Any] = [username]
    if before is not None and before_id is not None:
        where += " AND (created_at < ? OR (created_at = ? AND id < ?))"
        params += [before, before, before_id]
    elif before is not None:
        where += " AND created_at < ?"
        params.append(before)
    rows = conn.execute(
        f"SELECT * FROM swap_requests WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    return [_decoded(row) for row in rows]


def mark_reverted(
    conn: sqlite3.Connection,
    username: str,
    swap_id: str,
    *,
    reverted_at: str,
    reverted_by: str,
    revision: str,
    change_id: str,
) -> None:
    conn.execute(
        "UPDATE swap_requests SET status = 'reverted', reverted_at = ?, reverted_by = ?, "
        "reverted_revision = ?, revert_change_id = ?, updated_at = ? WHERE username = ? AND id = ?",
        (reverted_at, reverted_by, revision, change_id, reverted_at, username, swap_id),
    )


def add_event(
    conn: sqlite3.Connection,
    username: str,
    request_id: str,
    actor: str,
    action: str,
    detail: Dict[str, Any],
    created_at: str,
) -> None:
    """Append to the audit log (stage 1: "applied" and "reverted")."""
    conn.execute(
        "INSERT INTO swap_events (id, request_id, username, actor, action, detail, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (new_event_id(), request_id, username, actor, action, json.dumps(detail), created_at),
    )


def prune(conn: sqlite3.Connection, username: str, now: datetime) -> None:
    """Retention: finished swaps and their events go once their last update is
    older than SWAP_RETENTION_DAYS (two years, the record keeping of § 16 ArbZG)."""
    cutoff = iso_utc(now - timedelta(days=SWAP_RETENTION_DAYS))
    conn.execute(
        "DELETE FROM swap_events WHERE username = ? AND request_id IN "
        "(SELECT id FROM swap_requests WHERE username = ? "
        "AND status IN ('applied', 'reverted') AND updated_at < ?)",
        (username, username, cutoff),
    )
    conn.execute(
        "DELETE FROM swap_requests WHERE username = ? "
        "AND status IN ('applied', 'reverted') AND updated_at < ?",
        (username, cutoff),
    )
