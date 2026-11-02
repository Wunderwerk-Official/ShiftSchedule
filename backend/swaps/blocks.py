"""Work blocks on the absolute minute axis.

A block is a contiguous stretch of one person's visible items: touching or
overlapping items merge, across midnight too (a night and its next-morning
handover form one block). A swap always moves whole blocks.

Minutes are calendar wall-clock minutes, naive like every validator; only the
"now" comparisons in ``policy`` know about time zones.
"""

from dataclasses import dataclass
from datetime import date
from functools import cached_property
from typing import FrozenSet, Iterable, List, Optional, Sequence, Tuple

from ..models import Assignment, SolverSettings
from ..validation import ValidationContext, _is_on_vacation
from . import labels

MINUTES_PER_DAY = 1440
_LAST_DAY = date.max.toordinal()


def abs_minute(date_iso: str, minute: int) -> int:
    return date.fromisoformat(date_iso).toordinal() * MINUTES_PER_DAY + minute


def date_of(abs_min: int) -> str:
    """The calendar day of a minute. A minute after 9999-12-31 (the end of an
    overnight item stored on that day) reads as that day instead of failing."""
    return date.fromordinal(min(abs_min // MINUTES_PER_DAY, _LAST_DAY)).isoformat()


def local_iso(abs_min: int) -> str:
    """Calendar wall clock "YYYY-MM-DDTHH:MM"."""
    minute = abs_min % MINUTES_PER_DAY
    return f"{date_of(abs_min)}T{minute // 60:02d}:{minute % 60:02d}"


@dataclass(frozen=True)
class TimedItem:
    # The stored object: plans remove assignments by identity. None only for
    # the synthetic item of a cover instance, which has no holder either.
    assignment: Optional[Assignment]
    clinician_id: Optional[str]
    slot_id: str
    date_iso: str
    section_id: str
    location_id: str
    abs_start: int
    abs_end: int

    @property
    def minutes(self) -> int:
        return self.abs_end - self.abs_start

    @property
    def instance_key(self) -> Tuple[str, str]:
        return (self.slot_id, self.date_iso)


def _item_order(item: TimedItem) -> Tuple[int, int, str, str]:
    assignment_id = item.assignment.id if item.assignment is not None else ""
    return (item.abs_start, -item.abs_end, item.slot_id, assignment_id)


@dataclass(frozen=True)
class WorkBlock:
    clinician_id: Optional[str]
    items: Tuple[TimedItem, ...]
    abs_start: int
    abs_end: int

    @property
    def start_date_iso(self) -> str:
        return date_of(self.abs_start)

    @property
    def end_date_iso(self) -> str:
        """Calendar day of the last worked minute."""
        return date_of(self.abs_end - 1)

    @property
    def minutes(self) -> int:
        return self.abs_end - self.abs_start

    @property
    def overnight(self) -> bool:
        return self.abs_end > (self.abs_start // MINUTES_PER_DAY + 1) * MINUTES_PER_DAY


@dataclass(frozen=True)
class SwapUnit:
    """What moves: one block, all blocks starting on one date ("Whole day"),
    or the synthetic block of a cover instance (no holder)."""

    clinician_id: Optional[str]
    blocks: Tuple[WorkBlock, ...]

    @cached_property
    def items(self) -> Tuple[TimedItem, ...]:
        return tuple(sorted((item for block in self.blocks for item in block.items), key=_item_order))

    @property
    def abs_start(self) -> int:
        return min(block.abs_start for block in self.blocks)

    @property
    def abs_end(self) -> int:
        return max(block.abs_end for block in self.blocks)

    @property
    def start_date_iso(self) -> str:
        return date_of(self.abs_start)

    @property
    def minutes(self) -> int:
        """Worked minutes: the sum of the block spans."""
        return sum(block.minutes for block in self.blocks)

    @property
    def overnight(self) -> bool:
        return any(block.overnight for block in self.blocks)

    @property
    def instance_keys(self) -> FrozenSet[Tuple[str, str]]:
        return frozenset(item.instance_key for item in self.items)

    @property
    def dates(self) -> Tuple[str, ...]:
        return tuple(sorted({item.date_iso for item in self.items}))

    @property
    def primary_section(self) -> str:
        """Section of the longest item; ties go to the earliest start."""
        return min(self.items, key=lambda item: (-item.minutes, item.abs_start)).section_id

    def kind(self, settings: SolverSettings) -> str:
        """The My plan rule: "duty" for overnight or on-call work, else "shift"."""
        on_call = settings.onCallRestClassId if settings.onCallRestEnabled else None
        if self.overnight or (on_call and any(item.section_id == on_call for item in self.items)):
            return "duty"
        return "shift"


class UnitError(Exception):
    """The selected assignment cannot be swapped; ``code`` is target.blocked.code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def slot_fingerprint(vctx: ValidationContext, slot_id: str) -> Optional[str]:
    """Times, place and section of a slot, e.g. "1200-1920@loc-mitte#sec-night";
    None when the slot has no valid interval."""
    interval = vctx.slot_lookup.get(slot_id)
    if interval is None:
        return None
    start, end, location_id = interval
    return f"{start}-{end}@{location_id}#{vctx.slot_sections.get(slot_id, '')}"


def _timed(
    vctx: ValidationContext,
    slot_id: str,
    date_iso: str,
    assignment: Optional[Assignment],
    clinician_id: Optional[str],
) -> Optional[TimedItem]:
    interval = vctx.slot_lookup.get(slot_id)
    if interval is None:
        return None
    start, end, location_id = interval
    abs_start = abs_minute(date_iso, start)
    return TimedItem(
        assignment=assignment,
        clinician_id=clinician_id,
        slot_id=slot_id,
        date_iso=date_iso,
        section_id=vctx.slot_sections.get(slot_id, ""),
        location_id=location_id,
        abs_start=abs_start,
        abs_end=abs_start + (end - start),
    )


def timed_item(vctx: ValidationContext, a: Assignment) -> Optional[TimedItem]:
    """None for pool rows and for slots without a valid interval."""
    if a.rowId.startswith("pool-"):
        return None
    return _timed(vctx, a.rowId, a.dateISO, a, a.clinicianId)


def is_hidden(vctx: ValidationContext, a: Assignment) -> bool:
    """Vacation-hidden: the holder exists and is on vacation that day."""
    holder = vctx.clinicians_by_id.get(a.clinicianId)
    return holder is not None and _is_on_vacation(holder, a.dateISO)


def visible_items(vctx: ValidationContext, assignments: Iterable[Assignment]) -> List[TimedItem]:
    """Timed, non-pool, not vacation-hidden items, sorted. Pass ONE person's assignments."""
    items: List[TimedItem] = []
    for a in assignments:
        item = timed_item(vctx, a)
        if item is not None and not is_hidden(vctx, a):
            items.append(item)
    return sorted(items, key=_item_order)


def build_blocks(items: Sequence[TimedItem]) -> List[WorkBlock]:
    """Sweep the items in time order: a gap starts a new block, so touching
    shifts (08–12 and 12–16) and overlapping ones join."""
    groups: List[List[TimedItem]] = []
    current_end = 0
    for item in sorted(items, key=_item_order):
        if groups and item.abs_start <= current_end:
            groups[-1].append(item)
            current_end = max(current_end, item.abs_end)
        else:
            groups.append([item])
            current_end = item.abs_end
    return [
        WorkBlock(group[0].clinician_id, tuple(group), group[0].abs_start, max(i.abs_end for i in group))
        for group in groups
    ]


def block_containing(blocks: Iterable[WorkBlock], a: Assignment) -> Optional[WorkBlock]:
    return next((block for block in blocks if any(item.assignment is a for item in block.items)), None)


def blocks_on_date(blocks: Iterable[WorkBlock], start_date_iso: str) -> List[WorkBlock]:
    return [block for block in blocks if block.start_date_iso == start_date_iso]


def unit_for(
    vctx: ValidationContext,
    person_assignments: Sequence[Assignment],
    a: Assignment,
    *,
    whole_day: bool,
) -> SwapUnit:
    """The unit of the stored assignment ``a`` among its holder's assignments:
    its block, or with ``whole_day`` every block starting on that block's date."""
    if a.rowId.startswith("pool-"):
        raise UnitError("pool_row", labels.TARGET_POOL)
    if is_hidden(vctx, a):
        holder = vctx.clinicians_by_id[a.clinicianId]
        raise UnitError("vacation_hidden", labels.target_hidden(holder.name, a.dateISO))
    if a.rowId not in vctx.slot_lookup:
        raise UnitError("no_times", labels.TARGET_NO_TIMES)
    blocks = build_blocks(visible_items(vctx, person_assignments))
    block = block_containing(blocks, a)
    if block is None:
        raise ValueError(f"Assignment {a.id} is not among the given person's assignments")
    chosen = blocks_on_date(blocks, block.start_date_iso) if whole_day else [block]
    return SwapUnit(a.clinicianId, tuple(chosen))


def instance_unit(vctx: ValidationContext, slot_id: str, date_iso: str) -> Optional[SwapUnit]:
    """The cover target: one synthetic item of the slot instance (no assignment,
    no holder) in a one-block unit; None when the slot has no valid interval."""
    item = _timed(vctx, slot_id, date_iso, None, None)
    if item is None:
        return None
    return SwapUnit(None, (WorkBlock(None, (item,), item.abs_start, item.abs_end),))
