import { describe, expect, it } from "vitest";
import { countAbsenceDays, getShiftMinutes, getSlotDurationMinutes, sumHours } from "./hours";
import { buildPersonPlan } from "./timeline";
import { assign, makeSource } from "./testFixtures";

describe("getSlotDurationMinutes (WorkingHoursOverviewModal rule)", () => {
  it("returns the gross duration including endDayOffset", () => {
    expect(getSlotDurationMinutes({ startTime: "08:00", endTime: "16:30" })).toBe(510);
    expect(getSlotDurationMinutes({ startTime: "17:00", endTime: "08:00", endDayOffset: 1 })).toBe(900);
    expect(getSlotDurationMinutes({ startTime: "08:00", endTime: "08:00", endDayOffset: 1 })).toBe(1440);
  });

  it("falls back to 8 h without times and to 0 when end ≤ start", () => {
    expect(getSlotDurationMinutes({})).toBe(480);
    expect(getSlotDurationMinutes({ startTime: "08:00" })).toBe(480);
    expect(getSlotDurationMinutes({ startTime: "17:00", endTime: "08:00" })).toBe(0);
  });
});

describe("sumHours / countAbsenceDays", () => {
  const plan = buildPersonPlan({
    ...makeSource(),
    clinicianId: "lh",
    fromISO: "2026-09-28",
    toISO: "2026-11-01",
    todayISO: "2026-10-14",
  });

  it("sums whole ISO weeks on the start day (SPEC D3/D5)", () => {
    expect(sumHours(plan, "2026-10-12", "2026-10-18")).toBe(53);
    // Week 41: only the night (15 h, counted on Thu 8 Oct) — its Friday
    // continuation adds nothing.
    expect(sumHours(plan, "2026-10-05", "2026-10-11")).toBe(15);
    expect(sumHours(plan, "2026-10-09", "2026-10-09")).toBe(0);
    // Week 44 draft: MRT 8.5 + Konv 8.5 + Zusatzdienst 5.
    expect(sumHours(plan, "2026-10-26", "2026-11-01")).toBe(22);
  });

  it("counts vacation days instead of hours (\"Vacation · 5 days\")", () => {
    expect(sumHours(plan, "2026-10-19", "2026-10-25")).toBe(0);
    expect(countAbsenceDays(plan, "vacation", "2026-10-19", "2026-10-25")).toBe(5);
    expect(countAbsenceDays(plan, "rest", "2026-10-12", "2026-10-18")).toBe(1);
  });
});

describe("real hours across DST changes (plan zone Europe/Berlin)", () => {
  const planWith = (dates: string[], overrides = {}) =>
    buildPersonPlan({
      ...makeSource({ assignments: dates.map((dateISO) => assign("lh", "nacht", dateISO)), ...overrides }),
      clinicianId: "lh",
      fromISO: dates[0],
      toISO: dates[dates.length - 1],
      todayISO: dates[0],
    });
  const night = (dateISO: string, overrides = {}) => [...planWith([dateISO], overrides).shifts.values()][0];

  it("a 17:00–08:00 night lasts 16 h when the clocks go back and 14 h when they go forward", () => {
    expect(night("2026-10-24")).toMatchObject({ startMin: 1020, endMin: 1920, hours: 16 });
    expect(night("2026-03-28")).toMatchObject({ startMin: 1020, endMin: 1920, hours: 14 });
    expect(night("2026-10-17").hours).toBe(15);
  });

  it("day and week sums count the real hours", () => {
    const plan = planWith(["2026-10-24", "2026-10-25"]);
    expect(plan.days.map((day) => day.hours)).toEqual([16, 15]);
    expect(sumHours(plan, "2026-10-19", "2026-10-25")).toBe(31);
  });

  it("follows the plan's zone (no DST in Moscow)", () => {
    expect(night("2026-10-24", { timeZone: "Europe/Moscow" }).hours).toBe(15);
  });

  it("getShiftMinutes (working hours overview) uses the same rule", () => {
    const duty = { startTime: "16:00", endTime: "08:00", endDayOffset: 1 };
    expect(getShiftMinutes(duty, "2026-10-24", "Europe/Berlin")).toBe(17 * 60);
    expect(getShiftMinutes(duty, "2026-03-28", "Europe/Berlin")).toBe(15 * 60);
    expect(getShiftMinutes(duty, "2026-11-07", "Europe/Berlin")).toBe(16 * 60);
    // Without times: 8 h from 08:00; end ≤ start: 0.
    expect(getShiftMinutes({}, "2026-10-25", "Europe/Berlin")).toBe(480);
    expect(getShiftMinutes({ startTime: "17:00", endTime: "08:00" }, "2026-10-24", "Europe/Berlin")).toBe(0);
  });
});
