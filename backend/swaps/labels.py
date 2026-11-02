"""English texts of the swap assistant: errors, reasons, warnings, findings, chips, checks.

Pure formatting of names, ISO dates, calendar wall-clock times
("YYYY-MM-DDTHH:MM", see ``blocks.local_iso``) and minutes. Templates are
functions; texts without placeholders are constants.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Dict, List, NamedTuple, Optional, Sequence

from ..models import SolverSettings

if TYPE_CHECKING:  # policy imports blocks, which imports this module
    from .policy import SwapRules

_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_WEEKDAY_PLURALS = {
    "mon": "Mondays", "tue": "Tuesdays", "wed": "Wednesdays", "thu": "Thursdays",
    "fri": "Fridays", "sat": "Saturdays", "sun": "Sundays",
}


class Note(NamedTuple):
    """A warning or finding: the full sentence and its chip text."""

    message: str
    short: str


class Shift(NamedTuple):
    """A shift named in a text: its section, date and wall-clock start and end."""

    section: str
    date_iso: str
    start_local: str
    end_local: str


# --- Numbers, dates and times ------------------------------------------------


def hours_text(minutes: float) -> str:
    """Hours with one decimal: 2640 -> "44.0"."""
    return f"{minutes / 60:.1f}"


def compact_number(value: float) -> str:
    """At most one decimal and no trailing ".0": 40 -> "40", 38.5 -> "38.5"."""
    text = f"{value:.1f}"
    return text[:-2] if text.endswith(".0") else text


def day_label(date_iso: str) -> str:
    """Short date: 2026-11-19 -> "Thu 19 Nov"."""
    day = date.fromisoformat(date_iso)
    return f"{_WEEKDAYS[day.weekday()]} {day.day} {_MONTHS[day.month - 1]}"


def moment(local: str) -> str:
    """Short date and time: 2026-11-19T16:00 -> "Thu 19 Nov 16:00"."""
    return f"{day_label(local[:10])} {local[11:16]}"


def time_range(start_local: str, end_local: str) -> str:
    """Times only: "08:00–16:00" within one day, "20:00 → 08:00" across midnight."""
    separator = "–" if start_local[:10] == end_local[:10] else " → "
    return f"{start_local[11:16]}{separator}{end_local[11:16]}"


def _clock(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def window_range(start_minute: int, end_minute: int) -> str:
    """A same-day working-time window in minutes after midnight: "07:00–15:00"."""
    return f"{_clock(start_minute)}–{_clock(end_minute)}"


def weekday_plural(weekday_key: str) -> str:
    """Validator weekday key to plural: thu -> "Thursdays"."""
    return _WEEKDAY_PLURALS[weekday_key]


# --- Fixed server texts -----------------------------------------------------

STATE_CHANGED = "The calendar changed in another tab or operation. Reload it and try again."
CONSENT_REQUIRED = "Confirm that the colleague agreed to the swap."
INVALID_SAME_PERSON = "Choose another person."
INVALID_UNKNOWN_PERSON = "This person is not in the plan."
INVALID_ITEMS = "These shifts do not belong to the chosen people. Refresh and try again."
INVALID_SHARED_SLOT = "Both shifts are in the same slot. Choose another shift."
STALE_GONE = "This shift no longer exists. Refresh the plan."
STALE_SLOT = "This slot is no longer open. Refresh and try again."
STALE_SLOT_TIMES = "This slot's times or place changed. Refresh and try again."
STALE_REST_DAY = "The Rest Day entries changed. Refresh and try again."
STALE_HIDDEN = "The hidden shift in this slot changed. Refresh and try again."
STARTED = "This shift has already started and can't be swapped."
PLAN_INVALID = "This swap no longer matches the weekly template or holidays. Refresh and try again."
SWAP_INVALID_PREFIX = "This swap breaks a planning rule: "
UNDO_INVALID_PREFIX = "Undoing this swap would break a planning rule: "
WARNINGS_UNACK = "Check the working-time warnings first."
UNDO_CONFLICT = "The shifts changed after the swap. Edit them in the plan."
UNDO_STARTED = "A swapped shift has already started; change it in the plan instead."
ALREADY_REVERTED = "This swap was already undone."
NOT_FOUND = "Swap not found."
TARGET_STARTED = "This shift has already started."
TARGET_DAY_STARTED = "A shift of this day has already started."
TARGET_SLOT_STARTED = "This slot has already started."
TARGET_POOL = "Rest Day and Vacation entries can't be swapped."
TARGET_NO_TIMES = "This shift has no valid times in the template."
TARGET_NOT_OPEN = "This slot has no open position."
TARGET_INACTIVE = "This slot does not exist on this day."
UNDO_NOT_IN_PLAN = "Not in the current plan."
UNDO_CHANGED = "The shifts changed after the swap."
UNDO_ALREADY_STARTED = "Already started."
PERSON_GONE = "A person of this swap is no longer in the plan."


def stale_item(name: str, date_iso: str) -> str:
    return f"{name}'s shift on {day_label(date_iso)} changed. Refresh and try again."


def stale_now_hidden(name: str, date_iso: str) -> str:
    return f"{name} is now on vacation on {day_label(date_iso)}. Refresh and try again."


def stale_partner_in_slot(name: str) -> str:
    return f"{name} already works in this slot."


def notice(hours_left: float, notice_hours: float) -> str:
    return (f"This swap starts in {compact_number(hours_left)} h, inside the "
            f"{compact_number(notice_hours)} h notice period. Confirm the override to apply it.")


def target_hidden(name: str, date_iso: str) -> str:
    return (f"{name} is on vacation on {day_label(date_iso)}; this shift is hidden. "
            "Use Find cover on the open slot instead.")


def swap_invalid(reasons: Sequence[str]) -> str:
    """The 409 swap_invalid message of an apply: the prefix and the first three reasons."""
    return SWAP_INVALID_PREFIX + " ".join(reasons[:3])


def undo_invalid(reasons: Sequence[str]) -> str:
    """The 409 swap_invalid message of an undo: the undo's own prefix, since
    it is the undo that would break the rule."""
    return UNDO_INVALID_PREFIX + " ".join(reasons[:3])


def undo_person_gone(name: Optional[str]) -> str:
    """History reason: a person of the swap was deleted from the plan."""
    return f"{name} is no longer in the plan." if name else PERSON_GONE


def undo_person_gone_conflict(name: Optional[str]) -> str:
    return f"{undo_person_gone(name)} This swap can't be undone."


def undo_rest_and_work(name: str, date_iso: str) -> str:
    """History reason: undo would leave a person resting and working on one day."""
    return f"Undo would give {name} a Rest Day and a shift on {day_label(date_iso)}."


def undo_rest_and_work_conflict(name: str, date_iso: str) -> str:
    return f"{undo_rest_and_work(name, date_iso)} Edit them in the plan."


# --- Reasons for blocked options --------------------------------------------


def not_qualified(name: str, section: str) -> str:
    return f"{name} is not qualified for {section}."


def on_vacation(name: str, date_iso: str) -> str:
    return f"{name} is on vacation on {day_label(date_iso)}."


def rest_day(name: str, date_iso: str) -> str:
    """A shift on a day the person keeps in the Rest Day row."""
    return f"Rest Day: {name} has a Rest Day on {day_label(date_iso)}."


def already_assigned(name: str, section: str, date_iso: str) -> str:
    return f"{name} already works {section} on {day_label(date_iso)}."


def overlap(name: str, section: str, date_iso: str, start_local: str, end_local: str) -> str:
    return (f"{name} already works {section} on {day_label(date_iso)} "
            f"({time_range(start_local, end_local)}).")


def _shift_text(shift: Shift) -> str:
    return (f"{shift.section} ({day_label(shift.date_iso)}, "
            f"{time_range(shift.start_local, shift.end_local)})")


def overlap_received(name: str, first: Shift, second: Shift) -> str:
    """Both shifts of an overlap are new for the person, the earlier one first."""
    return f"{name} would get two overlapping shifts: {_shift_text(first)} and {_shift_text(second)}."


def on_call_rest_works(name: str, date_iso: str) -> str:
    return f"On-call rest: {name} works {day_label(date_iso)}."


def on_call_rest_on_call(name: str, date_iso: str) -> str:
    return f"On-call rest: {name} is on call on {day_label(date_iso)}."


# A vacation hides a stored shift on the grid (its slot shows as open), but the
# rules still count it until cover replaces it.
_HIDDEN_WAY_OUT = "is hidden by a vacation but still counts. Find cover for it first."


def hidden_on_call(name: str, date_iso: str) -> str:
    return f"On-call rest: {name}'s on-call on {day_label(date_iso)} {_HIDDEN_WAY_OUT}"


def hidden_rest_clash(name: str, section: str, date_iso: str) -> str:
    """A received on-call's rest day holds a vacation-hidden shift."""
    return f"On-call rest: {name}'s {section} on {day_label(date_iso)} {_HIDDEN_WAY_OUT}"


