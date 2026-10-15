// "My plan" core — the contract for src/components/myPlan/*. Pure functions
// only; components stay thin. Import everything from "lib/myPlan".
//
// Typical container flow (MyPlanView):
//   const plan = buildPersonPlan({ ...source, clinicianId, fromISO, toISO, todayISO });
//   plan.days → columns/rows; day.segments → blocks (plan.shifts.get(seg.shiftId));
//   day.absences → bands; day.tint → location ground + chip (tintTone(tint,
//   isDark) picks the light or the dark set); day.hours → day total.
//   sumHours(plan, weekFrom, weekTo) → footer; findCoworkers(source, shift) → detail.
// `source` = PlanSource: the page's scheduleRows, assignments, clinicians,
// locations, holidays, publishedWeekStartISOs and solverSettings.

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  /** "shift" | "duty" (overnight or on-call section → DUTY_COLORS + moon icon). */
  ShiftKind,
  /** { fill, border, text, secondaryText } hex colors for inline styles. */
  BlockColors,
  /** { ground, chip, ink, dark } of a location color (light set + dark-mode set). */
  LocationTint,
  /** { ground, chip, ink } of a location tint in one theme. */
  LocationTone,
  /** State slices every builder reads. */
  PlanSource,
  /** One own assignment on a section slot (times from the slot; hours on start day). */
  PlanShift,
  /** A shift's part on one day (overnight shifts → two segments, same shiftId). */
  PlanSegment,
  /** "vacation" | "rest". */
  PlanAbsenceKind,
  /** All-day band; rest starts after a night continuation (startMin). */
  PlanAbsence,
  /** One visible day: segments, absences, tint (+ tintBands for two locations), hours, flags. */
  PlanDay,
  /** { startMin, endMin, tint } part of a day ground split between two locations (SPEC R9). */
  TintBand,
  /** Result of buildPersonPlan. */
  PersonPlan,
  /** { strong, light, ink, onStrong } person colors resolved for the theme. */
  PersonTone,
} from "./types";

// ── Timeline ────────────────────────────────────────────────────────────────
/**
 * buildPersonPlan({ ...source, clinicianId, fromISO, toISO, todayISO }):
 * days fromISO..toISO (inclusive) with split segments, overlap lanes,
 * absences (vacation; rest days exactly as the team grid shows them, incl.
 * on-call rest), location tint of the day a shift STARTS, day hours. Reads a
 * week before/after the range itself — the night that started the day before
 * the range is included automatically (do not pass fromISO − 1).
 * For day-view lanes of colleagues, call it again with their clinicianId.
 */
export { buildPersonPlan } from "./timeline";
export type { PersonPlanInput } from "./timeline";

// ── Labels ──────────────────────────────────────────────────────────────────
/** Absence pool row → ≤ 5 characters ("ND-Frei" → "NDF", "Urlaub/FzA" → "Url."). */
export { deriveAbsenceShortLabel } from "./shifts";
/** Location name → ≤ max (8) characters ("Klinikum Mitte" → "Mitte", "Konferenzen" → "Konf."). */
export { deriveLocationShortName } from "./shifts";

// ── Hours ───────────────────────────────────────────────────────────────────
/** Gross slot minutes (end − start, + endDayOffset days); 8 h when times are missing. */
export { getSlotDurationMinutes } from "./hours";
/**
 * Counted hours of shifts STARTING in [fromISO, toISO] — e.g. the ISO week for the footer.
 * Overlapping own shifts count once, to the longer shift (SPEC R4).
 */
export { sumHours } from "./hours";
/** Hours a shift adds to sums (shift.countedHours ?? shift.hours); shift.hours stays the gross duration. */
export { countedHours } from "./hours";
/** Days with a vacation/rest absence in [fromISO, toISO] ("Vacation · 5 days"). */
export { countAbsenceDays } from "./hours";

// ── Dates (local calendar, DST-safe; never toISOString for local dates) ────
/** ISO-8601 week number of a local date. */
export { isoWeekNumber } from "./dates";
/** "YYYY-MM-DD" → local midnight. */
export { parseISODate } from "./dates";
/** ISO date ± n days. */
export { addDaysISO } from "./dates";
/** Whole days b − a between two ISO dates. */
export { dayDiff } from "./dates";
/** Monday of the week containing an ISO date (key of publishedWeekStartISOs). */
export { weekStartISO } from "./dates";
/** 1440. */
export { MINUTES_PER_DAY } from "./dates";

// ── Coworkers ───────────────────────────────────────────────────────────────
/**
 * findCoworkers(source, shift) → { sameDuty, sameTimeAtLocation, otherAtLocation }:
 * interval overlap at the same location (a night also lists the next
 * morning's early starters). Every group is limited to the shift's location
 * (SPEC R12), so a duty colleague at another site is not listed. One entry
 * per colleague, sorted by start. Show max 3 per group + "+N more" in the UI.
 */
export { findCoworkers } from "./coworkers";
export type { Coworker, CoworkerGroups } from "./coworkers";

// ── Next up ─────────────────────────────────────────────────────────────────
/**
 * findNextShift(plan, now, horizonDays = 14) → { shift, running, minutesUntil,
 * minutesLeft } | null. Build the plan for today … today+14 for the header chip.
 */
