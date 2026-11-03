import type { Assignment, Clinician, WeeklyCalendarTemplate } from "../api/client";
import { toISODate } from "./date";
import { getSlotDurationMinutes, isoWeekNumber } from "./myPlan";
import { REST_DAY_POOL_ID } from "./schedule";

// Working hours overview (v1.78): planned hours per person, day and week
// against the contract ("target"). Pure, so the week and year views share
// one calculation.
//
// Rules
// - Planned hours: every shift (non-pool assignment) counts its slot's
//   duration on its start day (8 h when the slot has no times); pool rows
//   (rest day, vacation) are not work.
// - Only planned weeks count: a week counts once the team has at least half
//   of its target hours planned (people with contract hours; without any,
//   once anybody has a shift). Weeks before the planner was used, a few test
//   entries, weeks still being planned and future weeks with only the
//   on-call duties planned get no target and stay out of the totals and the
//   balance, instead of piling up a deficit nobody owes.
// - Target = contract hours scaled to the week's days that are not vacation
//   (days / 7, like the planner's working-hours rule and its stats): a full
//   week of vacation has no target, a partial week at the year's ends a
//   partial one.
// - On target = within the person's tolerance (Clinician editor, default
//   ±5 h a week), scaled the same way.
// - Balance = running sum of (planned − target) over the year's counted
//   weeks.

export const DEFAULT_TOLERANCE_HOURS = 5;
/** Share of the team's target hours a week needs planned before it counts. */
export const COUNTED_WEEK_SHARE = 0.5;
const DEFAULT_SLOT_MINUTES = 8 * 60;

export type HoursWeek = {
  /** Position in the year (0-based). */
  index: number;
  /** ISO-8601 week number of the week's Monday ("W45"). */
  isoWeek: number;
  /** Monday of the week (in the previous year for the year's first partial week). */
  monday: Date;
  /** The week's days inside the year, Monday first (partial at the year's ends). */
  dates: string[];
};

/** Monday-based weeks covering Jan 1 to Dec 31; the first and last may be partial. */
export function getWeeksInYear(year: number): HoursWeek[] {
  const weeks: HoursWeek[] = [];
  const jan1 = new Date(year, 0, 1);
  const monday = new Date(year, 0, 1 - ((jan1.getDay() + 6) % 7));
  while (monday.getFullYear() < year || (monday.getFullYear() === year && weeks.length < 54)) {
    const dates: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset);
      if (day.getFullYear() === year) dates.push(toISODate(day));
    }
    if (dates.length === 0) break;
    weeks.push({ index: weeks.length, isoWeek: isoWeekNumber(monday), monday: new Date(monday), dates });
    monday.setDate(monday.getDate() + 7);
  }
  return weeks;
}

/** Index of the week containing the date (ISO), or -1 outside the year. */
export function weekIndexOf(weeks: HoursWeek[], dateISO: string): number {
  return weeks.findIndex((week) => week.dates.includes(dateISO));
}

export type HoursStatus = "under" | "on" | "over";

/** Over or under once the difference leaves the tolerance band. */
export function hoursStatus(differenceMinutes: number, toleranceMinutes: number): HoursStatus {
  if (differenceMinutes > toleranceMinutes) return "over";
  if (differenceMinutes < -toleranceMinutes) return "under";
  return "on";
}

export type PersonWeekHours = {
  plannedMinutes: number;
  /** Planned minutes per day (ISO date), days with shifts only. */
  minutesByDate: Map<string, number>;
  /** Shift row ids per day, for tooltips. */
  rowIdsByDate: Map<string, string[]>;
  vacationDates: Set<string>;
  restDates: Set<string>;
  /** False until the team has enough of this week planned (COUNTED_WEEK_SHARE). */
  counted: boolean;
  /** Contract hours for the days not on vacation; null without contract or plan. */
  targetMinutes: number | null;
  toleranceMinutes: number | null;
  differenceMinutes: number | null;
  /** Null without a target and for a week spent on vacation. */
  status: HoursStatus | null;
  /** Running balance through this week (counted weeks only; null otherwise). */
  balanceMinutes: number | null;
};

export type PersonYearHours = {
  clinicianId: string;
  weeklyHours: number | null;
  toleranceHours: number;
  weeks: PersonWeekHours[];
  /** Planned minutes in the counted weeks (like the target and the balance). */
  plannedMinutes: number;
  /** Sum of the counted weeks' targets; null without contract hours or counted weeks. */
  targetMinutes: number | null;
  balanceMinutes: number | null;
};

