"""Swap rules of one calendar and every comparison with "now".

Shift times stay naive calendar wall-clock minutes everywhere; only "started"
and the notice period are measured in the calendar time zone. Callers reach
the clock through ``policy.utc_now()`` so tests can monkeypatch it.
"""

import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Mapping, Sequence, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..models import Assignment
from ..validation import ValidationContext, _day_type_with
from .blocks import MINUTES_PER_DAY, is_hidden

DEFAULT_TIME_ZONE = "Europe/Berlin"
SWAP_RETENTION_DAYS = 730
NOTE_MAX_CHARS = 280
APPROVER_MAX_CHARS = 80
BEST_CAP, POSSIBLE_CAP, BLOCKED_CAP, CLOSEST_COUNT = 10, 20, 30, 3
MAX_GATE_EVALUATIONS = 600
MAX_PICKED_DATES = 31


@dataclass(frozen=True)
class SwapRules:
    time_zone: str = DEFAULT_TIME_ZONE
    notice_hours: float = 48.0
    min_rest_hours: float = 11.0
    max_block_hours: float = 24.0

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.time_zone)


# swap_settings key -> (SwapRules field, lowest, highest allowed value)
_NUMERIC_SETTINGS = {
    "noticeHours": ("notice_hours", 0, 336),
    "minRestHours": ("min_rest_hours", 0, 24),
    "maxBlockHours": ("max_block_hours", 1, 72),
}


def _is_time_zone(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


def rules_from_settings(data: Mapping[str, Any]) -> SwapRules:
    """Stored settings over the defaults, key by key: a missing, non-numeric or
    out-of-range value keeps its default. Unknown keys are ignored."""
    values: Dict[str, Any] = {}
    if _is_time_zone(data.get("timeZone")):
        values["time_zone"] = data["timeZone"]
    for key, (field_name, lowest, highest) in _NUMERIC_SETTINGS.items():
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and lowest <= value <= highest:
            values[field_name] = float(value)
    return SwapRules(**values)


def load_rules(conn: sqlite3.Connection, username: str) -> SwapRules:
    # Imported here: store takes the retention period from this module.
    from . import store

    return rules_from_settings(store.read_settings(conn, username))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def local_datetime(abs_min: int, tz: ZoneInfo) -> datetime:
    """Wall-clock minute -> aware datetime in ``tz`` (fold=0)."""
    day = date.fromordinal(abs_min // MINUTES_PER_DAY)
    naive = datetime.combine(day, time()) + timedelta(minutes=abs_min % MINUTES_PER_DAY)
    return naive.replace(tzinfo=tz)


@dataclass(frozen=True)
class StartStatus:
    starts_at: datetime  # aware, calendar time zone
    started: bool
    hours_until: float  # rounded to 0.1 h, negative once started; display only
    inside_notice: bool  # from the unrounded time left


def start_status(abs_start: int, rules: SwapRules, now: datetime) -> StartStatus:
    starts_at = local_datetime(abs_start, rules.tz)
    # Subtract in UTC: Python subtracts aware datetimes that share one tzinfo
    # as naive wall clocks, which would ignore a DST change in between.
    left = starts_at.astimezone(timezone.utc) - now.astimezone(timezone.utc)
    started = left <= timedelta(0)
    return StartStatus(
        starts_at=starts_at,
        started=started,
        hours_until=round(left.total_seconds() / 3600, 1),
        inside_notice=not started and left < timedelta(hours=rules.notice_hours),
    )


@dataclass(frozen=True)
class OpenSlotInfo:
    row_id: str
    date_iso: str
    active: bool  # the slot has times and its column matches the date's day type
    target: int  # requiredSlots + the date's override, at least 0
    stored: List[Assignment]  # all non-pool assignments of the instance
    visible: List[Assignment]  # stored minus vacation-hidden (unknown holders count as visible)
    hidden: List[Assignment]  # vacation-hidden, by holder name then holder id
    missing: int  # target - len(visible)

    @property
    def is_open(self) -> bool:
        return self.active and self.missing > 0


def open_slot(
    vctx: ValidationContext,
    instance_index: Mapping[Tuple[str, str], Sequence[Assignment]],
    row_id: str,
    date_iso: str,
) -> OpenSlotInfo:
    """Fill state of the slot instance ``(row_id, date_iso)``; ``instance_index``
    maps instances to their stored non-pool assignments."""
    active = (
        row_id in vctx.slot_lookup
        and vctx.slot_day_types.get(row_id) == _day_type_with(date_iso, vctx.state, vctx)
    )
    # Same target as validate_capacity with only_fill_required=True.
    raw_required = getattr(vctx.slot_by_id.get(row_id), "requiredSlots", 0)
    required = raw_required if isinstance(raw_required, int) else 0
    target = max(0, required + vctx.state.slotOverridesByKey.get(f"{row_id}__{date_iso}", 0))
    stored = list(instance_index.get((row_id, date_iso), ()))
    visible = [a for a in stored if not is_hidden(vctx, a)]
    hidden = sorted(
        (a for a in stored if is_hidden(vctx, a)),
        key=lambda a: (vctx.clinicians_by_id[a.clinicianId].name.casefold(), a.clinicianId),
    )
    return OpenSlotInfo(
        row_id=row_id,
        date_iso=date_iso,
        active=active,
        target=target,
        stored=stored,
        visible=visible,
        hidden=hidden,
        missing=target - len(visible),
    )
