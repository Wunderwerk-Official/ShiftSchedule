import { describe, expect, it } from "vitest";
import type { Assignment } from "../api/client";
import { formatHolidayChangeDate, holidayChangeConfirmation } from "./holidayChange";

let nextId = 0;
const shift = (dateISO: string, extra: Partial<Assignment> = {}): Assignment => ({
  id: `a${(nextId += 1)}`,
  rowId: "slot-1",
  dateISO,
  clinicianId: "c1",
  source: "solver",
  ...extra,
});
const times = (count: number, make: () => Assignment) => Array.from({ length: count }, make);

describe("holidayChangeConfirmation", () => {
  it("names the number of shifts, the locked ones and the day", () => {
    const dropped = [
      ...times(10, () => shift("2026-12-24")),
      shift("2026-12-24", { locked: true }),
      // Placed by hand: shown locked too (isProtectedAssignment).
      shift("2026-12-24", { source: "manual" }),
    ];
    expect(holidayChangeConfirmation(dropped)).toEqual({
      title: "Remove 12 shifts?",
      message:
        "12 shifts, 2 of them locked, no longer fit their day's plan and will be removed: " +
        "Thu 24.12.2026 (12 shifts). A holiday uses the template's Holiday column, every other " +
        "day the columns of its weekday. An automatic backup of the calendar is saved in " +
        "Calendar snapshots first.",
      confirmLabel: "Remove 12 shifts",
    });
  });

  it("lists at most five days in date order, then how many more", () => {
    const dates = ["2026-11-18", "2026-01-06", "2026-03-08", "2026-04-05", "2026-05-24", "2026-08-15", "2026-10-31"];
    const { message } = holidayChangeConfirmation([...dates.map((date) => shift(date)), shift("2026-01-06")]);
    expect(message).toContain(
      "removed: Tue 06.01.2026 (2 shifts), Sun 08.03.2026 (1 shift), Sun 05.04.2026 (1 shift), " +
        "Sun 24.05.2026 (1 shift), Sat 15.08.2026 (1 shift), +2 more days.",
    );
    expect(holidayChangeConfirmation([...dates.slice(0, 6).map((date) => shift(date))]).message).toContain(
      ", +1 more day.",
    );
  });

  it("speaks of one shift, and of locked shifts when all of them are", () => {
    expect(holidayChangeConfirmation([shift("2026-11-01")])).toMatchObject({
      title: "Remove 1 shift?",
      confirmLabel: "Remove 1 shift",
    });
    expect(holidayChangeConfirmation([shift("2026-11-01")]).message).toMatch(
      /^1 shift no longer fits its day's plan and will be removed: Sun 01\.11\.2026 \(1 shift\)\./,
    );
    expect(holidayChangeConfirmation([shift("2026-11-01", { locked: true })]).message).toMatch(
      /^1 locked shift no longer fits its day's plan/,
    );
    expect(
      holidayChangeConfirmation([shift("2026-11-01", { locked: true }), shift("2026-11-01", { source: "manual" })])
        .message,
    ).toMatch(/^2 locked shifts no longer fit their day's plan/);
  });
});

describe("formatHolidayChangeDate", () => {
  it("shows the weekday and the date as DD.MM.YYYY", () => {
    expect(formatHolidayChangeDate("2026-12-24")).toBe("Thu 24.12.2026");
    expect(formatHolidayChangeDate("2028-02-29")).toBe("Tue 29.02.2028");
  });
});
