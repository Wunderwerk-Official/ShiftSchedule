import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from .constants import (
    DEFAULT_LOCATION_ID,
    DEFAULT_LOCATION_NAME,
    DEFAULT_SUB_SHIFT_MINUTES,
    DEFAULT_SUB_SHIFT_START,
    DEFAULT_SUB_SHIFT_START_MINUTES,
    SHIFT_ROW_SEPARATOR,
)
from .db import _get_connection, _utcnow_iso
from .models import (
    AppState,
    Assignment,
    Clinician,
    Holiday,
    Location,
    MinSlots,
    PreferredWorkingTime,
    SolverRule,
    SolverSettings,
    SubShift,
    TemplateBlock,
    TemplateColBand,
    TemplateRowBand,
    TemplateSlot,
    UserStateExport,
    VacationRange,
    WeeklyCalendarTemplate,
    WeeklyTemplateLocation,
    WorkplaceRow,
)

DAY_TYPES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday")
PREFERRED_WORKING_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
SECTION_BLOCK_COLORS = [
    "#FDE2E4",
    "#FFD9C9",
    "#FFE8D6",
    "#FFEFD1",
    "#FFF4C1",
    "#EEF6C8",
    "#E6F7D9",
    "#DDF6EE",
    "#D9F0FF",
    "#DEE8FF",
    "#E8E1F5",
]


def _is_valid_date_iso(value: str) -> bool:
    """Check if value looks like a valid YYYY-MM-DD date string."""
    if not value or len(value) != 10:
        return False
    try:
        datetime.fromisoformat(f"{value}T00:00:00")
        return True
    except ValueError:
        return False


def _get_day_type(date_iso: str, holidays: List[Holiday]) -> str:
    if any(holiday.dateISO == date_iso for holiday in holidays):
        return "holiday"
    dt = datetime.fromisoformat(f"{date_iso}T00:00:00")
    mapping = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    return mapping[dt.weekday()]


def _build_shift_row_id(class_id: str, sub_shift_id: str) -> str:
    return f"{class_id}{SHIFT_ROW_SEPARATOR}{sub_shift_id}"


def _parse_shift_row_id(row_id: str) -> tuple[str, Optional[str]]:
    if SHIFT_ROW_SEPARATOR not in row_id:
        return row_id, None
    class_id, sub_shift_id = row_id.split(SHIFT_ROW_SEPARATOR, 1)
    return class_id, sub_shift_id or None


def _ensure_locations(locations: List[Location]) -> List[Location]:
    by_id = {loc.id: loc for loc in locations if loc.id}
    if DEFAULT_LOCATION_ID not in by_id:
        by_id[DEFAULT_LOCATION_ID] = Location(
            id=DEFAULT_LOCATION_ID, name=DEFAULT_LOCATION_NAME
        )
    return list(by_id.values())


DEFAULT_ROW_BAND_LABELS = ["Früh", "Morgen", "Mittag", "Nachmittag", "Spät"]


def _day_type_bool_record(value: bool) -> Dict[str, bool]:
    return {day_type: value for day_type in DAY_TYPES}


def _day_type_number_record(value: int) -> Dict[str, int]:
    return {day_type: value for day_type in DAY_TYPES}


def _normalize_day_type_bools(
    source: Optional[Dict[str, Any]], fallback: bool = False
) -> Dict[str, bool]:
    record = _day_type_bool_record(fallback)
    if not source:
        return record
    for day_type in DAY_TYPES:
        if isinstance(source.get(day_type), bool):
            record[day_type] = bool(source.get(day_type))
    return record


def _normalize_day_type_numbers(
    source: Optional[Dict[str, Any]], fallback: int = 0
) -> Dict[str, int]:
    record = _day_type_number_record(fallback)
    if not source:
        return record
    for day_type in DAY_TYPES:
        try:
            value = int(source.get(day_type))
        except (TypeError, ValueError):
            continue
        record[day_type] = max(0, value)
    return record


def _normalize_template_row_bands(row_bands: List[TemplateRowBand]) -> List[TemplateRowBand]:
    next_bands = [band for band in row_bands if band and band.id]
    next_bands.sort(key=lambda item: item.order)
    normalized = []
    for index, band in enumerate(next_bands, start=1):
        normalized.append(
            TemplateRowBand(
                id=band.id,
                label=band.label or None,
                order=index,
            )
        )
    return normalized


def _normalize_template_col_bands(col_bands: List[TemplateColBand]) -> List[TemplateColBand]:
    by_day: Dict[str, List[TemplateColBand]] = {day_type: [] for day_type in DAY_TYPES}
    for band in col_bands:
        if not band or not band.id:
            continue
        if band.dayType not in DAY_TYPES:
            continue
        by_day[band.dayType].append(band)
    normalized = []
    for day_type in DAY_TYPES:
        bands = by_day.get(day_type, [])
        bands.sort(key=lambda item: item.order)
        for index, band in enumerate(bands, start=1):
            normalized.append(
                TemplateColBand(
                    id=band.id,
                    label=band.label or "",
                    order=index,
                    dayType=day_type,
                )
            )
    return normalized


def _normalize_slot_time(slot: TemplateSlot) -> tuple[Optional[str], Optional[str], int]:
    start = _parse_time_to_minutes(slot.startTime)
    end = _parse_time_to_minutes(slot.endTime)
    raw_offset = slot.endDayOffset if isinstance(slot.endDayOffset, int) else 0
    end_day_offset = max(0, min(3, int(raw_offset or 0)))
    start_time = _format_minutes(start) if start is not None else None
    end_time = _format_minutes(end) if end is not None else None
    return start_time, end_time, end_day_offset


