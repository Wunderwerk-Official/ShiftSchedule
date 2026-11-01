"""Working-time warnings of a swap and weekly hours.

The warnings (short rest, no free day after a night, long stretches) never
block a swap; the planner acknowledges them. They are not validator rules and
use visible items only: nobody works a vacation-hidden shift. Weekly hours
instead count exactly what ``validate_weekly_hours`` counts, vacation-hidden
assignments included, so the numbers explain every WEEKLY_HOURS block.
"""

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

from ..models import Assignment, Clinician
from ..validation import ValidationContext
from . import labels
from .blocks import WorkBlock, build_blocks, local_iso, visible_items
from .policy import SwapRules

IsoWeek = Tuple[int, int]


@dataclass(frozen=True)
class WorkWarning:
    id: str  # a pure function of the plan: wall-clock minutes and clinician id
    code: str  # "rest_short" | "night_no_free_day" | "block_too_long"
    check: str  # its check code: "rest" | "night_free_day" | "block_length"
    clinician_id: str
    message: str
    short: str
    # Start date of the later block (rest_short) or of the block; internal,
    # used for the pre-existing checks and never serialized.
    date_iso: str

    def as_json(self) -> Dict[str, str]:
        """The API's SwapWarning object."""
        return {"id": self.id, "code": self.code, "check": self.check, "clinicianId": self.clinician_id,
                "message": self.message, "short": self.short}


def _rest_short(cid: str, name: str, earlier: WorkBlock, later: WorkBlock, rules: SwapRules) -> WorkWarning:
    end, start = local_iso(earlier.abs_end), local_iso(later.abs_start)
    note = labels.rest_short(name, end, start, later.abs_start - earlier.abs_end, rules.min_rest_hours)
    return WorkWarning(id=f"rest:{cid}:{end}:{start}", code="rest_short", check="rest", clinician_id=cid,
                       message=note.message, short=note.short, date_iso=later.start_date_iso)


def _night_no_free_day(cid: str, name: str, night: WorkBlock, next_block: WorkBlock) -> WorkWarning:
    note = labels.night_no_free_day(name, local_iso(night.abs_end), local_iso(next_block.abs_start))
    return WorkWarning(id=f"night:{cid}:{local_iso(night.abs_start)}:{night.end_date_iso}",
                       code="night_no_free_day", check="night_free_day", clinician_id=cid,
                       message=note.message, short=note.short, date_iso=night.start_date_iso)


def _block_too_long(cid: str, name: str, block: WorkBlock, rules: SwapRules) -> WorkWarning:
    start, end = local_iso(block.abs_start), local_iso(block.abs_end)
    note = labels.block_too_long(name, start, end, block.minutes, rules.max_block_hours)
    return WorkWarning(id=f"long:{cid}:{start}:{end}", code="block_too_long", check="block_length",
                       clinician_id=cid, message=note.message, short=note.short, date_iso=block.start_date_iso)


def person_warnings(
    vctx: ValidationContext,
    rules: SwapRules,
    assignments: Iterable[Assignment],
    clinician_id: str,
    name: str,
) -> Dict[str, WorkWarning]:
    """Every warning of one person over the visible items among ``assignments``, by id."""
    blocks = build_blocks(visible_items(vctx, (a for a in assignments if a.clinicianId == clinician_id)))
    found: List[WorkWarning] = []
    for earlier, later in zip(blocks, blocks[1:]):
        if 0 < later.abs_start - earlier.abs_end < rules.min_rest_hours * 60:
            found.append(_rest_short(clinician_id, name, earlier, later, rules))
    first_block_on: Dict[str, WorkBlock] = {}
    for block in blocks:
        first_block_on.setdefault(block.start_date_iso, block)
    for block in blocks:
        # An overnight block ends after its start date, so this is always another block.
        next_block = first_block_on.get(block.end_date_iso) if block.overnight else None
        if next_block is not None:
            found.append(_night_no_free_day(clinician_id, name, block, next_block))
        if block.minutes > rules.max_block_hours * 60:
            found.append(_block_too_long(clinician_id, name, block, rules))
    return {warning.id: warning for warning in found}


