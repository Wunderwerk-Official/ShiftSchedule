import { describe, expect, it } from "vitest";
import type { Assignment, Clinician } from "../api/client";
import {
  buildICalendar,
  buildShiftCalendar,
  foldLine,
  icalCalendarName,
  icalFileName,
  type ShiftCalendarSource,
} from "./ical";
import type { ScheduleRow } from "./shiftRows";

const octets = (text: string) => new TextEncoder().encode(text).length;
const unfold = (ics: string) => ics.replaceAll("\r\n ", "");
const lines = (ics: string) => unfold(ics).split("\r\n");
const times = (ics: string) => lines(ics).filter((line) => /^DT(START|END)/.test(line));
const now = new Date("2026-11-02T10:00:00Z");

const row = (id: string, slot: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id,
  kind: "class",
  name: "MRI",
  dotColorClass: "bg-slate-400",
  sectionId: "section-a",
  sectionName: "MRI",
  ...slot,
});

const clinician = (id: string, name: string, extra: Partial<Clinician> = {}): Clinician => ({
  id,
  name,
  qualifiedClassIds: [],
  preferredClassIds: [],
  vacations: [],
  ...extra,
});

const assignment = (id: string, rowId: string, dateISO: string, clinicianId = "c1"): Assignment => ({
  id,
  rowId,
  dateISO,
  clinicianId,
});

function source(overrides: Partial<ShiftCalendarSource> = {}): ShiftCalendarSource {
  const rows: ScheduleRow[] = [
    row("day", { startTime: "08:00", endTime: "16:30" }),
    row("night", { startTime: "20:00", endTime: "08:00", endDayOffset: 1 }),
    row("late", { startTime: "16:00", endTime: "00:00", endDayOffset: 1, slotLabel: "bis 24 Uhr" }),
    row("weekend", { startTime: "18:00", endTime: "18:00", endDayOffset: 2 }),
    row("untimed", { endDayOffset: 2 }),
    { id: "pool-rest-day", kind: "pool", name: "Rest Day", dotColorClass: "" },
  ];
  return {
    assignments: [],
    rowById: new Map(rows.map((item) => [item.id, item])),
    clinicians: [clinician("c1", "Dr. Alice"), clinician("c2", "Müller, Jörg; Dr.")],
    publishedWeekStartISOs: ["2026-03-23", "2026-10-19", "2026-11-02"],
    holidayCountry: "DE",
    ...overrides,
  };
}

const calendar = (overrides: Partial<ShiftCalendarSource>, options = {}) => {
  const file = buildShiftCalendar(source(overrides), { now, ...options });
  if (!file) throw new Error("no calendar");
  return file;
};

describe("foldLine", () => {
  it("keeps lines of up to 75 octets", () => {
    expect(foldLine("X".repeat(75))).toBe("X".repeat(75));
    expect(foldLine("X".repeat(73) + "ü")).toBe("X".repeat(73) + "ü");
  });

  it("folds at 75 octets with a space on each continuation line", () => {
    expect(foldLine("X".repeat(76))).toBe(`${"X".repeat(75)}\r\n X`);
    expect(foldLine("X".repeat(74) + "ü")).toBe(`${"X".repeat(74)}\r\n ü`);
  });

  it.each([
    ["umlauts", "SUMMARY:" + "Müller-Lüdenscheidt ".repeat(8)],
    ["CJK", "SUMMARY:" + "李小龍".repeat(30)],
    ["emoji", "SUMMARY:" + "🩺 Ärztin ".repeat(12)],
  ])("never splits a multi-byte character (%s)", (_, line) => {
    const folded = foldLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const [index, part] of physical.entries()) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
      expect(part).not.toContain("�");
    }
    expect(folded.replaceAll("\r\n ", "")).toBe(line);
  });
});

