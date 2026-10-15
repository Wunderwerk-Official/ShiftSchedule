import type { ClinicianOption } from "../components/schedule/ClinicianPickerPopover";
import type { RenderedAssignment, TimeRange } from "./schedule";
import {
  REST_DAY_POOL_ID,
  buildShiftInterval,
  intervalsOverlap,
  splitAssignmentKey,
} from "./schedule";
import type { ScheduleRow } from "./shiftRows";

// Pure extraction of the clinician-picker eligibility logic that used to live
// inside ScheduleGrid, so the classic weekly grid and the clinic sheet layout
// share identical vacation / rest-day / time-conflict / location semantics.

export type SlotOptionClinician = {
  id: string;
  name: string;
  qualifiedClassIds: string[];
  vacations: Array<{ startISO: string; endISO: string }>;
};

export function buildRowKindById(rows: ScheduleRow[]): Map<string, "class" | "pool"> {
  const map = new Map<string, "class" | "pool">();
  for (const row of rows) {
    map.set(row.id, row.kind);
    row.slotRows?.forEach((slotRow) => map.set(slotRow.id, slotRow.kind));
  }
  return map;
}

export function buildShiftIntervalsByRowId(rows: ScheduleRow[]): Map<string, TimeRange> {
  const map = new Map<string, TimeRange>();
  for (const row of rows) {
    const interval = buildShiftInterval(row);
    if (interval) map.set(row.id, interval);
    if (row.slotRows?.length) {
      row.slotRows.forEach((slotRow) => {
        const slotInterval = buildShiftInterval(slotRow);
        if (slotInterval) map.set(slotRow.id, slotInterval);
      });
    }
  }
  return map;
}

const rowKindOf = (rowKindById: Map<string, "class" | "pool">, rowId: string) =>
  rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");

export type DateIntervalIndex = {
  assignedIntervalsByDate: Map<string, Map<string, TimeRange[]>>;
  /**
   * Per date and clinician: how many of their class assignments sit in a slot
   * without a valid time (e.g. 20:00-08:00 without "+1 day"). A count, not a
   * set, so a drag can leave out the dragged assignment itself.
   */
  unknownIntervalsByDate: Map<string, Map<string, number>>;
};

export function buildDateIntervalIndex(
  assignmentMap: Map<string, RenderedAssignment[]>,
  rowKindById: Map<string, "class" | "pool">,
  shiftIntervalsByRowId: Map<string, TimeRange>,
): DateIntervalIndex {
  const assignedByDate = new Map<string, Map<string, TimeRange[]>>();
  const unknownByDate = new Map<string, Map<string, number>>();
  for (const [key, list] of assignmentMap.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!rowId || !dateISO) continue;
    if (rowKindOf(rowKindById, rowId) !== "class") continue;
    const interval = shiftIntervalsByRowId.get(rowId);
    for (const assignment of list) {
      if (!interval) {
        const unknownCounts = unknownByDate.get(dateISO) ?? new Map<string, number>();
        unknownCounts.set(
          assignment.clinicianId,
          (unknownCounts.get(assignment.clinicianId) ?? 0) + 1,
        );
        unknownByDate.set(dateISO, unknownCounts);
        continue;
      }
      let clinicianMap = assignedByDate.get(dateISO);
      if (!clinicianMap) {
        clinicianMap = new Map<string, TimeRange[]>();
        assignedByDate.set(dateISO, clinicianMap);
      }
      const intervals = clinicianMap.get(assignment.clinicianId) ?? [];
      intervals.push(interval);
      clinicianMap.set(assignment.clinicianId, intervals);
    }
  }
  return { assignedIntervalsByDate: assignedByDate, unknownIntervalsByDate: unknownByDate };
}

export type DragPayload = {
  rowId: string;
  dateISO: string;
  assignmentId: string;
  clinicianId: string;
};

/** Drag data type the schedule grids use for a dragged assignment. */
export const DRAG_MIME = "application/x-schedule-cell";

