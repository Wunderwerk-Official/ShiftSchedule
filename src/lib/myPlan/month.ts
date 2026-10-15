import { addDays, listWeekStartsOverlappingMonth, toISODate } from "../date";
import type { PlanAbsenceKind, PlanDay } from "./types";

/** Monday-first weeks (7 local midnights each) covering the anchor's month: 4–6 rows. */
export function buildMonthWeeks(monthAnchor: Date): Date[][] {
  return listWeekStartsOverlappingMonth(monthAnchor).map((weekStart) =>
    Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
  );
}

/** First and last day ISO of the month sheet (build the PersonPlan for this range). */
export function monthSheetRange(monthAnchor: Date): { fromISO: string; toISO: string } {
  const weeks = buildMonthWeeks(monthAnchor);
  return { fromISO: toISODate(weeks[0][0]), toISO: toISODate(weeks[weeks.length - 1][6]) };
}

export function isSameMonth(date: Date, monthAnchor: Date): boolean {
  return (
    date.getFullYear() === monthAnchor.getFullYear() && date.getMonth() === monthAnchor.getMonth()
  );
}

export type AbsenceRun = { kind: PlanAbsenceKind; startISO: string; endISO: string; days: number };

/** Consecutive days with the same absence kind merged into runs (one bar for "Vacation · 5 days"). */
export function absenceRuns(days: PlanDay[], kind: PlanAbsenceKind = "vacation"): AbsenceRun[] {
  const runs: AbsenceRun[] = [];
  let current: AbsenceRun | null = null;
  for (const day of days) {
    if (!day.absences.some((absence) => absence.kind === kind)) {
      current = null;
      continue;
    }
    if (current) {
      current.endISO = day.dateISO;
      current.days += 1;
    } else {
      current = { kind, startISO: day.dateISO, endISO: day.dateISO, days: 1 };
      runs.push(current);
    }
  }
  return runs;
}
