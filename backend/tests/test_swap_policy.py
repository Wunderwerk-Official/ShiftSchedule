"""Swap rules, "started" and the notice period in the calendar time zone, open
slots, the checks list, and the swap tables' settings, retention and deletion."""

import json
import sqlite3
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterator, List, Tuple
from zoneinfo import ZoneInfo

import pytest

import backend.db as db
from backend.auth import _create_user, _delete_user
from backend.models import AppState, Assignment, Clinician, Holiday, SolverSettings, VacationRange
from backend.swaps import labels, policy, store
from backend.swaps.blocks import abs_minute
from backend.swaps.policy import (
    SwapRules,
    load_rules,
    local_datetime,
    open_slot,
    rules_from_settings,
    start_status,
)
from backend.validation import build_validation_context

from .conftest import make_clinician
from .swap_fixtures import ALL_SECTIONS, THU, asg, make_swap_state

USER = "swap-policy-test"
BERLIN = SwapRules()


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


# --- Time zone, "started" and notice ----------------------------------------


def test_utc_now_is_aware_utc():
    assert policy.utc_now().tzinfo is timezone.utc


def test_local_datetime_uses_the_offset_of_that_date():
    tz = ZoneInfo("Europe/Berlin")
    assert local_datetime(abs_minute("2026-03-28", 8 * 60), tz).isoformat() == "2026-03-28T08:00:00+01:00"
    assert local_datetime(abs_minute("2026-03-30", 8 * 60), tz).isoformat() == "2026-03-30T08:00:00+02:00"
    evening = local_datetime(abs_minute("2026-11-19", 20 * 60 + 30), tz)
    assert evening.isoformat() == "2026-11-19T20:30:00+01:00"


def test_notice_is_measured_in_the_calendar_time_zone_across_dst():
    # The naive wall-clock difference would be 48.5 h: Berlin moved to UTC+2 on 29 March.
    status = start_status(abs_minute("2026-03-30", 8 * 60), BERLIN, _utc("2026-03-28T06:30Z"))
    assert status.starts_at.isoformat() == "2026-03-30T08:00:00+02:00"
    assert status.hours_until == 47.5
    assert status.inside_notice
    assert not status.started


def test_now_in_the_calendar_zone_gives_the_same_status():
    now = _utc("2026-03-28T06:30Z").astimezone(ZoneInfo("Europe/Berlin"))
    assert start_status(abs_minute("2026-03-30", 8 * 60), BERLIN, now).hours_until == 47.5


def test_started_at_the_start_minute():
    start = abs_minute("2026-11-19", 20 * 60)
    started = start_status(start, BERLIN, _utc("2026-11-19T19:00Z"))
    assert started.started
    assert not started.inside_notice
    before = start_status(start, BERLIN, _utc("2026-11-19T18:59Z"))
    assert not before.started
    assert before.inside_notice
    assert start_status(start, BERLIN, _utc("2026-11-19T20:00Z")).hours_until == -1.0


def test_notice_boundary_uses_the_unrounded_time_left():
    start = abs_minute("2026-11-19", 20 * 60)
    starts_at = _utc("2026-11-19T19:00Z")
    almost = start_status(start, BERLIN, starts_at - timedelta(hours=47, minutes=58))
    assert almost.hours_until == 48.0
    assert almost.inside_notice
    exact = start_status(start, BERLIN, starts_at - timedelta(hours=48))
    assert exact.hours_until == 48.0
    assert not exact.inside_notice


def test_rules_time_zone_and_notice_hours_apply():
    rules = SwapRules(time_zone="America/New_York", notice_hours=12)
    status = start_status(abs_minute("2026-11-19", 20 * 60), rules, _utc("2026-11-20T00:30Z"))
    assert status.starts_at.isoformat() == "2026-11-19T20:00:00-05:00"
    assert status.hours_until == 0.5
    assert status.inside_notice


# --- Settings ---------------------------------------------------------------


