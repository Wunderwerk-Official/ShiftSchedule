import { describe, expect, it } from "vitest";
import { elapsedMinutes, planTimeZone, wallClockToUtc } from "./planTimeZone";

const utc = (dateISO: string, minutes: number, zone: string) =>
  new Date(wallClockToUtc(dateISO, minutes, zone)).toISOString();

const hm = (h: number, m = 0) => h * 60 + m;

describe("planTimeZone", () => {
  it("maps the holiday country to its zone", () => {
    expect(planTimeZone("DE")).toBe("Europe/Berlin");
    expect(planTimeZone("fr")).toBe("Europe/Paris");
    expect(planTimeZone(" gb ")).toBe("Europe/London");
    expect(planTimeZone("RU")).toBe("Europe/Moscow");
    expect(["Europe/Kyiv", "Europe/Kiev"]).toContain(planTimeZone("UA"));
  });

  it("falls back to Europe/Berlin", () => {
    expect(planTimeZone(undefined)).toBe("Europe/Berlin");
    expect(planTimeZone("")).toBe("Europe/Berlin");
    expect(planTimeZone("XX")).toBe("Europe/Berlin");
  });
});

// Expected values match Python's zoneinfo (backend/tests/test_ical.py).
describe("wallClockToUtc", () => {
  it("converts ordinary winter and summer times", () => {
    expect(utc("2026-01-05", hm(8), "Europe/Berlin")).toBe("2026-01-05T07:00:00.000Z");
    expect(utc("2026-07-06", hm(8), "Europe/Berlin")).toBe("2026-07-06T06:00:00.000Z");
    expect(utc("2026-07-06", hm(8), "Europe/London")).toBe("2026-07-06T07:00:00.000Z");
    expect(utc("2026-07-06", hm(8), "Europe/Moscow")).toBe("2026-07-06T05:00:00.000Z");
  });

  it("rolls minutes past midnight into later days", () => {
    expect(utc("2026-11-02", hm(24), "Europe/Berlin")).toBe("2026-11-02T23:00:00.000Z");
    expect(utc("2026-10-23", hm(18) + 2 * 1440, "Europe/Berlin")).toBe("2026-10-25T17:00:00.000Z");
  });

  it("reads a time in the spring gap with the offset before the change (fold=0)", () => {
    // 02:30 does not exist on 2026-03-29 in Berlin (and 01:30 in London).
    expect(utc("2026-03-29", hm(2, 30), "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z");
    expect(utc("2026-03-29", hm(3, 30), "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z");
    expect(utc("2026-03-29", hm(1, 30), "Europe/London")).toBe("2026-03-29T01:30:00.000Z");
  });

  it("reads a time that exists twice in autumn as its first occurrence (fold=0)", () => {
    expect(utc("2026-10-25", hm(2, 30), "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
    expect(utc("2026-10-25", hm(1, 30), "Europe/London")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("follows offset changes that are not DST (Moscow, 26 Oct 2014: +4 → +3)", () => {
    expect(utc("2014-10-25", hm(20), "Europe/Moscow")).toBe("2014-10-25T16:00:00.000Z");
    expect(utc("2014-10-26", hm(8), "Europe/Moscow")).toBe("2014-10-26T05:00:00.000Z");
  });
});

describe("elapsedMinutes", () => {
  const night = (dateISO: string, zone: string) => elapsedMinutes(dateISO, hm(20), hm(8) + 1440, zone) / 60;

  it("gives a night across a DST change its real length", () => {
    expect(night("2026-10-24", "Europe/Berlin")).toBe(13);
    expect(night("2026-03-28", "Europe/Berlin")).toBe(11);
    expect(night("2026-10-24", "Europe/London")).toBe(13);
    expect(night("2026-03-28", "Europe/London")).toBe(11);
    expect(night("2026-11-02", "Europe/Berlin")).toBe(12);
  });

  it("keeps 12 hours in Moscow, which has no DST", () => {
    expect(night("2026-10-24", "Europe/Moscow")).toBe(12);
    expect(night("2026-03-28", "Europe/Moscow")).toBe(12);
  });

  it("counts 16:00 → 08:00 as 17 h and 15 h on the change nights", () => {
    expect(elapsedMinutes("2026-10-24", hm(16), hm(8) + 1440, "Europe/Berlin") / 60).toBe(17);
    expect(elapsedMinutes("2026-03-28", hm(16), hm(8) + 1440, "Europe/Berlin") / 60).toBe(15);
  });

  it("gives a shift inside the spring gap no duration", () => {
    expect(elapsedMinutes("2026-03-29", hm(2, 30), hm(3, 30), "Europe/Berlin")).toBe(0);
  });
});
