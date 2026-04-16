import logging
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext

from .db import _get_connection
from .models import (
    LoginRequest,
    Role,
    TokenResponse,
    UserCreateRequest,
    UserPublic,
    UserStateExport,
    UserUpdateRequest,
)
from .state import _default_state, _load_state, _parse_import_state, _save_state

logger = logging.getLogger(__name__)


def _resolve_jwt_secret() -> str:
    """Load the JWT signing secret.

    A missing secret silently falling back to a well-known string ("dev-secret")
    would let an attacker forge tokens for any environment that forgot to set
    JWT_SECRET. Require it explicitly in production; in development, generate a
    fresh ephemeral key and warn loudly so the problem is obvious.
    """
    configured = os.environ.get("JWT_SECRET")
    if configured:
        return configured
    env = os.environ.get("ENVIRONMENT", "").strip().lower()
    if env in {"production", "prod"}:
        raise RuntimeError(
            "JWT_SECRET must be set when ENVIRONMENT=production. Refusing to start "
            "with a default secret."
        )
    generated = secrets.token_urlsafe(32)
    logger.warning(
        "JWT_SECRET is not set; using an ephemeral dev secret. All existing tokens "
        "will be invalidated on every restart. Set JWT_SECRET explicitly for "
        "stable development sessions."
    )
    return generated


JWT_SECRET = _resolve_jwt_secret()
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "720"))

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# Precomputed hash for a random password, used as a dummy verify target when the
# requested username does not exist. This keeps login-endpoint timing constant
# regardless of whether the user is known, preventing username enumeration.
_DUMMY_PASSWORD_HASH = pwd_context.hash(secrets.token_urlsafe(32))

router = APIRouter()


def _hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def _is_truthy(value: Optional[str]) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _user_row_to_public(row: sqlite3.Row) -> UserPublic:
    return UserPublic(
        username=row["username"],
        role=row["role"],
        active=bool(row["active"]),
    )