def test_rules_from_settings_defaults_and_overrides():
    assert rules_from_settings({}) == SwapRules("Europe/Berlin", 48.0, 11.0, 24.0)
    assert rules_from_settings({
        "timeZone": "America/New_York", "noticeHours": 24, "minRestHours": 10.5, "maxBlockHours": 30,
        "addedInStageTwo": True,
    }) == SwapRules("America/New_York", 24.0, 10.5, 30.0)
    assert rules_from_settings({"noticeHours": 0, "minRestHours": 24, "maxBlockHours": 1}) == SwapRules(
        notice_hours=0.0, min_rest_hours=24.0, max_block_hours=1.0)
    assert rules_from_settings({"noticeHours": 336, "minRestHours": 0, "maxBlockHours": 72}) == SwapRules(
        notice_hours=336.0, min_rest_hours=0.0, max_block_hours=72.0)


@pytest.mark.parametrize("data", [
    {"timeZone": "Mars/Olympus_Mons"},
    {"timeZone": ""},
    {"timeZone": "Europe"},
    {"timeZone": "../etc/passwd"},
    {"timeZone": 1},
    {"noticeHours": -1},
    {"noticeHours": 337},
    {"noticeHours": "48"},
    {"noticeHours": True},
    {"noticeHours": float("nan")},
    {"minRestHours": 24.5},
    {"maxBlockHours": 0.5},
    {"maxBlockHours": float("inf")},
    {"maxBlockHours": None},
])
def test_invalid_settings_fall_back_to_the_default(data):
    assert rules_from_settings(data) == SwapRules()


def test_one_invalid_setting_keeps_the_valid_ones():
    rules = rules_from_settings({"timeZone": "Nowhere/Town", "noticeHours": 12})
    assert rules == SwapRules(notice_hours=12.0)


@pytest.fixture
def conn(tmp_path, monkeypatch) -> Iterator[sqlite3.Connection]:
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "swaps.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    with closing(db._get_connection()) as connection:
        yield connection


def _set_settings(conn: sqlite3.Connection, username: str, data: str) -> None:
    conn.execute("INSERT OR REPLACE INTO swap_settings (username, data, updated_at) VALUES (?, ?, ?)",
                 (username, data, "2026-01-01T00:00:00+00:00"))


def test_load_rules_reads_the_calendar_settings_row(conn):
    assert load_rules(conn, USER) == SwapRules()
    _set_settings(conn, USER, json.dumps({"timeZone": "Europe/London", "noticeHours": 72}))
    _set_settings(conn, "someone-else", json.dumps({"noticeHours": 1}))
    assert load_rules(conn, USER) == SwapRules(time_zone="Europe/London", notice_hours=72.0)


@pytest.mark.parametrize("data", ["not json", "[1, 2]", "null"])
def test_unreadable_settings_count_as_no_settings(conn, data):
    _set_settings(conn, USER, data)
    assert store.read_settings(conn, USER) == {}
    assert load_rules(conn, USER) == SwapRules()


# --- Retention and account deletion -----------------------------------------


def _insert_swap(conn: sqlite3.Connection, swap_id: str, username: str, status: str, updated_at: str) -> None:
    conn.execute(
        "INSERT INTO swap_requests (id, username, kind, status, partner_id, give_items, consent, "
        "created_via, created_by, created_at, updated_at) "
        "VALUES (?, ?, 'swap', ?, 'clin-ben', '[]', 'confirmed_by_planner', 'planner', ?, ?, ?)",
        (swap_id, username, status, f"user:{username}", updated_at, updated_at),
    )
    conn.execute(
        "INSERT INTO swap_events (id, request_id, username, actor, action, created_at) "
        "VALUES (?, ?, ?, ?, 'applied', ?)",
        (f"swe-{swap_id}", swap_id, username, f"user:{username}", updated_at),
    )


