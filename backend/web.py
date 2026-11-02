import json
from contextlib import closing
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from .auth import _get_current_user
from .account_lifecycle import authenticated_account_connection
from .db import _get_connection, _utcnow_iso
from .models import AppState, Clinician, UserPublic, WebPublishStatus
from .preferences import _read_preferences
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
    _normalize_state,
    _parse_iso_datetime,
    _parse_stored_state,
)

router = APIRouter()


def _shift_iso(date_iso: str, days: int) -> str:
    return (date.fromisoformat(date_iso) + timedelta(days=days)).isoformat()


def _on_vacation(clinician: Clinician, date_iso: str) -> bool:
    return any(vacation.startISO <= date_iso <= vacation.endISO for vacation in clinician.vacations)


def _rest_context_assignments(
    state: AppState,
    week_start_iso: str,
    week_end_iso: str,
    clinician_by_id: Dict[str, Clinician],
) -> List[Dict[str, str]]:
    """On-call shifts outside the week that put a rest day into it.

    With the on-call rest rule, a night on Sunday makes Monday a rest day (and
    one on the next Monday the Sunday before). The public page derives rest
    days from on-call shifts like the admin's calendar, so it needs these
    shifts too: only the on-call section's, only from the days whose rest
    reaches into the week (onCallRestDaysAfter before it, onCallRestDaysBefore
    after it), and reduced to who, when and which slot. They are never shown.
    """
    settings = state.solverSettings or {}
    on_call_class_id = settings.get("onCallRestClassId")
    if not settings.get("onCallRestEnabled") or not on_call_class_id:
        return []

    def rest_days(key: str) -> int:
        # Same bounds as _normalize_state.
        try:
            return max(0, min(7, int(settings.get(key, 1))))
        except (TypeError, ValueError):
            return 1

    days_after = rest_days("onCallRestDaysAfter")
    days_before = rest_days("onCallRestDaysBefore")
    template = state.weeklyTemplate
    if template is None or (days_after == 0 and days_before == 0):
        return []
    on_call_block_ids = {
        block.id for block in template.blocks or [] if block.sectionId == on_call_class_id
    }
    on_call_slot_ids = {
        slot.id
        for location in template.locations
        for slot in location.slots
        if slot.blockId in on_call_block_ids
    }
    earliest_iso = _shift_iso(week_start_iso, -days_after)
    latest_iso = _shift_iso(week_end_iso, days_before)
    context: List[Dict[str, str]] = []
    for assignment in state.assignments:
        if week_start_iso <= assignment.dateISO <= week_end_iso:
            continue
        if not earliest_iso <= assignment.dateISO <= latest_iso:
            continue
        if assignment.rowId not in on_call_slot_ids:
            continue
        clinician = clinician_by_id.get(assignment.clinicianId)
        # On vacation the shift is hidden in the calendar and gives no rest day.
        if not clinician or _on_vacation(clinician, assignment.dateISO):
            continue
        context.append({
            "clinicianId": assignment.clinicianId,
            "dateISO": assignment.dateISO,
            "rowId": assignment.rowId,
        })
    context.sort(key=lambda item: (item["dateISO"], item["clinicianId"], item["rowId"]))
    return context


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
        # The owner's Times choice (side by side / stacked), so the link
        # shows the week as they see it. Nothing else of their preferences.
        team_time_layout = _read_preferences(conn, publication["username"]).teamTimeLayout
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
        team_time_layout,
    )
    headers = _public_cache_headers(etag, last_modified)
    if _not_modified(if_none_match, if_modified_since, etag, last_modified):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)

    # Cleaned like GET /v1/state (in memory only): entries with impossible
    # dates stored before v1.78 must not hide shifts from readers.
    state, _ = _normalize_state(_parse_stored_state(state_payload))
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
        if _on_vacation(clinician, assignment.dateISO):
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
        # Only for deriving rest days at the week's edges (see above).
        "restContextAssignments": _rest_context_assignments(
            state, week_start_iso, week_end_iso, clinician_by_id
        ),
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
        "teamTimeLayout": team_time_layout,
    }
    return Response(
        content=json.dumps(payload),
        media_type="application/json",
        headers=headers,
    )