/** Reads the grids' drag data; null when missing or malformed (e.g. a cross-tab drop). */
export function readDragPayload(dataTransfer: Pick<DataTransfer, "getData">): DragPayload | null {
  const raw = dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<DragPayload> | null;
    if (!payload?.rowId || !payload.dateISO || !payload.assignmentId || !payload.clinicianId) {
      return null;
    }
    return {
      rowId: payload.rowId,
      dateISO: payload.dateISO,
      assignmentId: payload.assignmentId,
      clinicianId: payload.clinicianId,
    };
  } catch {
    return null;
  }
}

export function canDropAssignment(
  payload: DragPayload,
  targetRowId: string,
  targetDateISO: string,
  index: {
    rowKindById: Map<string, "class" | "pool">;
    shiftIntervalsByRowId: Map<string, TimeRange>;
    assignedIntervalsByDate: DateIntervalIndex["assignedIntervalsByDate"];
    unknownIntervalsByDate: DateIntervalIndex["unknownIntervalsByDate"];
  },
): boolean {
  const {
    rowKindById,
    shiftIntervalsByRowId,
    assignedIntervalsByDate,
    unknownIntervalsByDate,
  } = index;
  const targetKind = rowKindById.get(targetRowId);
  if (targetKind === "pool") return true;
  // Note: We allow dropping clinicians on rest day - manual overrides are allowed
  // and will show a warning. The solver enforces rules but UI allows overrides.
  const assignedIntervals =
    assignedIntervalsByDate.get(targetDateISO)?.get(payload.clinicianId) ?? [];
  const currentInterval =
    payload.dateISO === targetDateISO
      ? shiftIntervalsByRowId.get(payload.rowId) ?? null
      : null;
  let effectiveIntervals = assignedIntervals;
  if (currentInterval && payload.rowId !== targetRowId) {
    let removed = false;
    effectiveIntervals = assignedIntervals.filter((interval) => {
      if (removed) return true;
      const matches =
        interval.start === currentInterval.start &&
        interval.end === currentInterval.end;
      if (matches) {
        removed = true;
        return false;
      }
      return true;
    });
  }
  // A same-day move out of a slot without a valid time takes that unknown
  // interval along: only the clinician's other unknown intervals block.
  const ownUnknown =
    payload.dateISO === targetDateISO &&
    payload.rowId !== targetRowId &&
    rowKindOf(rowKindById, payload.rowId) === "class" &&
    !shiftIntervalsByRowId.has(payload.rowId)
      ? 1
      : 0;
  const unknownCount =
    unknownIntervalsByDate.get(targetDateISO)?.get(payload.clinicianId) ?? 0;
  const hasUnknown = unknownCount - ownUnknown > 0;
  const hasAny = effectiveIntervals.length > 0 || hasUnknown;
  // Always allow multiple shifts as long as times don't overlap
  if (!hasAny) return true;
  if (hasUnknown) return false;
  const targetInterval = shiftIntervalsByRowId.get(targetRowId);
  if (!targetInterval) return false;
  return !effectiveIntervals.some((interval) =>
    intervalsOverlap(interval, targetInterval),
  );
}

