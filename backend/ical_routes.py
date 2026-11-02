from contextlib import closing
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from .auth import _get_current_user
from .account_lifecycle import authenticated_account_connection
from .db import _get_connection, _utcnow_iso
from .ical import ICS_FORMAT_SINCE, generate_ics, ical_calendar_name, ical_file_name
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

        app_state, state_updated_at, state_updated_at_raw = _load_state_blob_and_updated_at(
            publication["username"], connection=conn
        )
    person = None
    if clinician_scope:
        # A personal link ends with its person (the token row goes with the
        # next save; this also covers rows left from before that).
        person = next(
            (c for c in app_state.get("clinicians") or [] if c.get("id") == clinician_scope),
            None,
        )
        if person is None:
            raise HTTPException(status_code=404, detail="Not found.")
    publication_updated_at_raw = publication["updated_at"] or ""
    publication_updated_at = _parse_iso_datetime(publication_updated_at_raw)
    last_modified = max(state_updated_at, publication_updated_at, ICS_FORMAT_SINCE)
    etag = _compute_etag(
        token,
        state_updated_at_raw or "",
        publication_updated_at_raw or "",
        app_state,
        dict(publication),
        ICS_FORMAT_SINCE.isoformat(),
    )
    headers = _public_cache_headers(etag, last_modified)
    if _not_modified(if_none_match, if_modified_since, etag, last_modified):
        return Response(status_code=304, headers=headers)

    ics = generate_ics(
        app_state,
        app_state.get("publishedWeekStartISOs") or [],
        ical_calendar_name(person),
        clinician_id=clinician_scope,
        dtstamp=last_modified,
    )
    # Names never carry the account's login name; the file name is ASCII.
    headers["Content-Disposition"] = f'inline; filename="{ical_file_name(person)}"'
    return Response(content=ics, media_type="text/calendar", headers=headers)