def hidden_overlap(name: str, section: str, date_iso: str, start_local: str, end_local: str) -> str:
    return (f"Overlap: {name}'s {section} on {day_label(date_iso)} "
            f"({time_range(start_local, end_local)}) {_HIDDEN_WAY_OUT}")


def mandatory_window(name: str, start_minute: int, end_minute: int, weekday_key: str) -> str:
    return (f"{name} must work within {window_range(start_minute, end_minute)} "
            f"on {weekday_plural(weekday_key)}.")


def same_location(name: str, date_iso: str) -> str:
    return f"{name} would work at two locations on {day_label(date_iso)}."


def split_shift(name: str, date_iso: str) -> str:
    return f"{name} would have a split day on {day_label(date_iso)}."


def weekly_hours(name: str, iso_week: int, assigned_minutes: int, max_minutes: int) -> str:
    return (f"{name}: week {iso_week} would reach {hours_text(assigned_minutes)} h "
            f"(limit {hours_text(max_minutes)} h).")


def capacity(section: str, date_iso: str) -> str:
    return f"{section} on {day_label(date_iso)} would be overfilled."


def unknown_slot(date_iso: str) -> str:
    return f"A shift on {day_label(date_iso)} no longer matches the weekly template."


# --- Working-time warnings --------------------------------------------------