export function buildClinicianOptionsForSlot(args: {
  rowId: string;
  dateISO: string;
  rows: ScheduleRow[];
  assignmentMap: Map<string, RenderedAssignment[]>;
  clinicians: SlotOptionClinician[];
  enforceSameLocationPerDay: boolean;
  shiftIntervalsByRowId: Map<string, TimeRange>;
  assignedIntervalsByDate: DateIntervalIndex["assignedIntervalsByDate"];
  unknownIntervalsByDate: DateIntervalIndex["unknownIntervalsByDate"];
  getIsOnRestDay?: (clinicianId: string, dateISO: string) => boolean;
}): ClinicianOption[] {
  const {
    rowId,
    dateISO,
    rows,
    assignmentMap,
    clinicians,
    enforceSameLocationPerDay,
    shiftIntervalsByRowId,
    assignedIntervalsByDate,
    unknownIntervalsByDate,
    getIsOnRestDay,
  } = args;
  const row =
    rows.find((r) => r.id === rowId) ??
    rows.flatMap((r) => r.slotRows ?? []).find((sr) => sr.id === rowId);
  if (!row || row.kind !== "class") return [];
  const classId = row.sectionId ?? row.id;
  const slotLocationId = row.locationId ?? "loc-default";

  // Get already assigned clinicians for this specific slot
  const slotKey = `${rowId}__${dateISO}`;
  const slotAssignments = assignmentMap.get(slotKey) ?? [];
  const assignedClinicianIds = new Set(slotAssignments.map((a) => a.clinicianId));

  // Build a map of clinician -> locations they're assigned to on this date
  const clinicianLocationsOnDate = new Map<string, Set<string>>();
  if (enforceSameLocationPerDay) {
    for (const [key, assignments] of assignmentMap.entries()) {
      if (!key.endsWith(`__${dateISO}`)) continue;
      const keyRowId = splitAssignmentKey(key).rowId;
      const keyRow =
        rows.find((r) => r.id === keyRowId) ??
        rows.flatMap((r) => r.slotRows ?? []).find((sr) => sr.id === keyRowId);
      if (!keyRow || keyRow.kind !== "class") continue;
      const locationId = keyRow.locationId ?? "loc-default";
      for (const assignment of assignments) {
        const existing = clinicianLocationsOnDate.get(assignment.clinicianId) ?? new Set();
        existing.add(locationId);
        clinicianLocationsOnDate.set(assignment.clinicianId, existing);
      }
    }
  }

  return clinicians.map((clinician) => {
    // Check qualification
    const isQualified = clinician.qualifiedClassIds.includes(classId);

    // Check vacation
    const isOnVacation = clinician.vacations.some((v) => {
      return dateISO >= v.startISO && dateISO <= v.endISO;
    });

    // Check rest day
    const restAssignments = assignmentMap.get(`${REST_DAY_POOL_ID}__${dateISO}`) ?? [];
    const fallbackRestDay = restAssignments.some(
      (assignment) => assignment.clinicianId === clinician.id,
    );
    const isOnRestDay = getIsOnRestDay?.(clinician.id, dateISO) ?? fallbackRestDay;

    // Check time conflict
    const assignedIntervals =
      assignedIntervalsByDate.get(dateISO)?.get(clinician.id) ?? [];
    const hasUnknownInterval =
      unknownIntervalsByDate.get(dateISO)?.has(clinician.id) ?? false;
    const slotInterval = shiftIntervalsByRowId.get(rowId);
    const computedConflict =
      slotInterval &&
      assignedIntervals.some((interval) => intervalsOverlap(interval, slotInterval));
    // Always allow multiple shifts as long as times don't overlap
    const hasTimeConflict = hasUnknownInterval || Boolean(computedConflict);

    // Check location conflict (only if enforceSameLocationPerDay is enabled)
    let hasLocationConflict = false;
    if (enforceSameLocationPerDay) {
      const clinicianLocations = clinicianLocationsOnDate.get(clinician.id);
      if (clinicianLocations && clinicianLocations.size > 0) {
        // If they're assigned to a different location, that's a conflict
        hasLocationConflict = !clinicianLocations.has(slotLocationId);
      }
    }

    // Check if already assigned to this slot
    const alreadyAssigned = assignedClinicianIds.has(clinician.id);

    // If already in this slot, don't report time conflict (it's redundant)
    const effectiveTimeConflict = alreadyAssigned ? false : hasTimeConflict;

    return {
      id: clinician.id,
      name: clinician.name,
      isQualified,
      isOnVacation,
      isOnRestDay,
      hasTimeConflict: effectiveTimeConflict,
      hasLocationConflict,
      alreadyAssigned,
    };
  });
}
