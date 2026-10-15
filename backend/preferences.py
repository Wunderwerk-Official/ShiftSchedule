"""Per-user UI preferences for the "My plan" view.

One JSON row per login: who "I am" in the plan, remembered range and
orientation, saved views and the start view per device class. These are
viewing choices of one person, so they live outside AppState: saving them
never changes the calendar revision or a planning fingerprint.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from .account_lifecycle import authenticated_account_connection
from .auth import _get_current_user
from .db import _utcnow_iso
from .models import UserPreferences, UserPublic

router = APIRouter()
logger = logging.getLogger(__name__)

# Validation already bounds the stored object to a few KB; the raw body cap
# rejects oversized requests (e.g. padded with ignored fields) outright.
MAX_PREFERENCES_BYTES = 32 * 1024


async def _limit_body_size(
    request: Request,
    # Authenticate first: an anonymous oversized PUT must get 401, not 413.
    # FastAPI caches the dependency, so the endpoint reuses this same user.
    _user: UserPublic = Depends(_get_current_user),
) -> None:
    # FastAPI has read the body before dependencies run; this only keeps
    # oversized payloads out of the table.
    if len(await request.body()) > MAX_PREFERENCES_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Preferences are limited to {MAX_PREFERENCES_BYTES // 1024} KB.",
        )


def _read_preferences(conn, username: str) -> UserPreferences:
    row = conn.execute(
        "SELECT data FROM user_preferences WHERE username = ?", (username,)
    ).fetchone()
    if not row:
        return UserPreferences()
    try:
        return UserPreferences.model_validate(json.loads(row["data"]))
    except ValueError:
        # Bad JSON or a row written under an older schema (pydantic's
        # ValidationError is a ValueError) must not lock the user out of the
        # page; the next save replaces it.
        logger.warning("Ignoring unreadable preferences of %s", username)
        return UserPreferences()


@router.get("/v1/me/preferences", response_model=UserPreferences)
def get_preferences(current_user: UserPublic = Depends(_get_current_user)):
    with authenticated_account_connection(current_user, write=False) as conn:
        return _read_preferences(conn, current_user.username)


@router.put(
    "/v1/me/preferences",
    response_model=UserPreferences,
    dependencies=[Depends(_limit_body_size)],
)
def put_preferences(
    payload: UserPreferences,
    current_user: UserPublic = Depends(_get_current_user),
):
    """Stores the top-level keys the request names and keeps all others, so a
    tab that sends only what it changed cannot undo what another device saved
    meanwhile. A complete object replaces everything. Returns the stored result."""
    changes = payload.model_dump(include=payload.model_fields_set)
    with authenticated_account_connection(current_user) as conn:
        stored = _read_preferences(conn, current_user.username).model_dump()
        data = UserPreferences.model_validate({**stored, **changes})
        conn.execute(
            "INSERT OR REPLACE INTO user_preferences (username, data, updated_at) VALUES (?, ?, ?)",
            (current_user.username, json.dumps(data.model_dump()), _utcnow_iso()),
        )
    return data
