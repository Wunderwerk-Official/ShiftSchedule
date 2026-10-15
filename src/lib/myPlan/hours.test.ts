import { describe, expect, it } from "vitest";
import { countAbsenceDays, getSlotDurationMinutes, sumHours } from "./hours";
import { buildPersonPlan } from "./timeline";
import { makeSource } from "./testFixtures";

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