export type TeamWeekHours = {
  /** Planned minutes of the people with contract hours. */
  plannedMinutes: number;
  /** Their targets (contract hours for the days not on vacation). */
  targetMinutes: number;
  counted: boolean;
};

export type WorkingHoursYear = {
  year: number;
  weeks: HoursWeek[];
  /** Indexes of the weeks that count (enough of the team's hours planned). */
  countedWeeks: Set<number>;
  /** Team sums per week index (why a week counts or not). */
  team: TeamWeekHours[];
  people: PersonYearHours[];
};

export type HoursClinician = Pick<Clinician, "id"> & {
  workingHoursPerWeek?: number;
  workingHoursToleranceHours?: number;
  vacations?: Array<{ startISO: string; endISO: string }>;
};

/** Slot durations (minutes) of the weekly template by slot id. */
export function slotMinutesFromTemplate(template?: WeeklyCalendarTemplate): Map<string, number> {
  const minutes = new Map<string, number>();
  for (const location of template?.locations ?? []) {
    for (const slot of location.slots ?? []) minutes.set(slot.id, getSlotDurationMinutes(slot));
  }
  return minutes;
}

const contractHours = (clinician: HoursClinician): number | null =>
  typeof clinician.workingHoursPerWeek === "number" && clinician.workingHoursPerWeek > 0
    ? clinician.workingHoursPerWeek
    : null;

const toleranceHours = (clinician: HoursClinician): number =>
  typeof clinician.workingHoursToleranceHours === "number" && clinician.workingHoursToleranceHours >= 0
    ? clinician.workingHoursToleranceHours
    : DEFAULT_TOLERANCE_HOURS;

