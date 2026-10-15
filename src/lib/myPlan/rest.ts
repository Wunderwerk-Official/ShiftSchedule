import { MINUTES_PER_DAY, addDaysISO, dayDiff } from "./dates";
import { formatDayLabel, formatTime, formatWeekdayTime } from "./format";
import type { PersonPlan, PlanAbsence, PlanShift } from "./types";

// Shift-detail context lines: rest before a shift and what comes after it.
// Both only look at the plan's context window (a week around the range).

export type RestBefore = {
  /** Gap between the previous shift's end and this start (0 when direct/overlapping). */
  hours: number;
  /** "Tue 16:30" — end of the previous shift. */
  fromLabel: string;
  /** "Wed 17:00" — start of this shift. */
  toLabel: string;
  previous: PlanShift;
  /** Starts right when (or before) the previous shift ends. */
  direct: boolean;
};

// Minutes relative to the shift's own start day.
const startOf = (shift: PlanShift, refISO: string) =>
  dayDiff(refISO, shift.dateISO) * MINUTES_PER_DAY + shift.startMin;
const endOf = (shift: PlanShift, refISO: string) =>
  dayDiff(refISO, shift.dateISO) * MINUTES_PER_DAY + shift.endMin;

/** "Rest before: 24.5 h (Tue 16:30 → Wed 17:00)"; null when no earlier shift in the plan. */
export function restBefore(plan: PersonPlan, shift: PlanShift): RestBefore | null {
  let previous: PlanShift | null = null;
  for (const other of plan.shifts.values()) {
    if (other.id === shift.id || startOf(other, shift.dateISO) >= shift.startMin) continue;
    if (!previous || endOf(other, shift.dateISO) > endOf(previous, shift.dateISO)) previous = other;
  }
  if (!previous) return null;
  const gap = shift.startMin - endOf(previous, shift.dateISO);
  return {
    hours: Math.max(0, gap) / 60,
    fromLabel: formatWeekdayTime(previous.dateISO, previous.endMin),
    toLabel: formatWeekdayTime(shift.dateISO, shift.startMin),
    previous,
    direct: gap <= 0,
  };
}

function describeAbsence(plan: PersonPlan, absence: PlanAbsence): string {
  if (absence.kind === "rest") {
    const from = absence.startMin > 0 ? ` from ${formatTime(absence.startMin)}` : "";
    return `${formatDayLabel(absence.dateISO)} · ${absence.label}${from}`;
  }
  // Consecutive vacation days are named as one range.
  let endISO = absence.dateISO;
  const vacationDays = new Set(
    plan.absences.filter((item) => item.kind === "vacation").map((item) => item.dateISO),
  );
  while (vacationDays.has(addDaysISO(endISO, 1))) endISO = addDaysISO(endISO, 1);
  const range =
    endISO === absence.dateISO
      ? formatDayLabel(absence.dateISO)
      : `${formatDayLabel(absence.dateISO)} – ${formatDayLabel(endISO)}`;
  return `${range} · ${absence.label}`;
}

/**
 * What comes next after a shift: "MRT 08:00 (directly after)", "Sono 12:00",
 * "Fri 16 Oct · Angio 08:00", "Thu 15 Oct · MRT 08:00 (directly after)" (after
 * a night), "Thu 15 Oct · Rest Day from 08:00",
 * "Mon 19 Oct – Fri 23 Oct · Vacation" (absence label = pool row name);
 * null when nothing follows in the plan. A shift that lies entirely within
 * this one is skipped (a meeting during a night, Demos 07:15–07:45 before its
 * 08:00 end), so the night names its rest day; one that starts during it but
 * runs past its end ("MRT spät 11:00" during MRT until 16:30) still follows.
 */
export function nextAfter(plan: PersonPlan, shift: PlanShift): string | null {
  let nextShift: PlanShift | null = null;
  for (const other of plan.shifts.values()) {
    if (
      other.id === shift.id ||
      startOf(other, shift.dateISO) <= shift.startMin ||
      endOf(other, shift.dateISO) <= shift.endMin
    ) {
      continue;
    }
    if (!nextShift || startOf(other, shift.dateISO) < startOf(nextShift, shift.dateISO)) {
      nextShift = other;
    }
  }
  const absenceStartOf = (absence: PlanAbsence) =>
    dayDiff(shift.dateISO, absence.dateISO) * MINUTES_PER_DAY + absence.startMin;
  // An all-day absence still follows when it begins during the shift but
  // outlasts it (vacation on the day a night ends); it counts from the end.
  const nextAbsence = plan.absences.find(
    (absence) =>
      absenceStartOf(absence) > shift.startMin &&
      (dayDiff(shift.dateISO, absence.dateISO) + 1) * MINUTES_PER_DAY > shift.endMin,
  );
  const shiftStart = nextShift ? startOf(nextShift, shift.dateISO) : Infinity;
  const absenceStart = nextAbsence ? Math.max(absenceStartOf(nextAbsence), shift.endMin) : Infinity;
  if (nextAbsence && absenceStart <= shiftStart) return describeAbsence(plan, nextAbsence);
  if (!nextShift) return null;
  const direct = shiftStart === shift.endMin ? " (directly after)" : "";
  const label = `${nextShift.title} ${formatTime(nextShift.startMin)}${direct}`;
  if (nextShift.dateISO !== shift.dateISO) return `${formatDayLabel(nextShift.dateISO)} · ${label}`;
  return label;
}
