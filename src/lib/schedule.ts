import { addDays, toISODate } from "./date";
import type { SolverSettings } from "../api/client";
import type { Assignment, Clinician } from "../api/client";
import type { ScheduleRow } from "./shiftRows";
import { parseTimeToMinutes } from "./time";

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

/**
 * Order of the people in a grid cell: by surname (the last word of the
 * name), then by the full name. Lists of fewer than two come back as is.
 */
export function sortAssignmentsBySurname<T extends { clinicianId: string }>(
  assignments: T[],
  getName: (clinicianId: string) => string,
): T[] {
  if (assignments.length < 2) return assignments;
  const surnameOf = (name: string) => name.trim().split(/\s+/).slice(-1)[0] ?? name;
  return [...assignments].sort((a, b) => {
    const nameA = getName(a.clinicianId);
    const nameB = getName(b.clinicianId);
    const bySurname = surnameOf(nameA).localeCompare(surnameOf(nameB));
    return bySurname !== 0 ? bySurname : nameA.localeCompare(nameB);
  });
}

/**
 * Days off from the on-call rest rule ("Rest days around on-call duty"): the
 * configured days before and after every on-call shift. Keyed by date, then
 * by person, with the date of the on-call shift that causes the rest day.
 * Vacation wins: an on-call shift on a vacation day causes no rest days, and
 * no rest day falls on a vacation day. Also lists days on which the person
 * still holds a shift (the team grid then hides the pill and flags the rule
 * violation, the slot picker still warns). Empty while the rule is off.
 */
export function buildOnCallRestDays(
  assignmentMap: Map<string, Assignment[]>,
  clinicians: Clinician[],
  options?: { scheduleRows?: ScheduleRow[]; solverSettings?: SolverSettings },
): Map<string, Map<string, string>> {
  const restDays = new Map<string, Map<string, string>>();
  const settings = options?.solverSettings;
  const daysBefore = Math.max(0, settings?.onCallRestDaysBefore ?? 0);
  const daysAfter = Math.max(0, settings?.onCallRestDaysAfter ?? 0);
  if (!settings?.onCallRestEnabled || (daysBefore === 0 && daysAfter === 0)) return restDays;
  const onCallClassId = settings.onCallRestClassId ?? "";
  const onCallRowIds = new Set(
    (options?.scheduleRows ?? [])
      .filter((row) => row.kind === "class" && (row.sectionId ?? row.id) === onCallClassId)
      .map((row) => row.id),
  );
  if (onCallRowIds.size === 0) return restDays;
  const vacationsById = new Map(clinicians.map((clinician) => [clinician.id, clinician.vacations]));
  const isOnVacation = (clinicianId: string, dateISO: string) =>
    vacationsById
      .get(clinicianId)
      ?.some((vacation) => vacation.startISO <= dateISO && dateISO <= vacation.endISO) ?? false;
  for (const [key, list] of assignmentMap.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!dateISO || !onCallRowIds.has(rowId)) continue;
    const onCallDate = new Date(`${dateISO}T00:00:00`);
    for (const { clinicianId } of list) {
      if (isOnVacation(clinicianId, dateISO)) continue;
      for (let offset = -daysBefore; offset <= daysAfter; offset += 1) {
        if (offset === 0) continue;
        const restISO = toISODate(addDays(onCallDate, offset));
        if (isOnVacation(clinicianId, restISO)) continue;
        const byPerson = restDays.get(restISO) ?? new Map<string, string>();
        if (!byPerson.has(clinicianId)) byPerson.set(clinicianId, dateISO);
        restDays.set(restISO, byPerson);
      }
    }
  }
  return restDays;
}

