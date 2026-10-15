import type { Assignment, Clinician, Location } from "../../api/client";
import { getDayType } from "../dayTypes";
import type { ScheduleRow } from "../shiftRows";
import { parseTimeToMinutes } from "../time";
import { deriveBlockColors, DUTY_COLORS } from "./colors";
import { MINUTES_PER_DAY, weekStartISO } from "./dates";
import { getSlotDurationMinutes } from "./hours";
import type { PlanShift, PlanSource } from "./types";

// Internal: turns assignments into PlanShifts. Shared by the person timeline
// and the coworker lookup so both apply the same visibility rules as the
// team grid (slot day type must match the date, vacation hides shifts).

const DEFAULT_START_MIN = 8 * 60;

export type PlanContext = {
  source: PlanSource;
  rowById: Map<string, ScheduleRow>;
  /** Slots of role sections titled by their row band (row id → "Nachtdienst"). */
  bandTitles: Map<string, string>;
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
    bandTitles: collectBandTitles(source.scheduleRows),
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

// Row bands are identified per location and label (band ids repeat across
// template locations, which collapse into one when locations are off).
const bandKey = (row: ScheduleRow) => `${row.locationId ?? ""}|${row.rowBandId}|${row.rowBandLabel}`;

/**
 * Clinic-sheet role sections: a section like "Oberärzte" placed in the row
 * bands of several other sections ("Nachtdienst", "MRT", …), each band named
 * after the section it belongs to. Its slots take the band name as title
 * (row id → title). A section in a single foreign band ("MRI Neuro" next to
 * MRI) keeps its own name, and generic labels ("Row 1") name no section.
 */
function collectBandTitles(rows: ScheduleRow[]): Map<string, string> {
  const classRows = rows.filter((row) => row.kind === "class" && row.rowBandId && row.rowBandLabel?.trim());
  const ownTitle = (row: ScheduleRow) => stripTimes(row.sectionName ?? row.name);
  const namedBands = new Map<string, string>();
  for (const row of classRows) {
    const bandTitle = stripTimes(row.rowBandLabel ?? "");
    if (bandTitle === ownTitle(row)) namedBands.set(bandKey(row), bandTitle);
  }
  const foreignBands = new Map<string, Set<string>>();
  for (const row of classRows) {
    const bandTitle = namedBands.get(bandKey(row));
    if (!row.sectionId || !bandTitle || bandTitle === ownTitle(row)) continue;
    foreignBands.set(row.sectionId, (foreignBands.get(row.sectionId) ?? new Set()).add(bandTitle));
  }
  const titles = new Map<string, string>();
  for (const row of classRows) {
    const bandTitle = namedBands.get(bandKey(row));
    if (bandTitle && row.sectionId && (foreignBands.get(row.sectionId)?.size ?? 0) >= 2) {
      if (bandTitle !== ownTitle(row)) titles.set(row.id, bandTitle);
    }
  }
  return titles;
}

const TIME_IN_NAME = /\s*\d{1,2}:\d{2}\s*(–|-|—|bis)\s*\d{1,2}(:\d{2})?(\s*(Uhr|h)\b)?/gi;

/** Section name without times: "MRT 08:00–17:00" → "MRT". */
export function stripTimes(name: string): string {
  const stripped = name.replace(TIME_IN_NAME, "").replace(/\s*[·,(]\s*\)?\s*$/, "").trim();
  return stripped || name.trim();
}

// Second halves of German compounds that carry no identity in a short
// label: "Nachtdienst" → "Nacht", "Mammadiagnostik" → "Mamma".
const COMPOUND_TAILS = ["diagnostik", "besprechung", "konferenz", "dienst", "station"];
const isVowel = (char?: string) => !!char && /[aeiouyäöü]/i.test(char);

// "Konventionell" → "Konv.": the longest stem (3..maxStem letters) that ends
// on a consonant before a vowel, else maxStem letters, plus a dot.
function abbreviateWord(word: string, maxStem: number): string {
  for (let length = Math.min(maxStem, word.length - 1); length >= 3; length -= 1) {
    if (!isVowel(word[length - 1]) && isVowel(word[length])) return `${word.slice(0, length)}.`;
  }
  return `${word.slice(0, maxStem)}.`;
}

/**
 * Short label of at most `max` characters (SPEC R8): "LKE/DL" → "LKE",
 * "CT-Intervention" → "CT-Int", "MRT spät" → "MRT-S", "Nachtdienst" → "Nacht",
 * "Konventionell" → "Konv.". Phones use max 5 ("Zusatzdienst" → "Zus.").
 */
export function deriveShortLabel(title: string, max = 6): string {
  const text = title.trim();
  const words = text.split(/[\s/]+/).filter(Boolean);
  const first = words[0] ?? text;
  if (text.includes("/") && first.length >= 2 && first.length <= max) return first;
  if (text.length <= max) return text;
  const hyphen = text.match(/^(\S{1,4})-(\S+)/);
  if (hyphen) return `${hyphen[1]}-${hyphen[2]}`.slice(0, max);
  if (words.length >= 2 && first.length <= 4) return `${first}-${words[1][0].toUpperCase()}`;
  const tail = COMPOUND_TAILS.find((item) => first.toLowerCase().endsWith(item));
  const stem = tail && first.length - tail.length >= 3 ? first.slice(0, first.length - tail.length) : first;
  if (stem.length <= max) return stem;
  return abbreviateWord(stem, max - 1);
}

/**
 * Short location name of at most `max` characters for chips (SPEC C5.2):
 * "Klinikum Mitte" → "Mitte", "Ambulanz/Station" → "Ambulanz",
 * "Konferenzen" → "Konf.".
 */
export function deriveLocationShortName(name: string, max = 8): string {
  const text = name.trim();
  if (text.length <= max) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 1 && last.length <= max) return last;
  const first = text.split(/[\s/]+/).filter(Boolean)[0] ?? text;
  if (first.length <= max) return first;
  return abbreviateWord(first, Math.min(4, max - 1));
}

/** Short label of an absence pool row: "ND-Frei" → "NDF", "Rest Day" → "Rest", "Urlaub/FzA" → "Url.". */
export function deriveAbsenceShortLabel(label: string, max = 5): string {
  const text = label.trim();
  if (text.length <= max) return text;
  const acronym = text.match(/^([A-ZÄÖÜ]{1,3})-(\S)/);
  if (acronym) return `${acronym[1]}${acronym[2].toUpperCase()}`;
  const first = text.split(/\s+/)[0];
  return first.length <= max ? first : deriveShortLabel(text, max);
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
  const sectionTitle = stripTimes(row.sectionName ?? row.name);
  const title = ctx.bandTitles.get(row.id) ?? sectionTitle;
  const isDuty =
    endMin > MINUTES_PER_DAY || (!!ctx.onCallSectionId && row.sectionId === ctx.onCallSectionId);
  const slotLabel = row.blockId ? row.slotLabel?.trim() || undefined : undefined;
  return {
    id: assignment.id,
    clinicianId: assignment.clinicianId,
    rowId: assignment.rowId,
    dateISO: assignment.dateISO,
    title,
    role: title !== sectionTitle ? sectionTitle : undefined,
    shortLabel: deriveShortLabel(title),
    compactLabel: deriveShortLabel(title, 5),
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
