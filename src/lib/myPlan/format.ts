import type { PlanRange } from "../../api/client";
import { addDays, startOfWeek } from "../date";
import { MINUTES_PER_DAY, addDaysISO, isoWeekNumber, parseISODate } from "./dates";
import type { PlanSegment, PlanShift } from "./types";

// Fixed English names (the app UI is English) instead of Intl, so labels do
// not depend on the browser locale.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Minutes → "08:00"; wraps at 24 h (1920 → "08:00"). */
export function formatTime(min: number): string {
  const wrapped = ((Math.round(min) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** 8.5 → "8.5 h", 53 → "53.0 h". */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

/** 148 → "2 h 28 min", 45 → "45 min", 1500 → "1 d 1 h". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / MINUTES_PER_DAY);
  const hours = Math.floor((total % MINUTES_PER_DAY) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}

/** 148 → "in 2 h 28 min"; ≤ 0 → "now". */
export function formatCountdown(minutes: number): string {
  return minutes <= 0 ? "now" : `in ${formatDuration(minutes)}`;
}

/** "Thu 15 Oct". */
export function formatDayLabel(dateISO: string): string {
  const date = parseISODate(dateISO);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

/** "Thu" (short weekday). */
export function formatWeekday(dateISO: string): string {
  return WEEKDAYS[parseISODate(dateISO).getDay()];
}

/** Day-relative minutes → "Thu 08:00" (minutes may roll into later days). */
export function formatWeekdayTime(dateISO: string, min: number): string {
  const dayOffset = Math.floor(min / MINUTES_PER_DAY);
  return `${formatWeekday(addDaysISO(dateISO, dayOffset))} ${formatTime(min)}`;
}

/** "08:00–16:30", overnight "17:00 → Thu 08:00". */
export function formatShiftTimeRange(shift: PlanShift): string {
  if (shift.endMin <= MINUTES_PER_DAY) {
    return `${formatTime(shift.startMin)}–${formatTime(shift.endMin)}`;
  }
  return `${formatTime(shift.startMin)} → ${formatWeekdayTime(shift.dateISO, shift.endMin)}`;
}

/**
 * Detail line: "Mon 12 Oct, 08:00–16:30 · 8.5 h" or
 * "Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h".
 */
export function formatShiftWhen(shift: PlanShift): string {
  const start = `${formatDayLabel(shift.dateISO)}, ${formatTime(shift.startMin)}`;
  const hours = formatHours(shift.hours);
  if (shift.endMin <= MINUTES_PER_DAY) {
    return `${start}–${formatTime(shift.endMin)} · ${hours}`;
  }
  const endISO = addDaysISO(shift.dateISO, Math.floor(shift.endMin / MINUTES_PER_DAY));
  return `${start} → ${formatDayLabel(endISO)}, ${formatTime(shift.endMin)} · ${hours}`;
}

/**
 * Caption of a split overnight segment: part 1 "→ until Thu 08:00",
 * part 2 "↳ Night duty · until 08:00"; null for unsplit segments.
 */
export function formatSegmentHint(segment: PlanSegment, shift: PlanShift): string | null {
  if (segment.cutStart) {
    const until = segment.cutEnd
      ? formatWeekdayTime(shift.dateISO, shift.endMin)
      : formatTime(shift.endMin);
    return `↳ ${shift.title} · until ${until}`;
  }
  if (segment.cutEnd) return `→ until ${formatWeekdayTime(shift.dateISO, shift.endMin)}`;
  return null;
}

/** "Wed, 14 Oct 2026" (day), "Week 42 · 12–18 Oct 2026" (ISO week), "October 2026" (month). */
export function formatPeriodLabel(range: PlanRange, anchor: Date): string {
  if (range === "month") {
    return `${MONTHS_LONG[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }
  if (range === "day") {
    return `${WEEKDAYS[anchor.getDay()]}, ${anchor.getDate()} ${
      MONTHS_SHORT[anchor.getMonth()]
    } ${anchor.getFullYear()}`;
  }
  const start = startOfWeek(anchor, 1);
  const end = addDays(start, 6);
  const week = `Week ${isoWeekNumber(start)}`;
  const day = (date: Date) => `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
  if (start.getFullYear() !== end.getFullYear()) {
    return `${week} · ${day(start)} ${start.getFullYear()} – ${day(end)} ${end.getFullYear()}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${week} · ${day(start)} – ${day(end)} ${end.getFullYear()}`;
  }
  return `${week} · ${start.getDate()}–${day(end)} ${end.getFullYear()}`;
}
