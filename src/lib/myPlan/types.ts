import type {
  Assignment,
  Clinician,
  DayType,
  Holiday,
  Location,
  SolverSettings,
} from "../../api/client";
import type { ScheduleRow } from "../shiftRows";

/** "duty" = overnight shift or the on-call section; drawn in the dark duty palette. */
export type ShiftKind = "shift" | "duty";

/** Inline-style colors of a shift block (all "#RRGGBB"). */
export type BlockColors = {
  fill: string;
  border: string;
  text: string;
  secondaryText: string;
};

/**
 * Location tint: light ground for the day, darker chip, chip text. Light mode
 * only for the ground: in dark mode paint it at ~15 % opacity (`${ground}26`)
 * under the usual light text, or skip it; chip + ink work on any surface.
 */
export type LocationTint = { ground: string; chip: string; ink: string };

/** Everything the plan builders read; pass the page's normalized state slices. */
export type PlanSource = {
  scheduleRows: ScheduleRow[];
  assignments: Assignment[];
  clinicians: Clinician[];
  locations: Location[];
  holidays: Holiday[];
  publishedWeekStartISOs: string[];
  /** On-call section (duty style) and on-call rest days, only when enabled. */
  solverSettings?: SolverSettings;
};

/** One assignment of a clinician on a section slot. */
export type PlanShift = {
  /** Assignment id (unique). Shared by both segments of an overnight shift. */
  id: string;
  clinicianId: string;
  rowId: string;
  /** Start day; the whole shift (and its hours) belongs to this day. */
  dateISO: string;
  /** Section name without times ("MRT 08:00–17:00" → "MRT"). */
  title: string;
  /** ≤ 6 characters, derived from the title. */
  shortLabel: string;
  /** Template block label, when set ("Arbeitsplatz 1"). */
  slotLabel?: string;
  sectionId?: string;
  locationId?: string;
  /** Undefined when locations are disabled. */
  locationName?: string;
  /** Minutes from start-day midnight. */
  startMin: number;
  /** Minutes from start-day midnight; > 1440 for overnight shifts. */
  endMin: number;
  /** Gross slot duration in hours (no break deduction), counted on the start day. */
  hours: number;
  kind: ShiftKind;
  colors: BlockColors;
  /** Week of the start day is published. */
  published: boolean;
  locked?: boolean;
};

/** A shift's part on one calendar day. */
export type PlanSegment = {
  key: string;
  shiftId: string;
  dateISO: string;
  /** 0..1440 within that day. */
  startMin: number;
  endMin: number;
  /** Continues from the previous day. */
  cutStart: boolean;
  /** Continues into the next day. */
  cutEnd: boolean;
  /** Overlapping segments of the same person share the lane: two lanes à 50 %. */
  lane: 0 | 1;
  lanes: 1 | 2;
};

export type PlanAbsenceKind = "vacation" | "rest";

/** All-day band; a rest day starts after a night continuation (startMin > 0). */
export type PlanAbsence = {
  kind: PlanAbsenceKind;
  dateISO: string;
  startMin: number;
  /** Pool row name ("Vacation", "Rest Day", "ND-Frei", …). */
  label: string;
};

export type PlanDay = {
  dateISO: string;
  /** Local midnight. */
  date: Date;
  /** "holiday" on holidays, otherwise the weekday. */
  dayType: DayType;
  /** Saturday or Sunday (independent of holidays). */
  isWeekend: boolean;
  isToday: boolean;
  holidayName?: string;
  /** The day's Monday-start week is published. */
  published: boolean;
  /** Sorted by start, then longer first. */
  segments: PlanSegment[];
  absences: PlanAbsence[];
  /** Location where the first shift starts this day (chips: startLocationIds). */
  startLocationId?: string;
  /** Distinct locations of shifts starting this day, in start order (none if locations are off). */
  startLocationIds: string[];
  /** Ground tint of startLocationId; null when there is none or it has no color. */
  tint: LocationTint | null;
  /** Hours of shifts starting this day; null when nothing starts this day. */
  hours: number | null;
  /** Only the continuation of an earlier shift is on this day. */
  isContinuationOnly: boolean;
  /** No segments and no absences. */
  isFree: boolean;
};

export type PersonPlan = {
  clinicianId: string;
  fromISO: string;
  toISO: string;
  /** Visible days fromISO..toISO. */
  days: PlanDay[];
  /**
   * Shifts starting up to a week before/after the visible range (context for
   * rest/next/coworkers), in chronological order.
   */
  shifts: Map<string, PlanShift>;
  /** Absences of the same context window, chronological. */
  absences: PlanAbsence[];
};
