"""Serialize local account replacement with solver admission and completion.

The database generation is the durable identity. Locks coordinate this server's
threads; callers must still compare generations before persisting old work.
"""

from contextlib import closing, contextmanager
import threading

from fastapi import HTTPException

from .db import _get_connection

_locks_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}


def account_lock(username: str):
    """Return the same reentrant lifecycle lock for an account name."""
    with _locks_guard:
        return _locks.setdefault(username, threading.RLock())


def get_account_generation(username: str) -> str | None:
    with closing(_get_connection()) as conn:
        row = conn.execute("SELECT account_generation FROM users WHERE username = ?",
                           (username,)).fetchone()
    return row["account_generation"] if row else None


def account_is_current(username: str, generation: str | None, *, token_version: int | None = None,
                       require_active: bool = False) -> bool:
    """Missing identities never authorize writes to a real account."""
    if not generation:
        return False
    with closing(_get_connection()) as conn:
        row = conn.execute("SELECT account_generation, token_version, active FROM users WHERE username = ?",
                           (username,)).fetchone()
    return bool(row and row["account_generation"] == generation
                and (token_version is None or row["token_version"] == token_version)
                and (not require_active or row["active"]))


def require_current_account(conn, user) -> None:
    """Recheck authenticated identity inside the transaction using its data."""
    generation = getattr(user, "_account_generation", None)
    version = getattr(user, "_token_version", None)
    row = conn.execute("SELECT account_generation, token_version, active FROM users WHERE username = ?",
                       (user.username,)).fetchone()
    if (not generation or version is None or not row or not row["active"]
            or row["account_generation"] != generation or row["token_version"] != version):
        raise HTTPException(401, "Account session is no longer valid.")


@contextmanager
def authenticated_account_connection(user, *, write: bool = True):
    """Identity check and access share a snapshot; deletion cannot slip between."""
    with account_lock(user.username), closing(_get_connection()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        require_current_account(conn, user)
        yield conn
