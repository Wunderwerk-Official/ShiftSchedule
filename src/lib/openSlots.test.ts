import { describe, expect, it } from "vitest";
import { computeOpenSlots, isWeekendOrHoliday } from "./openSlots";
import type { ScheduleRow } from "./shiftRows";

const row = (id: string, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id,
  kind: "class",
  name: id,
  dotColorClass: "bg-slate-200",
  ...extra,
});

// Mon 5 Jan 2026 .. Sun 11 Jan 2026
const MON = "2026-01-05";
const TUE = "2026-01-06";
const SAT = "2026-01-10";

const compute = (args: Partial<Parameters<typeof computeOpenSlots>[0]> = {}) => {
  const rows = args.rowById ?? new Map<string, ScheduleRow>();
  return computeOpenSlots({
    dateISOs: [MON, TUE],
    rowIds: [...rows.keys()],
    rowById: rows,
    cells: new Map(),
    minSlotsByRowId: {},
    slotOverridesByKey: {},
    holidayDates: new Set(),
    ...args,
  });
};

describe("isWeekendOrHoliday", () => {
  it("is true on Saturday, Sunday and holidays only", () => {
    expect(isWeekendOrHoliday(SAT, new Set())).toBe(true);
    expect(isWeekendOrHoliday("2026-01-11", new Set())).toBe(true);
    expect(isWeekendOrHoliday(MON, new Set())).toBe(false);
    expect(isWeekendOrHoliday(MON, new Set([MON]))).toBe(true);
  });
});

describe("computeOpenSlots", () => {
  it("uses the template's requiredSlots and subtracts the rendered cell", () => {
    const rows = new Map([["a", row("a", { requiredSlots: 2 })]]);
    const result = compute({
      rowById: rows,
      cells: new Map([[`a__${MON}`, [{}]]]),
    });
    // Mon misses 1, Tue misses 2.
    expect(result.count).toBe(3);
    expect(result.targets).toEqual([
      { rowId: "a", dateISO: MON },
      { rowId: "a", dateISO: TUE },
    ]);
  });

  it("falls back to the weekday / weekend minimum (holidays count as weekend)", () => {
    const rows = new Map([["a", row("a")]]);
    const minSlotsByRowId = { a: { weekday: 1, weekend: 3 } };
    expect(compute({ rowById: rows, minSlotsByRowId, dateISOs: [MON] }).count).toBe(1);
    expect(compute({ rowById: rows, minSlotsByRowId, dateISOs: [SAT] }).count).toBe(3);
    expect(
      compute({ rowById: rows, minSlotsByRowId, dateISOs: [MON], holidayDates: new Set([MON]) })
        .count,
    ).toBe(3);
    // No minimum stored for the row: nothing required.
    expect(compute({ rowById: rows, dateISOs: [MON] }).count).toBe(0);
  });

  it("applies positive and negative overrides, never below zero", () => {
    const rows = new Map([["a", row("a", { requiredSlots: 1 })]]);
    expect(
      compute({ rowById: rows, dateISOs: [MON], slotOverridesByKey: { [`a__${MON}`]: 2 } }).count,
    ).toBe(3);
    const negative = compute({
      rowById: rows,
      dateISOs: [MON],
      slotOverridesByKey: { [`a__${MON}`]: -5 },
    });
    expect(negative).toEqual({ count: 0, targets: [] });
  });

  it("skips rows of another day type, pool rows and unknown rows", () => {
    const rows = new Map<string, ScheduleRow>([
      ["mon-only", row("mon-only", { dayType: "mon", requiredSlots: 1 })],
      ["pool", row("pool", { kind: "pool", requiredSlots: 1 })],
    ]);
    const result = compute({ rowById: rows, rowIds: ["mon-only", "pool", "missing"] });
    expect(result.targets).toEqual([{ rowId: "mon-only", dateISO: MON }]);
    // A holiday turns Monday into day type "holiday": the Monday row is inactive.
    expect(compute({ rowById: rows, holidayDates: new Set([MON]) }).count).toBe(0);
  });

  it("orders targets day by day, rows in the given order within a day", () => {
    const rows = new Map([
      ["b", row("b", { requiredSlots: 1 })],
      ["a", row("a", { requiredSlots: 1 })],
    ]);
    const result = compute({ rowById: rows, rowIds: ["b", "a"] });
    expect(result.targets).toEqual([
      { rowId: "b", dateISO: MON },
      { rowId: "a", dateISO: MON },
      { rowId: "b", dateISO: TUE },
      { rowId: "a", dateISO: TUE },
    ]);
    expect(result.count).toBe(4);
  });
});
