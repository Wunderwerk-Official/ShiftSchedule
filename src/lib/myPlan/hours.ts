import { parseTimeToMinutes } from "../time";
import { MINUTES_PER_DAY, dayDiff } from "./dates";
import type { PersonPlan, PlanAbsenceKind, PlanShift } from "./types";

// Hours rule: gross slot duration (end − start, no break deduction), the
// whole shift counted on its start day. Overlapping own shifts count once
// (SPEC R4): the overlap belongs to the longer shift, so a 30-min meeting
// inside a night adds nothing. Only shifts My plan shows are counted (none
// on vacation days or in slots of another day type).
// The Working hours overview (WorkingHoursOverviewModal) shares only
// getSlotDurationMinutes: it adds the full duration of every non-pool
// assignment, so its weekly total can be higher than My plan's.

const DEFAULT_SLOT_MINUTES = 8 * 60;

/** Gross slot minutes; 8 h when a time is missing, 0 when end ≤ start. */
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
  const refISO = shifts[0].dateISO;
  const spanOf = (shift: PlanShift) => {
    const offset = dayDiff(refISO, shift.dateISO) * MINUTES_PER_DAY;
    return { start: offset + shift.startMin, end: offset + shift.endMin };
  };
  const byLength = [...shifts].sort((a, b) => {
    const lengthDiff = b.endMin - b.startMin - (a.endMin - a.startMin);
    return lengthDiff || spanOf(a).start - spanOf(b).start;
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
