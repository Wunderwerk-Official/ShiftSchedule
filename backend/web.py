import json
import secrets
import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from .auth import _get_current_user
from .db import _get_connection, _utcnow_iso
from .models import AppState, UserPublic, WebPublishStatus
from .publication import (
    _compute_public_week_etag,
    _etag_matches,
    _format_http_datetime,
    _get_web_publication_by_token,
    _get_web_publication_by_username,
    _if_modified_since_matches,
    _web_token_exists,
)
from .state import (
    _load_state_blob_and_updated_at,
    _normalize_week_start,
    _parse_date_input,
    _parse_iso_datetime,
)

router = APIRouter()


@router.get("/v1/web/publish", response_model=WebPublishStatus)
def get_web_publication_status(current_user: UserPublic = Depends(_get_current_user)):
    publication = _get_web_publication_by_username(current_user.username)
    if not publication:
        return WebPublishStatus(published=False)
    return WebPublishStatus(published=True, token=publication["token"])


@router.post("/v1/web/publish", response_model=WebPublishStatus)
def publish_web(current_user: UserPublic = Depends(_get_current_user)):
    now = _utcnow_iso()
    conn = _get_connection()
    existing = conn.execute(
        "SELECT token FROM web_publications WHERE username = ?",
        (current_user.username,),
    ).fetchone()
    if existing:
        token = existing["token"]
        conn.execute(
            "UPDATE web_publications SET updated_at = ? WHERE username = ?",
            (now, current_user.username),
        )
        conn.commit()
        conn.close()
        return WebPublishStatus(published=True, token=token)

    for _ in range(10):
        token = secrets.token_urlsafe(32)
        if _web_token_exists(conn, token):
            continue
        try:
            conn.execute(
                """
                INSERT INTO web_publications (username, token, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (current_user.username, token, now, now),
            )
            conn.commit()
            conn.close()
            return WebPublishStatus(published=True, token=token)
        except sqlite3.IntegrityError:
            conn.rollback()
            # The conflict may be on the username primary key (a concurrent
            # publish won the race) rather than the token; return the
            # existing publication instead of retrying until a 500.
            raced = conn.execute(
                "SELECT token FROM web_publications WHERE username = ?",
                (current_user.username,),
            ).fetchone()
            if raced:
                conn.close()
                return WebPublishStatus(published=True, token=raced["token"])
            continue
    conn.close()
    raise HTTPException(status_code=500, detail="Failed to generate token.")


@router.post("/v1/web/publish/rotate", response_model=WebPublishStatus)
def rotate_web(current_user: UserPublic = Depends(_get_current_user)):
    now = _utcnow_iso()
    conn = _get_connection()
    existing = conn.execute(
        "SELECT token FROM web_publications WHERE username = ?",
        (current_user.username,),
    ).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="No publication found.")
    for _ in range(10):
        token = secrets.token_urlsafe(32)
        if _web_token_exists(conn, token):
            continue
        try:
            conn.execute(
                "UPDATE web_publications SET token = ?, updated_at = ? WHERE username = ?",
                (token, now, current_user.username),
            )
            conn.commit()
            conn.close()
            return WebPublishStatus(published=True, token=token)
        except sqlite3.IntegrityError:
            conn.rollback()
            continue
    conn.close()
    raise HTTPException(status_code=500, detail="Failed to generate token.")


@router.delete("/v1/web/publish", status_code=204)
def unpublish_web(current_user: UserPublic = Depends(_get_current_user)):
    conn = _get_connection()
    conn.execute("DELETE FROM web_publications WHERE username = ?", (current_user.username,))
    conn.commit()
    conn.close()


@router.get("/v1/web/{token}/week")
def get_public_web_week(
    token: str,
    start: str = Query(..., min_length=8),
    if_none_match: Optional[str] = Header(default=None),
    if_modified_since: Optional[str] = Header(default=None),
):
    publication = _get_web_publication_by_token(token)
    if not publication:
        raise HTTPException(status_code=404, detail="Link not found.")

    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    week_start_iso, week_end_iso = _normalize_week_start(start_iso)

    state_payload, state_updated_at, state_updated_at_raw = _load_state_blob_and_updated_at(
        publication["username"]
    )
    publication_updated_at_raw = publication["updated_at"] or ""
    publication_updated_at = _parse_iso_datetime(publication_updated_at_raw)
    last_modified = max(state_updated_at, publication_updated_at)
    etag = _compute_public_week_etag(
        token,
        week_start_iso,
        state_updated_at_raw,
        publication_updated_at_raw,
    )
    headers = {
        "Cache-Control": "private, max-age=0, must-revalidate",
        "ETag": etag,
        "Last-Modified": _format_http_datetime(last_modified),
        "Referrer-Policy": "no-referrer",
    }

    if _etag_matches(if_none_match, etag) or _if_modified_since_matches(
        if_modified_since, last_modified
    ):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)

    state = AppState.model_validate(state_payload)
    published_weeks = set(state.publishedWeekStartISOs or [])
    if week_start_iso not in published_weeks:
        return Response(
            content=json.dumps(
                {
                    "published": False,
                    "weekStartISO": week_start_iso,
                    "weekEndISO": week_end_iso,
                }
            ),
            media_type="application/json",
            headers=headers,
        )

    clinician_by_id = {clinician.id: clinician for clinician in state.clinicians}
    slot_ids = {
        slot.id
        for location in (state.weeklyTemplate.locations if state.weeklyTemplate else [])
        for slot in location.slots
    }
    pool_row_ids = {row.id for row in state.rows if row.kind == "pool"}
    assignments: List[Dict[str, Any]] = []
    for assignment in state.assignments:
        if assignment.dateISO < week_start_iso or assignment.dateISO > week_end_iso:
            continue
        if assignment.rowId not in slot_ids and assignment.rowId not in pool_row_ids:
            continue
        clinician = clinician_by_id.get(assignment.clinicianId)
        if not clinician:
            continue
        if any(
            vacation.startISO <= assignment.dateISO <= vacation.endISO
            for vacation in clinician.vacations
        ):
            continue
        assignments.append(assignment.model_dump())

    holidays = [
        holiday.model_dump()
        for holiday in state.holidays
        if week_start_iso <= holiday.dateISO <= week_end_iso
    ]

    payload = {
        "published": True,
        "weekStartISO": week_start_iso,
        "weekEndISO": week_end_iso,
        "locations": [loc.model_dump() for loc in state.locations],
        "locationsEnabled": state.locationsEnabled,
        "rows": [row.model_dump() for row in state.rows],
        "clinicians": [clinician.model_dump() for clinician in state.clinicians],
        "assignments": assignments,
        "minSlotsByRowId": {
            row_id: min_slots.model_dump()
            for row_id, min_slots in state.minSlotsByRowId.items()
        },
        "slotOverridesByKey": state.slotOverridesByKey,
        "weeklyTemplate": state.weeklyTemplate.model_dump()
        if state.weeklyTemplate
        else None,
        "holidays": holidays,
        "solverSettings": state.solverSettings,
        "solverRules": state.solverRules,
    }
    return Response(
        content=json.dumps(payload),
        media_type="application/json",
        headers=headers,
    )