export function buildRenderedAssignmentMap(
  assignmentMap: Map<string, Assignment[]>,
  clinicians: Clinician[],
  displayDays: Date[],
  options?: {
    scheduleRows?: ScheduleRow[];
    solverSettings?: SolverSettings;
    /** Unused. Still accepted because existing callers pass it. */
    holidayDates?: Set<string>;
  },
) {
  const scheduleRows = options?.scheduleRows ?? [];
  const displayDateSet = new Set(displayDays.map((date) => toISODate(date)));
  const rowKindById = new Map(scheduleRows.map((row) => [row.id, row.kind]));
  const rowKindOf = (rowId: string) =>
    rowKindById.get(rowId) ?? (rowId.startsWith("pool-") ? "pool" : "class");
  const hasRestDayPoolRow = scheduleRows.some((row) => row.id === REST_DAY_POOL_ID);

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
  const assignedShiftRowsByDate = new Map<string, Map<string, Set<string>>>();
  const restDayAssignmentsByDate = new Map<string, Set<string>>();

  // Stored pool entries (Rest Day) keep their own ids, even when the clinician
  // also holds a slot that day: dragging the pill out of Rest Day removes the
  // stored entry by that id.
  for (const [key, list] of assignmentMap.entries()) {
    const { rowId, dateISO } = splitAssignmentKey(key);
    if (!dateISO) continue;
    if (rowId === VACATION_POOL_ID) continue;
    const rowKind = rowKindOf(rowId);

    const vacationSet = vacationByDate.get(dateISO);
    const filtered = list.filter((item) => !vacationSet || !vacationSet.has(item.clinicianId));
    if (filtered.length === 0) continue;
    next.set(key, [...filtered]);
    if (rowKind === "pool" && rowId === REST_DAY_POOL_ID) {
      const restSet = restDayAssignmentsByDate.get(dateISO) ?? new Set<string>();
      for (const item of filtered) {
        restSet.add(item.clinicianId);
      }
      restDayAssignmentsByDate.set(dateISO, restSet);
    }

    if (rowKind !== "class") continue;
    let dayShiftRows = assignedShiftRowsByDate.get(dateISO);
    if (!dayShiftRows) {
      dayShiftRows = new Map();
      assignedShiftRowsByDate.set(dateISO, dayShiftRows);
    }
    for (const item of filtered) {
      const assignedRows = dayShiftRows.get(item.clinicianId) ?? new Set<string>();
      assignedRows.add(rowId);
      dayShiftRows.set(item.clinicianId, assignedRows);
    }
  }

  // Who is off on a date: stored Rest Day entries, plus the on-call rest
  // rule's days on which the person holds no shift. A shift on such a day
  // wins: the computed pill is left out, so nobody shows up twice that day
  // (the page flags the rule violation).
  const offByDate = new Map<string, Set<string>>();
  for (const [dateISO, cliniciansOff] of restDayAssignmentsByDate.entries()) {
    offByDate.set(dateISO, new Set(cliniciansOff));
  }
  const onCallRestDays = buildOnCallRestDays(assignmentMap, clinicians, options);
  for (const [dateISO, restByPerson] of onCallRestDays.entries()) {
    if (!displayDateSet.has(dateISO)) continue;
    const working = assignedShiftRowsByDate.get(dateISO);
    for (const clinicianId of restByPerson.keys()) {
      if (working?.has(clinicianId)) continue;
      const offSet = offByDate.get(dateISO) ?? new Set<string>();
      offSet.add(clinicianId);
      offByDate.set(dateISO, offSet);
    }
  }

  if (offByDate.size > 0) {
    for (const [key, list] of next.entries()) {
      const { rowId, dateISO } = splitAssignmentKey(key);
      if (!rowId || !dateISO) continue;
      if (rowKindOf(rowId) !== "pool") continue;
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

  const poolCliniciansByKey = new Map<string, Set<string>>();
  for (const [key, list] of next.entries()) {
    const { rowId } = splitAssignmentKey(key);
    if (rowKindOf(rowId) !== "pool") continue;
    poolCliniciansByKey.set(key, new Set(list.map((item) => item.clinicianId)));
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
