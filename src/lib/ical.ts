export type ICalEvent = {
  uid: string;
  dateISO: string; // YYYY-MM-DD (all-day event)
  /** Days the shift runs past midnight (slot endDayOffset); widens DTEND like the server feed. */
  endDayOffset?: number;
  summary: string;
  description?: string;
};

function toYYYYMMDD(dateISO: string) {
  return dateISO.replaceAll("-", "");
}

function addDaysISO(dateISO: string, days: number) {
  const [y, m, d] = dateISO.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function escapeText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

export function buildICalendar({
  calendarName,
  events,
}: {
  calendarName: string;
  events: ICalEvent[];
}) {
  const dtStamp = new Date().toISOString().replaceAll(/[-:]/g, "").split(".")[0] + "Z";
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Shift Planner//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);

  for (const event of events) {
    const start = toYYYYMMDD(event.dateISO);
    // DTEND is exclusive: a shift crossing midnight also covers the next day(s),
    // matching the subscribed feed (backend/ical.py).
    const extraDays = Math.max(0, Math.min(3, Math.floor(event.endDayOffset ?? 0))) || 0;
    const end = toYYYYMMDD(addDaysISO(event.dateISO, 1 + extraDays));
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(event.uid)}`);
    lines.push(`DTSTAMP:${dtStamp}`);
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end}`);
    lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

