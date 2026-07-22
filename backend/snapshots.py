"""Named calendar snapshots ("quicksave").

The admin saves the current calendar under a name and can restore, rename,
or delete versions later. Each snapshot stores the FULL AppState blob —
never assignments alone: both normalizers silently drop assignments that
don't match the CURRENT template, so a partial restore against a changed
template would lose data (the historic client-side snapshot export had
exactly that flaw).

Restore safety: before overwriting the live state, the current calendar is
written into ONE reserved auto-backup slot per user (enforced by a partial
unique index), so an accidental restore is always reversible.
"""

from __future__ import annotations

import json
from typing import Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import _get_current_user
from .db import _get_connection, _utcnow_iso
from .models import AppState, UserPublic
from .state import _load_state, _normalize_state, _save_state

router = APIRouter()

# Reject creation at the cap instead of silently pruning (the solver_runs
# pattern) — deleting USER-NAMED data behind the user's back is hostile.
MAX_NAMED_SNAPSHOTS_PER_USER = 30
SNAPSHOT_NAME_MAX_CHARS = 100
AUTO_BACKUP_NAME = "Auto-backup before restore"


class SnapshotMeta(BaseModel):
    id: str
    name: str
    kind: Literal["named", "auto_backup"]
    created_at: str
    updated_at: str
    size_bytes: int


class SnapshotCreateRequest(BaseModel):
    name: str
    # The client sends the SAME normalized payload its auto-save builds:
    # the server's app_state row lags the screen by the 500ms debounce, so
    # "copy my stored row" could miss the user's last edit.
    state: AppState


class SnapshotRestoreRequest(BaseModel):
    # Basis for the auto-backup; falls back to the stored row when absent.
    currentState: Optional[AppState] = None


class SnapshotRenameRequest(BaseModel):
    name: str


def _clean_name(raw: str) -> str:
    name = (raw or "").strip()[:SNAPSHOT_NAME_MAX_CHARS]
    if not name:
        raise HTTPException(status_code=400, detail="Snapshot name must not be empty.")
    return name


def _row_to_meta(row) -> SnapshotMeta:
    return SnapshotMeta(
        id=row["id"],
        name=row["name"],
        kind=row["kind"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        size_bytes=row["size_bytes"],
    )


_META_COLUMNS = "id, name, kind, created_at, updated_at, LENGTH(data) AS size_bytes"


def _write_auto_backup(conn, username: str, state: AppState) -> None:
    """Upsert the user's single auto-backup slot from the given state."""
    now = _utcnow_iso()
    normalized, _ = _normalize_state(state)
    blob = json.dumps(normalized.model_dump())
    existing = conn.execute(
        "SELECT id FROM calendar_snapshots WHERE username = ? AND kind = 'auto_backup'",
        (username,),
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE calendar_snapshots SET data = ?, created_at = ?, updated_at = ? WHERE id = ?",
            (blob, now, now, existing["id"]),
        )
    else:
        conn.execute(
            """
            INSERT INTO calendar_snapshots (id, username, name, kind, data, created_at, updated_at)
            VALUES (?, ?, ?, 'auto_backup', ?, ?, ?)
            """,
            (uuid4().hex, username, AUTO_BACKUP_NAME, blob, now, now),
        )


@router.get("/v1/state/snapshots", response_model=list[SnapshotMeta])
def list_snapshots(current_user: UserPublic = Depends(_get_current_user)):
    with _get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT {_META_COLUMNS} FROM calendar_snapshots
            WHERE username = ?
            ORDER BY created_at DESC, id DESC
            """,
            (current_user.username,),
        ).fetchall()
    return [_row_to_meta(r) for r in rows]


@router.post("/v1/state/snapshots", response_model=SnapshotMeta, status_code=201)
def create_snapshot(
    payload: SnapshotCreateRequest,
    current_user: UserPublic = Depends(_get_current_user),
):
    name = _clean_name(payload.name)
    normalized, _ = _normalize_state(payload.state)
    blob = json.dumps(normalized.model_dump())
    now = _utcnow_iso()
    snapshot_id = uuid4().hex
    with _get_connection() as conn:
        named_count = conn.execute(
            "SELECT COUNT(*) AS n FROM calendar_snapshots WHERE username = ? AND kind = 'named'",
            (current_user.username,),
        ).fetchone()["n"]
        if named_count >= MAX_NAMED_SNAPSHOTS_PER_USER:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Snapshot limit reached ({MAX_NAMED_SNAPSHOTS_PER_USER}). "
                    "Delete an old snapshot first."
                ),
            )
        conn.execute(
            """
            INSERT INTO calendar_snapshots (id, username, name, kind, data, created_at, updated_at)
            VALUES (?, ?, ?, 'named', ?, ?, ?)
            """,
            (snapshot_id, current_user.username, name, blob, now, now),
        )
        conn.commit()
        row = conn.execute(
            f"SELECT {_META_COLUMNS} FROM calendar_snapshots WHERE id = ?",
            (snapshot_id,),
        ).fetchone()
    return _row_to_meta(row)


@router.post("/v1/state/snapshots/{snapshot_id}/restore", response_model=AppState)
def restore_snapshot(
    snapshot_id: str,
    payload: SnapshotRestoreRequest,
    current_user: UserPublic = Depends(_get_current_user),
):
    username = current_user.username
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT data FROM calendar_snapshots WHERE id = ? AND username = ?",
            (snapshot_id, username),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Snapshot not found.")
        backup_basis = (
            payload.currentState if payload.currentState is not None else _load_state(username)
        )
        _write_auto_backup(conn, username, backup_basis)
        conn.commit()
    # Same validation path old app_state rows take on load: unknown future
    # fields are ignored, missing ones get defaults — no migration needed.
    restored = AppState.model_validate(json.loads(row["data"]))
    normalized, _ = _normalize_state(restored)
    _save_state(normalized, username)
    return normalized


@router.patch("/v1/state/snapshots/{snapshot_id}", response_model=SnapshotMeta)
def rename_snapshot(
    snapshot_id: str,
    payload: SnapshotRenameRequest,
    current_user: UserPublic = Depends(_get_current_user),
):
    name = _clean_name(payload.name)
    with _get_connection() as conn:
        row = conn.execute(
            "SELECT kind FROM calendar_snapshots WHERE id = ? AND username = ?",
            (snapshot_id, current_user.username),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Snapshot not found.")
        if row["kind"] == "auto_backup":
            raise HTTPException(
                status_code=400, detail="The automatic backup cannot be renamed."
            )
        conn.execute(
            "UPDATE calendar_snapshots SET name = ?, updated_at = ? WHERE id = ?",
            (name, _utcnow_iso(), snapshot_id),
        )
        conn.commit()
        meta = conn.execute(
            f"SELECT {_META_COLUMNS} FROM calendar_snapshots WHERE id = ?",
            (snapshot_id,),
        ).fetchone()
    return _row_to_meta(meta)


@router.delete("/v1/state/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(
    snapshot_id: str,
    current_user: UserPublic = Depends(_get_current_user),
):
    with _get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM calendar_snapshots WHERE id = ? AND username = ?",
            (snapshot_id, current_user.username),
        )
        conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Snapshot not found.")