def _ensure_template_location(location_id: str) -> WeeklyTemplateLocation:
    return WeeklyTemplateLocation(
        locationId=location_id,
        rowBands=[
            TemplateRowBand(
                id=f"{location_id}-row-{index + 1}",
                label=label,
                order=index + 1,
            )
            for index, label in enumerate(DEFAULT_ROW_BAND_LABELS)
        ],
        colBands=[
            TemplateColBand(
                id=f"{location_id}-col-{day_type}-1", label="", order=1, dayType=day_type
            )
            for day_type in DAY_TYPES
        ],
        slots=[],
    )


def _build_default_template_for_location(
    location_id: str,
    class_rows: List[WorkplaceRow],
    min_slots_by_row_id: Dict[str, MinSlots],
) -> tuple[WeeklyTemplateLocation, List[TemplateBlock]]:
    col_bands = [
        TemplateColBand(
            id=f"{location_id}-col-{day_type}-1", label="", order=1, dayType=day_type
        )
        for day_type in DAY_TYPES
    ]
    col_band_by_day = {band.dayType: band.id for band in col_bands}
    row_bands: List[TemplateRowBand] = []
    slots: List[TemplateSlot] = []
    blocks: List[TemplateBlock] = []
    row_index = 1
    for row in class_rows:
        shifts = _normalize_sub_shifts(row.subShifts)
        for shift in shifts:
            row_band_id = f"{location_id}-row-{row_index}"
            row_bands.append(
                TemplateRowBand(
                    id=row_band_id,
                    label=shift.name,
                    order=row_index,
                )
            )
            row_index += 1
            shift_row_id = _build_shift_row_id(row.id, shift.id)
            min_slots = min_slots_by_row_id.get(shift_row_id, MinSlots(weekday=0, weekend=0))
            required_by_day_type = {
                "mon": min_slots.weekday,
                "tue": min_slots.weekday,
                "wed": min_slots.weekday,
                "thu": min_slots.weekday,
                "fri": min_slots.weekday,
                "sat": min_slots.weekend,
                "sun": min_slots.weekend,
                "holiday": min_slots.weekend,
            }
            for day_type in DAY_TYPES:
                block_id = f"block-{shift_row_id}-{day_type}"
                blocks.append(
                    TemplateBlock(
                        id=block_id,
                        sectionId=row.id,
                        label=shift.name,
                        requiredSlots=required_by_day_type.get(day_type, 0),
                        color=row.blockColor,
                    )
                )
                slots.append(
                    TemplateSlot(
                        id=f"{shift_row_id}__{day_type}",
                        locationId=location_id,
                        rowBandId=row_band_id,
                        colBandId=col_band_by_day.get(day_type) or "",
                        blockId=block_id,
                        requiredSlots=required_by_day_type.get(day_type, 0),
                        startTime=shift.startTime or DEFAULT_SUB_SHIFT_START,
                        endTime=shift.endTime
                        or _format_minutes(
                            DEFAULT_SUB_SHIFT_START_MINUTES + DEFAULT_SUB_SHIFT_MINUTES
                        ),
                        endDayOffset=shift.endDayOffset or 0,
                    )
                )
    if not row_bands:
        return _ensure_template_location(location_id), []
    return (
        WeeklyTemplateLocation(
            locationId=location_id, rowBands=row_bands, colBands=col_bands, slots=slots
        ),
        blocks,
    )


