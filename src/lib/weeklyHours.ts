// Weekly hours exactly as the backend gate counts them (backend/validation.py
// validate_weekly_hours, used by every planner): per ISO week (Monday to
// Sunday), each non-pool assignment of a template slot counts its full
// duration (overnight "+1 day" included) on its start date, and the cap is
// contract + max(0, tolerance ?? 5) hours. People without a positive
// contract have no cap. The clinician picker uses it so a person the planner
// cannot place no longer looks free (v1.74).

export type WeeklyHoursClinician = {
  id: string;
  workingHoursPerWeek?: number;
  workingHoursToleranceHours?: number;
};

export type WeeklyHoursStatus = {
  weekKey: string;
  assignedMinutes: number;
  afterMinutes: number;
  capMinutes: number;
  over: boolean;
};

/** Minutes per `${clinicianId}|${isoWeekKey}`. */
export type WeeklyMinutesIndex = Map<string, number>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 8601 week of a "YYYY-MM-DD" date, e.g. "2026-W45"; null if invalid. */
export function isoWeekKey(dateISO: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateISO) return null;
  // The Thursday of this date's week decides the ISO year.
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(date.getTime() + (3 - weekday) * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  const weekOneMonday = firstThursday.getTime() - firstWeekday * DAY_MS;
  const week = 1 + Math.floor((thursday.getTime() - weekOneMonday) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Sum assignment minutes per clinician and ISO week. `minutesOf` returns a
 * row's slot duration, or null for rows that do not count (pool rows, slots
 * without a valid time): the backend counts those as 0 too.
 */
export function buildWeeklyMinutesIndex(
  assignments: Iterable<{ rowId: string; dateISO: string; clinicianId: string }>,
  minutesOf: (rowId: string) => number | null,
): WeeklyMinutesIndex {
  const index: WeeklyMinutesIndex = new Map();
  for (const assignment of assignments) {
    if (assignment.rowId.startsWith("pool-")) continue;
    const minutes = minutesOf(assignment.rowId);
    if (!minutes || minutes <= 0) continue;
    const week = isoWeekKey(assignment.dateISO);
    if (!week) continue;
    const key = `${assignment.clinicianId}|${week}`;
    index.set(key, (index.get(key) ?? 0) + minutes);
  }
  return index;
}

/** Contract + tolerance in minutes, or null when the person has no cap. */
export function weeklyCapMinutes(clinician: WeeklyHoursClinician): number | null {
  const contract = clinician.workingHoursPerWeek;
  if (typeof contract !== "number" || !Number.isFinite(contract) || contract <= 0) return null;
  const rawTolerance = clinician.workingHoursToleranceHours;
  const tolerance =
    typeof rawTolerance === "number" && Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 5;
  return (contract + tolerance) * 60;
}

/** The person's week after adding `addMinutes` on `dateISO`; null without a cap. */
export function checkWeeklyHours(
  index: WeeklyMinutesIndex,
  clinician: WeeklyHoursClinician,
  dateISO: string,
  addMinutes: number,
): WeeklyHoursStatus | null {
  const capMinutes = weeklyCapMinutes(clinician);
  const weekKey = isoWeekKey(dateISO);
  if (capMinutes === null || !weekKey) return null;
  const assignedMinutes = index.get(`${clinician.id}|${weekKey}`) ?? 0;
  const afterMinutes = assignedMinutes + Math.max(0, addMinutes);
  return { weekKey, assignedMinutes, afterMinutes, capMinutes, over: afterMinutes > capMinutes };
}

const hours = (minutes: number) => {
  const value = Math.round((minutes / 60) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/** "41.5/40 h" — the week after the shift against the cap. */
export function formatWeeklyHours(status: WeeklyHoursStatus): string {
  return `${hours(status.afterMinutes)}/${hours(status.capMinutes)} h`;
}
