import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("SCHEDULE_DB_PATH", "schedule.db")
_SCHEMA_READY = False


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_state (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            active INTEGER NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ical_publications (
            username TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            start_date_iso TEXT NULL,
            end_date_iso TEXT NULL,
            cal_name TEXT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ical_clinician_publications (
            username TEXT NOT NULL,
            clinician_id TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (username, clinician_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS web_publications (
            username TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_spend (
            username TEXT PRIMARY KEY,
            total_cost_usd REAL NOT NULL DEFAULT 0,
            updated_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS solver_runs (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            status TEXT NOT NULL,
            start_iso TEXT NOT NULL,
            end_iso TEXT NOT NULL,
            params TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            finished_at TEXT,
            applied_at TEXT,
            result TEXT,
            error TEXT,
            notes TEXT,
            input_fingerprint TEXT
        )
        """
    )
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(app_state)").fetchall()]
    if "updated_at" not in columns:
        conn.execute("ALTER TABLE app_state ADD COLUMN updated_at TEXT")
        now = _utcnow_iso()
        conn.execute(
            "UPDATE app_state SET updated_at = ? WHERE updated_at IS NULL OR updated_at = ''",
            (now,),
        )

    conn.commit()
    _SCHEMA_READY = True


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    _ensure_schema(conn)
    return conn
