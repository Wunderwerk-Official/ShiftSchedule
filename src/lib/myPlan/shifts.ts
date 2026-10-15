import type { Assignment, Clinician, Location } from "../../api/client";
import { getDayType } from "../dayTypes";
import type { ScheduleRow } from "../shiftRows";
import { deriveBlockColors, DUTY_COLORS } from "./colors";
import { MINUTES_PER_DAY, weekStartISO } from "./dates";
import { getSlotDurationMinutes, parseTimeToMinutes } from "./hours";
import type { PlanShift, PlanSource } from "./types";

// Internal: turns assignments into PlanShifts. Shared by the person timeline
// and the coworker lookup so both apply the same visibility rules as the
// team grid (slot day type must match the date, vacation hides shifts).

const DEFAULT_START_MIN = 8 * 60;

export type PlanContext = {
  source: PlanSource;
  rowById: Map<string, ScheduleRow>;
  clinicianById: Map<string, Clinician>;
  locationById: Map<string, Location>;
  holidayDates: Set<string>;
  publishedWeeks: Set<string>;
  onCallSectionId?: string;
};

export function createPlanContext(source: PlanSource): PlanContext {
  const settings = source.solverSettings;
  return {
    source,
    rowById: new Map(source.scheduleRows.map((row) => [row.id, row])),
    clinicianById: new Map(source.clinicians.map((clinician) => [clinician.id, clinician])),
    locationById: new Map(source.locations.map((location) => [location.id, location])),
    holidayDates: new Set(source.holidays.map((holiday) => holiday.dateISO)),
    publishedWeeks: new Set(source.publishedWeekStartISOs),
    // normalizeAppState always fills onCallRestClassId, so it only means
    // "on-call section" while on-call rest is enabled.
    onCallSectionId: settings?.onCallRestEnabled ? settings.onCallRestClassId || undefined : undefined,
  };
}

export function isOnVacation(clinician: Clinician | undefined, dateISO: string): boolean {
  return (clinician?.vacations ?? []).some(
    (vacation) => vacation.startISO <= dateISO && dateISO <= vacation.endISO,
  );
}

const TIME_IN_NAME = /\s*\d{1,2}:\d{2}\s*(–|-|—|bis)\s*\d{1,2}(:\d{2})?(\s*(Uhr|h)\b)?/gi;

/** Section name without times: "MRT 08:00–17:00" → "MRT". */
export function stripTimes(name: string): string {
  const stripped = name.replace(TIME_IN_NAME, "").replace(/\s*[·,(]\s*\)?\s*$/, "").trim();
  return stripped || name.trim();
}

/** ≤ 6 characters: "MRT spät" → "MRT-S", "CT-Intervention" → "CT-Int", "Konventionell" → "Konve.". */
export function deriveShortLabel(title: string): string {
  const text = title.trim();
  if (text.length <= 6) return text;
  const hyphen = text.match(/^(\S{1,4})-(\S+)/);
  if (hyphen) return `${hyphen[1]}-${hyphen[2]}`.slice(0, 6);
  const words = text.split(/[\s/]+/).filter(Boolean);
  if (words.length >= 2 && words[0].length <= 4) {
    return `${words[0]}-${words[1][0].toUpperCase()}`;
  }
  if (words[0].length <= 6) return words[0];
  return `${words[0].slice(0, 5)}.`;
}

/**
 * PlanShift for an assignment, or null when it is not a visible section
 * shift (pool row, unknown row, slot of another day type, vacation day).
 */
export function toPlanShift(ctx: PlanContext, assignment: Assignment): PlanShift | null {
  const row = ctx.rowById.get(assignment.rowId);
  if (!row || row.kind !== "class") return null;
  if (row.dayType && row.dayType !== getDayType(assignment.dateISO, ctx.holidayDates)) return null;
  if (isOnVacation(ctx.clinicianById.get(assignment.clinicianId), assignment.dateISO)) return null;

  const durationMin = getSlotDurationMinutes(row);
  const startMin = parseTimeToMinutes(row.startTime) ?? DEFAULT_START_MIN;
  const endMin = startMin + durationMin;
  const title = stripTimes(row.sectionName ?? row.name);
  const isDuty =
    endMin > MINUTES_PER_DAY || (!!ctx.onCallSectionId && row.sectionId === ctx.onCallSectionId);
  const slotLabel = row.blockId ? row.slotLabel?.trim() || undefined : undefined;
  return {
    id: assignment.id,
    clinicianId: assignment.clinicianId,
    rowId: assignment.rowId,
    dateISO: assignment.dateISO,
    title,
    shortLabel: deriveShortLabel(title),
    slotLabel,
    sectionId: row.sectionId,
    locationId: row.locationId,
    locationName: row.locationName,
    startMin,
    endMin,
    hours: durationMin / 60,
    kind: isDuty ? "duty" : "shift",
    colors: isDuty ? DUTY_COLORS : deriveBlockColors(row.blockColor),
    published: ctx.publishedWeeks.has(weekStartISO(assignment.dateISO)),
    locked: assignment.locked || undefined,
  };
}

export function compareShifts(a: PlanShift, b: PlanShift): number {
  if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? -1 : 1;
  if (a.startMin !== b.startMin) return a.startMin - b.startMin;
  if (a.endMin !== b.endMin) return b.endMin - a.endMin;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Visible shifts starting in [fromISO, toISO] (optionally of one clinician), chronological. */
export function collectShifts(
  ctx: PlanContext,
  range: { fromISO: string; toISO: string; clinicianId?: string },
): PlanShift[] {
  const shifts: PlanShift[] = [];
  for (const assignment of ctx.source.assignments) {
    if (range.clinicianId && assignment.clinicianId !== range.clinicianId) continue;
    if (assignment.dateISO < range.fromISO || assignment.dateISO > range.toISO) continue;
    const shift = toPlanShift(ctx, assignment);
    if (shift) shifts.push(shift);
  }
  return shifts.sort(compareShifts);
}
