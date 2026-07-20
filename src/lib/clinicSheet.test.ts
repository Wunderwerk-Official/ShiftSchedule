import { describe, expect, it } from "vitest";
import type { ScheduleRow } from "./shiftRows";
import {
  EXCEL_PINK,
  SHEET_DAY_COLUMNS,
  buildClinicSheetModel,
  buildMonthDays,
  buildSheetDays,
  resolveAreaWidths,
} from "./clinicSheet";

const makeSlotRow = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "slot-mri__mon",
  kind: "class",
  name: "MRI",
  dotColorClass: "bg-slate-400",
  sectionId: "section-mri",
  sectionName: "MRI",
  locationId: "loc-default",
  locationName: "Default",
  blockColor: "#FDE2E4",
  rowBandId: "band-1",
  rowBandLabel: "MRT 08:00–17:00",
  rowBandOrder: 1,
  colBandOrder: 1,
  dayType: "mon",
  startTime: "08:00",
  endTime: "17:00",
  requiredSlots: 4,
  ...overrides,
});

const makeGroupedRow = (slotRows: ScheduleRow[], overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  ...slotRows[0],
  id: `group-${slotRows[0].locationId}__${slotRows[0].rowBandId}`,
  slotRows,
  ...overrides,
});

describe("buildMonthDays", () => {
  it("produces every day of a 31-day month", () => {
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    expect(days).toHaveLength(31);
    expect(days[0].dateISO).toBe("2026-07-01");
    expect(days[30].dateISO).toBe("2026-07-31");
  });

  it("handles 30-day and 28-day months and leap years", () => {
    expect(buildMonthDays(new Date(2026, 3, 15), new Set())).toHaveLength(30);
    expect(buildMonthDays(new Date(2026, 1, 1), new Set())).toHaveLength(28);
    expect(buildMonthDays(new Date(2028, 1, 1), new Set())).toHaveLength(29);
  });

  it("marks weekends as cyan", () => {
    const days = buildMonthDays(new Date(2026, 6, 1), new Set());
    // 2026-07-04 is a Saturday, 2026-07-05 a Sunday.
    const saturday = days.find((d) => d.dateISO === "2026-07-04");
    const sunday = days.find((d) => d.dateISO === "2026-07-05");
    const wednesday = days.find((d) => d.dateISO === "2026-07-01");
    expect(saturday?.dayType).toBe("sat");
    expect(saturday?.isCyan).toBe(true);
    expect(sunday?.isCyan).toBe(true);
    expect(wednesday?.dayType).toBe("wed");
    expect(wednesday?.isCyan).toBe(false);
  });

  it("marks holidays as cyan with the holiday day type and name", () => {
    const days = buildMonthDays(
      new Date(2026, 9, 1),
      new Set(["2026-10-03"]),
      { "2026-10-03": "Tag der Deutschen Einheit" },
    );
    const holiday = days.find((d) => d.dateISO === "2026-10-03");
    expect(holiday?.dayType).toBe("holiday");
    expect(holiday?.isCyan).toBe(true);
    expect(holiday?.holidayName).toBe("Tag der Deutschen Einheit");
  });
});

describe("buildSheetDays", () => {
  it("builds a 7-day week spanning a month boundary", () => {
    // 2026-06-29 is the Monday of the week containing 2026-07-01.
    const days = buildSheetDays(new Date(2026, 5, 29), 7, new Set());
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.dateISO)).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(days[0].dayType).toBe("mon");
    expect(days[5].isCyan).toBe(true); // Saturday
    expect(days[6].isCyan).toBe(true); // Sunday
  });

  it("marks holidays with name and cyan tint", () => {
    const days = buildSheetDays(
      new Date(2026, 9, 1),
      7,
      new Set(["2026-10-03"]),
      { "2026-10-03": "Tag der Deutschen Einheit" },
    );
    const holiday = days.find((d) => d.dateISO === "2026-10-03");
    expect(holiday?.dayType).toBe("holiday");
    expect(holiday?.isCyan).toBe(true);
    expect(holiday?.holidayName).toBe("Tag der Deutschen Einheit");
  });

  it("is the primitive buildMonthDays delegates to", () => {
    const holidays = new Set(["2026-07-22"]);
    const names = { "2026-07-22": "Testfeiertag" };
    expect(buildMonthDays(new Date(2026, 6, 15), holidays, names)).toEqual(
      buildSheetDays(new Date(2026, 6, 1), 31, holidays, names),
    );
  });
});

