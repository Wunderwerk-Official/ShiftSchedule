import { addDays, startOfWeek, toISODate } from "../date";

// Local-calendar date helpers. Dates are handled as "YYYY-MM-DD" strings and
// local midnights; day differences go through Date.UTC so DST switches never
// produce 23/25-hour days. Never use toISOString() for local dates.

export const MINUTES_PER_DAY = 24 * 60;

/** "2026-10-14" → local midnight of that day. */
export function parseISODate(dateISO: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function addDaysISO(dateISO: string, days: number): string {
  return toISODate(addDays(parseISODate(dateISO), days));
}

/** Whole calendar days from a to b (b − a). */
export function dayDiff(aISO: string, bISO: string): number {
  const toUtc = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, (month ?? 1) - 1, day ?? 1);
  };
  return Math.round((toUtc(bISO) - toUtc(aISO)) / 86_400_000);
}

/** Inclusive list of ISO dates; empty when to < from. */
export function listDaysISO(fromISO: string, toISO: string): string[] {
  const count = dayDiff(fromISO, toISO) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => addDaysISO(fromISO, i));
}

/** Monday of the week containing the date, as ISO. */
export function weekStartISO(dateISO: string): string {
  return toISODate(startOfWeek(parseISODate(dateISO), 1));
}

/** ISO-8601 week number (weeks start Monday, week 1 contains 4 January). */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Wall-clock instant of `minutes` after the day's local midnight (may roll into later days). */
export function localDateTime(dateISO: string, minutes: number): Date {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, minutes);
}
