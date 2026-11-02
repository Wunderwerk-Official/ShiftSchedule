import type { AppState, Assignment } from "../api/client";
import { toISODate } from "./date";

// Shifts file ("Download shifts file" / "Import shifts file…"): the file is
// read and checked before anything is asked or changed. Entries that are not
// shifts are skipped and counted, identical shifts (person, slot, date) are
// kept once, and a file without a single shift for this calendar is refused.
// Saving an import: the calendar as shown is saved as the auto-backup first
// ("Auto-backup before shifts file import" in Calendar snapshots), then the
// imported calendar replaces it. When the backup cannot be saved (or the
// calendar changed in another tab), nothing is imported.

export const IMPORT_BACKUP_FAILED_MESSAGE =
  "The backup could not be saved, so nothing was imported.";
export const NO_SHIFTS_FOUND_MESSAGE = "No shifts found in this file.";
export const NO_SHIFTS_FOR_CALENDAR_MESSAGE =
  "This file contains no shifts for this calendar. Nothing was changed.";

/** Larger files are not read at all (a year of a large team is far below). */
export const MAX_SHIFTS_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SHIFTS_FILE_ENTRIES = 100_000;
export const SHIFTS_FILE_TOO_LARGE_MESSAGE =
  "This file is larger than 10 MB, so it was not read. Nothing was changed.";
export const TOO_MANY_ENTRIES_MESSAGE =
  "This file has more than 100,000 entries, so it was not imported. Nothing was changed.";

/** File name of a download: the local date, so a download after midnight is dated that day. */
export function shiftsFileName(now: Date = new Date()): string {
  return `shifts-${toISODate(now)}.json`;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** A real calendar date written as YYYY-MM-DD (no 2026-02-30). */
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** A shift with only the known fields, or null when the entry is not a valid shift. */
function toAssignment(raw: unknown): Omit<Assignment, "id"> & { id?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!isNonEmptyString(entry.clinicianId) || !isNonEmptyString(entry.rowId)) return null;
  if (!isISODate(entry.dateISO)) return null;
  if (entry.id !== undefined && typeof entry.id !== "string") return null;
  if (entry.locked !== undefined && typeof entry.locked !== "boolean") return null;
  if (
    entry.source !== undefined &&
    entry.source !== null &&
    entry.source !== "manual" &&
    entry.source !== "solver"
  ) {
    return null;
  }
  return {
    ...(entry.id ? { id: entry.id } : {}),
    rowId: entry.rowId,
    dateISO: entry.dateISO,
    clinicianId: entry.clinicianId,
    ...(entry.locked !== undefined ? { locked: entry.locked } : {}),
    ...(entry.source === "manual" || entry.source === "solver" ? { source: entry.source } : {}),
  };
}

export type ShiftsFileEntries = {
  /** Valid shifts, each (person, slot, date) once, with unique ids. */
  assignments: Assignment[];
  /** Entries that are not valid shifts. */
  invalid: number;
  /** Repeats of a shift already in the file. */
  duplicates: number;
};

/**
 * The shifts of a shifts file (or of a full calendar export). Throws with a
 * message for the reader when the file has no list of shifts or too many entries.
 */
export function readShiftsFile(payload: unknown): ShiftsFileEntries {
  const container =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { assignments?: unknown; state?: { assignments?: unknown } })
      : null;
  const entries = Array.isArray(container?.assignments)
    ? container.assignments
    : Array.isArray(container?.state?.assignments)
      ? container.state.assignments
      : null;
  if (!entries) throw new Error(NO_SHIFTS_FOUND_MESSAGE);
  if (entries.length > MAX_SHIFTS_FILE_ENTRIES) throw new Error(TOO_MANY_ENTRIES_MESSAGE);

  const valid = entries.map(toAssignment);
  const usedIds = new Set(
    valid.flatMap((entry) => (entry?.id !== undefined ? [entry.id] : [])),
  );
  const seenIds = new Set<string>();
  const seenShifts = new Set<string>();
  let nextId = 1;
  const freshId = () => {
    while (usedIds.has(`as-import-${nextId}`)) nextId += 1;
    const id = `as-import-${nextId}`;
    usedIds.add(id);
    return id;
  };
  const assignments: Assignment[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const entry of valid) {
    if (!entry) {
      invalid += 1;
      continue;
    }
    const shiftKey = JSON.stringify([entry.clinicianId, entry.dateISO, entry.rowId]);
    if (seenShifts.has(shiftKey)) {
      duplicates += 1;
      continue;
    }
    seenShifts.add(shiftKey);
    // Ids identify a shift when it is moved or removed: give a missing or
    // repeated one a new id.
    const id = entry.id !== undefined && !seenIds.has(entry.id) ? entry.id : freshId();
    seenIds.add(id);
    assignments.push({ ...entry, id });
  }
  return { assignments, invalid, duplicates };
}

export type ShiftsImportSummary = {
  /** Shifts the calendar has after the import. */
  imported: number;
  invalid: number;
  duplicates: number;
  /** Shifts of people who are not in this calendar. */
  droppedClinicians: number;
  /** Shifts in slots the template no longer has. */
  droppedSlots: number;
  /** Shifts in existing slots on days that are now holidays. */
  droppedHolidays: number;
  /** Shifts in existing slots that their day's plan no longer has. */
  droppedDayPlan: number;
};