def rest_short(name: str, end_local: str, start_local: str, gap_minutes: int,
               min_rest_hours: float) -> Note:
    return Note(
        f"{name}: only {hours_text(gap_minutes)} h rest between {moment(end_local)} and "
        f"{moment(start_local)} (minimum {compact_number(min_rest_hours)} h).",
        f"Short rest {compact_number(gap_minutes / 60)} h",
    )


def night_no_free_day(name: str, night_end_local: str, next_start_local: str) -> Note:
    return Note(
        f"{name}: no free day after the night ending {moment(night_end_local)} "
        f"(works again {moment(next_start_local)}).",
        "No free day after night",
    )


def block_too_long(name: str, start_local: str, end_local: str, minutes: int,
                   max_block_hours: float) -> Note:
    return Note(
        f"{name}: {hours_text(minutes)} h without a break, {moment(start_local)} → "
        f"{moment(end_local)} (maximum {compact_number(max_block_hours)} h).",
        f"{compact_number(minutes / 60)} h stretch",
    )


# --- Soft findings ----------------------------------------------------------


def rest_day_removed(name: str, date_iso: str) -> Note:
    """A person who takes a shift loses their Rest Day that day (a day off
    placed by hand, which automatic planning respects since v1.75)."""
    return Note(f"{name} has a Rest Day on {day_label(date_iso)}; it will be removed.", "Rest Day removed")


