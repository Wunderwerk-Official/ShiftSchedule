import { describe, expect, it } from "vitest";
import { addDaysISO, dayDiff, isoWeekNumber, listDaysISO, localDateTime, parseISODate, weekStartISO } from "./dates";
import {
  formatCountdown,
  formatDayLabel,
  formatDuration,
  formatHours,
  formatPeriodLabel,
  formatSegmentHint,
  formatShiftTimeRange,
  formatShiftWhen,
  formatTime,
  formatWeekdayTime,
} from "./format";
import { buildPersonPlan } from "./timeline";
import { makeSource } from "./testFixtures";

describe("local date helpers", () => {
  it("computes ISO week numbers around year boundaries", () => {
    expect(isoWeekNumber(new Date(2026, 9, 14))).toBe(42);
    expect(isoWeekNumber(new Date(2026, 11, 28))).toBe(53); // 2026 has 53 weeks
    expect(isoWeekNumber(new Date(2027, 0, 3))).toBe(53); // Sunday still in week 53
    expect(isoWeekNumber(new Date(2027, 0, 4))).toBe(1);
    expect(isoWeekNumber(new Date(2024, 11, 30))).toBe(1); // Monday of week 1/2025
    expect(isoWeekNumber(new Date(2021, 0, 3))).toBe(53); // Sunday of week 53/2020
  });

  it("steps calendar days across the October DST switch without drifting", () => {
    // 2026-10-25 is a 25-hour day in Europe; calendar math must not care.
    expect(listDaysISO("2026-10-24", "2026-10-27")).toEqual([
      "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27",
    ]);
    expect(addDaysISO("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDaysISO("2026-03-29", -1)).toBe("2026-03-28");
    expect(dayDiff("2026-10-24", "2026-10-26")).toBe(2);
    expect(dayDiff("2026-12-31", "2027-01-01")).toBe(1);
    expect(weekStartISO("2026-11-01")).toBe("2026-10-26");
    expect(parseISODate("2026-10-25").getDate()).toBe(25);
    const end = localDateTime("2026-10-24", 1920); // night 17:00 → Sun 08:00
    expect([end.getDate(), end.getHours(), end.getMinutes()]).toEqual([25, 8, 0]);
  });
});

describe("formatting", () => {
  it("formats times, hours and durations", () => {
    expect(formatTime(450)).toBe("07:30");
    expect(formatTime(1920)).toBe("08:00");
    expect(formatTime(1440)).toBe("00:00");
    expect(formatHours(53)).toBe("53.0 h");
    expect(formatHours(8.5)).toBe("8.5 h");
    expect(formatDuration(148)).toBe("2 h 28 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(1500)).toBe("1 d 1 h");
    expect(formatCountdown(148)).toBe("in 2 h 28 min");
    expect(formatCountdown(0)).toBe("now");
  });

  it("formats day labels and period labels", () => {
    expect(formatDayLabel("2026-10-15")).toBe("Thu 15 Oct");
    expect(formatWeekdayTime("2026-10-14", 1920)).toBe("Thu 08:00");
    const anchor = new Date(2026, 9, 14);
    expect(formatPeriodLabel("day", anchor)).toBe("Wed, 14 Oct 2026");
    expect(formatPeriodLabel("week", anchor)).toBe("Week 42 · 12–18 Oct 2026");
    expect(formatPeriodLabel("month", anchor)).toBe("October 2026");
    expect(formatPeriodLabel("week", new Date(2026, 9, 28))).toBe("Week 44 · 26 Oct – 1 Nov 2026");
    expect(formatPeriodLabel("week", new Date(2027, 0, 1))).toBe(
      "Week 53 · 28 Dec 2026 – 3 Jan 2027",
    );
  });

  it("captions both halves of a split night and the detail line", () => {
    const plan = buildPersonPlan({
      ...makeSource(),
      clinicianId: "lh",
      fromISO: "2026-10-12",
      toISO: "2026-10-18",
      todayISO: "2026-10-14",
    });
    const [part1] = plan.days[2].segments;
    const [part2] = plan.days[3].segments;
    const night = plan.shifts.get(part1.shiftId)!;
    expect(formatSegmentHint(part1, night)).toBe("→ until Thu 08:00");
    expect(formatSegmentHint(part1, night, "vertical")).toBe("↓ Thu until 08:00");
    expect(formatSegmentHint(part2, night)).toBe("↳ Nachtdienst · until 08:00");
    expect(formatShiftTimeRange(night)).toBe("17:00 → Thu 08:00");
    expect(formatShiftWhen(night)).toBe("Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h");
    const mrt = plan.shifts.get(plan.days[0].segments[1].shiftId)!;
    expect(formatSegmentHint(plan.days[0].segments[1], mrt)).toBeNull();
    expect(formatShiftWhen(mrt)).toBe("Mon 12 Oct, 08:00–16:30 · 8.5 h");
  });
});
