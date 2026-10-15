from contextlib import closing
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from .auth import _get_current_user
from .account_lifecycle import authenticated_account_connection
from .db import _get_connection, _utcnow_iso
from .ical import generate_ics
from .models import (
    IcalPublishStatus,
    UserPublic,
)
from .publication import (
    _build_publish_status,
    _compute_etag,
    _get_clinician_publication_by_token,
    _get_publication_by_token,
    _get_publication_by_username,
    _new_token,
    _not_modified,
    _public_cache_headers,
    _token_exists,
    _ensure_clinician_publications,
)
from .state import _load_state, _load_state_blob_and_updated_at, _parse_iso_datetime

router = APIRouter()


@router.get("/v1/ical/publish", response_model=IcalPublishStatus)
def get_ical_publication_status(
    request: Request, current_user: UserPublic = Depends(_get_current_user)
):
    with authenticated_account_connection(current_user) as conn:
        publication = _get_publication_by_username(current_user.username, connection=conn)
        if not publication:
            return IcalPublishStatus(published=False)
        state = _load_state(current_user.username, connection=conn)
        clinician_rows = _ensure_clinician_publications(conn, current_user.username, state.clinicians)
        return _build_publish_status(request, publication, clinician_rows, state.clinicians)


@router.post("/v1/ical/publish", response_model=IcalPublishStatus)
def publish_ical(
    request: Request,
    current_user: UserPublic = Depends(_get_current_user),
):
    with authenticated_account_connection(current_user) as conn:
        state = _load_state(current_user.username, connection=conn)
        existing = conn.execute(
            "SELECT token FROM ical_publications WHERE username = ?",
            (current_user.username,),
        ).fetchone()
        if existing:
            # Idempotent: touching updated_at would invalidate every
            # subscriber's cache each time the export dialog opens.
            token = existing["token"]
        else:
            now = _utcnow_iso()
            token = _new_token(conn, _token_exists)
            conn.execute(
                """
                INSERT INTO ical_publications (
                    username, token, start_date_iso, end_date_iso, cal_name, created_at, updated_at
                )
                VALUES (?, ?, NULL, NULL, NULL, ?, ?)
                """,
                (current_user.username, token, now, now),
            )
        clinician_rows = _ensure_clinician_publications(
            conn, current_user.username, state.clinicians
        )
        return _build_publish_status(request, {"token": token}, clinician_rows, state.clinicians)


@router.post("/v1/ical/publish/rotate", response_model=IcalPublishStatus)
def rotate_ical(
    request: Request, current_user: UserPublic = Depends(_get_current_user)
):
    with authenticated_account_connection(current_user) as conn:
        now = _utcnow_iso()
        state = _load_state(current_user.username, connection=conn)
        existing = conn.execute(
            "SELECT token FROM ical_publications WHERE username = ?",
            (current_user.username,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="No publication found.")
        token = _new_token(conn, _token_exists)
        conn.execute(
            "UPDATE ical_publications SET token = ?, updated_at = ? WHERE username = ?",
            (token, now, current_user.username),
        )
        conn.execute(
            "DELETE FROM ical_clinician_publications WHERE username = ?",
            (current_user.username,),
        )
        clinician_rows = _ensure_clinician_publications(
            conn, current_user.username, state.clinicians
        )
        return _build_publish_status(request, {"token": token}, clinician_rows, state.clinicians)


@router.delete("/v1/ical/publish", status_code=204)
def unpublish_ical(current_user: UserPublic = Depends(_get_current_user)):
    with authenticated_account_connection(current_user) as conn:
        conn.execute("DELETE FROM ical_publications WHERE username = ?", (current_user.username,))
        conn.execute(
            "DELETE FROM ical_clinician_publications WHERE username = ?",
            (current_user.username,),
        )


@router.get("/v1/ical/{token}.ics")
@router.head("/v1/ical/{token}.ics", include_in_schema=False)
def download_ical(
    token: str,
    request: Request,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
    if_modified_since: Optional[str] = Header(default=None, alias="If-Modified-Since"),
):
    # Resolve both kinds of bearer link and the calendar in one snapshot.
    with closing(_get_connection()) as conn, conn:
        conn.execute("BEGIN")
        publication = _get_publication_by_token(token, connection=conn)
        clinician_scope = None
        if not publication:
            publication = _get_clinician_publication_by_token(token, connection=conn)
            if not publication:
                raise HTTPException(status_code=404, detail="Not found.")
            clinician_scope = publication["clinician_id"]

        owner = publication["username"]
        app_state, state_updated_at, state_updated_at_raw = _load_state_blob_and_updated_at(
            owner, connection=conn
        )
    publication_updated_at_raw = publication["updated_at"] or ""
    publication_updated_at = _parse_iso_datetime(publication_updated_at_raw)
    last_modified = max(state_updated_at, publication_updated_at)
    etag = _compute_etag(
        token,
        state_updated_at_raw or "",
        publication_updated_at_raw or "",
        app_state,
        dict(publication),
    )
    headers = _public_cache_headers(etag, last_modified)
    if _not_modified(if_none_match, if_modified_since, etag, last_modified):
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
    # Header values are Latin-1; keep the plain filename ASCII (generic when the
    # account name is not quote-safe ASCII) and carry the account name in the
    # RFC 6266 UTF-8 form so any username is safe.
    filename = f"shift-planner-{owner}.ics"
    plain_safe = (
        filename.isascii() and filename.isprintable() and not any(c in filename for c in '"\\')
    )
    plain_filename = filename if plain_safe else "shift-planner.ics"
    headers["Content-Disposition"] = (
        f"inline; filename=\"{plain_filename}\"; filename*=UTF-8''" + quote(filename, safe="")
    )
    return Response(content=ics, media_type="text/calendar", headers=headers)