export { findNextShift } from "./nextUp";
/** findNextShiftFor(source, clinicianId, now, horizonDays = 14): the same lookup on a plan it builds itself. */
export { findNextShiftFor } from "./nextUp";
export type { NextShift } from "./nextUp";

// ── Rest / next (shift detail) ──────────────────────────────────────────────
/** restBefore(plan, shift) → { hours, fromLabel "Tue 16:30", toLabel, previous, direct } | null. */
export { restBefore } from "./rest";
export type { RestBefore } from "./rest";
/**
 * nextAfter(plan, shift) → "Thu 15 Oct · Rest Day from 08:00" | "MRT 08:00 (directly after)" |
 * "Thu 15 Oct · MRT 08:00 (directly after)" | null.
 */
export { nextAfter } from "./rest";

// ── Colors ──────────────────────────────────────────────────────────────────
/**
 * Section block colors from blockColor (cached): border ≥ 3:1 vs white and darker than the
 * fill; text ≥ 7:1 where reachable, always ≥ 4.5:1; fallback fill slate-200.
 */
export { deriveBlockColors } from "./colors";
/** Dark-mode variant of a section fill (deep fill, light border and text; cached). */
export { deriveDarkBlockColors } from "./colors";
/** Dark duty palette (#312E81 fill, white text, #C7D2FE secondary). */
export { DUTY_COLORS } from "./colors";
/** Vacation stripes / rest-day dashed band colors, each with a `dark` variant. */
export { ABSENCE_COLORS } from "./colors";
/** Location.color → { ground, chip, ink, dark } (presets, or derived: ink ≥ 4.5:1 on chip), null = none. */
export { locationTint } from "./colors";
/** tintTone(tint, isDark): the theme's { ground, chip, ink } of a location tint (SPEC B7). */
export { tintTone } from "./colors";
/** Person color by clinician list index (16, repeating): { id, strong, light, ink }. */
export { personColor } from "./colors";
/** personTone(index, isDark): theme-resolved person colors (dark: B8 dark tokens, dark initials). */
export { personTone } from "./colors";
/** WCAG contrast ratio of two hex colors. */
export { contrastRatio } from "./colors";

// ── Layout ──────────────────────────────────────────────────────────────────
/** (min − windowStart) · pxPerHour / 60. */
export { minutesToPx } from "./layout";
/** Day-view window 06–22, extended to cover the given shifts (max next day 12:00). */
export { dayWindow } from "./layout";
/** "full" | "medium" | "line" | "tiny" text level for a block size along an axis. */
export { blockDetailLevel } from "./layout";
export type { BlockDetailLevel } from "./layout";
/**
 * { offsetPx, sizePx }: min size 18 px, grown into free time (down to the next segment, then
 * up to the previous one); never covers a neighbour, so a squeezed block may stay smaller.
 */
export { segmentBox } from "./layout";
/** Day-view defaults (06:00, 22:00), max end (next day 12:00), MIN_BLOCK_PX = 18. */
export {
  DAY_VIEW_DEFAULT_START,
  DAY_VIEW_DEFAULT_END,
  DAY_VIEW_MAX_END,
  MIN_BLOCK_PX,
} from "./layout";

// ── Month ───────────────────────────────────────────────────────────────────
/** Monday-first weeks (Date[7] each) covering the month: 4–6 rows. */
export { buildMonthWeeks } from "./month";
/** { fromISO, toISO } of the month sheet — build the plan for it (week sums = full ISO weeks). */
export { monthSheetRange } from "./month";
/** Same calendar month? (dim days of neighbouring months). */
export { isSameMonth } from "./month";
/** Consecutive absence days (of consecutive PlanDays) merged into { startISO, endISO, days }. */
export { absenceRuns } from "./month";
export type { AbsenceRun } from "./month";

// ── Formatting (English UI copy) ───────────────────────────────────────────
/** Minutes → "08:00", wraps at 24 h. */
export { formatTime } from "./format";
/** 8.5 → "8.5 h" (always one decimal). */
export { formatHours } from "./format";
/** 148 → "2 h 28 min". */
export { formatDuration } from "./format";
/** 148 → "in 2 h 28 min"; ≤ 0 → "now". */
export { formatCountdown } from "./format";
/** "Thu 15 Oct". */
export { formatDayLabel } from "./format";
/** "Thu". */
export { formatWeekday } from "./format";
/** (dateISO, minutes possibly > 1440) → "Thu 08:00". */
export { formatWeekdayTime } from "./format";
/** "08:00–16:30" or overnight "17:00 → Thu 08:00". */
export { formatShiftTimeRange } from "./format";
/** Detail line "Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h". */
export { formatShiftWhen } from "./format";
/**
 * Split-night caption: part 1 "→ until Thu 08:00" (axis "horizontal", default) or
 * "↓ Thu until 08:00" ("vertical") / part 2 "↳ Title · until 08:00" / null.
 */
export { formatSegmentHint } from "./format";
/** "Wed, 14 Oct 2026" | "Week 42 · 12–18 Oct 2026" | "October 2026". */
export { formatPeriodLabel } from "./format";
