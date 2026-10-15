import { MINUTES_PER_DAY } from "./dates";
import type { PersonPlan, PlanAbsenceKind } from "./types";

// Hours rule (same as WorkingHoursOverviewModal): gross slot duration
// (end − start, no break deduction), the whole shift counted on its start day.

const DEFAULT_SLOT_MINUTES = 8 * 60;

/** Strict "HH:MM" → minutes after midnight, else null. */
export function parseTimeToMinutes(value?: string): number | null {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

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

/** Hours of the plan's shifts starting in [fromISO, toISO] (any range within the plan context). */
export function sumHours(plan: PersonPlan, fromISO: string, toISO: string): number {
  let minutes = 0;
  for (const shift of plan.shifts.values()) {
    if (shift.dateISO >= fromISO && shift.dateISO <= toISO) minutes += shift.hours * 60;
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