def test_prune_drops_finished_swaps_after_the_retention_period(conn):
    now = datetime(2026, 11, 1, 12, 0, 30, 500000, tzinfo=timezone.utc)
    cutoff = now - timedelta(days=policy.SWAP_RETENTION_DAYS)
    expired = store.iso_utc(cutoff - timedelta(seconds=1))
    _insert_swap(conn, "swp-applied", USER, "applied", expired)
    _insert_swap(conn, "swp-reverted", USER, "reverted", expired)
    _insert_swap(conn, "swp-at-cutoff", USER, "applied", store.iso_utc(cutoff))
    _insert_swap(conn, "swp-recent", USER, "reverted", store.iso_utc(now))
    _insert_swap(conn, "swp-pending", USER, "awaiting_partner", expired)
    _insert_swap(conn, "swp-other-user", "someone-else", "applied", expired)

    store.prune(conn, USER, now)

    remaining = sorted(row[0] for row in conn.execute("SELECT id FROM swap_requests"))
    assert remaining == ["swp-at-cutoff", "swp-other-user", "swp-pending", "swp-recent"]
    assert sorted(row[0] for row in conn.execute("SELECT request_id FROM swap_events")) == remaining


def test_iso_utc_matches_the_stored_timestamp_format():
    berlin_now = datetime(2026, 11, 12, 11, 42, 7, 999999, tzinfo=ZoneInfo("Europe/Berlin"))
    assert store.iso_utc(berlin_now) == "2026-11-12T10:42:07+00:00"


def test_account_creation_and_deletion_remove_swap_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "accounts.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    with closing(db._get_connection()) as conn, conn:
        # Rows left by an older account of the same name.
        _insert_swap(conn, "swp-orphan", USER, "applied", "2026-01-01T00:00:00+00:00")
        _set_settings(conn, USER, "{}")
    _create_user(USER, "swap-policy-password", "user")
    _create_user("someone-else", "swap-policy-password", "user")
    with closing(db._get_connection()) as conn:
        assert _counts(conn, USER) == [0, 0, 0]
    with closing(db._get_connection()) as conn, conn:
        for username in (USER, "someone-else"):
            _insert_swap(conn, f"swp-{username}", username, "applied", "2026-01-01T00:00:00+00:00")
            _set_settings(conn, username, "{}")

    _delete_user(USER)

    with closing(db._get_connection()) as conn:
        assert _counts(conn, USER) == [0, 0, 0]
        assert _counts(conn, "someone-else") == [1, 1, 1]


def _counts(conn: sqlite3.Connection, username: str) -> List[int]:
    return [
        conn.execute(f"SELECT COUNT(*) FROM {table} WHERE username = ?", (username,)).fetchone()[0]
        for table in ("swap_requests", "swap_events", "swap_settings")
    ]


# --- Open slots -------------------------------------------------------------


def _index(state: AppState) -> Dict[Tuple[str, str], List[Assignment]]:
    index: Dict[Tuple[str, str], List[Assignment]] = defaultdict(list)
    for a in state.assignments:
        if not a.rowId.startswith("pool-"):
            index[(a.rowId, a.dateISO)].append(a)
    return index


def _on_vacation(clinician_id: str, name: str) -> Clinician:
    return make_clinician(clinician_id, name, list(ALL_SECTIONS), working_hours_per_week=40,
                          vacations=[VacationRange(id="v", startISO=THU, endISO=THU)])


def test_open_slot_target_counts_the_override():
    state = make_swap_state([asg("b", "ct-thu", THU, "clin-ben")], slot_overrides={f"ct-thu__{THU}": 1})
    info = open_slot(build_validation_context(state), _index(state), "ct-thu", THU)
    assert (info.active, info.target, info.missing, info.is_open) == (True, 2, 1, True)
    assert info.stored == info.visible == state.assignments
    assert info.hidden == []


def test_hidden_holders_are_stored_but_not_visible():
    clinicians = [
        _on_vacation("clin-ben", "Ben Ott"),
        _on_vacation("clin-anna", "anna weber"),
        make_clinician("clin-clara", "Clara Schmidt", ["sec-ct"]),
    ]
    state = make_swap_state(
        [asg("b", "ct-thu", THU, "clin-ben"), asg("a", "ct-thu", THU, "clin-anna"),
         asg("c", "ct-thu", THU, "clin-clara"), asg("g", "ct-thu", THU, "clin-gone")],
        clinicians=clinicians,
        slot_overrides={f"ct-thu__{THU}": 2},
    )
    info = open_slot(build_validation_context(state), _index(state), "ct-thu", THU)
    assert [a.id for a in info.stored] == ["b", "a", "c", "g"]
    assert [a.id for a in info.visible] == ["c", "g"]  # an unknown holder counts as visible
    assert [a.id for a in info.hidden] == ["a", "b"]  # by name, ignoring case
    assert (info.target, info.missing, info.is_open) == (3, 1, True)