export type ShiftsImportCalendar = {
  clinicianIds: ReadonlySet<string>;
  /** Slot ids of the weekly template. */
  slotIds: ReadonlySet<string>;
  holidayDates: ReadonlySet<string>;
  /** The calendar with these shifts, normalized as it would be saved; null when it cannot be saved. */
  buildState: (assignments: Assignment[]) => AppState | null;
};

/**
 * Reads and checks a shifts file against the calendar. Returns the calendar
 * to save and what the import keeps and skips; throws with a message for the
 * reader (nothing changed) when the file has no shift for this calendar.
 */
export function prepareShiftsImport(
  payload: unknown,
  calendar: ShiftsImportCalendar,
): { next: AppState; summary: ShiftsImportSummary } {
  const { assignments, invalid, duplicates } = readShiftsFile(payload);
  const ofPeople = assignments.filter((item) => calendar.clinicianIds.has(item.clinicianId));
  const next = calendar.buildState(ofPeople);
  if (!next) throw new Error("The current calendar cannot be saved. Fix its template first.");
  if (next.assignments.length === 0) throw new Error(NO_SHIFTS_FOR_CALENDAR_MESSAGE);

  // The normalizer keeps ids, so what it dropped is what has no id in the result.
  const keptIds = new Set(next.assignments.map((item) => item.id));
  let droppedSlots = 0;
  let droppedHolidays = 0;
  let droppedDayPlan = 0;
  for (const item of ofPeople) {
    if (keptIds.has(item.id)) continue;
    if (!calendar.slotIds.has(item.rowId)) droppedSlots += 1;
    else if (calendar.holidayDates.has(item.dateISO)) droppedHolidays += 1;
    else droppedDayPlan += 1;
  }
  return {
    next,
    summary: {
      imported: next.assignments.length,
      invalid,
      duplicates,
      droppedClinicians: assignments.length - ofPeople.length,
      droppedSlots,
      droppedHolidays,
      droppedDayPlan,
    },
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 duplicates, 12 on days that are now holidays" — or null when nothing is skipped. */
export function describeSkippedShifts(summary: ShiftsImportSummary): string | null {
  const parts = [
    summary.invalid > 0 && count(summary.invalid, "entry that is not a valid shift", "entries that are not valid shifts"),
    summary.duplicates > 0 && count(summary.duplicates, "duplicate", "duplicates"),
    summary.droppedClinicians > 0 &&
      count(summary.droppedClinicians, "shift of a person", "shifts of people") + " not in this calendar",
    summary.droppedSlots > 0 && `${summary.droppedSlots} in slots that no longer exist`,
    summary.droppedHolidays > 0 && `${summary.droppedHolidays} on days that are now holidays`,
    summary.droppedDayPlan > 0 && `${summary.droppedDayPlan} that no longer fit the day's plan`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

export type ShiftsImportResult = ShiftsImportSummary & {
  /** Name of the auto-backup of the calendar shown before the import. */
  backupName: string;
};

/** A checked import, waiting for the reader to confirm it. */
export type PreparedShiftsImport = {
  /** Shifts the calendar has now; the import replaces all of them. */
  currentCount: number;
  summary: ShiftsImportSummary;
  /** Backs up the calendar shown, then saves the import. */
  apply: () => Promise<ShiftsImportResult>;
};

/** The question before an import replaces the shifts, with both counts. */
export function describeShiftsImportQuestion(prepared: PreparedShiftsImport, fileName: string): string {
  const skipped = describeSkippedShifts(prepared.summary);
  return [
    `Replace all ${count(prepared.currentCount, "current shift", "current shifts")} with ` +
      `${count(prepared.summary.imported, "shift", "shifts")} from “${fileName}”?`,
    "Every week is replaced, locked shifts too.",
    skipped && `Skipped from the file: ${skipped}.`,
    "The current calendar is saved in Calendar snapshots first; this automatic backup replaces the previous one.",
  ].filter(Boolean).join(" ");
}

export function describeShiftsImportResult(result: ShiftsImportResult): string {
  const skipped = describeSkippedShifts(result);
  return [
    `Imported ${count(result.imported, "shift", "shifts")}.`,
    skipped && `Skipped ${skipped}.`,
    `A backup of the previous calendar is in Calendar snapshots: “${result.backupName}”.`,
  ].filter(Boolean).join(" ");
}

export type ShiftsFileImportDeps = {
  /** This tab's calendar revision once its queued saves have landed. */
  currentRevision: () => Promise<string | null | undefined>;
  /**
   * Saves `state` as the auto-backup and returns its name; refused when the
   * stored calendar is no longer at `expectedRevision`.
   */
  createBackup: (state: AppState, expectedRevision?: string | null) => Promise<{ name: string }>;
  saveState: (state: AppState) => Promise<unknown>;
};

/**
 * Back up `current`, then save `next`. Returns the backup's name. Throws
 * (without saving `next`) when the backup fails or is refused because the
 * calendar changed elsewhere; a failing save is passed on.
 */
export async function saveShiftsFileImport(
  current: AppState,
  next: AppState,
  deps: ShiftsFileImportDeps,
): Promise<{ backupName: string }> {
  let backupName: string;
  try {
    const expectedRevision = await deps.currentRevision();
    backupName = (await deps.createBackup(current, expectedRevision)).name;
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(`${IMPORT_BACKUP_FAILED_MESSAGE}${detail}`);
  }
  await deps.saveState(next);
  return { backupName };
}
