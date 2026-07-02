import json
import secrets
import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from .auth import _get_current_user
from .db import _get_connection, _utcnow_iso
from .models import (
    IcalPublishRequest,
    IcalPublishStatus,
    UserPublic,
)
from .publication import (
    _build_publish_status,
    _compute_public_etag,
    _etag_matches,
    _format_http_datetime,
    _get_clinician_publication_by_token,
    _get_publication_by_token,
    _get_publication_by_username,
    _if_modified_since_matches,
    _token_exists,
    _ensure_clinician_publications,
)
from .state import _load_state, _load_state_blob_and_updated_at, _parse_iso_datetime

try:
    from backend.ical import generate_ics
except ImportError:  # pragma: no cover
    from ical import generate_ics

router = APIRouter()


@router.get("/v1/ical/publish", response_model=IcalPublishStatus)
def get_ical_publication_status(
    request: Request, current_user: UserPublic = Depends(_get_current_user)
):
    publication = _get_publication_by_username(current_user.username)
    if not publication:
        return IcalPublishStatus(published=False)
    state = _load_state(current_user.username)
    conn = _get_connection()
    clinician_rows = _ensure_clinician_publications(conn, current_user.username, state.clinicians)
    conn.commit()
    conn.close()
    return _build_publish_status(request, publication, clinician_rows, state.clinicians)


@router.post("/v1/ical/publish", response_model=IcalPublishStatus)
def publish_ical(
    request: Request,
    current_user: UserPublic = Depends(_get_current_user),
    _payload: Optional[IcalPublishRequest] = None,
):
    now = _utcnow_iso()
    conn = _get_connection()
    existing = conn.execute(
        "SELECT token FROM ical_publications WHERE username = ?",
        (current_user.username,),
    ).fetchone()
    if existing:
        token = existing["token"]
        conn.execute(
            """
            UPDATE ical_publications
            SET updated_at = ?
            WHERE username = ?
            """,
            (now, current_user.username),
        )
        state = _load_state(current_user.username)
        clinician_rows = _ensure_clinician_publications(
            conn, current_user.username, state.clinicians
        )
        conn.commit()
        conn.close()
        return _build_publish_status(request, {"token": token}, clinician_rows, state.clinicians)

    for _ in range(10):
        token = secrets.token_urlsafe(32)
        if _token_exists(conn, token):
            continue
        try:
            conn.execute(
                """
                INSERT INTO ical_publications (
                    username, token, start_date_iso, end_date_iso, cal_name, created_at, updated_at
                )
                VALUES (?, ?, NULL, NULL, NULL, ?, ?)
                """,
                (current_user.username, token, now, now),
            )
            state = _load_state(current_user.username)
            clinician_rows = _ensure_clinician_publications(
                conn, current_user.username, state.clinicians
            )
            conn.commit()
            conn.close()
            return _build_publish_status(request, {"token": token}, clinician_rows, state.clinicians)
        except sqlite3.IntegrityError:
            conn.rollback()
            # The conflict may be on the username primary key (a concurrent
            # publish won the race) rather than the token; return the
            # existing publication instead of retrying until a 500.
            raced = conn.execute(
                "SELECT token FROM ical_publications WHERE username = ?",
                (current_user.username,),
            ).fetchone()
            if raced:
                state = _load_state(current_user.username)
                clinician_rows = _ensure_clinician_publications(
                    conn, current_user.username, state.clinicians
                )
                conn.commit()
                conn.close()
                return _build_publish_status(
                    request, {"token": raced["token"]}, clinician_rows, state.clinicians
                )
            continue
    conn.close()
    raise HTTPException(status_code=500, detail="Failed to generate token.")


@router.post("/v1/ical/publish/rotate", response_model=IcalPublishStatus)
def rotate_ical(
    request: Request, current_user: UserPublic = Depends(_get_current_user)
):
    now = _utcnow_iso()
    conn = _get_connection()
    existing = conn.execute(
        "SELECT token FROM ical_publications WHERE username = ?",
        (current_user.username,),
    ).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="No publication found.")
    for _ in range(10):
        token = secrets.token_urlsafe(32)
        if _token_exists(conn, token):
            continue
        try:
            conn.execute(
                "UPDATE ical_publications SET token = ?, updated_at = ? WHERE username = ?",
                (token, now, current_user.username),
            )
            conn.execute(
                "DELETE FROM ical_clinician_publications WHERE username = ?",
                (current_user.username,),
            )
            state = _load_state(current_user.username)
            clinician_rows = _ensure_clinician_publications(
                conn, current_user.username, state.clinicians
            )
            conn.commit()
            conn.close()
            return _build_publish_status(request, {"token": token}, clinician_rows, state.clinicians)
        except sqlite3.IntegrityError:
            conn.rollback()
            continue
    conn.close()
    raise HTTPException(status_code=500, detail="Failed to generate token.")


@router.delete("/v1/ical/publish", status_code=204)
def unpublish_ical(current_user: UserPublic = Depends(_get_current_user)):
    conn = _get_connection()
    conn.execute("DELETE FROM ical_publications WHERE username = ?", (current_user.username,))
    conn.execute(
        "DELETE FROM ical_clinician_publications WHERE username = ?",
        (current_user.username,),
    )
    conn.commit()
    conn.close()


@router.get("/v1/ical/{token}.ics")
def download_ical(
    token: str,
    request: Request,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
    if_modified_since: Optional[str] = Header(default=None, alias="If-Modified-Since"),
):
    publication = _get_publication_by_token(token)
    clinician_scope = None
    if not publication:
        publication = _get_clinician_publication_by_token(token)
        if not publication:
            raise HTTPException(status_code=404, detail="Not found.")
        clinician_scope = publication["clinician_id"]

    owner = publication["username"]
    app_state, state_updated_at, state_updated_at_raw = _load_state_blob_and_updated_at(owner)
    publication_updated_at_raw = publication["updated_at"] or ""
    publication_updated_at = _parse_iso_datetime(publication_updated_at_raw)
    last_modified = max(state_updated_at, publication_updated_at)
    etag = _compute_public_etag(
        token=token,
        state_updated_at=state_updated_at_raw,
        publication_updated_at=publication_updated_at_raw,
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
        return Response(status_code=304, headers=headers)

    cal_name = f"Shift Planner ({owner})"
    if clinician_scope:
        clinician_name = None
        for clinician in app_state.get("clinicians") or []:
            if clinician.get("id") == clinician_scope:
                clinician_name = clinician.get("name")
                break
        if clinician_name:
            cal_name = f"Shift Planner ({clinician_name})"
    ics = generate_ics(
        app_state,
        app_state.get("publishedWeekStartISOs") or [],
        cal_name,
        clinician_id=clinician_scope,
        dtstamp=last_modified,
    )
    headers["Content-Disposition"] = f'inline; filename="shift-planner-{owner}.ics"'
    return Response(content=ics, media_type="text/calendar", headers=headers)
