import os
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = os.environ.get("SCHEDULE_DB_PATH", "schedule.db")
_SCHEMA_READY = False
_SCHEMA_LOCK = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    # Migrations can be entered concurrently by request threads or spawned
    # workers. Serialize locally and take the SQLite writer lock before
    # inspecting columns so two processes cannot both ALTER the same table.
    with _SCHEMA_LOCK:
        if _SCHEMA_READY:
            return
        conn.execute("BEGIN IMMEDIATE")
        _ensure_schema_locked(conn)


def _ensure_schema_locked(conn: sqlite3.Connection) -> None:
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
            created_at TEXT NOT NULL,
            account_generation TEXT NOT NULL,
            token_version INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "account_generation" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN account_generation TEXT")
    if "token_version" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0")
    # Existing accounts keep their data and password. Name-only legacy JWTs
    # intentionally expire at migration: there is no safe way to prove which
    # historical account generation issued such a token.
    conn.execute("UPDATE users SET account_generation = lower(hex(randomblob(16))) "
                 "WHERE account_generation IS NULL OR account_generation = ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_generation "
                 "ON users(account_generation)")
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS run_feedback (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            username TEXT NOT NULL,
            comment TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schedule_changes (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            run_id TEXT,
            after_run_id TEXT,
            diff TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_schedule_changes_user_time
            ON schedule_changes (username, created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_schedule_changes_after_run
            ON schedule_changes (after_run_id)
        """
    )
    # Named calendar snapshots ("quicksave"): the FULL AppState blob per
    # version — assignments-only would be lossy, normalization drops
    # assignments that don't match the CURRENT template on restore.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS calendar_snapshots (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'named',
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_calendar_snapshots_user
            ON calendar_snapshots(username, created_at)
        """
    )
    # Exactly ONE reserved auto-backup slot per user (written before every
    # restore so an accidental restore is always reversible).
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_snapshots_auto_backup
            ON calendar_snapshots(username) WHERE kind = 'auto_backup'
        """
    )
    # Per-login UI preferences ("My plan" view, saved views, start page);
    # deliberately outside app_state so they never touch calendar revisions.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_preferences (
            username TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    # Swap assistant (v1.81): one row per swap with its exact patch for undo, an
    # append-only event log, and per-calendar swap rules. Columns that a later
    # request type leaves empty are nullable, so later stages only ADD COLUMN;
    # swaps/store.py checks on insert what stage 1 requires.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS swap_requests (
            id TEXT PRIMARY KEY,                 -- 'swp-<ms hex>-<6 hex>'
            username TEXT NOT NULL,
            kind TEXT NOT NULL,                  -- swap | handover | cover (stage 2: offer)
            status TEXT NOT NULL,                -- stage 1: 'applied' | 'reverted'
            requester_id TEXT,                   -- A; NULL for cover
            partner_id TEXT,                     -- B (stage-2 offers: NULL)
            -- JSON [{assignmentId, rowId, dateISO, clinicianId, fp}]: A's items, or the
            -- cover instance with clinicianId null
            give_items TEXT NOT NULL,
            take_items TEXT,                     -- JSON, same shape (swap), else NULL
            summary TEXT NOT NULL DEFAULT '{}',  -- JSON names and labels at apply time
            note TEXT,                           -- trimmed, <= 280 chars, NULL when empty
            consent TEXT,                        -- 'confirmed_by_planner'
            created_via TEXT NOT NULL,           -- 'planner' (stage 2: 'link')
            created_by TEXT NOT NULL,            -- 'user:<username>'
            approver_name TEXT,                  -- trimmed, <= 80 chars, NULL when empty
            notice_override INTEGER NOT NULL DEFAULT 0,
            acknowledged_warnings TEXT NOT NULL DEFAULT '[]',  -- JSON [{id, code, message}]
            starts_at TEXT,                      -- earliest moved start, UTC ISO
            expires_at TEXT,                     -- stage 2; NULL
            client_request_id TEXT,              -- stage 2; NULL
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            decided_at TEXT,                     -- = applied_at in stage 1
            decided_by TEXT,                     -- 'user:<username>'
            applied_at TEXT,
            applied_revision TEXT,               -- calendar revision right after the apply
            applied_patch TEXT,                  -- JSON {removed, added}: Assignment dumps;
                                                 -- {resolved}: violations the swap resolved
            change_id TEXT,                      -- schedule_changes row of the apply
            reverted_at TEXT,
            reverted_by TEXT,
            reverted_revision TEXT,
            revert_change_id TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_swap_requests_user_time
            ON swap_requests (username, created_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_swap_requests_user_status
            ON swap_requests (username, status, starts_at)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS swap_events (
            id TEXT PRIMARY KEY,                 -- 'swe-<ms hex>-<6 hex>'
            request_id TEXT NOT NULL,
            username TEXT NOT NULL,
            actor TEXT NOT NULL,                 -- 'user:<username>'
            action TEXT NOT NULL,                -- 'applied' | 'reverted'
            -- applied: {"revision", "noticeOverride", "acknowledgedWarnings": [ids],
            -- "approverName"}; reverted: {"revision"}
            detail TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_swap_events_request
            ON swap_events (request_id, created_at)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_swap_events_user_time
            ON swap_events (username, created_at)
        """
    )
    # Deliberately not part of solverSettings, which feed the planning
    # fingerprint and the calendar revision.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS swap_settings (
            username TEXT PRIMARY KEY,
            -- JSON object, e.g. {"timeZone": "Europe/Berlin", "noticeHours": 48,
            -- "minRestHours": 11, "maxBlockHours": 24}
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
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
    # 30s busy timeout: with concurrent solver runs, several monitor threads
    # can write large finish_run result blobs at once; the default 5s window
    # occasionally loses that race against a slow write.
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_schema(conn)
    except Exception:
        conn.close()
        raise
    return conn