def _normalize_weekly_template(
    template: Optional[WeeklyCalendarTemplate],
    locations: List[Location],
    rows: List[WorkplaceRow],
    min_slots_by_row_id: Dict[str, MinSlots],
) -> tuple[WeeklyCalendarTemplate, bool, Dict[str, Dict[str, str]]]:
    changed = False
    legacy_slot_id_map: Dict[str, Dict[str, str]] = {}
    class_rows = [row for row in rows if row.kind == "class"]
    class_ids = {row.id for row in class_rows}
    section_color_by_id = {
        row.id: row.blockColor for row in class_rows if getattr(row, "blockColor", None)
    }
    location_ids = {loc.id for loc in locations}

    # Check if template needs legacy migration: None, old version, or missing blocks property
    # Note: Use hasattr() not truthiness check - empty blocks [] is valid for v4 templates
    if template is None or template.version < 4 or not hasattr(template, "blocks"):
        blocks: List[TemplateBlock] = []
        default_locations: List[WeeklyTemplateLocation] = []

        def _normalize_legacy_col_bands(
            col_bands: List[TemplateColBand],
        ) -> List[TemplateColBand]:
            next_bands = [band for band in col_bands if band and band.id]
            next_bands.sort(key=lambda item: item.order)
            normalized = []
            for index, band in enumerate(next_bands, start=1):
                normalized.append(
                    TemplateColBand(
                        id=band.id,
                        label=band.label or "",
                        order=index,
                        dayType="mon",
                    )
                )
            return normalized

        for loc in locations:
            existing = None
            if template:
                existing = next(
                    (item for item in template.locations if item.locationId == loc.id),
                    None,
                )
            if existing is None:
                loc_rows = [
                    row
                    for row in class_rows
                    if (row.locationId or DEFAULT_LOCATION_ID) == loc.id
                ]
                built_location, built_blocks = _build_default_template_for_location(
                    loc.id, loc_rows, min_slots_by_row_id
                )
                default_locations.append(built_location)
                blocks.extend(built_blocks)
                changed = True
                continue

            row_bands = _normalize_template_row_bands(existing.rowBands)
            # Allow empty row bands - users can add their own
            legacy_col_bands = _normalize_legacy_col_bands(existing.colBands or [])
            if not legacy_col_bands:
                legacy_col_bands = [
                    TemplateColBand(id=f"{loc.id}-col-1", label="", order=1, dayType="mon")
                ]
                changed = True

            col_bands: List[TemplateColBand] = []
            col_band_ids_by_legacy: Dict[str, Dict[str, str]] = {}
            for band in legacy_col_bands:
                mapping: Dict[str, str] = {}
                for day_type in DAY_TYPES:
                    col_id = f"{band.id}-{day_type}"
                    mapping[day_type] = col_id
                    col_bands.append(
                        TemplateColBand(
                            id=col_id,
                            label=band.label or "",
                            order=band.order or 1,
                            dayType=day_type,
                        )
                    )
                col_band_ids_by_legacy[band.id] = mapping

            row_band_ids = {band.id for band in row_bands}
            slots: List[TemplateSlot] = []
            for slot in existing.slots:
                if not slot or not slot.id:
                    continue
                if slot.rowBandId not in row_band_ids:
                    changed = True
                    continue
                section_id = getattr(slot, "sectionId", None)
                if section_id not in class_ids:
                    changed = True
                    continue
                enabled_by_day_type = _normalize_day_type_bools(
                    getattr(slot, "enabledByDayType", None), True
                )
                required_by_day_type = _normalize_day_type_numbers(
                    getattr(slot, "requiredByDayType", None)
                )
                start_minutes = _parse_time_to_minutes(getattr(slot, "startTime", None))
                if start_minutes is None:
                    start_minutes = DEFAULT_SUB_SHIFT_START_MINUTES
                end_minutes = _parse_time_to_minutes(getattr(slot, "endTime", None))
                if end_minutes is None:
                    end_minutes = start_minutes + DEFAULT_SUB_SHIFT_MINUTES
                raw_offset = getattr(slot, "endDayOffset", 0)
                end_day_offset = max(
                    0, min(3, int(raw_offset if isinstance(raw_offset, int) else 0))
                )
                # Carry a midnight-crossing default end into the day offset;
                # _format_minutes wraps modulo 24h.
                if end_minutes >= 24 * 60:
                    end_day_offset = max(end_day_offset, min(3, end_minutes // (24 * 60)))
                start_time = _format_minutes(start_minutes)
                end_time = _format_minutes(end_minutes)
                slot_label = getattr(slot, "label", None)

                for day_type in DAY_TYPES:
                    if not enabled_by_day_type.get(day_type, False):
                        continue
                    block_id = f"block-{slot.id}-{day_type}"
                    blocks.append(
                        TemplateBlock(
                            id=block_id,
                            sectionId=section_id,
                            label=slot_label,
                            requiredSlots=required_by_day_type.get(day_type, 0),
                            color=section_color_by_id.get(section_id),
                        )
                    )
                    col_band_id = (
                        col_band_ids_by_legacy.get(slot.colBandId, {}).get(day_type)
                        or f"{loc.id}-col-{day_type}-1"
                    )
                    slot_id = f"{slot.id}__{day_type}"
                    legacy_slot_id_map.setdefault(slot.id, {})[day_type] = slot_id
                    slots.append(
                        TemplateSlot(
                            id=slot_id,
                            locationId=loc.id,
                            rowBandId=slot.rowBandId,
                            colBandId=col_band_id,
                            blockId=block_id,
                            requiredSlots=required_by_day_type.get(day_type, 0),
                            startTime=start_time,
                            endTime=end_time,
                            endDayOffset=end_day_offset,
                        )
                    )

            default_locations.append(
                WeeklyTemplateLocation(
                    locationId=loc.id, rowBands=row_bands, colBands=col_bands, slots=slots
                )
            )
            changed = True

        return (
            WeeklyCalendarTemplate(version=4, blocks=blocks, locations=default_locations),
            True,
            legacy_slot_id_map,
        )

    blocks: List[TemplateBlock] = []
    for block in template.blocks or []:
        if not block or not block.id:
            continue
        if block.sectionId not in class_ids:
            changed = True
            continue
        raw_color = getattr(block, "color", None)
        color = raw_color.strip() if isinstance(raw_color, str) else None
        if color == "":
            color = None
        section_color = section_color_by_id.get(block.sectionId)
        if section_color:
            color = section_color
        required_slots = block.requiredSlots if isinstance(block.requiredSlots, int) else 0
        required_slots = max(0, required_slots)
        normalized_block = TemplateBlock(
            id=block.id,
            sectionId=block.sectionId,
            label=block.label,
            requiredSlots=required_slots,
            color=color,
        )
        if normalized_block.requiredSlots != block.requiredSlots:
            changed = True
        if raw_color != color:
            changed = True
        blocks.append(normalized_block)
    block_ids = {block.id for block in blocks}
    block_by_id = {block.id: block for block in blocks}

    next_locations: List[WeeklyTemplateLocation] = []
    for loc in locations:
        existing = next(
            (item for item in template.locations if item.locationId == loc.id), None
        )
        if existing is None:
            next_locations.append(_ensure_template_location(loc.id))
            changed = True
            continue
        row_bands = _normalize_template_row_bands(existing.rowBands)
        # Allow empty row bands - users can add their own
        col_bands = _normalize_template_col_bands(existing.colBands)
        col_bands_by_day: Dict[str, List[TemplateColBand]] = {day_type: [] for day_type in DAY_TYPES}
        for band in col_bands:
            col_bands_by_day.setdefault(band.dayType, []).append(band)
        for day_type in DAY_TYPES:
            if col_bands_by_day.get(day_type):
                continue
            col_bands.append(
                TemplateColBand(
                    id=f"{loc.id}-col-{day_type}-1", label="", order=1, dayType=day_type
                )
            )
            changed = True
        col_bands = _normalize_template_col_bands(col_bands)
        row_band_by_id = {band.id: band for band in row_bands}
        col_band_ids = {band.id for band in col_bands}
        slots: List[TemplateSlot] = []
        for slot in existing.slots:
            if not slot.id or slot.rowBandId not in row_band_by_id:
                changed = True
                continue
            if slot.colBandId not in col_band_ids:
                changed = True
                continue
            if slot.blockId not in block_ids:
                changed = True
                continue
            start_time, end_time, end_day_offset = _normalize_slot_time(slot)
            raw_required = getattr(slot, "requiredSlots", None)
            if isinstance(raw_required, (int, float)):
                required_slots = max(0, int(raw_required))
            else:
                required_slots = max(
                    0,
                    getattr(block_by_id.get(slot.blockId), "requiredSlots", 0)
                    if block_by_id.get(slot.blockId)
                    else 0,
                )
            normalized_slot = TemplateSlot(
                id=slot.id,
                locationId=loc.id,
                rowBandId=slot.rowBandId,
                colBandId=slot.colBandId,
                blockId=slot.blockId,
                requiredSlots=required_slots,
                startTime=start_time,
                endTime=end_time,
                endDayOffset=end_day_offset,
            )
            if normalized_slot.locationId != slot.locationId:
                changed = True
            if getattr(slot, "requiredSlots", None) != required_slots:
                changed = True
            slots.append(normalized_slot)
        next_locations.append(
            WeeklyTemplateLocation(
                locationId=loc.id,
                rowBands=row_bands,
                colBands=col_bands,
                slots=slots,
            )
        )
    if any(item.locationId not in location_ids for item in template.locations):
        changed = True
    return (
        WeeklyCalendarTemplate(version=4, blocks=blocks, locations=next_locations),
        changed,
        legacy_slot_id_map,
    )


def _parse_time_to_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    match = re.match(r"^(\d{1,2}):(\d{2})$", value.strip())
    if not match:
        return None
    hours = int(match.group(1))
    minutes = int(match.group(2))
    if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
        return None
    return hours * 60 + minutes


def _format_minutes(total_minutes: int) -> str:
    clamped = total_minutes % (24 * 60)
    hours = clamped // 60
    minutes = clamped % 60
    return f"{hours:02d}:{minutes:02d}"


def _normalize_working_time_requirement(value: Any) -> str:
    if not isinstance(value, str):
        return "none"
    trimmed = value.strip().lower()
    if trimmed == "preferred":
        return "preference"
    if trimmed in ("none", "preference", "mandatory"):
        return trimmed
    return "none"


def _normalize_preferred_working_time_entry(raw: Any) -> PreferredWorkingTime:
    start_raw = raw.startTime if isinstance(raw, PreferredWorkingTime) else None
    end_raw = raw.endTime if isinstance(raw, PreferredWorkingTime) else None
    requirement_raw = raw.requirement if isinstance(raw, PreferredWorkingTime) else None
    if isinstance(raw, dict):
        start_raw = raw.get("startTime", start_raw)
        end_raw = raw.get("endTime", end_raw)
        requirement_raw = raw.get("requirement", raw.get("mode", raw.get("status", requirement_raw)))
    start_minutes_raw = _parse_time_to_minutes(start_raw)
    end_minutes_raw = _parse_time_to_minutes(end_raw)
    invalid_window = (
        start_minutes_raw is None
        or end_minutes_raw is None
        or end_minutes_raw <= start_minutes_raw
    )
    requirement = _normalize_working_time_requirement(requirement_raw)
    if invalid_window:
        start_minutes_raw = None
        end_minutes_raw = None
    start_minutes = (
        start_minutes_raw if start_minutes_raw is not None else _parse_time_to_minutes("07:00")
    )
    end_minutes = (
        end_minutes_raw if end_minutes_raw is not None else _parse_time_to_minutes("17:00")
    )
    start_time = _format_minutes(start_minutes) if start_minutes is not None else "07:00"
    end_time = _format_minutes(end_minutes) if end_minutes is not None else "17:00"
    return PreferredWorkingTime(
        startTime=start_time,
        endTime=end_time,
        requirement=requirement,
    )


def _normalize_preferred_working_times(raw: Any) -> Dict[str, PreferredWorkingTime]:
    source = raw if isinstance(raw, dict) else {}
    return {
        day: _normalize_preferred_working_time_entry(source.get(day))
        for day in PREFERRED_WORKING_DAYS
    }


def _normalize_sub_shifts(sub_shifts: List[SubShift]) -> List[SubShift]:
    if not sub_shifts:
        return [
            SubShift(
                id="s1",
                name="Shift 1",
                order=1,
                startTime=DEFAULT_SUB_SHIFT_START,
                endTime=_format_minutes(
                    DEFAULT_SUB_SHIFT_START_MINUTES + DEFAULT_SUB_SHIFT_MINUTES
                ),
            )
        ]
    used_orders = set()
    normalized: List[SubShift] = []
    for shift in sub_shifts:
        order = shift.order if shift.order in (1, 2, 3) else None
        if not order or order in used_orders:
            for candidate in (1, 2, 3):
                if candidate not in used_orders:
                    order = candidate
                    break
        if not order or order in used_orders:
            continue
        used_orders.add(order)
        shift_id = shift.id or f"s{order}"
        shift_name = shift.name or f"Shift {order}"
        start_minutes = _parse_time_to_minutes(shift.startTime)
        end_minutes = _parse_time_to_minutes(shift.endTime)
        raw_offset = shift.endDayOffset if isinstance(shift.endDayOffset, int) else 0
        end_day_offset = max(0, min(3, raw_offset))
        if start_minutes is None:
            start_minutes = DEFAULT_SUB_SHIFT_START_MINUTES + DEFAULT_SUB_SHIFT_MINUTES * (
                order - 1
            )
        legacy_hours = shift.hours if isinstance(shift.hours, (int, float)) else None
        duration_minutes = (
            int(max(0, legacy_hours) * 60)
            if legacy_hours is not None
            else DEFAULT_SUB_SHIFT_MINUTES
        )
        if end_minutes is None:
            end_minutes = start_minutes + duration_minutes
            # A duration-derived end can cross midnight; _format_minutes wraps
            # modulo 24h, so carry the overflow into endDayOffset or the shift
            # would end before it starts (e.g. 22:00 + 8h -> 06:00 same day).
            if end_minutes >= 24 * 60:
                end_day_offset = max(end_day_offset, min(3, end_minutes // (24 * 60)))
        normalized.append(
            SubShift(
                id=shift_id,
                name=shift_name,
                order=order,
                startTime=_format_minutes(start_minutes),
                endTime=_format_minutes(end_minutes),
                endDayOffset=end_day_offset,
            )
        )
    if not normalized:
        normalized.append(
            SubShift(
                id="s1",
                name="Shift 1",
                order=1,
                startTime=DEFAULT_SUB_SHIFT_START,
                endTime=_format_minutes(
                    DEFAULT_SUB_SHIFT_START_MINUTES + DEFAULT_SUB_SHIFT_MINUTES
                ),
                endDayOffset=0,
            )
        )
    normalized.sort(key=lambda item: item.order)
    return normalized[:3]


def _resolve_shift_row(
    row_id: str, rows_by_id: Dict[str, WorkplaceRow]
) -> tuple[Optional[WorkplaceRow], Optional[SubShift]]:
    class_id, sub_shift_id = _parse_shift_row_id(row_id)
    row = rows_by_id.get(class_id)
    if not row or row.kind != "class":
        return None, None
    if not sub_shift_id:
        sub_shift_id = "s1"
    sub_shift = next(
        (shift for shift in row.subShifts if shift.id == sub_shift_id), None
    )
    return row, sub_shift


def _normalize_state(state: AppState) -> tuple[AppState, bool]:
    changed = False

    # Migration: Remove deprecated pool rows (Distribution Pool and Reserve Pool)
    deprecated_pool_ids = {"pool-not-allocated", "pool-manual"}
    filtered_rows = [row for row in state.rows if row.id not in deprecated_pool_ids]
    if len(filtered_rows) != len(state.rows):
        state.rows = filtered_rows
        changed = True

    # Migration: Remove assignments to deprecated pools
    filtered_assignments = [
        a for a in state.assignments if a.rowId not in deprecated_pool_ids
    ]
    if len(filtered_assignments) != len(state.assignments):
        state.assignments = filtered_assignments
        changed = True

    # Ensure system pools exist (Rest Day and Vacation)
    existing_row_ids = {row.id for row in state.rows}
    system_pools = [
        WorkplaceRow(
            id="pool-rest-day",
            name="Rest Day",
            kind="pool",
            dotColorClass="bg-slate-200",
        ),
        WorkplaceRow(
            id="pool-vacation",
            name="Vacation",
            kind="pool",
            dotColorClass="bg-emerald-500",
        ),
    ]
    for pool in system_pools:
        if pool.id not in existing_row_ids:
            state.rows.append(pool)
            changed = True

    locations_enabled = state.locationsEnabled is not False
    if state.locationsEnabled != locations_enabled:
        state.locationsEnabled = locations_enabled
        changed = True
    locations = _ensure_locations(state.locations or [])
    if state.locations != locations:
        state.locations = locations
        changed = True
    location_ids = {loc.id for loc in state.locations}

    normalized_clinicians: List[Clinician] = []
    for clinician in state.clinicians:
        preferred_working_times = _normalize_preferred_working_times(
            getattr(clinician, "preferredWorkingTimes", None)
        )
        next_clinician = clinician
        if preferred_working_times != getattr(clinician, "preferredWorkingTimes", {}):
            next_clinician = clinician.model_copy(
                update={"preferredWorkingTimes": preferred_working_times}
            )
            changed = True
        normalized_clinicians.append(next_clinician)
    if normalized_clinicians != state.clinicians:
        state.clinicians = normalized_clinicians

    if state.weeklyTemplate is not None and hasattr(state.weeklyTemplate, "blocks"):
        block_section_ids = {
            block.sectionId
            for block in (state.weeklyTemplate.blocks or [])
            if block.sectionId
        }
        next_rows: List[WorkplaceRow] = []
        for row in state.rows:
            if row.kind == "class" and row.id not in block_section_ids:
                changed = True
                continue
            next_rows.append(row)
        if next_rows != state.rows:
            state.rows = next_rows

    class_rows: List[WorkplaceRow] = []
    class_index = 0
    sub_shift_ids_by_class: Dict[str, set[str]] = {}
    row_ids = {row.id for row in state.rows}
    for row in state.rows:
        if row.kind != "class":
            continue
        normalized_shifts = _normalize_sub_shifts(row.subShifts)
        if row.subShifts != normalized_shifts:
            row.subShifts = normalized_shifts
            changed = True
        else:
            row.subShifts = normalized_shifts
        raw_block_color = getattr(row, "blockColor", None)
        block_color = raw_block_color.strip() if isinstance(raw_block_color, str) else None
        if not block_color:
            block_color = SECTION_BLOCK_COLORS[
                class_index % len(SECTION_BLOCK_COLORS)
            ]
        if block_color != raw_block_color:
            row.blockColor = block_color
            changed = True
        if not row.locationId or row.locationId not in location_ids:
            row.locationId = DEFAULT_LOCATION_ID
            changed = True
        if not locations_enabled and row.locationId != DEFAULT_LOCATION_ID:
            row.locationId = DEFAULT_LOCATION_ID
            changed = True
        class_rows.append(row)
        class_index += 1
        sub_shift_ids_by_class[row.id] = {shift.id for shift in row.subShifts}

    class_row_ids = {row.id for row in class_rows}
    fallback_shift_id_by_class = {
        row.id: (row.subShifts[0].id if row.subShifts else "s1") for row in class_rows
    }

    raw_slot_ids = set()
    if state.weeklyTemplate:
        for location in state.weeklyTemplate.locations:
            for slot in location.slots:
                raw_slot_ids.add(slot.id)

    next_assignments: List[Assignment] = []
    for assignment in state.assignments:
        row_id = assignment.rowId
        if row_id in class_row_ids and SHIFT_ROW_SEPARATOR not in row_id:
            fallback = fallback_shift_id_by_class.get(row_id, "s1")
            assignment = assignment.model_copy(
                update={"rowId": _build_shift_row_id(row_id, fallback)}
            )
            row_id = assignment.rowId
            changed = True
        if SHIFT_ROW_SEPARATOR in row_id:
            class_id, sub_shift_id = _parse_shift_row_id(row_id)
            if class_id in class_row_ids:
                class_shift_ids = sub_shift_ids_by_class.get(class_id, set())
                if not sub_shift_id or sub_shift_id not in class_shift_ids:
                    fallback = fallback_shift_id_by_class.get(class_id)
                    if not fallback:
                        changed = True
                        continue
                    assignment = assignment.model_copy(
                        update={"rowId": _build_shift_row_id(class_id, fallback)}
                    )
                    changed = True
                next_assignments.append(assignment)
                continue
            changed = True
            continue
        if (
            row_id in class_row_ids
            or row_id.startswith("pool-")
            or row_id in row_ids
            or row_id in raw_slot_ids
        ):
            next_assignments.append(assignment)
        else:
            changed = True
    state.assignments = next_assignments

    min_slots = dict(state.minSlotsByRowId)
    for row in class_rows:
        base = min_slots.pop(row.id, None)
        if base:
            changed = True
        for shift in row.subShifts:
            shift_row_id = _build_shift_row_id(row.id, shift.id)
            if shift_row_id not in min_slots:
                min_slots[shift_row_id] = (
                    base
                    if shift.id == "s1" and base
                    else MinSlots(weekday=0, weekend=0)
                )
                changed = True
    for key in list(min_slots.keys()):
        if SHIFT_ROW_SEPARATOR not in key and key not in row_ids and key not in raw_slot_ids:
            del min_slots[key]
            changed = True
            continue
        if SHIFT_ROW_SEPARATOR not in key:
            continue
        class_id, sub_shift_id = _parse_shift_row_id(key)
        if not sub_shift_id:
            del min_slots[key]
            changed = True
            continue
        class_shift_ids = sub_shift_ids_by_class.get(class_id)
        if not class_shift_ids or sub_shift_id not in class_shift_ids:
            del min_slots[key]
            changed = True
    state.minSlotsByRowId = min_slots

    overrides = state.slotOverridesByKey or {}
    next_overrides: Dict[str, int] = {}
    for key, value in overrides.items():
        row_id, date_iso = key.rsplit("__", 1) if "__" in key else (key, "")
        if not row_id or not date_iso:
            continue
        next_row_id = row_id
        if row_id in class_row_ids and SHIFT_ROW_SEPARATOR not in row_id:
            next_row_id = _build_shift_row_id(row_id, "s1")
            changed = True
        elif SHIFT_ROW_SEPARATOR in row_id:
            class_id, sub_shift_id = _parse_shift_row_id(row_id)
            class_shift_ids = sub_shift_ids_by_class.get(class_id)
            if not sub_shift_id or not class_shift_ids:
                changed = True
                continue
            if sub_shift_id not in class_shift_ids:
                fallback = next(iter(class_shift_ids), None)
                if not fallback:
                    changed = True
                    continue
                next_row_id = _build_shift_row_id(class_id, fallback)
                changed = True
        next_key = f"{next_row_id}__{date_iso}"
        next_overrides[next_key] = next_overrides.get(next_key, 0) + int(value)
    if overrides != next_overrides:
        state.slotOverridesByKey = next_overrides
        changed = True

    weekly_template, template_changed, legacy_slot_id_map = _normalize_weekly_template(
        state.weeklyTemplate, locations, state.rows, min_slots
    )
    if template_changed:
        changed = True
    state.weeklyTemplate = weekly_template
    slot_ids = {
        slot.id for location in weekly_template.locations for slot in location.slots
    }
    block_by_id = {block.id: block for block in weekly_template.blocks}
    slot_meta_by_id: Dict[str, Dict[str, Any]] = {}
    for location in weekly_template.locations:
        col_band_by_id = {band.id: band for band in location.colBands}
        for slot in location.slots:
            block = block_by_id.get(slot.blockId)
            valid = bool(block and block.sectionId in class_row_ids)
            col_band = col_band_by_id.get(slot.colBandId)
            day_type = col_band.dayType if col_band else None
            slot_meta_by_id[slot.id] = {"valid": valid, "dayType": day_type}
    pool_row_ids = {row.id for row in state.rows if row.kind == "pool"}

    slot_id_map_by_legacy: Dict[str, Dict[str, str]] = {
        **legacy_slot_id_map,
    }
    for slot_id in slot_ids:
        parts = slot_id.split("__")
        if len(parts) != 2:
            continue
        base_id, day_type = parts
        if not base_id or day_type not in DAY_TYPES:
            continue
        slot_id_map_by_legacy.setdefault(base_id, {})[day_type] = slot_id

    def _resolve_legacy_slot_id(row_id: str, date_iso: str) -> Optional[str]:
        mapping = slot_id_map_by_legacy.get(row_id)
        if not mapping:
            return row_id
        day_type = _get_day_type(date_iso, state.holidays or [])
        return mapping.get(day_type)

    mapped_assignments: List[Assignment] = []
    for assignment in state.assignments:
        if assignment.rowId in pool_row_ids:
            mapped_assignments.append(assignment)
            continue
        next_row_id = assignment.rowId
        if next_row_id not in slot_ids:
            mapped = _resolve_legacy_slot_id(next_row_id, assignment.dateISO)
            if not mapped:
                changed = True
                continue
            next_row_id = mapped
            changed = True
        if next_row_id not in slot_ids:
            changed = True
            continue
        meta = slot_meta_by_id.get(next_row_id)
        if not meta or not meta.get("valid", False):
            # Invalid assignment - remove it (no longer moved to Distribution Pool)
            changed = True
            continue
        assignment_day_type = _get_day_type(assignment.dateISO, state.holidays or [])
        slot_day_type = meta.get("dayType")
        if slot_day_type and slot_day_type != assignment_day_type:
            # Day type mismatch - remove assignment (no longer moved to Distribution Pool)
            changed = True
            continue
        if next_row_id != assignment.rowId:
            assignment = assignment.model_copy(update={"rowId": next_row_id})
        mapped_assignments.append(assignment)
    if mapped_assignments != state.assignments:
        state.assignments = mapped_assignments
        changed = True

    next_overrides: Dict[str, int] = {}
    for key, value in (state.slotOverridesByKey or {}).items():
        row_id, date_iso = key.rsplit("__", 1) if "__" in key else (key, "")
        if not row_id or not date_iso:
            continue
        # Skip malformed keys where date_iso is not a valid date (e.g., day type like "mon")
        if not _is_valid_date_iso(date_iso):
            changed = True
            continue
        next_row_id = row_id
        if next_row_id not in slot_ids:
            mapped = _resolve_legacy_slot_id(next_row_id, date_iso)
            if not mapped:
                changed = True
                continue
            next_row_id = mapped
            changed = True
        if next_row_id not in slot_ids:
            changed = True
            continue
        next_key = f"{next_row_id}__{date_iso}"
        next_overrides[next_key] = next_overrides.get(next_key, 0) + int(value)
    if next_overrides != state.slotOverridesByKey:
        state.slotOverridesByKey = next_overrides
        changed = True

    # Solver settings defaults
    solver_settings = state.solverSettings or {}
    default_settings = SolverSettings().model_dump()
    merged_settings = {**default_settings, **solver_settings}
    merged_settings["enforceSameLocationPerDay"] = bool(
        merged_settings.get("enforceSameLocationPerDay", False)
    )
    merged_settings["onCallRestEnabled"] = bool(
        merged_settings.get("onCallRestEnabled", False)
    )
    # Remove deprecated settings during migration
    merged_settings.pop("showDistributionPool", None)
    merged_settings.pop("showReservePool", None)
    merged_settings.pop("allowMultipleShiftsPerDay", None)
    merged_settings.pop("weightGapPenalty", None)
    on_call_class_id = merged_settings.get("onCallRestClassId")
    if not isinstance(on_call_class_id, str) or on_call_class_id not in class_row_ids:
        merged_settings["onCallRestClassId"] = class_rows[0].id if class_rows else None

    def _clamp_days(value: Any) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return 1
        return max(0, min(7, parsed))

    merged_settings["onCallRestDaysBefore"] = _clamp_days(
        merged_settings.get("onCallRestDaysBefore", 1)
    )
    merged_settings["onCallRestDaysAfter"] = _clamp_days(
        merged_settings.get("onCallRestDaysAfter", 1)
    )
    merged_settings["preferContinuousShifts"] = bool(
        merged_settings.get("preferContinuousShifts", True)
    )

    def _clamp_tolerance(value: Any) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default_settings.get("workingHoursToleranceHours", 5)
        return max(0, min(40, parsed))

    merged_settings["workingHoursToleranceHours"] = _clamp_tolerance(
        merged_settings.get(
            "workingHoursToleranceHours",
            default_settings.get("workingHoursToleranceHours", 5),
        )
    )
    if merged_settings != solver_settings:
        state.solverSettings = merged_settings
        changed = True

    # Solver rules validation
    valid_shift_row_ids = slot_ids
    normalized_rules: List[Dict[str, Any]] = []
    for raw_rule in state.solverRules or []:
        try:
            rule = SolverRule.model_validate(raw_rule)
        except Exception:
            changed = True
            continue
        enabled = rule.enabled
        if rule.ifShiftRowId not in valid_shift_row_ids:
            enabled = False
        if rule.thenType == "shiftRow" and rule.thenShiftRowId not in valid_shift_row_ids:
            enabled = False
        normalized_rules.append({**rule.model_dump(), "enabled": enabled})
        if enabled != rule.enabled:
            changed = True
    if normalized_rules != (state.solverRules or []):
        state.solverRules = normalized_rules
        changed = True

    return state, changed


def _default_state() -> AppState:
    """Load default state from default_state.json file."""
    import os
    default_state_path = os.path.join(os.path.dirname(__file__), "default_state.json")
    if os.path.exists(default_state_path):
        with open(default_state_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        state = AppState.model_validate(data)
        state, _ = _normalize_state(state)
        return state
    # Fallback to minimal empty state if file doesn't exist
    current_year = datetime.now(timezone.utc).year
    default_location = Location(id=DEFAULT_LOCATION_ID, name="Default")
    rows = [
        WorkplaceRow(
            id="pool-rest-day",
            name="Rest Day",
            kind="pool",
            dotColorClass="bg-slate-200",
        ),
        WorkplaceRow(
            id="pool-vacation",
            name="Vacation",
            kind="pool",
            dotColorClass="bg-emerald-500",
        ),
    ]
    clinicians: List[Clinician] = []
    min_slots: Dict[str, MinSlots] = {}
    empty_col_bands = [
        TemplateColBand(
            id=f"{DEFAULT_LOCATION_ID}-col-{day_type}-1",
            label="",
            order=1,
            dayType=day_type,
        )
        for day_type in DAY_TYPES
    ]
    weekly_template = WeeklyCalendarTemplate(
        version=4,
        blocks=[],
        locations=[
            WeeklyTemplateLocation(
                locationId=DEFAULT_LOCATION_ID,
                rowBands=[],
                colBands=empty_col_bands,
                slots=[],
            )
        ],
    )
    return AppState(
        locations=[default_location],
        locationsEnabled=True,
        solverSettings=SolverSettings().model_dump(),
        solverRules=[],
        rows=rows,
        clinicians=clinicians,
        assignments=[],
        minSlotsByRowId=min_slots,
        slotOverridesByKey={},
        weeklyTemplate=weekly_template,
        holidayCountry="DE",
        holidayYear=current_year,
        holidays=[],
    )


def _load_state(user_id: str) -> AppState:
    conn = _get_connection()
    row = conn.execute(
        "SELECT data FROM app_state WHERE id = ?", (user_id,)
    ).fetchone()
    if not row and user_id == "jk":
        legacy = conn.execute(
            "SELECT data FROM app_state WHERE id = ?", ("state",)
        ).fetchone()
        if legacy:
            data = json.loads(legacy[0])
            state = AppState.model_validate(data)
            state, _ = _normalize_state(state)
            _save_state(state, user_id)
            conn.close()
            return state
    conn.close()
    if not row:
        state = _default_state()
        _save_state(state, user_id)
        return state
    data = json.loads(row[0])
    state = AppState.model_validate(data)
    state, changed = _normalize_state(state)
    if changed:
        _save_state(state, user_id)
    return state


def _save_state(state: AppState, user_id: str) -> None:
    conn = _get_connection()
    payload = state.model_dump()
    now = _utcnow_iso()
    conn.execute(
        "INSERT OR REPLACE INTO app_state (id, data, updated_at) VALUES (?, ?, ?)",
        (user_id, json.dumps(payload), now),
    )
    conn.commit()
    conn.close()


def _load_raw_state_blob(username: str) -> Optional[Dict[str, Any]]:
    """Side-effect-free read of the stored state blob. Unlike _load_state
    this never creates, normalizes, or re-saves anything - the change log
    diffs against exactly what was on disk."""
    conn = _get_connection()
    row = conn.execute(
        "SELECT data FROM app_state WHERE id = ?", (username,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except (TypeError, ValueError):
        return None


def _parse_date_input(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", trimmed):
        try:
            datetime.fromisoformat(f"{trimmed}T00:00:00+00:00")
        except ValueError as exc:
            from fastapi import HTTPException

            raise HTTPException(status_code=400, detail="Invalid date.") from exc
        return trimmed
    match = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", trimmed)
    if not match:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="Invalid date format.")
    day_raw, month_raw, year_raw = match.groups()
    day = int(day_raw)
    month = int(month_raw)
    year = int(year_raw)
    try:
        dt = datetime(year, month, day)
    except ValueError as exc:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="Invalid date.") from exc
    return dt.date().isoformat()


def _parse_iso_datetime(value: Optional[str]) -> datetime:
    if not value:
        return datetime.now(timezone.utc).replace(microsecond=0)
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return datetime.now(timezone.utc).replace(microsecond=0)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0)


def _normalize_week_start(date_iso: str) -> tuple[str, str]:
    base = datetime.fromisoformat(f"{date_iso}T00:00:00+00:00").date()
    week_start = base - timedelta(days=base.weekday())
    week_end = week_start + timedelta(days=6)
    return week_start.isoformat(), week_end.isoformat()


def _load_state_blob_and_updated_at(username: str) -> tuple[Dict[str, Any], datetime, str]:
    conn = _get_connection()
    row = conn.execute(
        "SELECT data, updated_at FROM app_state WHERE id = ?", (username,)
    ).fetchone()
    conn.close()
    if not row:
        state = _default_state()
        _save_state(state, username)
        now = _utcnow_iso()
        return state.model_dump(), datetime.fromisoformat(now), now
    data = json.loads(row[0])
    updated_at_raw = row[1]
    updated_at = _parse_iso_datetime(updated_at_raw)
    return data, updated_at, updated_at_raw


def _parse_import_state(payload: Optional[Dict[str, Any]]) -> Optional[AppState]:
    if payload is None:
        return None
    if isinstance(payload, dict) and "state" in payload:
        export = UserStateExport.model_validate(payload)
        normalized, _ = _normalize_state(export.state)
        return normalized
    state = AppState.model_validate(payload)
    normalized, _ = _normalize_state(state)
    return normalized
