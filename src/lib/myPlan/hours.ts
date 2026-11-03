import { elapsedMinutes } from "../planTimeZone";
import { parseTimeToMinutes } from "../time";
import { MINUTES_PER_DAY } from "./dates";
import type { PersonPlan, PlanAbsenceKind, PlanShift } from "./types";

// Hours rule: gross duration (end − start, no break deduction) as real
// elapsed time in the plan's zone, the whole shift counted on its start day:
// a night across a DST change lasts an hour more or less than on the wall
// clock. Overlapping own shifts count once (SPEC R4): the overlap belongs to
// the longer shift, so a 30-min meeting inside a night adds nothing. Only
// shifts My plan shows are counted (none on vacation days or in slots of
// another day type).
// The Working hours overview (WorkingHoursOverviewModal) shares only
// getShiftMinutes: it adds the full duration of every non-pool assignment,
// so its weekly total can be higher than My plan's. The solver keeps
// wall-clock durations (getSlotDurationMinutes).

const DEFAULT_SLOT_MINUTES = 8 * 60;
/** Start assumed for a slot without a start time. */
export const DEFAULT_START_MIN = 8 * 60;

/** Wall clock slot minutes (end − start + endDayOffset days); 8 h when a time is missing, 0 when end ≤ start. */
export function getSlotDurationMinutes(slot: {
  startTime?: string;
  endTime?: string;
  endDayOffset?: number;
}): number {
  const start = parseTimeToMinutes(slot.startTime);
  const end = parseTimeToMinutes(slot.endTime);
  if (start === null || end === null) return DEFAULT_SLOT_MINUTES;
  const offset =
    typeof slot.endDayOffset === "number" && Number.isFinite(slot.endDayOffset)
      ? Math.max(0, Math.min(3, Math.floor(slot.endDayOffset)))
      : 0;
  return Math.max(0, end + offset * MINUTES_PER_DAY - start);
}

/** Real minutes of a slot worked from `dateISO` in the plan's zone: getSlotDurationMinutes with DST changes counted. */
export function getShiftMinutes(
  slot: { startTime?: string; endTime?: string; endDayOffset?: number },
  dateISO: string,
  timeZone: string,
): number {
  const start = parseTimeToMinutes(slot.startTime) ?? DEFAULT_START_MIN;
  return Math.max(0, elapsedMinutes(dateISO, start, start + getSlotDurationMinutes(slot), timeZone));
}

/** Hours a shift adds to sums: countedHours when set (own plan), else its gross hours. */
export function countedHours(shift: PlanShift): number {
  return shift.countedHours ?? shift.hours;
}

/**
 * One person's shifts with countedHours set: longest shifts claim their time
 * first, each shorter one only counts what is still free (ties: earlier start).
 */
export function withCountedHours(shifts: PlanShift[]): PlanShift[] {
  if (shifts.length === 0) return shifts;
  // Real minutes, so overlaps and lengths stay right across DST changes.
  const spanOf = (shift: PlanShift) => ({ start: shift.startsAt / 60_000, end: shift.endsAt / 60_000 });
  const byLength = [...shifts].sort((a, b) => {
    const lengthDiff = b.endsAt - b.startsAt - (a.endsAt - a.startsAt);
    return lengthDiff || a.startsAt - b.startsAt;
  });
  const claimed: Array<{ start: number; end: number }> = [];
  const counted = new Map<string, number>();
  for (const shift of byLength) {
    const span = spanOf(shift);
    let overlap = 0;
    for (const other of claimed) {
      overlap += Math.max(0, Math.min(span.end, other.end) - Math.max(span.start, other.start));
    }
    counted.set(shift.id, Math.max(0, span.end - span.start - overlap) / 60);
    // Claim only the still-free parts, so later overlaps are not subtracted twice.
    let cursor = span.start;
    for (const other of [...claimed].sort((a, b) => a.start - b.start)) {
      if (other.end <= cursor || other.start >= span.end) continue;
      if (other.start > cursor) claimed.push({ start: cursor, end: other.start });
      cursor = Math.max(cursor, other.end);
    }
    if (cursor < span.end) claimed.push({ start: cursor, end: span.end });
  }
  return shifts.map((shift) => ({ ...shift, countedHours: counted.get(shift.id) ?? shift.hours }));
}

/** Counted hours of the plan's shifts starting in [fromISO, toISO] (any range within the plan context). */
export function sumHours(plan: PersonPlan, fromISO: string, toISO: string): number {
  let minutes = 0;
  for (const shift of plan.shifts.values()) {
    if (shift.dateISO >= fromISO && shift.dateISO <= toISO) minutes += countedHours(shift) * 60;
  }
  return Math.round(minutes) / 60;
}

/** Number of days in [fromISO, toISO] with an absence of that kind ("Vacation · 5 days"). */
export function countAbsenceDays(
  plan: PersonPlan,
  kind: PlanAbsenceKind,
  fromISO: string,
  toISO: string,
): number {
  const days = new Set<string>();
  for (const absence of plan.absences) {
    if (absence.kind === kind && absence.dateISO >= fromISO && absence.dateISO <= toISO) {
      days.add(absence.dateISO);
    }
  }
  return days.size;
}
