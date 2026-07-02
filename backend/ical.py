from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional


def _escape_text(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _format_dtstamp(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc).replace(microsecond=0)
    return utc.strftime("%Y%m%dT%H%M%SZ")


def _iso_to_yyyymmdd(date_iso: str) -> str:
    return date_iso.replace("-", "")


def _add_days_iso(date_iso: str, days: int) -> str:
    year, month, day_ = (int(part) for part in date_iso.split("-"))
    next_date = date(year, month, day_)  # noqa: DTZ011
    next_date = next_date.fromordinal(next_date.toordinal() + days)
    return next_date.isoformat()


def _fold_ical_line(line: str) -> str:
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

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//ShiftSchedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape_text(cal_name)}",
    ]

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

        if published_weeks:
            try:
                date_value = date.fromisoformat(date_iso)
            except ValueError:
                continue
            week_start = (date_value - timedelta(days=date_value.weekday())).isoformat()
            if week_start not in published_weeks:
                continue
        else:
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
        start = _iso_to_yyyymmdd(date_iso)
        # All-day events: DTEND is exclusive, so a single-day shift ends at
        # start+1. Shifts crossing midnight (endDayOffset >= 1) extend into
        # the following day(s) and must block them in subscribers' calendars.
        end_day_offset = slot.get("endDayOffset")
        extra_days = end_day_offset if isinstance(end_day_offset, int) and end_day_offset > 0 else 0
        end = _iso_to_yyyymmdd(_add_days_iso(date_iso, 1 + min(3, extra_days)))
        uid = f"{assignment_id}@shiftschedule"

        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{_escape_text(uid)}",
                f"DTSTAMP:{_format_dtstamp(stamp)}",
                f"DTSTART;VALUE=DATE:{start}",
                f"DTEND;VALUE=DATE:{end}",
                f"SUMMARY:{_escape_text(summary)}",
                "END:VEVENT",
            ]
        )

    lines.append("END:VCALENDAR")
    return _fold_lines(lines)