/** Vacation days of the year as ISO dates (inclusive ranges, clipped to the year). */
function vacationDatesInYear(clinician: HoursClinician, year: number): Set<string> {
  const dates = new Set<string>();
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  for (const vacation of clinician.vacations ?? []) {
    if (!vacation?.startISO || !vacation?.endISO) continue;
    const from = vacation.startISO > first ? vacation.startISO : first;
    const to = vacation.endISO < last ? vacation.endISO : last;
    if (from > to) continue;
    const cursor = new Date(`${from}T00:00:00`);
    if (Number.isNaN(cursor.getTime())) continue;
    for (let dateISO = from; dateISO <= to; dateISO = toISODate(cursor)) {
      dates.add(dateISO);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return dates;
}

export function buildWorkingHoursYear({
  year,
  clinicians,
  assignments,
  slotMinutesById,
  minutesOf,
}: {
  year: number;
  clinicians: HoursClinician[];
  assignments: Assignment[];
  slotMinutesById: Map<string, number>;
  /** Real minutes of a shift on its date (the plan's zone, DST changes); falls back to slotMinutesById. */
  minutesOf?: (rowId: string, dateISO: string) => number | undefined;
}): WorkingHoursYear {
  const weeks = getWeeksInYear(year);
  const weekIndexByDate = new Map<string, number>();
  for (const week of weeks) for (const dateISO of week.dates) weekIndexByDate.set(dateISO, week.index);

  type Raw = {
    minutesByWeek: number[];
    minutesByDate: Map<string, number>;
    rowIdsByDate: Map<string, string[]>;
    restDates: Set<string>;
  };
  const raw = new Map<string, Raw>(
    clinicians.map((clinician) => [
      clinician.id,
      { minutesByWeek: weeks.map(() => 0), minutesByDate: new Map(), rowIdsByDate: new Map(), restDates: new Set() },
    ]),
  );
  const weeksWithShifts = new Set<number>();

  for (const assignment of assignments) {
    const weekIndex = weekIndexByDate.get(assignment.dateISO);
    if (weekIndex === undefined) continue;
    const isPool = assignment.rowId.startsWith("pool-");
    if (!isPool) weeksWithShifts.add(weekIndex);
    const person = raw.get(assignment.clinicianId);
    if (!person) continue;
    if (isPool) {
      if (assignment.rowId === REST_DAY_POOL_ID) person.restDates.add(assignment.dateISO);
      continue;
    }
    const minutes =
      minutesOf?.(assignment.rowId, assignment.dateISO) ?? slotMinutesById.get(assignment.rowId) ?? DEFAULT_SLOT_MINUTES;
    person.minutesByWeek[weekIndex] += minutes;
    person.minutesByDate.set(assignment.dateISO, (person.minutesByDate.get(assignment.dateISO) ?? 0) + minutes);
    person.rowIdsByDate.set(assignment.dateISO, [...(person.rowIdsByDate.get(assignment.dateISO) ?? []), assignment.rowId]);
  }

  const vacationsById = new Map(clinicians.map((clinician) => [clinician.id, vacationDatesInYear(clinician, year)]));
  const availableDays = (clinicianId: string, week: HoursWeek) => {
    const vacations = vacationsById.get(clinicianId)!;
    return week.dates.filter((dateISO) => !vacations.has(dateISO)).length;
  };

  // Which weeks count: enough of the team's target hours planned.
  const withContract = clinicians.filter((clinician) => contractHours(clinician) !== null);
  const team = weeks.map((week): TeamWeekHours => {
    let plannedMinutes = 0;
    let targetMinutes = 0;
    for (const clinician of withContract) {
      plannedMinutes += raw.get(clinician.id)!.minutesByWeek[week.index];
      targetMinutes += (contractHours(clinician)! * 60 * availableDays(clinician.id, week)) / 7;
    }
    const counted =
      targetMinutes > 0
        ? plannedMinutes >= COUNTED_WEEK_SHARE * targetMinutes
        : weeksWithShifts.has(week.index);
    return { plannedMinutes, targetMinutes, counted };
  });
  const countedWeeks = new Set(weeks.filter((week) => team[week.index].counted).map((week) => week.index));

  const people = clinicians.map((clinician): PersonYearHours => {
    const data = raw.get(clinician.id)!;
    const weekly = contractHours(clinician);
    const tolerance = toleranceHours(clinician);
    const vacations = vacationsById.get(clinician.id)!;
    let balance = 0;
    let targetTotal = 0;
    let plannedTotal = 0;
    const personWeeks = weeks.map((week): PersonWeekHours => {
      const plannedMinutes = data.minutesByWeek[week.index];
      const counted = countedWeeks.has(week.index);
      if (counted) plannedTotal += plannedMinutes;
      const inWeek = (dates: Set<string>) => new Set(week.dates.filter((dateISO) => dates.has(dateISO)));
      const minutesByDate = new Map(week.dates.filter((d) => data.minutesByDate.has(d)).map((d) => [d, data.minutesByDate.get(d)!]));
      const rowIdsByDate = new Map(week.dates.filter((d) => data.rowIdsByDate.has(d)).map((d) => [d, data.rowIdsByDate.get(d)!]));
      const vacationDates = inWeek(vacations);
      const restDates = inWeek(data.restDates);
      const base = { plannedMinutes, minutesByDate, rowIdsByDate, vacationDates, restDates, counted };
      if (!counted || weekly === null) {
        return { ...base, targetMinutes: null, toleranceMinutes: null, differenceMinutes: null, status: null, balanceMinutes: null };
      }
      const daysAvailable = week.dates.length - vacationDates.size;
      const targetMinutes = (weekly * 60 * daysAvailable) / 7;
      const toleranceMinutes = (tolerance * 60 * daysAvailable) / 7;
      const differenceMinutes = plannedMinutes - targetMinutes;
      targetTotal += targetMinutes;
      balance += differenceMinutes;
      return {
        ...base,
        targetMinutes,
        toleranceMinutes,
        differenceMinutes,
        // A week spent on vacation has nothing to be over or under.
        status: daysAvailable === 0 && plannedMinutes === 0 ? null : hoursStatus(differenceMinutes, toleranceMinutes),
        balanceMinutes: balance,
      };
    });
    // Without contract hours, or before anything is planned, there is no
    // target to compare with.
    const hasTarget = weekly !== null && countedWeeks.size > 0;
    return {
      clinicianId: clinician.id,
      weeklyHours: weekly,
      toleranceHours: tolerance,
      weeks: personWeeks,
      plannedMinutes: plannedTotal,
      targetMinutes: hasTarget ? targetTotal : null,
      balanceMinutes: hasTarget ? balance : null,
    };
  });

  return { year, weeks, countedWeeks, team, people };
}

/** Hours with at most one decimal ("8", "7.5"); null/0 → "–". */
export function formatHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "–";
  const hours = Math.round(minutes / 6) / 10;
  if (hours === 0) return "–";
  return hours.toFixed(1).replace(/\.0$/, "");
}

/** Signed hours ("+4", "−2.5", "0"), with a real minus sign. */
export function formatSignedHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "–";
  const hours = Math.round(minutes / 6) / 10;
  if (hours === 0) return "0";
  const text = Math.abs(hours).toFixed(1).replace(/\.0$/, "");
  return hours > 0 ? `+${text}` : `−${text}`;
}
