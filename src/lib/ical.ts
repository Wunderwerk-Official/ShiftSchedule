import type { Assignment, Clinician } from "../api/client";
import { planTimeZone, wallClockToUtc } from "./planTimeZone";
import { buildShiftInterval } from "./schedule";
import type { ScheduleRow } from "./shiftRows";

// The .ics download. It builds the same events and calendar header as the
// subscription feed (backend/ical.py generate_ics); keep both in step.

export type ICalEvent = {
  uid: string;
  /** Start day, YYYY-MM-DD. */
  dateISO: string;
  /**
   * Wall clock minutes after the start day's midnight in the plan's zone (the
   * end may lie on a later day). Absent: an all-day event on the start day.
   */
  times?: { startMin: number; endMin: number };
  summary: string;
};

export type ICalPerson = Pick<Clinician, "id" | "name">;

const GERMAN_LETTERS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/** X-WR-CALNAME: "Shift Planner – All people" or "Shift Planner – <person>". */
export function icalCalendarName(person?: ICalPerson): string {
  return person ? `Shift Planner – ${person.name || person.id}` : "Shift Planner – All people";
}

function fileSlug(text: string): string {
  const ascii = text
    .toLowerCase()
    .replaceAll(/[äöüß]/g, (letter) => GERMAN_LETTERS[letter])
    // NFD splits other accented letters into base letter + mark; every
    // character still outside ASCII (marks, CJK, emoji) is dropped.
    .normalize("NFD")
    .replaceAll(/[\u0080-\uffff]/g, "");
  return ascii
    .replaceAll(/[^\w\s-]+/g, "")
    .trim()
    .replaceAll(/\s+/g, "-");
}

/** ASCII file name: shift-planner-all.ics or shift-planner-<transliterated name>.ics. */
export function icalFileName(person?: ICalPerson): string {
  if (!person) return "shift-planner-all.ics";
  return `shift-planner-${fileSlug(person.name) || fileSlug(person.id) || "person"}.ics`;
}

function escapeText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

const encoder = new TextEncoder();

/** RFC 5545 folding: at most 75 octets per line, never inside a character; continuations start with a space. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const segments: string[] = [];
  let current = "";
  let currentOctets = 0;
  let limit = 75;
  for (const char of line) {
    const octets = encoder.encode(char).length;
    if (current && currentOctets + octets > limit) {
      segments.push(current);
      current = char;
      currentOctets = octets;
      limit = 74;
    } else {
      current += char;
      currentOctets += octets;
    }
  }
  segments.push(current);
  return segments.join("\r\n ");
}

const formatUtc = (instant: number) =>
  new Date(instant).toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const formatDate = (dateISO: string) => dateISO.replaceAll("-", "");

function nextDayISO(dateISO: string) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

function weekStartISO(dateISO: string) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const compareEvents = (a: ICalEvent, b: ICalEvent) =>
  a.dateISO !== b.dateISO
    ? a.dateISO < b.dateISO
      ? -1
      : 1
    : (a.times?.startMin ?? -1) - (b.times?.startMin ?? -1) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

export function buildICalendar({
  calendarName,
  timeZone,
  events,
  now = new Date(),
}: {
  calendarName: string;
  /** The plan's IANA zone; event times are its wall clock times, sent as UTC. */
  timeZone: string;
  events: ICalEvent[];
  now?: Date;
}) {
  const dtStamp = formatUtc(Math.floor(now.getTime() / 1000) * 1000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ShiftSchedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${timeZone}`,
  ];

  for (const event of [...events].sort(compareEvents)) {
    lines.push("BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${dtStamp}`);
    if (event.times) {
      const start = wallClockToUtc(event.dateISO, event.times.startMin, timeZone);
      const end = wallClockToUtc(event.dateISO, event.times.endMin, timeZone);
      lines.push(`DTSTART:${formatUtc(start)}`);
      // A shift inside the spring-forward gap has no real duration, and DTEND
      // must lie after DTSTART.
      if (end > start) lines.push(`DTEND:${formatUtc(end)}`);
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${formatDate(event.dateISO)}`,
        `DTEND;VALUE=DATE:${formatDate(nextDayISO(event.dateISO))}`,
      );
    }
    lines.push(`SUMMARY:${escapeText(event.summary)}`, "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export type ShiftCalendarSource = {
  assignments: Assignment[];
  /** Schedule rows by id, slot rows included. */
  rowById: Map<string, ScheduleRow>;
  clinicians: Clinician[];
  publishedWeekStartISOs: string[];
  holidayCountry?: string;
};

export type ShiftCalendarOptions = {
  /** One person's calendar; absent: everyone's. */
  clinicianId?: string;
  startISO?: string;
  endISO?: string;
  /** Also export weeks that are not published (the subscription feeds never do). */
  includeUnpublished?: boolean;
  now?: Date;
};

/**
 * The download file: the feed's events (section shifts, no vacation days,
 * published weeks unless includeUnpublished) within the range. Null when the
 * person does not exist.
 */
export function buildShiftCalendar(
  source: ShiftCalendarSource,
  options: ShiftCalendarOptions = {},
): { fileName: string; ics: string; eventCount: number; unpublishedSkipped: number } | null {
  const clinicianById = new Map(source.clinicians.map((clinician) => [clinician.id, clinician]));
  const person = options.clinicianId ? clinicianById.get(options.clinicianId) : undefined;
  if (options.clinicianId && !person) return null;
  const publishedWeeks = new Set(source.publishedWeekStartISOs);

  const events: ICalEvent[] = [];
  // Shifts left out only because their week is not published (the dialog
  // then points to "Include unpublished weeks" instead of an empty file).
  let unpublishedSkipped = 0;
  for (const assignment of source.assignments) {
    const { dateISO } = assignment;
    if (person && assignment.clinicianId !== person.id) continue;
    if (options.startISO && dateISO < options.startISO) continue;
    if (options.endISO && dateISO > options.endISO) continue;
    const row = source.rowById.get(assignment.rowId);
    const clinician = clinicianById.get(assignment.clinicianId);
    if (!row || row.kind !== "class" || !clinician) continue;
    // Vacations override assignments everywhere (grid, web page, feed).
    if (clinician.vacations.some((vacation) => vacation.startISO <= dateISO && dateISO <= vacation.endISO)) {
      continue;
    }
    if (!options.includeUnpublished && !publishedWeeks.has(weekStartISO(dateISO))) {
      unpublishedSkipped += 1;
      continue;
    }
    const section = row.sectionName || row.sectionId || "Section";
    const label = row.slotLabel ? `${section} (${row.slotLabel})` : section;
    // The grid's reading of the slot times; none usable → all-day.
    const interval = buildShiftInterval(row);
    events.push({
      uid: `${assignment.id}@shiftschedule`,
      dateISO,
      ...(interval ? { times: { startMin: interval.start, endMin: interval.end } } : {}),
      summary: `${label} - ${clinician.name || clinician.id}`,
    });
  }

  return {
    fileName: icalFileName(person),
    eventCount: events.length,
    unpublishedSkipped,
    ics: buildICalendar({
      calendarName: icalCalendarName(person),
      timeZone: planTimeZone(source.holidayCountry),
      events,
      now: options.now,
    }),
  };
}
