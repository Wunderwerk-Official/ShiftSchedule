from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Mapping, Optional

from .plan_timezone import plan_time_zone, wall_clock_to_utc
from .state import _parse_time_to_minutes

# Download (src/lib/ical.ts) and subscription feed build the same events and
# calendar header; keep both in step.

MINUTES_PER_DAY = 24 * 60

_GERMAN_LETTERS = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}


def ical_calendar_name(person: Optional[Mapping[str, Any]] = None) -> str:
    """X-WR-CALNAME: "Shift Planner – All people" or "Shift Planner – <person>"."""
    if person is None:
        return "Shift Planner – All people"
    return f"Shift Planner – {person.get('name') or person.get('id')}"


def _file_slug(text: str) -> str:
    lowered = text.lower()
    for letter, replacement in _GERMAN_LETTERS.items():
        lowered = lowered.replace(letter, replacement)
    # NFD splits other accented letters into base letter + mark; every
    # character still outside ASCII (marks, CJK, emoji) is dropped.
    ascii_text = unicodedata.normalize("NFD", lowered).encode("ascii", "ignore").decode("ascii")
    kept = re.sub(r"[^\w\s-]+", "", ascii_text, flags=re.ASCII)
    return re.sub(r"\s+", "-", kept.strip(), flags=re.ASCII)


def ical_file_name(person: Optional[Mapping[str, Any]] = None) -> str:
    """ASCII file name: shift-planner-all.ics or shift-planner-<transliterated name>.ics."""
    if person is None:
        return "shift-planner-all.ics"
    slug = _file_slug(str(person.get("name") or "")) or _file_slug(str(person.get("id") or ""))
    return f"shift-planner-{slug or 'person'}.ics"


