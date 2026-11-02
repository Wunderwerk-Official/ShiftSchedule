import { useEffect } from "react";
import { toISODate } from "../lib/date";

// The calendar's viewed period in the address bar (?week=YYYY-MM-DD), so a
// reload keeps it and a link opens it. The team week writes its Monday, the
// phone day view and My plan their day, the clinic sheet the first of its
// month. The period around today writes no parameter: the plain address (a
// bookmark, a home screen icon, a tab reopened days later) keeps opening the
// current week. Only the calendar page reads and writes it; the print and
// public routes keep their own addresses.

const WEEK_PARAM = "week";

/** The date in `?week=YYYY-MM-DD`; null when missing or not a real date. */
export function readWeekParam(search: string): Date | null {
  const value = new URLSearchParams(search).get(WEEK_PARAM);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  // Rolled-over dates ("2026-02-30") are not real dates.
  return toISODate(date) === value ? date : null;
}

/** `href` with `?week=` set to `dateISO`, or without it for null; the rest of the address stays. */
export function withWeekParam(href: string, dateISO: string | null): string {
  const url = new URL(href);
  if (dateISO) url.searchParams.set(WEEK_PARAM, dateISO);
  else url.searchParams.delete(WEEK_PARAM);
  return url.toString();
}

/**
 * Keeps `?week=` in step with the viewed period, replacing the history entry
 * (no entry per click). While `enabled` is false the address stays as it is
 * (the calendar's layout, and with it the period, is not known yet).
 */
export function useWeekParam(dateISO: string | null, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const next = withWeekParam(window.location.href, dateISO);
    if (next !== window.location.href) window.history.replaceState(window.history.state, "", next);
  }, [dateISO, enabled]);
}
