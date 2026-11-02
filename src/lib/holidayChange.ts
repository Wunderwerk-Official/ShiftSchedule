import type { Assignment } from "../api/client";
import { isProtectedAssignment } from "./assignmentPolicy";

// Texts of the confirmation before a holiday change removes shifts (see
// findAssignmentsDroppedByHolidayChange in shiftRows.ts).

export const HOLIDAY_BACKUP_FAILED_MESSAGE =
  "The backup could not be saved, so the holidays were not changed.";

const MAX_LISTED_DAYS = 5;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "2026-12-24" -> "Thu 24.12.2026" */
export function formatHolidayChangeDate(dateISO: string): string {
  const [year, month, day] = dateISO.split("-");
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${weekday} ${day}.${month}.${year}`;
}

/**
 * Title, message and confirm label of the dialog, e.g. "12 shifts, 2 of them
 * locked, no longer fit their day's plan and will be removed: Thu 24.12.2026
 * (12 shifts). ..." Lists at most five days, then "+N more days".
 */
export function holidayChangeConfirmation(dropped: Assignment[]) {
  const countByDate = new Map<string, number>();
  for (const assignment of dropped) {
    countByDate.set(assignment.dateISO, (countByDate.get(assignment.dateISO) ?? 0) + 1);
  }
  const dates = [...countByDate.keys()].sort();
  const days = dates
    .slice(0, MAX_LISTED_DAYS)
    .map((dateISO) => `${formatHolidayChangeDate(dateISO)} (${countOf(countByDate.get(dateISO) ?? 0, "shift")})`);
  if (dates.length > MAX_LISTED_DAYS) {
    days.push(`+${countOf(dates.length - MAX_LISTED_DAYS, "more day")}`);
  }
  const total = dropped.length;
  const locked = dropped.filter(isProtectedAssignment).length;
  const shifts = countOf(total, "shift");
  const subject =
    locked === 0
      ? shifts
      : locked === total
        ? `${total} locked shift${total === 1 ? "" : "s"}`
        : `${shifts}, ${locked} of them locked,`;
  const verb = total === 1 ? "no longer fits its day's plan" : "no longer fit their day's plan";
  return {
    title: `Remove ${shifts}?`,
    message:
      `${subject} ${verb} and will be removed: ${days.join(", ")}. ` +
      "A holiday uses the template's Holiday column, every other day the columns of its weekday. " +
      "An automatic backup of the calendar is saved in Calendar snapshots first.",
    confirmLabel: `Remove ${shifts}`,
  };
}