def test_full_and_inactive_slots_are_not_open():
    state = make_swap_state([asg("b", "ct-thu", THU, "clin-ben")])
    vctx = build_validation_context(state)
    full = open_slot(vctx, _index(state), "ct-thu", THU)
    assert (full.active, full.missing, full.is_open) == (True, 0, False)
    wrong_day = open_slot(vctx, _index(state), "ct-fri", THU)
    assert (wrong_day.active, wrong_day.is_open) == (False, False)
    unknown = open_slot(vctx, _index(state), "nope-thu", THU)
    assert (unknown.active, unknown.target, unknown.is_open) == (False, 0, False)

    holiday = make_swap_state(holidays=[Holiday(dateISO=THU, name="Holiday")])
    info = open_slot(build_validation_context(holiday), {}, "ct-thu", THU)
    assert (info.active, info.target, info.missing, info.is_open) == (False, 1, 1, False)
    assert open_slot(build_validation_context(holiday), {}, "ct-holiday", THU).is_open


# --- Checks list ------------------------------------------------------------


def test_check_list_for_the_swap_template():
    settings = SolverSettings.model_validate(make_swap_state().solverSettings)
    assert labels.check_list(settings, SwapRules(), "swap") == [
        {"code": "qualification", "label": "Qualified for both shifts"},
        {"code": "vacation", "label": "No shift moved onto a vacation day"},
        {"code": "rest_day", "label": "No new shift on a Rest Day"},
        {"code": "overlap", "label": "No new overlapping shifts"},
        {"code": "on_call_rest", "label": "No new on-call rest conflict (1 day before, 1 after)"},
        {"code": "mandatory_window", "label": "No new shift outside mandatory working times"},
        {"code": "weekly_hours", "label": "No new week over contract + tolerance"},
        {"code": "split_shift", "label": "No new split day"},
        {"code": "rest", "label": "No new rest under 11 h between shifts"},
        {"code": "night_free_day", "label": "No new night without a free day after it"},
        {"code": "block_length", "label": "No new stretch longer than 24 h"},
    ]


def test_check_list_follows_settings_rules_and_mode():
    settings = SolverSettings(enforceSameLocationPerDay=True, onCallRestEnabled=True,
                              onCallRestClassId="sec-oncall", onCallRestDaysBefore=2, onCallRestDaysAfter=0,
                              preferContinuousShifts=False)
    checks = labels.check_list(settings, SwapRules(min_rest_hours=10, max_block_hours=30.5), "cover")
    assert [c["code"] for c in checks] == [
        "qualification", "vacation", "rest_day", "overlap", "same_location", "on_call_rest", "mandatory_window",
        "weekly_hours", "capacity", "rest", "night_free_day", "block_length",
    ]
    by_code = {c["code"]: c["label"] for c in checks}
    assert by_code["qualification"] == "Qualified for the shift"
    assert by_code["same_location"] == "No new second location on a day"
    assert by_code["on_call_rest"] == "No new on-call rest conflict (2 days before, 0 after)"
    assert by_code["capacity"] == "Slot not overfilled"
    assert by_code["rest"] == "No new rest under 10 h between shifts"
    assert by_code["block_length"] == "No new stretch longer than 30.5 h"


@pytest.mark.parametrize("settings", [
    SolverSettings(onCallRestEnabled=False, onCallRestClassId="sec-oncall"),
    SolverSettings(onCallRestEnabled=True, onCallRestClassId=None),
    SolverSettings(onCallRestEnabled=True, onCallRestClassId="sec-oncall", onCallRestDaysBefore=0,
                   onCallRestDaysAfter=0),
])
def test_check_list_leaves_out_on_call_rest_when_it_cannot_apply(settings):
    codes = [c["code"] for c in labels.check_list(settings, SwapRules(), "handover")]
    assert "on_call_rest" not in codes
    assert "capacity" not in codes
