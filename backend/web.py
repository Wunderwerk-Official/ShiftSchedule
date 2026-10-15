import json
from contextlib import closing
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from .auth import _get_current_user
from .account_lifecycle import authenticated_account_connection
from .db import _get_connection, _utcnow_iso
from .models import AppState, UserPublic, WebPublishStatus
from .publication import (
    _compute_etag,
    _get_web_publication_by_token,
    _get_web_publication_by_username,
    _new_token,
    _not_modified,
    _public_cache_headers,
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
    with authenticated_account_connection(current_user, write=False) as conn:
        publication = _get_web_publication_by_username(current_user.username, connection=conn)
        if not publication:
            return WebPublishStatus(published=False)
        return WebPublishStatus(published=True, token=publication["token"])


@router.post("/v1/web/publish", response_model=WebPublishStatus)
def publish_web(current_user: UserPublic = Depends(_get_current_user)):
    with authenticated_account_connection(current_user) as conn:
        now = _utcnow_iso()
        existing = conn.execute(
            "SELECT token FROM web_publications WHERE username = ?",
            (current_user.username,),
        ).fetchone()
        if existing:
            # Idempotent like publish_ical: touching updated_at would change
            # the public week ETag/Last-Modified for every viewer.
            return WebPublishStatus(published=True, token=existing["token"])

        token = _new_token(conn, _web_token_exists)
        conn.execute(
            """
            INSERT INTO web_publications (username, token, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (current_user.username, token, now, now),
        )
        return WebPublishStatus(published=True, token=token)


@router.post("/v1/web/publish/rotate", response_model=WebPublishStatus)
def rotate_web(current_user: UserPublic = Depends(_get_current_user)):
    with authenticated_account_connection(current_user) as conn:
        now = _utcnow_iso()
        existing = conn.execute(
            "SELECT token FROM web_publications WHERE username = ?",
            (current_user.username,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="No publication found.")
        token = _new_token(conn, _web_token_exists)
        conn.execute(
            "UPDATE web_publications SET token = ?, updated_at = ? WHERE username = ?",
            (token, now, current_user.username),
        )
        return WebPublishStatus(published=True, token=token)


@router.delete("/v1/web/publish", status_code=204)
def unpublish_web(current_user: UserPublic = Depends(_get_current_user)):
    with authenticated_account_connection(current_user) as conn:
        conn.execute("DELETE FROM web_publications WHERE username = ?", (current_user.username,))


@router.get("/v1/web/{token}/week")
def get_public_web_week(
    token: str,
    start: str = Query(..., min_length=8),
    if_none_match: Optional[str] = Header(default=None),
    if_modified_since: Optional[str] = Header(default=None),
):
    start_iso = _parse_date_input(start)
    if not start_iso:
        raise HTTPException(status_code=400, detail="Start date required.")
    week_start_iso, week_end_iso = _normalize_week_start(start_iso)

    # The token owner and their calendar must come from the same snapshot.
    # Deletion/recreation under the same name cannot retarget an old link.
    with closing(_get_connection()) as conn, conn:
        conn.execute("BEGIN")
        publication = _get_web_publication_by_token(token, connection=conn)
        if not publication:
            raise HTTPException(status_code=404, detail="Link not found.")
        state_payload, state_updated_at, state_updated_at_raw = _load_state_blob_and_updated_at(
            publication["username"], connection=conn
        )
    publication_updated_at_raw = publication["updated_at"] or ""
    publication_updated_at = _parse_iso_datetime(publication_updated_at_raw)
    last_modified = max(state_updated_at, publication_updated_at)
    etag = _compute_etag(
        token,
        week_start_iso,
        state_updated_at_raw or "",
        publication_updated_at_raw or "",
        state_payload,
        dict(publication),
    )
    headers = _public_cache_headers(etag, last_modified)
    if _not_modified(if_none_match, if_modified_since, etag, last_modified):
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
        # Public links expose a rendered week, not personnel planning records.
        # Keep only fields used by the public grid and clip absences to this week.
        "clinicians": [
            {
                "id": clinician.id,
                "name": clinician.name,
                "qualifiedClassIds": clinician.qualifiedClassIds,
                "vacations": [
                    {"id": vacation.id,
                     "startISO": max(vacation.startISO, week_start_iso),
                     "endISO": min(vacation.endISO, week_end_iso)}
                    for vacation in clinician.vacations
                    if vacation.startISO <= week_end_iso and vacation.endISO >= week_start_iso
                ],
            }
            for clinician in state.clinicians
        ],
        "assignments": assignments,
        "minSlotsByRowId": {
            row_id: min_slots.model_dump()
            for row_id, min_slots in state.minSlotsByRowId.items()
        },
        # Clamp to the requested (published) week like assignments/holidays —
        # override keys are `${slotId}__${dateISO}`; slot ids may contain "__",
        # so split at the LAST separator.
        "slotOverridesByKey": {
            key: value
            for key, value in (state.slotOverridesByKey or {}).items()
            if week_start_iso <= key.rsplit("__", 1)[-1] <= week_end_iso
        },
        "weeklyTemplate": state.weeklyTemplate.model_dump()
        if state.weeklyTemplate
        else None,
        "holidays": holidays,
        "solverSettings": {
            key: value for key, value in state.solverSettings.items()
            if key in {"scheduleLayout", "onCallRestEnabled", "onCallRestClassId",
                       "onCallRestDaysBefore", "onCallRestDaysAfter"}
        },
        "solverRules": [],
    }
    return Response(
        content=json.dumps(payload),
        media_type="application/json",
        headers=headers,
    )