describe("buildICalendar", () => {
  it("writes the feed's calendar header", () => {
    const ics = buildICalendar({ calendarName: "Shift Planner – All people", timeZone: "Europe/Berlin", events: [], now });
    expect(ics).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//ShiftSchedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Shift Planner – All people",
        "X-WR-TIMEZONE:Europe/Berlin",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("escapes CRLF, CR, LF, backslash, comma and semicolon like the feed", () => {
    const ics = buildICalendar({
      calendarName: "李小龍\r\nZeile 2",
      timeZone: "Europe/Berlin",
      events: [{ uid: "a@x", dateISO: "2026-01-05", summary: "a\rb\nc\\d,e;f" }],
      now,
    });
    expect(ics).toContain("X-WR-CALNAME:李小龍\\nZeile 2\r\n");
    expect(ics).toContain("SUMMARY:a\\nb\\nc\\\\d\\,e\\;f\r\n");
    expect(ics.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it("folds every physical line to at most 75 octets", () => {
    const longName = "Anne-Sophie Lefèvre-Brückner von und zu Hohenzollern-Sigmaringen, PD Dr. med. habil.";
    const ics = buildICalendar({
      calendarName: longName,
      timeZone: "Europe/Berlin",
      events: [{ uid: "a@x", dateISO: "2026-01-05", summary: `Rufdienst, Wochenende; 24h - ${longName} 🩺` }],
      now,
    });
    for (const line of ics.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`X-WR-CALNAME:${longName.replaceAll(",", "\\,")}`);
  });

  it("sends a spring-gap shift without real duration without DTEND", () => {
    const ics = buildICalendar({
      calendarName: "T",
      timeZone: "Europe/Berlin",
      events: [{ uid: "g@x", dateISO: "2026-03-29", times: { startMin: 150, endMin: 210 }, summary: "Gap" }],
      now,
    });
    expect(times(ics)).toEqual(["DTSTART:20260329T013000Z"]);
  });
});

describe("names", () => {
  it("names calendars without the account", () => {
    expect(icalCalendarName()).toBe("Shift Planner – All people");
    expect(icalCalendarName({ id: "c1", name: "Müller, Jörg" })).toBe("Shift Planner – Müller, Jörg");
    expect(icalCalendarName({ id: "c1", name: "" })).toBe("Shift Planner – c1");
  });

  // Same cases as backend/tests/test_ical.py.
  it.each([
    ["Müller, Jörg; Dr.", "c1", "shift-planner-mueller-joerg-dr.ics"],
    ["Zoë Ångström", "c2", "shift-planner-zoe-angstroem.ics"],
    ["Björn Ødegård", "c2", "shift-planner-bjoern-oedegard.ics"],
    ["Zoë O'Brien-Łukasiewicz", "c2", "shift-planner-zoe-obrien-lukasiewicz.ics"],
    ["Anne-Sophie Lefèvre-Brückner", "c3", "shift-planner-anne-sophie-lefevre-brueckner.ics"],
    ["GROẞE Straße", "c4", "shift-planner-grosse-strasse.ics"],
    ["李小龍", "c5", "shift-planner-c5.ics"],
    ["Emoji 🩺 Ärztin", "c6", "shift-planner-emoji-aerztin.ics"],
    ["李小龍\r\nZeile 2", "c7", "shift-planner-zeile-2.ics"],
    ["  Ünal\tÖzdemir  ", "c8", "shift-planner-uenal-oezdemir.ics"],
    ["🩺", "李", "shift-planner-person.ics"],
  ])("transliterates %j to an ASCII file name", (name, id, expected) => {
    expect(icalFileName({ id, name })).toBe(expected);
  });

  it("names the all-people file", () => {
    expect(icalFileName()).toBe("shift-planner-all.ics");
  });
});

describe("buildShiftCalendar", () => {
  it("exports timed events with the feed's UID and summary", () => {
    const { fileName, ics } = calendar(
      { assignments: [assignment("a1", "day", "2026-11-02", "c2")] },
      { clinicianId: "c2" },
    );
    expect(fileName).toBe("shift-planner-mueller-joerg-dr.ics");
    expect(lines(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ShiftSchedule//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Shift Planner – Müller\\, Jörg\\; Dr.",
      "X-WR-TIMEZONE:Europe/Berlin",
      "BEGIN:VEVENT",
      "UID:a1@shiftschedule",
      "DTSTAMP:20261102T100000Z",
      "DTSTART:20261102T070000Z",
      "DTEND:20261102T153000Z",
      "SUMMARY:MRI - Müller\\, Jörg\\; Dr.",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
  });

  // Same instants as backend/tests/test_ical.py.
  it.each([
    ["16:00-24:00 ends at midnight", "late", "2026-11-02", ["DTSTART:20261102T150000Z", "DTEND:20261102T230000Z"]],
    ["night across the October change (13 h)", "night", "2026-10-24", ["DTSTART:20261024T180000Z", "DTEND:20261025T070000Z"]],
    ["night across the March change (11 h)", "night", "2026-03-28", ["DTSTART:20260328T190000Z", "DTEND:20260329T060000Z"]],
    ["Fri 18:00 to Sun 18:00", "weekend", "2026-10-23", ["DTSTART:20261023T160000Z", "DTEND:20261025T170000Z"]],
    ["no times: all-day on its day only", "untimed", "2026-11-02", ["DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103"]],
  ])("%s", (_, rowId, dateISO, expected) => {
    expect(times(calendar({ assignments: [assignment("a", rowId, dateISO)] }).ics)).toEqual(expected);
  });

  it("uses the holiday country's zone", () => {
    const { ics } = calendar({ assignments: [assignment("a", "night", "2026-03-28")], holidayCountry: "GB" });
    expect(ics).toContain("X-WR-TIMEZONE:Europe/London\r\n");
    expect(times(ics)).toEqual(["DTSTART:20260328T200000Z", "DTEND:20260329T070000Z"]);
  });

  it("exports published weeks only unless unpublished weeks are included", () => {
    const assignments = [assignment("pub", "day", "2026-11-08"), assignment("draft", "day", "2026-11-09")];
    const uids = (ics: string) => lines(ics).filter((line) => line.startsWith("UID:"));
    expect(uids(calendar({ assignments }).ics)).toEqual(["UID:pub@shiftschedule"]);
    expect(uids(calendar({ assignments }, { includeUnpublished: true }).ics)).toEqual([
      "UID:pub@shiftschedule",
      "UID:draft@shiftschedule",
    ]);
  });

  it("counts the events and the shifts left out only because their week is not published", () => {
    const assignments = [assignment("pub", "day", "2026-11-08"), assignment("draft", "day", "2026-11-09")];
    expect(calendar({ assignments })).toMatchObject({ eventCount: 1, unpublishedSkipped: 1 });
    expect(calendar({ assignments }, { startISO: "2026-11-09" })).toMatchObject({
      eventCount: 0,
      unpublishedSkipped: 1,
    });
    expect(calendar({ assignments }, { startISO: "2026-11-09", includeUnpublished: true })).toMatchObject({
      eventCount: 1,
      unpublishedSkipped: 0,
    });
  });

  it("leaves out pool rows, vacation days, other people and dates outside the range", () => {
    const { ics } = calendar(
      {
        assignments: [
          assignment("keep", "day", "2026-11-03"),
          assignment("pool", "pool-rest-day", "2026-11-03"),
          assignment("vacation", "day", "2026-11-04"),
          assignment("other", "day", "2026-11-03", "c2"),
          assignment("early", "day", "2026-11-02"),
          assignment("ghost", "day", "2026-11-03", "gone"),
        ],
        clinicians: [
          clinician("c1", "Dr. Alice", { vacations: [{ id: "v", startISO: "2026-11-04", endISO: "2026-11-04" }] }),
          clinician("c2", "Dr. Bob"),
        ],
      },
      { clinicianId: "c1", startISO: "2026-11-03", endISO: "2026-11-08" },
    );
    expect(lines(ics).filter((line) => line.startsWith("UID:"))).toEqual(["UID:keep@shiftschedule"]);
  });

  it("orders events by day, start time and UID like the feed", () => {
    const { ics } = calendar({
      assignments: [
        assignment("b-night", "night", "2026-11-02"),
        assignment("next-day", "day", "2026-11-03"),
        assignment("a-day", "day", "2026-11-02"),
        assignment("all-day", "untimed", "2026-11-02"),
      ],
    });
    expect(lines(ics).filter((line) => line.startsWith("UID:"))).toEqual([
      "UID:all-day@shiftschedule",
      "UID:a-day@shiftschedule",
      "UID:b-night@shiftschedule",
      "UID:next-day@shiftschedule",
    ]);
  });

  it("names the all-people file and returns null for an unknown person", () => {
    expect(calendar({}).fileName).toBe("shift-planner-all.ics");
    expect(lines(calendar({}).ics)).toContain("X-WR-CALNAME:Shift Planner – All people");
    expect(buildShiftCalendar(source(), { clinicianId: "gone" })).toBeNull();
  });
});
