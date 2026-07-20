import { describe, expect, it } from "vitest";
import { listWeekStartsOverlappingMonth, toISODate } from "./date";

describe("listWeekStartsOverlappingMonth", () => {
  it("lists five Monday starts for July 2026, beginning in June", () => {
    const weeks = listWeekStartsOverlappingMonth(new Date(2026, 6, 15));
    expect(weeks.map(toISODate)).toEqual([
      "2026-06-29",
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
    ]);
  });

  it("lists six weeks for a month spanning six ISO weeks", () => {
    // August 2026 starts on a Saturday and ends on a Monday-week tail:
    // weeks of Jul 27, Aug 3, 10, 17, 24, 31.
    const weeks = listWeekStartsOverlappingMonth(new Date(2026, 7, 1));
    expect(weeks.map(toISODate)).toEqual([
      "2026-07-27",
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ]);
  });

  it("lists four weeks for a 28-day month starting on a Monday", () => {
    // February 2027 starts on Monday 2027-02-01.
    const weeks = listWeekStartsOverlappingMonth(new Date(2027, 1, 10));
    expect(weeks.map(toISODate)).toEqual([
      "2027-02-01",
      "2027-02-08",
      "2027-02-15",
      "2027-02-22",
    ]);
  });
});
