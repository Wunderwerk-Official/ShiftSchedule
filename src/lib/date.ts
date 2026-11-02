export function toISODate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfWeek(date: Date, weekStartsOn: 0 | 1 = 0) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

export function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addWeeks(date: Date, weeks: number) {
  return addDays(date, weeks * 7);
}

export function startOfMonth(date: Date) {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Always lands on the 1st of the target month, so there is no
// end-of-month day overflow to worry about.
export function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function daysInMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// All Monday-start weeks that overlap the given month (i.e. contain at
// least one day of it). The first week may start in the previous month.
export function listWeekStartsOverlappingMonth(monthAnchor: Date): Date[] {
  const monthStart = startOfMonth(monthAnchor);
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const weeks: Date[] = [];
  let week = startOfWeek(monthStart, 1);
  while (week.getTime() <= monthEnd.getTime()) {
    weeks.push(week);
    week = addWeeks(week, 1);
  }
  return weeks;
}

// English like the rest of the UI ("December 2026").
export function formatMonthLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatDayHeader(date: Date) {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" })
    .format(date)
    .toUpperCase();
  const dayOfMonth = new Intl.DateTimeFormat("en-US", { day: "2-digit" }).format(
    date,
  );
  return { weekday, dayOfMonth };
}

// "02.11.2026", or "02.11." without the year.
function formatEuropeanDate(date: Date, withYear = true) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return withYear ? `${day}.${month}.${date.getFullYear()}` : `${day}.${month}.`;
}

/** A day in the style of the week range label: "Mon 02.11.2026" ("Mon 02.11." without the year). */
export function formatWeekdayDate(date: Date, { withYear = true }: { withYear?: boolean } = {}) {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  return `${weekday} ${formatEuropeanDate(date, withYear)}`;
}

export function formatRangeLabel(start: Date, endInclusive: Date) {
  const sameDay =
    start.getFullYear() === endInclusive.getFullYear() &&
    start.getMonth() === endInclusive.getMonth() &&
    start.getDate() === endInclusive.getDate();

  if (sameDay) {
    return formatEuropeanDate(start);
  }

  return `${formatEuropeanDate(start)} \u2013 ${formatEuropeanDate(endInclusive)}`;
}