def _split(
    vctx: ValidationContext,
    rules: SwapRules,
    before: Sequence[Assignment],
    after: Sequence[Assignment],
    clinician_ids: Iterable[str],
    names: Mapping[str, str],
) -> Tuple[List[WorkWarning], List[WorkWarning]]:
    new: List[WorkWarning] = []
    kept: List[WorkWarning] = []
    for cid in clinician_ids:
        known = person_warnings(vctx, rules, before, cid, names[cid])
        for warning_id, warning in person_warnings(vctx, rules, after, cid, names[cid]).items():
            (kept if warning_id in known else new).append(warning)
    return sorted(new, key=lambda w: w.id), sorted(kept, key=lambda w: w.id)


def new_warnings(
    vctx: ValidationContext,
    rules: SwapRules,
    before: Sequence[Assignment],
    after: Sequence[Assignment],
    clinician_ids: Iterable[str],
    names: Mapping[str, str],
) -> List[WorkWarning]:
    """Warnings of ``after`` whose ids ``before`` does not have, sorted by id. A
    short rest the change does not touch is therefore never reported."""
    return _split(vctx, rules, before, after, clinician_ids, names)[0]


def kept_warnings(
    vctx: ValidationContext,
    rules: SwapRules,
    before: Sequence[Assignment],
    after: Sequence[Assignment],
    clinician_ids: Iterable[str],
    names: Mapping[str, str],
) -> List[WorkWarning]:
    """Warnings present in both ``before`` and ``after``, sorted by id."""
    return _split(vctx, rules, before, after, clinician_ids, names)[1]


def iso_week(date_iso: str) -> IsoWeek:
    year, week, _ = date.fromisoformat(date_iso).isocalendar()
    return year, week


def week_minutes(
    vctx: ValidationContext,
    assignments: Iterable[Assignment],
    clinician_id: str,
    weeks: Iterable[IsoWeek],
) -> Dict[IsoWeek, int]:
    """validate_weekly_hours' sum for one person (whole slot durations, ISO week
    of the start date, vacation-hidden included) for every requested week."""
    totals = {week: 0 for week in weeks}
    for a in assignments:
        if a.clinicianId != clinician_id or a.rowId.startswith("pool-"):
            continue
        interval = vctx.slot_lookup.get(a.rowId)
        if interval is None:
            continue
        week = iso_week(a.dateISO)
        if week in totals:
            totals[week] += interval[1] - interval[0]
    return totals


def person_hours(
    vctx: ValidationContext,
    clinician: Clinician,
    before: Sequence[Assignment],
    after: Sequence[Assignment],
    weeks: Iterable[IsoWeek],
) -> Dict[str, Any]:
    """The API's SwapPersonHours object for the given weeks, ascending."""
    ordered = sorted(set(weeks))
    minutes_before = week_minutes(vctx, before, clinician.id, ordered)
    minutes_after = week_minutes(vctx, after, clinician.id, ordered)
    contract = clinician.workingHoursPerWeek
    contract_minutes = limit_minutes = None
    if isinstance(contract, (int, float)) and contract > 0:
        tolerance = clinician.workingHoursToleranceHours
        contract_minutes = round(contract * 60)
        limit_minutes = int((contract + max(0, tolerance if tolerance is not None else 5)) * 60)
    return {
        "clinicianId": clinician.id,
        "name": clinician.name,
        "weeks": [
            {
                "isoYear": year,
                "isoWeek": week,
                "weekStartISO": date.fromisocalendar(year, week, 1).isoformat(),
                "beforeMinutes": minutes_before[(year, week)],
                "afterMinutes": minutes_after[(year, week)],
                "contractMinutes": contract_minutes,
                "limitMinutes": limit_minutes,
            }
            for year, week in ordered
        ],
    }
