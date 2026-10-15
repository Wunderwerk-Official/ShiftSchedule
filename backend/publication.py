import json
import os
import secrets
import sqlite3
from email.utils import format_datetime, parsedate_to_datetime
from hashlib import sha256
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException, Request

from .db import _utcnow_iso
from .models import Clinician, IcalPublishAllLink, IcalPublishClinicianLink, IcalPublishStatus

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip()


def _etag_matches(if_none_match: Optional[str], etag: str) -> bool:
    if not if_none_match:
        return False
    raw = if_none_match.strip()
    if raw == "*":
        return True
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    for part in parts:
        if part == etag:
            return True
        if part.startswith("W/") and part[2:].strip() == etag:
            return True
    return False


def _if_modified_since_matches(
    if_modified_since: Optional[str], last_modified
) -> bool:
    if not if_modified_since:
        return False
    try:
        parsed = parsedate_to_datetime(if_modified_since)
    except (TypeError, ValueError):
        return False
    if parsed is None:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=last_modified.tzinfo)
    parsed_utc = parsed.astimezone(last_modified.tzinfo).replace(microsecond=0)
    return parsed_utc >= last_modified


def _compute_etag(*parts: Any) -> str:
    # Timestamps have second precision; separate edits within one second
    # still represent different calendars and must invalidate the cache.
    payload = json.dumps(list(parts), sort_keys=True, separators=(",", ":"))
    digest = sha256(payload.encode("utf-8")).hexdigest()
    return f"\"{digest}\""


def _public_cache_headers(etag: str, last_modified) -> Dict[str, str]:
    return {
        "Cache-Control": "private, max-age=0, must-revalidate",
        "ETag": etag,
        "Last-Modified": _format_http_datetime(last_modified),
        "Referrer-Policy": "no-referrer",
    }


def _not_modified(
    if_none_match: Optional[str], if_modified_since: Optional[str], etag: str, last_modified
) -> bool:
    # RFC 9110: If-None-Match takes precedence over If-Modified-Since.
    return _etag_matches(if_none_match, etag) or (
        if_none_match is None
        and _if_modified_since_matches(if_modified_since, last_modified)
    )


def _build_subscribe_url(request: Request, token: str) -> str:
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    return f"{base}/v1/ical/{token}.ics"


def _token_exists(conn: sqlite3.Connection, token: str) -> bool:
    row = conn.execute(
        """
        SELECT token FROM ical_publications WHERE token = ?
        UNION
        SELECT token FROM ical_clinician_publications WHERE token = ?
        LIMIT 1
        """,
        (token, token),
    ).fetchone()
    return row is not None


def _web_token_exists(conn: sqlite3.Connection, token: str) -> bool:
    row = conn.execute(
        "SELECT token FROM web_publications WHERE token = ? LIMIT 1",
        (token,),
    ).fetchone()
    return row is not None


def _new_token(conn: sqlite3.Connection, exists: Callable[[sqlite3.Connection, str], bool]) -> str:
    """Return a fresh token unused by ``exists``.

    Callers hold the account's write transaction (account lock + BEGIN
    IMMEDIATE), so no other writer can claim the token or the row between
    this check and their INSERT/UPDATE.
    """
    for _ in range(10):
        token = secrets.token_urlsafe(32)
        if not exists(conn, token):
            return token
    raise HTTPException(status_code=500, detail="Failed to generate token.")


def _get_publication_by_username(username: str, *, connection) -> Optional[sqlite3.Row]:
    return connection.execute(
        """
        SELECT username, token, start_date_iso, end_date_iso, cal_name, created_at, updated_at
        FROM ical_publications
        WHERE username = ?
        """,
        (username,),
    ).fetchone()


def _get_web_publication_by_username(username: str, *, connection) -> Optional[sqlite3.Row]:
    return connection.execute(
        """
        SELECT username, token, created_at, updated_at
        FROM web_publications
        WHERE username = ?
        """,
        (username,),
    ).fetchone()


def _get_web_publication_by_token(token: str, *, connection) -> Optional[sqlite3.Row]:
    return connection.execute(
        """
        SELECT username, token, created_at, updated_at
        FROM web_publications
        WHERE token = ?
        """,
        (token,),
    ).fetchone()


def _get_publication_by_token(token: str, *, connection) -> Optional[sqlite3.Row]:
    return connection.execute(
        """
        SELECT username, token, start_date_iso, end_date_iso, cal_name, created_at, updated_at
        FROM ical_publications
        WHERE token = ?
        """,
        (token,),
    ).fetchone()


def _get_clinician_publication_by_token(token: str, *, connection) -> Optional[sqlite3.Row]:
    return connection.execute(
        """
        SELECT username, clinician_id, token, created_at, updated_at
        FROM ical_clinician_publications
        WHERE token = ?
        """,
        (token,),
    ).fetchone()


def _get_clinician_publications_for_user(
    conn: sqlite3.Connection, username: str
) -> Dict[str, Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT clinician_id, token, created_at, updated_at
        FROM ical_clinician_publications
        WHERE username = ?
        """,
        (username,),
    ).fetchall()
    return {row["clinician_id"]: dict(row) for row in rows}


def _ensure_clinician_publications(
    conn: sqlite3.Connection, username: str, clinicians: List[Clinician]
) -> Dict[str, Dict[str, Any]]:
    now = _utcnow_iso()
    existing = _get_clinician_publications_for_user(conn, username)
    for clinician in clinicians:
        if clinician.id in existing:
            continue
        token = _new_token(conn, _token_exists)
        conn.execute(
            """
            INSERT INTO ical_clinician_publications (
                username, clinician_id, token, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (username, clinician.id, token, now, now),
        )
        existing[clinician.id] = {
            "clinician_id": clinician.id,
            "token": token,
            "created_at": now,
            "updated_at": now,
        }
    return existing


def _build_publish_status(
    request: Request,
    publication: sqlite3.Row,
    clinician_rows: Dict[str, Dict[str, Any]],
    clinicians: List[Clinician],
) -> IcalPublishStatus:
    all_link = IcalPublishAllLink(
        subscribeUrl=_build_subscribe_url(request, publication["token"])
    )
    clinician_links = []
    for clinician in clinicians:
        row = clinician_rows.get(clinician.id)
        if not row:
            continue
        clinician_links.append(
            IcalPublishClinicianLink(
                clinicianId=clinician.id,
                clinicianName=clinician.name,
                subscribeUrl=_build_subscribe_url(request, row["token"]),
            )
        )
    return IcalPublishStatus(published=True, all=all_link, clinicians=clinician_links)


def _format_http_datetime(dt) -> str:
    return format_datetime(dt, usegmt=True)
