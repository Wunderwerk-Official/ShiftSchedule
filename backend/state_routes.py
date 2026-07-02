from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .auth import _get_current_user
from .models import AppState, UserPublic
from .state import _load_state, _normalize_state, _save_state

router = APIRouter()


class HealthCheckIssue(BaseModel):
    type: str  # "orphaned_assignment", "slot_collision", "duplicate_assignment", "colband_explosion"
    severity: str  # "error", "warning"
    message: str
    details: dict = {}


class DatabaseHealthCheckResult(BaseModel):
    healthy: bool
    issues: List[HealthCheckIssue]
    stats: dict


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/v1/state", response_model=AppState)
def get_state(current_user: UserPublic = Depends(_get_current_user)):
    return _load_state(current_user.username)


@router.post("/v1/state", response_model=AppState)
def set_state(payload: AppState, current_user: UserPublic = Depends(_get_current_user)):
    normalized, _ = _normalize_state(payload)
    _save_state(normalized, current_user.username)
    return normalized


@router.get("/v1/state/health", response_model=DatabaseHealthCheckResult)
def check_database_health(current_user: UserPublic = Depends(_get_current_user)):
    """
    Run database health checks and return any issues found.

    Checks performed:
    1. Orphaned assignments - assignments referencing non-existent slots
    2. Slot collisions - multiple sections sharing the same slot position
    3. Duplicate assignments - same clinician assigned multiple times to same slot/date
    4. ColBand explosion - excessive colBands per day type
    """
    state = _load_state(current_user.username)
    issues: List[HealthCheckIssue] = []

    # Build valid slot IDs from template
    valid_slot_ids = set()
    pool_ids = set()
    slot_info = {}  # slot_id -> {locationId, rowBandId, dayType, colBandOrder, sectionId}

    for row in state.rows or []:
        if row.kind == "pool":
            pool_ids.add(row.id)

    template = state.weeklyTemplate
    if template:
        # Build slot info for collision detection
        for loc in template.locations or []:
            col_band_by_id = {cb.id: cb for cb in (loc.colBands or [])}
            for slot in loc.slots or []:
                valid_slot_ids.add(slot.id)
                col_band = col_band_by_id.get(slot.colBandId)
                if col_band:
                    # Find block to get sectionId
                    block = next((b for b in (template.blocks or []) if b.id == slot.blockId), None)
                    slot_info[slot.id] = {
                        "locationId": loc.locationId,
                        "rowBandId": slot.rowBandId,
                        "dayType": col_band.dayType,
                        "colBandOrder": col_band.order,
                        "sectionId": block.sectionId if block else None,
                        "slotId": slot.id,
                    }

    # 1. Check for orphaned assignments
    orphaned = []
    for assignment in state.assignments or []:
        row_id = assignment.rowId
        if row_id not in valid_slot_ids and row_id not in pool_ids:
            orphaned.append({
                "assignmentId": assignment.id,
                "rowId": row_id,
                "dateISO": assignment.dateISO,
                "clinicianId": assignment.clinicianId,
            })

    if orphaned:
        issues.append(HealthCheckIssue(
            type="orphaned_assignment",
            severity="warning",
            message=f"{len(orphaned)} assignment(s) reference slots not in the template",
            details={"assignments": orphaned[:10]},  # Limit to first 10
        ))

    # 2. Check for slot collisions (multiple sections at same position)
    position_to_slots = {}  # key: "locId__rowBandId__dayType__colBandOrder" -> list of slot infos
    for slot_id, info in slot_info.items():
        key = f"{info['locationId']}__{info['rowBandId']}__{info['dayType']}__{info['colBandOrder']}"
        if key not in position_to_slots:
            position_to_slots[key] = []
        position_to_slots[key].append(info)

    collisions = []
    for key, slots in position_to_slots.items():
        section_ids = set(s["sectionId"] for s in slots if s["sectionId"])
        if len(section_ids) > 1:
            collisions.append({
                "position": key,
                "sectionIds": list(section_ids),
                "slotCount": len(slots),
            })

    if collisions:
        issues.append(HealthCheckIssue(
            type="slot_collision",
            severity="error",
            message=f"{len(collisions)} slot collision(s) detected - sections hidden in calendar",
            details={"collisions": collisions[:10]},
        ))

    # 3. Check for duplicate assignments (same clinician, same slot, same date)
    assignment_keys = {}  # key: "rowId__dateISO__clinicianId" -> list of assignment ids
    for assignment in state.assignments or []:
        key = f"{assignment.rowId}__{assignment.dateISO}__{assignment.clinicianId}"
        if key not in assignment_keys:
            assignment_keys[key] = []
        assignment_keys[key].append(assignment.id)

    duplicates = []
    for key, ids in assignment_keys.items():
        if len(ids) > 1:
            parts = key.split("__")
            duplicates.append({
                "rowId": parts[0],
                "dateISO": parts[1],
                "clinicianId": parts[2],
                "assignmentIds": ids,
                "count": len(ids),
            })

    if duplicates:
        issues.append(HealthCheckIssue(
            type="duplicate_assignment",
            severity="warning",
            message=f"{len(duplicates)} duplicate assignment(s) found",
            details={"duplicates": duplicates[:10]},
        ))

    # 4. Check for colBand explosion
    MAX_COLBANDS_PER_DAY = 20
    colband_issues = []
    if template:
        for loc in template.locations or []:
            count_by_day = {}
            for cb in loc.colBands or []:
                day = cb.dayType or "unknown"
                count_by_day[day] = count_by_day.get(day, 0) + 1

            for day, count in count_by_day.items():
                if count > MAX_COLBANDS_PER_DAY:
                    colband_issues.append({
                        "locationId": loc.locationId,
                        "dayType": day,
                        "count": count,
                        "limit": MAX_COLBANDS_PER_DAY,
                    })

    if colband_issues:
        issues.append(HealthCheckIssue(
            type="colband_explosion",
            severity="error",
            message=f"{len(colband_issues)} location(s) have excessive colBands",
            details={"locations": colband_issues},
        ))

    # 5. Count pool assignments and show as info
    pool_assignments = []
    for assignment in state.assignments or []:
        if assignment.rowId in pool_ids:
            pool_assignments.append({
                "assignmentId": assignment.id,
                "rowId": assignment.rowId,
                "dateISO": assignment.dateISO,
                "clinicianId": assignment.clinicianId,
            })

    if pool_assignments:
        issues.append(HealthCheckIssue(
            type="pool_assignment_info",
            severity="info",
            message=f"{len(pool_assignments)} pool assignment(s) (Rest Day, Vacation, etc.)",
            details={"assignments": pool_assignments[:10]},  # Limit to first 10
        ))

    # Build stats
    slot_assignments = [a for a in (state.assignments or []) if a.rowId not in pool_ids]
    stats = {
        "totalAssignments": len(slot_assignments),
        "totalSlots": len(valid_slot_ids),
        "totalClinicians": len(state.clinicians or []),
        "totalLocations": len(template.locations) if template else 0,
        "totalBlocks": len(template.blocks) if template else 0,
        "poolAssignments": len(pool_assignments),
    }

    # Only count errors and warnings as unhealthy (not info)
    error_warning_issues = [i for i in issues if i.severity in ("error", "warning")]

    return DatabaseHealthCheckResult(
        healthy=len(error_warning_issues) == 0,
        issues=issues,
        stats=stats,
    )