def solver_rule(name: str, rule_name: str, date_iso: str) -> Note:
    return Note(f"{name}: breaks the rule “{rule_name}” on {day_label(date_iso)}.",
                f"Rule: {rule_name}")


def preference_window(name: str, start_minute: int, end_minute: int, weekday_key: str) -> Note:
    return Note(
        f"{name} prefers to work {window_range(start_minute, end_minute)} "
        f"on {weekday_plural(weekday_key)}.",
        "Outside preferred times",
    )


def preferred_day_off(name: str, weekday_key: str) -> Note:
    return Note(f"{name} prefers {weekday_plural(weekday_key)} off.", "Preferred day off")


def section_preference(name: str, section: str) -> Note:
    return Note(f"{name} prefers other sections to {section}.", "Less preferred section")


def hours_above_contract(name: str, iso_week: int, after_minutes: int, contract_hours: float) -> Note:
    return Note(
        f"{name}: week {iso_week} at {hours_text(after_minutes)} h "
        f"(contract {compact_number(contract_hours)} h).",
        f"+{compact_number(after_minutes / 60 - contract_hours)} h over contract",
    )


def giver_below_contract(name: str, iso_week: int, after_minutes: int, contract_hours: float) -> Note:
    return Note(
        f"{name}: week {iso_week} drops to {hours_text(after_minutes)} h "
        f"(contract {compact_number(contract_hours)} h).",
        f"−{compact_number(contract_hours - after_minutes / 60)} h under contract",
    )


def partner_notice(name: str, hours_until: float, notice_hours: float) -> Note:
    return Note(
        f"{name}'s shift starts in {compact_number(hours_until)} h "
        f"(notice period {compact_number(notice_hours)} h).",
        f"Starts in {compact_number(hours_until)} h",
    )


# --- Chips ------------------------------------------------------------------

SAME_SECTION = "Same section"
SAME_TYPE = "Same type"
SAME_WEEK = "Same week"
HOURS_EVEN = "Hours even"
NO_CONTRACT = "No contract hours"


def prefers(section: str) -> str:
    return f"Prefers {section}"


def behind_on_hours(percent: int) -> str:
    return f"{percent} % behind on hours"


# --- Checks list ------------------------------------------------------------


def check_list(settings: SolverSettings, rules: SwapRules, mode: str) -> List[Dict[str, str]]:
    """The preview's checks in display order; each says "no new …" because the
    gate only rejects new or worse violations."""
    checks = [
        ("qualification", "Qualified for both shifts" if mode == "swap" else "Qualified for the shift"),
        ("vacation", "No shift moved onto a vacation day"),
        ("rest_day", "No new shift on a Rest Day"),
        ("overlap", "No new overlapping shifts"),
    ]
    if settings.enforceSameLocationPerDay:
        checks.append(("same_location", "No new second location on a day"))
    before = max(0, settings.onCallRestDaysBefore or 0)
    after = max(0, settings.onCallRestDaysAfter or 0)
    if settings.onCallRestEnabled and settings.onCallRestClassId and before + after > 0:
        days = "day" if before == 1 else "days"
        checks.append(("on_call_rest",
                       f"No new on-call rest conflict ({before} {days} before, {after} after)"))
    checks += [
        ("mandatory_window", "No new shift outside mandatory working times"),
        ("weekly_hours", "No new week over contract + tolerance"),
    ]
    if settings.preferContinuousShifts:
        checks.append(("split_shift", "No new split day"))
    if mode == "cover":
        checks.append(("capacity", "Slot not overfilled"))
    checks += [
        ("rest", f"No new rest under {compact_number(rules.min_rest_hours)} h between shifts"),
        ("night_free_day", "No new night without a free day after it"),
        ("block_length", f"No new stretch longer than {compact_number(rules.max_block_hours)} h"),
    ]
    return [{"code": code, "label": label} for code, label in checks]
