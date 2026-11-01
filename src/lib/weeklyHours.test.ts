import { describe, expect, it } from "vitest";
import {
  buildGateMinutesByRowId,
  buildWeeklyMinutesIndex,
  checkWeeklyHours,
  formatWeeklyHours,
  gateSlotMinutes,
  isoWeekKey,
  weeklyCapMinutes,
} from "./weeklyHours";
import type { ScheduleRow } from "./shiftRows";

describe("isoWeekKey", () => {
  it.each([
    ["2026-11-02", "2026-W45"], // Monday
    ["2026-11-05", "2026-W45"],
    ["2026-11-08", "2026-W45"], // Sunday ends the week
    ["2026-11-09", "2026-W46"],
    ["2026-01-01", "2026-W01"], // a Thursday: week 1 of its own year
    ["2027-01-01", "2026-W53"], // a Friday: still the old year's last week
    ["2024-12-30", "2025-W01"], // a Monday: already the next year's week 1
  ])("%s is %s (same as Python's isocalendar)", (dateISO, expected) => {
    expect(isoWeekKey(dateISO)).toBe(expected);
  });

  it("rejects malformed dates", () => {
    expect(isoWeekKey("2026-02-30")).toBeNull();
    expect(isoWeekKey("5.11.2026")).toBeNull();
  });
});

describe("weekly hours like the planner's gate", () => {
  // 08:00-17:10, the night duty 20:00-08:00 (+1 day), a slot without a valid time.
  const minutes: Record<string, number | null> = { day: 550, night: 720, broken: null };
  const index = buildWeeklyMinutesIndex(
    [
      { rowId: "day", dateISO: "2026-11-02", clinicianId: "a" },
      { rowId: "day", dateISO: "2026-11-03", clinicianId: "a" },
      { rowId: "day", dateISO: "2026-11-04", clinicianId: "a" },
      // Sunday night belongs to W45 (counted on its start date) …
      { rowId: "night", dateISO: "2026-11-08", clinicianId: "b" },
      // … and pool rows and slots without a time never count.
      { rowId: "pool-rest-day", dateISO: "2026-11-05", clinicianId: "a" },
      { rowId: "broken", dateISO: "2026-11-05", clinicianId: "a" },
      { rowId: "day", dateISO: "2026-11-09", clinicianId: "a" }, // next week
    ],
    (rowId) => minutes[rowId] ?? null,
  );

  it("counts each ISO week on the start date", () => {
    expect(index.get("a|2026-W45")).toBe(3 * 550);
    expect(index.get("a|2026-W46")).toBe(550);
    expect(index.get("b|2026-W45")).toBe(720);
  });

  it("caps at contract + tolerance (5 h when unset, an explicit 0 stays 0)", () => {
    expect(weeklyCapMinutes({ id: "a", workingHoursPerWeek: 32 })).toBe(37 * 60);
    expect(weeklyCapMinutes({ id: "a", workingHoursPerWeek: 32, workingHoursToleranceHours: 0 })).toBe(32 * 60);
    expect(weeklyCapMinutes({ id: "a", workingHoursPerWeek: 32, workingHoursToleranceHours: -3 })).toBe(32 * 60);
    expect(weeklyCapMinutes({ id: "a" })).toBeNull();
    expect(weeklyCapMinutes({ id: "a", workingHoursPerWeek: 0 })).toBeNull();
  });

  it("flags only a week that would end above the cap", () => {
    // 27.5 h booked, cap 32 + 8 = 40 h.
    const laurain = { id: "a", workingHoursPerWeek: 32, workingHoursToleranceHours: 8 };
    const fits = checkWeeklyHours(index, laurain, "2026-11-06", 600)!; // 37.5 h
    expect(fits.over).toBe(false);
    const exactly = checkWeeklyHours(index, laurain, "2026-11-06", 750)!; // 40 h
    expect(exactly.over).toBe(false);
    const over = checkWeeklyHours(index, laurain, "2026-11-06", 840)!; // 41.5 h
    expect(over).toMatchObject({ weekKey: "2026-W45", assignedMinutes: 1650, afterMinutes: 2490, over: true });
    expect(formatWeeklyHours(over)).toBe("41.5/40 h");
    expect(checkWeeklyHours(index, { id: "a" }, "2026-11-06", 840)).toBeNull();
  });
});

describe("slot minutes as the gate counts them (validation._slot_interval)", () => {
  it.each([
    [{ startTime: "07:30", endTime: "11:30" }, 240],
    [{ startTime: "20:00", endTime: "08:00", endDayOffset: 1 }, 720],
    // A slot saved without times is 08:00-16:00 for every planner.
    [{}, 480],
    [{ startTime: "06:00" }, 480], // end = start + 8 h
    [{ endTime: "12:00" }, 240], // start = 08:00
    [{ endTime: "07:00" }, 0], // 08:00-07:00 ends before it starts
    [{ startTime: "20:00", endTime: "08:00" }, 0], // overnight without "+1 day"
    [{ startTime: "08:00", endTime: "09:00", endDayOffset: 9 }, 60 + 3 * 1440], // offset clamped to 3
  ])("%o counts %i minutes", (slot, minutes) => {
    expect(gateSlotMinutes(slot)).toBe(minutes);
  });

  it("maps class rows and their slot rows, never pool rows", () => {
    const rows: ScheduleRow[] = [
      { id: "pool-rest-day", kind: "pool", name: "Rest", dotColorClass: "" },
      { id: "sec", kind: "class", name: "Sec", dotColorClass: "", startTime: "07:30", endTime: "11:30",
        slotRows: [{ id: "slot-a", kind: "class", name: "A", dotColorClass: "" }] },
    ];
    expect([...buildGateMinutesByRowId(rows)]).toEqual([["sec", 240], ["slot-a", 480]]);
  });

  it("a person over the cap through a slot without times is over in the picker too", () => {
    const minutes = buildGateMinutesByRowId([
      { id: "day", kind: "class", name: "Day", dotColorClass: "", startTime: "08:00", endTime: "16:00" },
      { id: "untimed", kind: "class", name: "Untimed", dotColorClass: "" },
    ]);
    const index = buildWeeklyMinutesIndex(
      ["2026-11-02", "2026-11-03", "2026-11-04"].map((dateISO) => ({ rowId: "day", dateISO, clinicianId: "anna" }))
        .concat([{ rowId: "untimed", dateISO: "2026-11-05", clinicianId: "anna" }]),
      (rowId) => minutes.get(rowId) ?? null,
    );
    const anna = { id: "anna", workingHoursPerWeek: 32, workingHoursToleranceHours: 0 };
    // 4 x 8 h booked; a 4 h Friday slot ends at 36/32 h like the backend says.
    expect(checkWeeklyHours(index, anna, "2026-11-06", 240)).toMatchObject({ assignedMinutes: 1920, over: true });
  });
});