def _get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    conn = _get_connection()
    row = conn.execute(
        "SELECT id, username, password_hash, role, active FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    return row


def _list_users() -> List[UserPublic]:
    conn = _get_connection()
    rows = conn.execute(
        "SELECT username, role, active FROM users ORDER BY username"
    ).fetchall()
    conn.close()
    return [_user_row_to_public(row) for row in rows]


def _create_user(username: str, password: str, role: Role, active: bool = True) -> UserPublic:
    conn = _get_connection()
    conn.execute(
        """
        INSERT INTO users (username, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            username,
            _hash_password(password),
            role,
            1 if active else 0,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.commit()
    row = conn.execute(
        "SELECT username, role, active FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        raise RuntimeError("User creation failed.")
    return _user_row_to_public(row)


def _update_user(username: str, updates: UserUpdateRequest) -> UserPublic:
    conn = _get_connection()
    fields = []
    values: List[object] = []
    if updates.active is not None:
        fields.append("active = ?")
        values.append(1 if updates.active else 0)
    if updates.role is not None:
        fields.append("role = ?")
        values.append(updates.role)
    if updates.password is not None:
        fields.append("password_hash = ?")
        values.append(_hash_password(updates.password))
    if not fields:
        raise HTTPException(status_code=400, detail="No updates provided.")
    values.append(username)
    conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE username = ?", values)
    conn.commit()
    row = conn.execute(
        "SELECT username, role, active FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="User not found.")
    return _user_row_to_public(row)


def _delete_user(username: str) -> None:
    conn = _get_connection()
    conn.execute("DELETE FROM users WHERE username = ?", (username,))
    conn.execute("DELETE FROM app_state WHERE id = ?", (username,))
    conn.execute("DELETE FROM ical_publications WHERE username = ?", (username,))
    conn.execute("DELETE FROM ical_clinician_publications WHERE username = ?", (username,))
    conn.execute("DELETE FROM web_publications WHERE username = ?", (username,))
    conn.commit()
    conn.close()


def _create_access_token(user: UserPublic) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    payload = {"sub": user.username, "role": user.role, "exp": expires}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token.strip()


def _get_current_user(authorization: Optional[str] = Header(default=None)) -> UserPublic:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token.")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")
    return _verify_token_and_get_user(token)


def _verify_token_and_get_user(token: str) -> UserPublic:
    """Verify JWT token and return user. Used by SSE endpoints that get token via query param."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token.",
        ) from exc
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")
    row = _get_user_by_username(username)
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found.")
    if not row["active"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User disabled.")
    return _user_row_to_public(row)


def _require_admin(current_user: UserPublic = Depends(_get_current_user)) -> UserPublic:
    if current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required.")
    return current_user


def _ensure_admin_user() -> None:
    username = os.environ.get("ADMIN_USERNAME")
    password = os.environ.get("ADMIN_PASSWORD")
    reset_password = _is_truthy(os.environ.get("ADMIN_PASSWORD_RESET"))
    if not username or not password:
        return
    normalized = username.strip().lower()
    if not normalized:
        return
    existing = _get_user_by_username(normalized)
    if existing:
        if reset_password:
            _update_user(
                normalized,
                UserUpdateRequest(active=True, role="admin", password=password),
            )
        return
    _create_user(normalized, password, "admin", active=True)


def _ensure_test_user() -> None:
    # The E2E test user has a hardcoded password. Keep it enabled by default for
    # local development and CI, but NEVER provision it when ENVIRONMENT=production
    # even if someone forgets to set ENABLE_E2E_TEST_USER=0.
    env = os.environ.get("ENVIRONMENT", "").strip().lower()
    if env in {"production", "prod"}:
        return
    if os.environ.get("ENABLE_E2E_TEST_USER", "1") != "1":
        return
    username = "testuser"
    password = "sdjhfl34-wfsdfwsd2"
    normalized = username.strip().lower()
    if not normalized or not password:
        return
    existing = _get_user_by_username(normalized)
    if existing:
        return
    _create_user(normalized, password, "user", active=True)


@router.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest):
    username = payload.username.strip().lower()
    if not username or not payload.password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.")
    row = _get_user_by_username(username)
    # Always hash a password, even when the user doesn't exist, so response time
    # doesn't leak which usernames are registered.
    password_hash = row["password_hash"] if row else _DUMMY_PASSWORD_HASH
    password_ok = _verify_password(payload.password, password_hash)
    if not row or not row["active"] or not password_ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.")
    user_public = _user_row_to_public(row)
    token = _create_access_token(user_public)
    return TokenResponse(access_token=token, user=user_public)


@router.get("/auth/me", response_model=UserPublic)
def get_me(current_user: UserPublic = Depends(_get_current_user)):
    return current_user


@router.get("/auth/users", response_model=List[UserPublic])
def list_users(_: UserPublic = Depends(_require_admin)):
    return _list_users()


@router.get("/auth/users/{username}/export", response_model=UserStateExport)
def export_user_state(username: str, _: UserPublic = Depends(_require_admin)):
    normalized = username.strip().lower()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username required.")
    if not _get_user_by_username(normalized):
        raise HTTPException(status_code=404, detail="User not found.")
    state = _load_state(normalized)
    return UserStateExport(
        exportedAt=datetime.now(timezone.utc).isoformat(),
        sourceUser=normalized,
        state=state,
    )


@router.post("/auth/users", response_model=UserPublic)
def create_user(
    payload: UserCreateRequest, current_user: UserPublic = Depends(_require_admin)
):
    username = payload.username.strip().lower()
    if not username:
        raise HTTPException(status_code=400, detail="Username required.")
    if not payload.password:
        raise HTTPException(status_code=400, detail="Password required.")
    if _get_user_by_username(username):
        raise HTTPException(status_code=409, detail="User already exists.")
    try:
        import_state = _parse_import_state(payload.importState)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid import state.")
    created = _create_user(username, payload.password, payload.role, active=True)
    if import_state is None:
        # Use default state for new users (not admin's state)
        default_state = _default_state()
        _save_state(default_state, username)
    else:
        _save_state(import_state, username)
    return created


@router.patch("/auth/users/{username}", response_model=UserPublic)
def update_user(
    username: str,
    payload: UserUpdateRequest,
    _: UserPublic = Depends(_require_admin),
):
    normalized = username.strip().lower()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username required.")
    if payload.password is not None and not payload.password:
        raise HTTPException(status_code=400, detail="Password required.")
    return _update_user(normalized, payload)


@router.delete("/auth/users/{username}", status_code=204)
def delete_user(
    username: str,
    current_user: UserPublic = Depends(_require_admin),
):
    normalized = username.strip().lower()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username required.")
    if normalized == current_user.username:
        raise HTTPException(status_code=400, detail="Cannot delete yourself.")
    if not _get_user_by_username(normalized):
        raise HTTPException(status_code=404, detail="User not found.")
    _delete_user(normalized)
    return None
