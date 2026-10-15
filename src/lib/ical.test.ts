import { describe, expect, it } from "vitest";
import { buildICalendar } from "./ical";

const dtEnd = (ics: string) =>
  ics.split("\r\n").filter((line) => line.startsWith("DTEND;VALUE=DATE:"));

describe("buildICalendar", () => {
  it("ends a same-day shift on the next day (exclusive DTEND)", () => {
    const ics = buildICalendar({
      calendarName: "Test",
      events: [{ uid: "a@x", dateISO: "2026-10-12", summary: "MRT" }],
    });
    expect(dtEnd(ics)).toEqual(["DTEND;VALUE=DATE:20261013"]);
  });

  it("extends a shift crossing midnight into the next day, like the server feed", () => {
    const ics = buildICalendar({
      calendarName: "Test",
      events: [{ uid: "n@x", dateISO: "2026-10-14", endDayOffset: 1, summary: "Night duty" }],
    });
    expect(dtEnd(ics)).toEqual(["DTEND;VALUE=DATE:20261016"]);
  });

  it("crosses month boundaries", () => {
    const ics = buildICalendar({
      calendarName: "Test",
      events: [{ uid: "m@x", dateISO: "2026-10-31", endDayOffset: 1, summary: "Night duty" }],
    });
    expect(dtEnd(ics)).toEqual(["DTEND;VALUE=DATE:20261102"]);
  });
});
