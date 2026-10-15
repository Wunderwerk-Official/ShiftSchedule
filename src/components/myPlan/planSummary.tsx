import type { ReactNode } from "react";
import type { Clinician, PlanRange } from "../../api/client";
import { toISODate } from "../../lib/date";
import {
  MINUTES_PER_DAY,
  dayDiff,
  formatDayLabel,
  formatHours,
  isoWeekNumber,
  parseISODate,
  type PersonPlan,
  type PlanShift,
} from "../../lib/myPlan";
import type { MyPlanData } from "./useMyPlanData";

// Small pure helpers of MyPlanView: shift lookup across plans, the default
// shift of the desktop day detail column, and the footer hours summary.

/** Shift and its plan among the viewed plan and the day lanes. */
export function findShift(plans: PersonPlan[], shiftId: string): { shift: PlanShift; plan: PersonPlan } | null {
  for (const plan of plans) {
    const shift = plan.shifts.get(shiftId);
    if (shift) return { shift, plan };
  }
  return null;
}

/**
 * The plan's next (direction 1) or previous (-1) shift by start time,
 * relative to minute `refMin` of `refISO` ("N" / "Shift+N"); null if none
 * in the plan's context window.
 */
export function adjacentShift(plan: PersonPlan, refISO: string, refMin: number, direction: 1 | -1): PlanShift | null {
  let best: { shift: PlanShift; offset: number } | null = null;
  for (const shift of plan.shifts.values()) {
    const offset = (dayDiff(refISO, shift.dateISO) * MINUTES_PER_DAY + shift.startMin - refMin) * direction;
    if (offset > 0 && (!best || offset < best.offset)) best = { shift, offset };
  }
  return best?.shift ?? null;
}

/** Running or next own shift of the day (else its first), for the desktop day detail column. */
export function defaultDayShiftId(plan: PersonPlan, dateISO: string, todayISO: string, nowMin: number): string | null {
  const day = plan.days.find((item) => item.dateISO === dateISO);
  if (!day || day.segments.length === 0) return null;
  const upcoming = dateISO === todayISO ? day.segments.find((segment) => segment.endMin > nowMin) : undefined;
  return (upcoming ?? day.segments[0]).shiftId;
}

/** "Week 42: 53.0 h planned · target 40 h" (day view: the day's hours first). */
export function footerSummary(
  range: PlanRange,
  data: MyPlanData,
  viewed: Clinician | undefined,
  anchorDate: Date,
  plan: PersonPlan,
): ReactNode {
  const { week } = data;
  const weekLabel = `Week ${isoWeekNumber(parseISODate(week.fromISO))}`;
  const target = viewed?.workingHoursPerWeek;
  const weekPart =
    week.hours === 0 && week.vacationDays > 0 ? (
      <>
        {weekLabel}: Vacation · {week.vacationDays} {week.vacationDays === 1 ? "day" : "days"}
      </>
    ) : (
      <>
        {weekLabel}: <strong className="font-semibold text-slate-900 dark:text-slate-100">{formatHours(week.hours)}</strong>{" "}
        planned{target ? ` · target ${target} h` : ""}
      </>
    );
  if (range !== "day") return weekPart;
  const dateISO = toISODate(anchorDate);
  const dayHours = plan.days.find((day) => day.dateISO === dateISO)?.hours;
  return (
    <>
      {formatDayLabel(dateISO)}:{" "}
      <strong className="font-semibold text-slate-900 dark:text-slate-100">
        {dayHours != null ? formatHours(dayHours) : "–"}
      </strong>{" "}
      · {weekPart}
    </>
  );
}