def _escape_text(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _format_utc(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc).replace(microsecond=0)
    return utc.strftime("%Y%m%dT%H%M%SZ")


def _yyyymmdd(day: date) -> str:
    return day.strftime("%Y%m%d")


def _slot_minutes(slot: Mapping[str, Any]) -> Optional[tuple[int, int]]:
    """(start, end) minutes after the start day's midnight, as the team grid
    reads them (src/lib/schedule.ts buildShiftInterval); None without usable times."""
    start = _parse_time_to_minutes(slot.get("startTime"))
    end = _parse_time_to_minutes(slot.get("endTime"))
    if start is None or end is None:
        return None
    raw_offset = slot.get("endDayOffset")
    offset = raw_offset if isinstance(raw_offset, int) and not isinstance(raw_offset, bool) else 0
    end += max(0, min(3, offset)) * MINUTES_PER_DAY
    return (start, end) if end > start else None


def _fold_ical_line(line: str) -> str:
    if len(line.encode("utf-8")) <= 75:
        return line
    first_limit = 75
    next_limit = 74  # continuation lines start with a single space

    segments: list[str] = []
    current = ""
    current_limit = first_limit
    for ch in line:
        if current and len((current + ch).encode("utf-8")) > current_limit:
            segments.append(current)
            current = ch
            current_limit = next_limit
        else:
            current += ch
    if current:
        segments.append(current)

    if not segments:
        return line

    out = segments[0]
    for seg in segments[1:]:
        out += "\r\n " + seg
    return out


def _fold_lines(lines: Iterable[str]) -> str:
    return "\r\n".join(_fold_ical_line(line) for line in lines) + "\r\n"


def generate_ics(
    app_state: Dict[str, Any],
    published_week_start_isos: Optional[list[str]],
    cal_name: str,
    *,
    clinician_id: Optional[str] = None,
    dtstamp: Optional[datetime] = None,
) -> str:
    rows = app_state.get("rows") or []
    clinicians = app_state.get("clinicians") or []
    assignments = app_state.get("assignments") or []
    published_weeks = {iso for iso in (published_week_start_isos or []) if isinstance(iso, str)}

    row_by_id: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        row_id = row.get("id")
        if not row_id:
            continue
        row_by_id[row_id] = row
    weekly_template = app_state.get("weeklyTemplate") or {}
    slot_by_id: Dict[str, Dict[str, Any]] = {}
    block_by_id: Dict[str, Dict[str, Any]] = {}
    for block in weekly_template.get("blocks") or []:
        block_id = block.get("id")
        if block_id:
            block_by_id[block_id] = block
    for location in weekly_template.get("locations") or []:
        for slot in location.get("slots") or []:
            slot_id = slot.get("id")
            if slot_id:
                slot_by_id[slot_id] = slot

    clinician_name_by_id: Dict[str, str] = {}
    vacation_ranges_by_clinician: Dict[str, list[tuple[str, str]]] = {}
    for clinician in clinicians:
        clinician_key = clinician.get("id")
        if not clinician_key:
            continue
        clinician_name_by_id[clinician_key] = clinician.get("name") or clinician_key
        vacations = clinician.get("vacations") or []
        ranges: list[tuple[str, str]] = []
        for vacation in vacations:
            start = vacation.get("startISO")
            end = vacation.get("endISO")
            if isinstance(start, str) and isinstance(end, str) and start and end:
                ranges.append((start, end))
        vacation_ranges_by_clinician[clinician_key] = ranges

    stamp = dtstamp or datetime.now(timezone.utc)
    zone_name, zone = plan_time_zone(app_state.get("holidayCountry"))

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//ShiftSchedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape_text(cal_name)}",
        f"X-WR-TIMEZONE:{zone_name}",
    ]
    if not published_weeks:
        lines.append("END:VCALENDAR")
        return _fold_lines(lines)

    events: list[tuple[tuple[str, int, str], list[str]]] = []
    for assignment in assignments:
        row_id = assignment.get("rowId")
        if not row_id:
            continue
        slot = slot_by_id.get(row_id)
        if not slot:
            continue
        block = block_by_id.get(slot.get("blockId"))
        if not block:
            continue
        row = row_by_id.get(block.get("sectionId"))
        if not row or row.get("kind") != "class":
            continue

        date_iso = assignment.get("dateISO")
        if not isinstance(date_iso, str):
            continue

        try:
            date_value = date.fromisoformat(date_iso)
        except ValueError:
            continue
        week_start = (date_value - timedelta(days=date_value.weekday())).isoformat()
        if week_start not in published_weeks:
            continue

        assignment_clinician_id = assignment.get("clinicianId")
        if clinician_id and assignment_clinician_id != clinician_id:
            continue
        # The UI treats vacations as an override that removes class assignments from the schedule
        # (even if the raw assignment exists in persisted state). Mirror that behavior here.
        if assignment_clinician_id in vacation_ranges_by_clinician:
            for start, end in vacation_ranges_by_clinician[assignment_clinician_id]:
                if start <= date_iso <= end:
                    assignment_clinician_id = None
                    break
        if not assignment_clinician_id:
            continue
        # Skip assignments whose clinician no longer exists: the public web
        # page drops them too, and emitting the raw internal id as a person's
        # name leaks implementation detail into subscribers' calendars.
        if assignment_clinician_id not in clinician_name_by_id:
            continue
        clinician_name = clinician_name_by_id[assignment_clinician_id]
        row_name = row.get("name") or block.get("sectionId") or "Section"
        slot_label = block.get("label") or None
        assignment_id = assignment.get("id") or f"{date_iso}-{row_id}-{assignment_clinician_id}"

        summary = (
            f"{row_name} ({slot_label}) - {clinician_name}"
            if slot_label
            else f"{row_name} - {clinician_name}"
        )
        uid = f"{assignment_id}@shiftschedule"

        minutes = _slot_minutes(slot)
        if minutes:
            # Wall clock times in the plan's zone, sent as UTC: an overnight
            # shift ends on a later day, and DST changes give real durations.
            start_utc = wall_clock_to_utc(date_value, minutes[0], zone)
            end_utc = wall_clock_to_utc(date_value, minutes[1], zone)
            when = [f"DTSTART:{_format_utc(start_utc)}"]
            # A shift inside the spring-forward gap has no real duration, and
            # DTEND must lie after DTSTART.
            if end_utc > start_utc:
                when.append(f"DTEND:{_format_utc(end_utc)}")
            start_minute = minutes[0]
        else:
            # No usable times: an all-day event on the start day.
            when = [
                f"DTSTART;VALUE=DATE:{_yyyymmdd(date_value)}",
                f"DTEND;VALUE=DATE:{_yyyymmdd(date_value + timedelta(days=1))}",
            ]
            start_minute = -1

        events.append((
            (date_iso, start_minute, uid),
            [
                "BEGIN:VEVENT",
                f"UID:{_escape_text(uid)}",
                f"DTSTAMP:{_format_utc(stamp)}",
                *when,
                f"SUMMARY:{_escape_text(summary)}",
                "END:VEVENT",
            ],
        ))

    events.sort(key=lambda event: event[0])
    for _, event_lines in events:
        lines.extend(event_lines)
    lines.append("END:VCALENDAR")
    return _fold_lines(lines)
