import { addDays, toISODate } from "./date";
import type { SolverSettings } from "../api/client";
import type { Assignment, Clinician } from "../api/client";
import type { ScheduleRow } from "./shiftRows";

export const REST_DAY_POOL_ID = "pool-rest-day";
export const VACATION_POOL_ID = "pool-vacation";

export type TimeRange = { start: number; end: number };
export type AvailabilitySegment = { label: string; kind: "free" | "taken" };
export type RenderedAssignment = Assignment & {
  availabilitySegments?: AvailabilitySegment[];
};

const MINUTES_IN_DAY = 24 * 60;

// Assignment-map keys have the form `${rowId}__${dateISO}`. Row ids can
// themselves contain "__" (migrated template slot ids like "class-1::s1__mon"),
// so the key must be split at the LAST "__" separator.
export function splitAssignmentKey(key: string): { rowId: string; dateISO: string } {
  const idx = key.lastIndexOf("__");
  if (idx < 0) return { rowId: key, dateISO: "" };
  return { rowId: key.slice(0, idx), dateISO: key.slice(idx + 2) };
}

function parseTimeToMinutes(value?: string): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutesWithOffset(totalMinutes: number): string {
  const offset = Math.floor(totalMinutes / MINUTES_IN_DAY);
  const clamped = ((totalMinutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return offset > 0 ? `${base} +${offset}d` : base;
}

export function formatTimeRangeLabel(start: number, end: number): string {
  return `${formatMinutesWithOffset(start)} - ${formatMinutesWithOffset(end)}`;
}

export function buildShiftInterval(row: ScheduleRow): TimeRange | null {
  if (row.kind !== "class") return null;
  const start = parseTimeToMinutes(row.startTime);
  if (start === null) return null;
  const endBase = parseTimeToMinutes(row.endTime);
  if (endBase === null) return null;
  const offset =
    typeof row.endDayOffset === "number" && Number.isFinite(row.endDayOffset)
      ? Math.max(0, Math.min(3, Math.floor(row.endDayOffset)))
      : 0;
  const end = endBase + offset * MINUTES_IN_DAY;
  if (end <= start) return null;
  return { start, end };
}

export function intervalsOverlap(a: TimeRange, b: TimeRange): boolean {
  return !(a.end <= b.start || b.end <= a.start);
}

export function buildRenderedAssignmentMap(
  assignmentMap: Map<string, Assignment[]>,
  clinicians: Clinician[],
  displayDays: Date[],
  options?: {
    scheduleRows?: ScheduleRow[];
    solverSettings?: SolverSettings;
    holidayDates?: Set<string>;
  },
) {
  const scheduleRows = options?.scheduleRows ?? [];
  const solverSettings = options?.solverSettings ?? {
    enforceSameLocationPerDay: true,
    onCallRestEnabled: false,
    onCallRestClassId: "",
    onCallRestDaysBefore: 0,
    onCallRestDaysAfter: 0,
  };
  const displayDateSet = new Set(displayDays.map((date) => toISODate(date)));
  const rowKindById = new Map(scheduleRows.map((row) => [row.id, row.kind]));
  const sectionByRowId = new Map(
    scheduleRows
      .filter((row) => row.kind === "class")
      .map((row) => [row.id, row.sectionId ?? row.id]),
  );
  const hasRestDayPoolRow = scheduleRows.some((row) => row.id === REST_DAY_POOL_ID);
  const onCallRestClassId = solverSettings.onCallRestClassId ?? "";
  const restDaysBefore = Math.max(0, solverSettings.onCallRestDaysBefore ?? 0);
  const restDaysAfter = Math.max(0, solverSettings.onCallRestDaysAfter ?? 0);
  const onCallShiftRowIds = new Set(
    Array.from(sectionByRowId.entries())
      .filter(([, sectionId]) => sectionId === onCallRestClassId)
      .map(([rowId]) => rowId),
  );

  const vacationByDate = new Map<string, Set<string>>();
  for (const clinician of clinicians) {
    for (const vacation of clinician.vacations) {
      let cursor = new Date(`${vacation.startISO}T00:00:00`);
      const end = new Date(`${vacation.endISO}T00:00:00`);
      while (cursor <= end) {
        const dateISO = toISODate(cursor);
        let set = vacationByDate.get(dateISO);
        if (!set) {
          set = new Set();
          vacationByDate.set(dateISO, set);
        }
        set.add(clinician.id);
        cursor = addDays(cursor, 1);
      }
    }
  }

  const next = new Map<string, RenderedAssignment[]>();
  const assignedCliniciansByDate = new Map<string, Set<string>>();
  const assignedShiftRowsByDate = new Map<string, Map<string, Set<string>>>();
  const restDayAssignmentsByDate = new Map<string, Set<string>>();
  const poolCliniciansByKey = new Map<string, Set<string>>();
  const poolCliniciansByDate = new Map<string, Set<string>>();

  for (const [key, list] of assignmentMap.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!dateISO) continue;
    if (rowId === VACATION_POOL_ID) continue;
    const rowKind =
      rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");

    const vacationSet = vacationByDate.get(dateISO);
    const filtered = list.filter((item) => !vacationSet || !vacationSet.has(item.clinicianId));
    if (filtered.length === 0) continue;
    next.set(key, [...filtered]);
    if (rowKind === "pool") {
      const poolSet = poolCliniciansByKey.get(key) ?? new Set<string>();
      for (const item of filtered) {
        poolSet.add(item.clinicianId);
        const dateSet = poolCliniciansByDate.get(dateISO) ?? new Set<string>();
        dateSet.add(item.clinicianId);
        poolCliniciansByDate.set(dateISO, dateSet);
      }
      poolCliniciansByKey.set(key, poolSet);
      if (rowId === REST_DAY_POOL_ID) {
        const restSet = restDayAssignmentsByDate.get(dateISO) ?? new Set<string>();
        for (const item of filtered) {
          restSet.add(item.clinicianId);
        }
        restDayAssignmentsByDate.set(dateISO, restSet);
      }
    }

    if (rowKind !== "class") continue;
    let dayShiftRows = assignedShiftRowsByDate.get(dateISO);
    if (!dayShiftRows) {
      dayShiftRows = new Map();
      assignedShiftRowsByDate.set(dateISO, dayShiftRows);
    }
    let assignedSet = assignedCliniciansByDate.get(dateISO);
    if (!assignedSet) {
      assignedSet = new Set();
      assignedCliniciansByDate.set(dateISO, assignedSet);
    }
    for (const item of filtered) {
      assignedSet.add(item.clinicianId);
      const assignedRows = dayShiftRows.get(item.clinicianId) ?? new Set<string>();
      assignedRows.add(rowId);
      dayShiftRows.set(item.clinicianId, assignedRows);
    }
  }

  for (const [key, list] of next.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!rowId || !dateISO) continue;
    const rowKind =
      rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");
    if (rowKind !== "pool") continue;
    const assignedSet = assignedCliniciansByDate.get(dateISO);
    if (!assignedSet || assignedSet.size === 0) continue;
    const filtered = list.filter((item) => !assignedSet.has(item.clinicianId));
    if (filtered.length === 0) {
      next.delete(key);
      continue;
    }
    if (filtered.length !== list.length) {
      next.set(key, filtered);
    }
  }
  poolCliniciansByKey.clear();
  poolCliniciansByDate.clear();
  for (const [key, list] of next.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!rowId || !dateISO) continue;
    const rowKind =
      rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");
    if (rowKind !== "pool") continue;
    const poolSet = poolCliniciansByKey.get(key) ?? new Set<string>();
    for (const item of list) {
      poolSet.add(item.clinicianId);
      const dateSet = poolCliniciansByDate.get(dateISO) ?? new Set<string>();
      dateSet.add(item.clinicianId);
      poolCliniciansByDate.set(dateISO, dateSet);
    }
    poolCliniciansByKey.set(key, poolSet);
  }

  const offByDate = new Map<string, Set<string>>();
  for (const [dateISO, cliniciansOff] of restDayAssignmentsByDate.entries()) {
    const offSet = offByDate.get(dateISO) ?? new Set<string>();
    cliniciansOff.forEach((clinicianId) => offSet.add(clinicianId));
    offByDate.set(dateISO, offSet);
  }
  if (
    solverSettings.onCallRestEnabled &&
    onCallShiftRowIds.size > 0 &&
    (restDaysBefore > 0 || restDaysAfter > 0)
  ) {
    const shiftDateISO = (dateISO: string, delta: number) =>
      toISODate(addDays(new Date(`${dateISO}T00:00:00`), delta));
    for (const [dateISO, clinicianMap] of assignedShiftRowsByDate.entries()) {
      for (const [clinicianId, assignedRows] of clinicianMap.entries()) {
        const hasOnCall = Array.from(assignedRows).some((rowId) =>
          onCallShiftRowIds.has(rowId),
        );
        if (!hasOnCall) continue;
        for (let offset = 1; offset <= restDaysBefore; offset += 1) {
          const targetISO = shiftDateISO(dateISO, -offset);
          if (!displayDateSet.has(targetISO)) continue;
          const offSet = offByDate.get(targetISO) ?? new Set<string>();
          offSet.add(clinicianId);
          offByDate.set(targetISO, offSet);
        }
        for (let offset = 1; offset <= restDaysAfter; offset += 1) {
          const targetISO = shiftDateISO(dateISO, offset);
          if (!displayDateSet.has(targetISO)) continue;
          const offSet = offByDate.get(targetISO) ?? new Set<string>();
          offSet.add(clinicianId);
          offByDate.set(targetISO, offSet);
        }
      }
    }
  }

  if (offByDate.size > 0) {
    for (const [key, list] of next.entries()) {
      const { rowId, dateISO } = splitAssignmentKey(key);
      if (!rowId || !dateISO) continue;
      const rowKind =
        rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");
      if (rowKind !== "pool") continue;
      const offSet = offByDate.get(dateISO);
      if (!offSet || offSet.size === 0) continue;
      if (rowId === REST_DAY_POOL_ID || rowId === VACATION_POOL_ID) continue;
      const filtered = list.filter((item) => !offSet.has(item.clinicianId));
      if (filtered.length !== list.length) {
        const restKey = `${REST_DAY_POOL_ID}__${dateISO}`;
        const restList = next.get(restKey) ?? [];
        const restSet = new Set(restList.map((item) => item.clinicianId));
        for (const item of list) {
          if (!offSet.has(item.clinicianId)) continue;
          if (restSet.has(item.clinicianId)) continue;
          restList.push({
            ...item,
            id: `pool-${REST_DAY_POOL_ID}-${item.clinicianId}-${dateISO}`,
            rowId: REST_DAY_POOL_ID,
          });
          restSet.add(item.clinicianId);
        }
        if (restList.length > 0) {
          next.set(restKey, restList);
        }
      }
      if (filtered.length === 0) {
        next.delete(key);
      } else if (filtered.length !== list.length) {
        next.set(key, filtered);
      }
    }
  }

  for (const date of displayDays) {
    const dateISO = toISODate(date);
    const vacationSet = vacationByDate.get(dateISO) ?? new Set<string>();
    const offSet = offByDate.get(dateISO) ?? new Set<string>();
    for (const clinician of clinicians) {
      const inVacation = vacationSet.has(clinician.id);
      const isOff = offSet.has(clinician.id);

      // Only generate pool entries for vacation and rest day pools
      // Clinicians without assignments are no longer placed in a "Distribution Pool"
      if (!inVacation && !isOff) continue;

      const poolRowId = inVacation
        ? VACATION_POOL_ID
        : hasRestDayPoolRow
          ? REST_DAY_POOL_ID
          : null;

      // Skip if no applicable pool row exists
      if (!poolRowId) continue;

      const key = `${poolRowId}__${dateISO}`;
      const existingPoolSet = poolCliniciansByKey.get(key);
      if (existingPoolSet?.has(clinician.id)) continue;

      const item: RenderedAssignment = {
        id: `pool-${poolRowId}-${clinician.id}-${dateISO}`,
        rowId: poolRowId,
        dateISO,
        clinicianId: clinician.id,
      };
      const existing = next.get(key);
      if (existing) existing.push(item);
      else next.set(key, [item]);
      const poolSet = poolCliniciansByKey.get(key) ?? new Set<string>();
      poolSet.add(clinician.id);
      poolCliniciansByKey.set(key, poolSet);
    }
  }

  return next;
}