describe("resolveAreaWidths", () => {
  it("gives a single area the whole day block", () => {
    expect(resolveAreaWidths(1)).toEqual([SHEET_DAY_COLUMNS]);
  });

  it("uses the Excel 4+2 split for two areas", () => {
    expect(resolveAreaWidths(2)).toEqual([4, 2]);
  });

  it("splits evenly beyond two areas, remainder to the left", () => {
    expect(resolveAreaWidths(3)).toEqual([2, 2, 2]);
    expect(resolveAreaWidths(4)).toEqual([2, 2, 1, 1]);
    expect(resolveAreaWidths(6)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("never exceeds six areas", () => {
    expect(resolveAreaWidths(9)).toHaveLength(6);
  });
});

describe("buildClinicSheetModel", () => {
  const days = buildMonthDays(new Date(2026, 6, 1), new Set());

  it("lays out one slot across all six columns", () => {
    const row = makeGroupedRow([makeSlotRow()]);
    const model = buildClinicSheetModel({ calendarRows: [row], days });
    // 2026-07-06 is a Monday.
    const areas = model.sections[0].rows[0].areasByDate.get("2026-07-06");
    expect(areas).toHaveLength(1);
    expect(areas?.[0]).toMatchObject({
      slotId: "slot-mri__mon",
      startCol: 1,
      colSpan: 6,
      requiredSlots: 4,
    });
  });

  it("lays out two colBands as the 4+2 Excel split, ordered by colBandOrder", () => {
    const assistant = makeSlotRow({ id: "slot-mri__mon", colBandOrder: 1, requiredSlots: 4 });
    const senior = makeSlotRow({
      id: "slot-mri-oa__mon",
      colBandOrder: 2,
      sectionId: "section-mri-oa",
      sectionName: "MRI OA",
      blockColor: EXCEL_PINK,
      requiredSlots: 2,
    });
    const row = makeGroupedRow([assistant, senior]);
    const model = buildClinicSheetModel({ calendarRows: [row], days });
    const areas = model.sections[0].rows[0].areasByDate.get("2026-07-06");
    expect(areas).toHaveLength(2);
    expect(areas?.[0]).toMatchObject({ slotId: "slot-mri__mon", startCol: 1, colSpan: 4 });
    expect(areas?.[1]).toMatchObject({
      slotId: "slot-mri-oa__mon",
      startCol: 5,
      colSpan: 2,
      blockColor: EXCEL_PINK,
    });
  });

  it("omits days whose dayType has no slots", () => {
    const row = makeGroupedRow([makeSlotRow()]); // mon only
    const model = buildClinicSheetModel({ calendarRows: [row], days });
    const areasByDate = model.sections[0].rows[0].areasByDate;
    expect(areasByDate.has("2026-07-06")).toBe(true); // Monday
    expect(areasByDate.has("2026-07-07")).toBe(false); // Tuesday
  });

  it("applies additive per-date slot overrides, clamped at zero", () => {
    const row = makeGroupedRow([makeSlotRow({ requiredSlots: 2 })]);
    const model = buildClinicSheetModel({
      calendarRows: [row],
      days,
      slotOverridesByKey: {
        "slot-mri__mon__2026-07-06": 1,
        "slot-mri__mon__2026-07-13": -5,
      },
    });
    const areasByDate = model.sections[0].rows[0].areasByDate;
    expect(areasByDate.get("2026-07-06")?.[0].requiredSlots).toBe(3);
    expect(areasByDate.get("2026-07-13")?.[0].requiredSlots).toBe(0);
    expect(areasByDate.get("2026-07-20")?.[0].requiredSlots).toBe(2);
  });

  it("keeps slot ids containing __ and :: intact", () => {
    const slotId = "class-x::s1__mon";
    const row = makeGroupedRow([makeSlotRow({ id: slotId })]);
    const model = buildClinicSheetModel({
      calendarRows: [row],
      days,
      slotOverridesByKey: { [`${slotId}__2026-07-06`]: 2 },
    });
    const areas = model.sections[0].rows[0].areasByDate.get("2026-07-06");
    expect(areas?.[0].slotId).toBe(slotId);
    expect(areas?.[0].requiredSlots).toBe(6);
  });

  it("groups consecutive rows by location into sections and extracts pools", () => {
    const rowA = makeGroupedRow([makeSlotRow()]);
    const rowB = makeGroupedRow([
      makeSlotRow({
        id: "slot-ct__mon",
        locationId: "loc-2",
        locationName: "CT-Bereich",
        rowBandId: "band-ct",
        rowBandLabel: "CT 08:00–17:00",
      }),
    ]);
    const pool: ScheduleRow = {
      id: "pool-vacation",
      kind: "pool",
      name: "Urlaub",
      dotColorClass: "bg-emerald-500",
    };
    const model = buildClinicSheetModel({ calendarRows: [rowA, rowB, pool], days });
    expect(model.sections).toHaveLength(2);
    expect(model.sections[0].locationId).toBe("loc-default");
    expect(model.sections[1].locationId).toBe("loc-2");
    expect(model.sections[1].rows[0].label).toBe("CT 08:00–17:00");
    expect(model.poolRows.map((row) => row.id)).toEqual(["pool-vacation"]);
  });

  it("falls back to Excel pink for the row label color", () => {
    const row = makeGroupedRow([makeSlotRow({ blockColor: undefined })]);
    const model = buildClinicSheetModel({ calendarRows: [row], days });
    expect(model.sections[0].rows[0].labelColor).toBe(EXCEL_PINK);
  });

  it("labels the month in German", () => {
    const model = buildClinicSheetModel({ calendarRows: [], days });
    expect(model.monthLabel).toBe("Juli 2026");
  });
});