class SlotInspection(BaseModel):
    slotId: str
    locationId: str
    locationName: str
    rowBandId: str
    rowBandLabel: Optional[str]
    colBandId: str
    colBandLabel: Optional[str]
    dayType: str
    blockId: str
    sectionId: Optional[str]
    sectionName: Optional[str]
    startTime: Optional[str]
    endTime: Optional[str]
    dateISO: str
    dayOfWeek: str
    status: str  # "open", "assigned"
    assignments: List[dict]  # list of {clinicianId, clinicianName, source, assignmentId}


class PoolInspection(BaseModel):
    poolId: str
    poolName: str
    dateISO: str
    dayOfWeek: str
    assignments: List[dict]  # list of {clinicianId, clinicianName, source, assignmentId}


class WeeklyInspectionResult(BaseModel):
    weekStartISO: str
    weekEndISO: str
    slots: List[SlotInspection]
    poolAssignments: List[PoolInspection]
    stats: dict


_WEEKDAY_TO_DAY_TYPE = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _get_day_type(date: datetime, holidays: list) -> str:
    """Determine day type for a given date.

    Must return one of the values in ``DAY_TYPES`` from state.py
    (``"mon" | "tue" | ... | "sun" | "holiday"``) so slot matching against
    ``TemplateColBand.dayType`` works. A previous version returned
    ``"saturday" | "sunday" | "weekday"`` which silently produced empty
    inspection results because nothing ever matched the template day-type.
    """
    date_iso = date.strftime("%Y-%m-%d")
    if any(h.dateISO == date_iso for h in holidays):
        return "holiday"
    return _WEEKDAY_TO_DAY_TYPE[date.weekday()]


DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@router.get("/v1/state/inspect/week", response_model=WeeklyInspectionResult)
def inspect_week(
    week_start: str = Query(..., description="Week start date in YYYY-MM-DD format"),
    current_user: UserPublic = Depends(_get_current_user),
):
    """
    Inspect all slots for a given week directly from the database.
    Returns all slots with their assignment status (open or assigned).
    """
    state = _load_state(current_user.username)
    template = state.weeklyTemplate

    # Parse week start
    try:
        start_date = datetime.strptime(week_start, "%Y-%m-%d")
    except ValueError:
        start_date = datetime.now()
        # Adjust to Monday
        start_date = start_date - timedelta(days=start_date.weekday())

    # Generate dates for the week (Monday to Sunday)
    week_dates = [start_date + timedelta(days=i) for i in range(7)]
    week_end = week_dates[-1]

    # Build lookup maps
    location_names = {loc.id: loc.name for loc in (state.locations or [])}
    clinician_names = {c.id: c.name for c in (state.clinicians or [])}
    # block.sectionId refers to class row ids (row.kind is "class" or "pool";
    # there is no "section" kind).
    section_names = {row.id: row.name for row in (state.rows or []) if row.kind == "class"}
    pool_names = {row.id: row.name for row in (state.rows or []) if row.kind == "pool"}
    pool_ids = set(pool_names.keys())

    # Build assignment lookup: (rowId, dateISO) -> list of assignments
    assignment_lookup: dict = {}
    for assignment in state.assignments or []:
        key = (assignment.rowId, assignment.dateISO)
        if key not in assignment_lookup:
            assignment_lookup[key] = []
        assignment_lookup[key].append(assignment)

    slots_result: List[SlotInspection] = []
    pool_result: List[PoolInspection] = []

    if template:
        # Build slot info from template
        for loc in template.locations or []:
            loc_name = location_names.get(loc.locationId, loc.locationId)
            row_band_by_id = {rb.id: rb for rb in (loc.rowBands or [])}
            col_band_by_id = {cb.id: cb for cb in (loc.colBands or [])}
            block_by_id = {b.id: b for b in (template.blocks or [])}

            for slot in loc.slots or []:
                col_band = col_band_by_id.get(slot.colBandId)
                row_band = row_band_by_id.get(slot.rowBandId)
                block = block_by_id.get(slot.blockId)

                if not col_band:
                    continue

                slot_day_type = col_band.dayType

                # Find which days this slot applies to
                for date in week_dates:
                    date_iso = date.strftime("%Y-%m-%d")
                    day_type = _get_day_type(date, state.holidays or [])

                    # Check if this slot applies to this day
                    if slot_day_type != day_type:
                        continue

                    # Get assignments for this slot on this date
                    key = (slot.id, date_iso)
                    slot_assignments = assignment_lookup.get(key, [])

                    assignment_list = []
                    for a in slot_assignments:
                        assignment_list.append({
                            "assignmentId": a.id,
                            "clinicianId": a.clinicianId,
                            "clinicianName": clinician_names.get(a.clinicianId, a.clinicianId),
                            "source": a.source or "unknown",
                        })

                    status = "assigned" if assignment_list else "open"

                    slots_result.append(SlotInspection(
                        slotId=slot.id,
                        locationId=loc.locationId,
                        locationName=loc_name,
                        rowBandId=slot.rowBandId,
                        rowBandLabel=row_band.label if row_band else None,
                        colBandId=slot.colBandId,
                        colBandLabel=col_band.label if col_band else None,
                        dayType=slot_day_type,
                        blockId=slot.blockId,
                        sectionId=block.sectionId if block else None,
                        sectionName=section_names.get(block.sectionId) if block else None,
                        startTime=slot.startTime,
                        endTime=slot.endTime,
                        dateISO=date_iso,
                        dayOfWeek=DAY_NAMES[date.weekday()],
                        status=status,
                        assignments=assignment_list,
                    ))

    # Collect pool assignments for the week
    for date in week_dates:
        date_iso = date.strftime("%Y-%m-%d")
        for pool_id, pool_name in pool_names.items():
            key = (pool_id, date_iso)
            pool_assignments = assignment_lookup.get(key, [])

            if pool_assignments:
                assignment_list = []
                for a in pool_assignments:
                    assignment_list.append({
                        "assignmentId": a.id,
                        "clinicianId": a.clinicianId,
                        "clinicianName": clinician_names.get(a.clinicianId, a.clinicianId),
                        "source": a.source or "unknown",
                    })

                pool_result.append(PoolInspection(
                    poolId=pool_id,
                    poolName=pool_name,
                    dateISO=date_iso,
                    dayOfWeek=DAY_NAMES[date.weekday()],
                    assignments=assignment_list,
                ))

    # Sort slots by date, location, section, row, col
    slots_result.sort(key=lambda s: (s.dateISO, s.locationName, s.sectionName or "", s.rowBandLabel or "", s.colBandLabel or ""))

    # Calculate stats
    total_slots = len(slots_result)
    assigned_slots = sum(1 for s in slots_result if s.status == "assigned")
    open_slots = total_slots - assigned_slots

    return WeeklyInspectionResult(
        weekStartISO=start_date.strftime("%Y-%m-%d"),
        weekEndISO=week_end.strftime("%Y-%m-%d"),
        slots=slots_result,
        poolAssignments=pool_result,
        stats={
            "totalSlots": total_slots,
            "assignedSlots": assigned_slots,
            "openSlots": open_slots,
            "poolAssignments": len(pool_result),
        },
    )
