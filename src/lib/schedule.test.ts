import { describe, expect, it } from "vitest";
import type { Assignment, Clinician } from "../api/client";
import {
  buildRenderedAssignmentMap,
  buildShiftInterval,
  formatTimeRangeLabel,
  intervalsOverlap,
  REST_DAY_POOL_ID,
  VACATION_POOL_ID,
} from "./schedule";
import type { ScheduleRow } from "./shiftRows";

const baseRow: ScheduleRow = {
  id: "row-1",
  name: "MRI",
  kind: "class",
  dotColorClass: "bg-slate-200",
  startTime: "08:00",
  endTime: "16:00",
  endDayOffset: 0,
};

describe("intervalsOverlap", () => {
  it("returns false when intervals only touch at the edge", () => {
    expect(intervalsOverlap({ start: 0, end: 60 }, { start: 60, end: 120 })).toBe(
      false,
    );
  });

  it("returns true when intervals overlap", () => {
    expect(intervalsOverlap({ start: 0, end: 90 }, { start: 60, end: 120 })).toBe(
      true,
    );
  });

  it("returns false when first interval is completely before second", () => {
    expect(intervalsOverlap({ start: 0, end: 30 }, { start: 60, end: 120 })).toBe(
      false,
    );
  });

  it("returns false when first interval is completely after second", () => {
    expect(intervalsOverlap({ start: 150, end: 180 }, { start: 60, end: 120 })).toBe(
      false,
    );
  });

  it("returns true when one interval contains the other", () => {
    expect(intervalsOverlap({ start: 0, end: 180 }, { start: 60, end: 120 })).toBe(
      true,
    );
  });
});

describe("buildShiftInterval", () => {
  it("builds an interval with day offset applied", () => {
    const row: ScheduleRow = {
      ...baseRow,
      endDayOffset: 1,
    };
    expect(buildShiftInterval(row)).toEqual({ start: 480, end: 2400 });
  });

  it("returns null when end time is not after start", () => {
    const row: ScheduleRow = {
      ...baseRow,
      endTime: "08:00",
    };
    expect(buildShiftInterval(row)).toBeNull();
  });

  it("ignores non-class rows", () => {
    const row: ScheduleRow = {
      id: "pool-row",
      name: "Pool",
      kind: "pool",
      dotColorClass: "bg-slate-200",
    };
    expect(buildShiftInterval(row)).toBeNull();
  });

  it("handles overnight shifts correctly", () => {
    const row: ScheduleRow = {
      ...baseRow,
      startTime: "22:00",
      endTime: "06:00",
      endDayOffset: 1,
    };
    const interval = buildShiftInterval(row);
    expect(interval).not.toBeNull();
    // 22:00 = 22*60 = 1320 minutes
    // 06:00 + 1 day = 6*60 + 24*60 = 360 + 1440 = 1800 minutes
    expect(interval?.start).toBe(1320);
    expect(interval?.end).toBe(1800);
  });

  it("clamps endDayOffset to valid range", () => {
    const row: ScheduleRow = {
      ...baseRow,
      endDayOffset: 10, // Should be clamped to 3
    };
    const interval = buildShiftInterval(row);
    expect(interval).not.toBeNull();
    // end = 16:00 + 3 days = 960 + 3*1440 = 960 + 4320 = 5280
    expect(interval?.end).toBe(5280);
  });
});

describe("formatTimeRangeLabel", () => {
  it("formats basic time range", () => {
    // 8:00 = 480 minutes, 16:00 = 960 minutes
    expect(formatTimeRangeLabel(480, 960)).toBe("08:00 - 16:00");
  });

  it("formats time range with day offset", () => {
    // 22:00 = 1320 minutes, 06:00 next day = 360 + 1440 = 1800 minutes
    expect(formatTimeRangeLabel(1320, 1800)).toBe("22:00 - 06:00 +1d");
  });
});

describe("buildRenderedAssignmentMap", () => {
  const makeClinicianWithVacation = (
    id: string,
    vacationStart?: string,
    vacationEnd?: string,
  ): Clinician => ({
    id,
    name: `Dr. ${id}`,
    qualifiedClassIds: [],
    preferredClassIds: [],
    vacations: vacationStart && vacationEnd
      ? [{ id: "v1", startISO: vacationStart, endISO: vacationEnd }]
      : [],
  });

  const scheduleRows: ScheduleRow[] = [
    {
      id: "slot-a",
      kind: "class",
      name: "MRI",
      dotColorClass: "bg-slate-200",
      sectionId: "mri",
    },
    {
      id: "pool-rest-day",
      kind: "pool",
      name: "Rest Day",
      dotColorClass: "bg-slate-200",
    },
    {
      id: "pool-vacation",
      kind: "pool",
      name: "Vacation",
      dotColorClass: "bg-emerald-500",
    },
  ];

  it("filters out assignments during vacation", () => {
    const clinicians = [makeClinicianWithVacation("clin-1", "2026-01-05", "2026-01-10")];
    const assignments: Assignment[] = [
      { id: "a1", rowId: "slot-a", dateISO: "2026-01-07", clinicianId: "clin-1" },
    ];
    const assignmentMap = new Map([["slot-a__2026-01-07", assignments]]);
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
    });

    // Assignment should be filtered out due to vacation
    const slotAssignments = result.get("slot-a__2026-01-07");
    expect(slotAssignments?.length ?? 0).toBe(0);
  });

  it("filters out vacation assignments for slot ids containing __", () => {
    // Migrated template slot ids look like "class-1::s1__wed"; the key must be
    // split at the LAST "__" so the dateISO is parsed correctly.
    const migratedRows: ScheduleRow[] = [
      {
        id: "class-1::s1__wed",
        kind: "class",
        name: "MRI",
        dotColorClass: "bg-slate-200",
        sectionId: "mri",
      },
      ...scheduleRows.filter((row) => row.kind === "pool"),
    ];
    const clinicians = [makeClinicianWithVacation("clin-1", "2026-01-05", "2026-01-10")];
    const assignments: Assignment[] = [
      { id: "a1", rowId: "class-1::s1__wed", dateISO: "2026-01-07", clinicianId: "clin-1" },
    ];
    const assignmentMap = new Map([["class-1::s1__wed__2026-01-07", assignments]]);
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows: migratedRows,
    });

    const slotAssignments = result.get("class-1::s1__wed__2026-01-07");
    expect(slotAssignments?.length ?? 0).toBe(0);
    const vacationPool = result.get("pool-vacation__2026-01-07");
    expect(vacationPool?.some((item) => item.clinicianId === "clin-1")).toBe(true);
  });

  it("preserves assignments outside vacation period", () => {
    const clinicians = [makeClinicianWithVacation("clin-1", "2026-01-10", "2026-01-15")];
    const assignments: Assignment[] = [
      { id: "a1", rowId: "slot-a", dateISO: "2026-01-07", clinicianId: "clin-1" },
    ];
    const assignmentMap = new Map([["slot-a__2026-01-07", assignments]]);
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
    });

    const slotAssignments = result.get("slot-a__2026-01-07");
    expect(slotAssignments?.length).toBe(1);
    expect(slotAssignments?.[0].clinicianId).toBe("clin-1");
  });

  it("places vacation clinicians in vacation pool", () => {
    const clinicians = [makeClinicianWithVacation("clin-1", "2026-01-05", "2026-01-10")];
    const assignmentMap = new Map<string, Assignment[]>();
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
    });

    const vacationAssignments = result.get(`${VACATION_POOL_ID}__2026-01-07`);
    expect(vacationAssignments).toBeDefined();
    expect(vacationAssignments?.some((a) => a.clinicianId === "clin-1")).toBe(true);
  });

  it("never references deprecated Distribution Pool", () => {
    const clinicians = [makeClinicianWithVacation("clin-1")];
    const assignmentMap = new Map<string, Assignment[]>();
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
    });

    // No key should reference the deprecated pool
    for (const key of result.keys()) {
      expect(key).not.toContain("pool-not-allocated");
    }
  });

  it("preserves valid pool assignments from input", () => {
    // Test that pool assignments are preserved when passed in the assignmentMap
    const clinicians = [makeClinicianWithVacation("clin-1")];
    const assignmentMap = new Map<string, Assignment[]>([
      ["pool-rest-day__2026-01-07", [
        { id: "a1", rowId: "pool-rest-day", dateISO: "2026-01-07", clinicianId: "clin-1" },
      ]],
    ]);
    const displayDays = [new Date("2026-01-07")];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
    });

    const poolAssignments = result.get(`${REST_DAY_POOL_ID}__2026-01-07`);
    expect(poolAssignments).toBeDefined();
    expect(poolAssignments?.some((a) => a.clinicianId === "clin-1")).toBe(true);
  });

  it("places clinician in rest day pool when on-call rest days are enabled", () => {
    const clinicians = [makeClinicianWithVacation("clin-1")];
    // Clinician is on-call on 2026-01-07
    const assignmentMap = new Map<string, Assignment[]>([
      ["slot-a__2026-01-07", [
        { id: "a1", rowId: "slot-a", dateISO: "2026-01-07", clinicianId: "clin-1" },
      ]],
    ]);
    // Display includes 2026-01-06 (day before) through 2026-01-08 (day after)
    const displayDays = [
      new Date("2026-01-06"),
      new Date("2026-01-07"),
      new Date("2026-01-08"),
    ];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
      solverSettings: {
        enforceSameLocationPerDay: false,
        onCallRestEnabled: true,
        onCallRestClassId: "mri",
        onCallRestDaysBefore: 1,
        onCallRestDaysAfter: 1,
        preferContinuousShifts: true,
      },
    });

    // Day before (2026-01-06) should have rest day entry
    const restDayBefore = result.get(`${REST_DAY_POOL_ID}__2026-01-06`);
    expect(restDayBefore).toBeDefined();
    expect(restDayBefore?.some((a) => a.clinicianId === "clin-1")).toBe(true);

    // Day after (2026-01-08) should have rest day entry
    const restDayAfter = result.get(`${REST_DAY_POOL_ID}__2026-01-08`);
    expect(restDayAfter).toBeDefined();
    expect(restDayAfter?.some((a) => a.clinicianId === "clin-1")).toBe(true);

    // On-call day (2026-01-07) should NOT have rest day entry
    const onCallDay = result.get(`${REST_DAY_POOL_ID}__2026-01-07`);
    const hasRestOnCallDay = onCallDay?.some((a) => a.clinicianId === "clin-1") ?? false;
    expect(hasRestOnCallDay).toBe(false);
  });

  it("uses slot row id correctly for on-call detection with template slots", () => {
    // This simulates a template slot with a custom ID format (like slot-123)
    const templateScheduleRows: ScheduleRow[] = [
      {
        id: "slot-xyz-123",  // Template slot ID
        kind: "class",
        name: "MRI",
        dotColorClass: "bg-slate-200",
        sectionId: "mri",  // Section ID that matches on-call config
      },
      {
        id: "pool-rest-day",
        kind: "pool",
        name: "Rest Day",
        dotColorClass: "bg-slate-200",
      },
    ];

    const clinicians = [makeClinicianWithVacation("clin-1")];
    // Clinician is assigned to the template slot
    const assignmentMap = new Map<string, Assignment[]>([
      ["slot-xyz-123__2026-01-07", [
        { id: "a1", rowId: "slot-xyz-123", dateISO: "2026-01-07", clinicianId: "clin-1" },
      ]],
    ]);
    const displayDays = [
      new Date("2026-01-06"),
      new Date("2026-01-07"),
      new Date("2026-01-08"),
    ];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows: templateScheduleRows,
      solverSettings: {
        enforceSameLocationPerDay: false,
        onCallRestEnabled: true,
        onCallRestClassId: "mri",  // Matches sectionId of the slot
        onCallRestDaysBefore: 1,
        onCallRestDaysAfter: 1,
        preferContinuousShifts: true,
      },
    });

    // Day before should have rest day entry
    const restDayBefore = result.get(`${REST_DAY_POOL_ID}__2026-01-06`);
    expect(restDayBefore).toBeDefined();
    expect(restDayBefore?.some((a) => a.clinicianId === "clin-1")).toBe(true);

    // Day after should have rest day entry
    const restDayAfter = result.get(`${REST_DAY_POOL_ID}__2026-01-08`);
    expect(restDayAfter).toBeDefined();
    expect(restDayAfter?.some((a) => a.clinicianId === "clin-1")).toBe(true);
  });

  it("only shows rest days that fall within displayDays (edge of week)", () => {
    // On-call on Monday 2026-01-05 (first day of week)
    // Rest day BEFORE would be Sunday 2026-01-04 (not in displayDays)
    // Rest day AFTER would be Tuesday 2026-01-06 (in displayDays)
    const clinicians = [makeClinicianWithVacation("clin-1")];
    const assignmentMap = new Map<string, Assignment[]>([
      ["slot-a__2026-01-05", [
        { id: "a1", rowId: "slot-a", dateISO: "2026-01-05", clinicianId: "clin-1" },
      ]],
    ]);
    // Week Mon-Sun: 2026-01-05 through 2026-01-11 (Sunday 01-04 NOT included)
    const displayDays = [
      new Date("2026-01-05"),
      new Date("2026-01-06"),
      new Date("2026-01-07"),
      new Date("2026-01-08"),
      new Date("2026-01-09"),
      new Date("2026-01-10"),
      new Date("2026-01-11"),
    ];

    const result = buildRenderedAssignmentMap(assignmentMap, clinicians, displayDays, {
      scheduleRows,
      solverSettings: {
        enforceSameLocationPerDay: false,
        onCallRestEnabled: true,
        onCallRestClassId: "mri",
        onCallRestDaysBefore: 1,
        onCallRestDaysAfter: 1,
        preferContinuousShifts: true,
      },
    });

    // Day before (2026-01-04) is NOT in displayDays, so no rest day entry
    const restDayBefore = result.get(`${REST_DAY_POOL_ID}__2026-01-04`);
    expect(restDayBefore).toBeUndefined();

    // Day after (2026-01-06) IS in displayDays, so should have rest day entry
    const restDayAfter = result.get(`${REST_DAY_POOL_ID}__2026-01-06`);
    expect(restDayAfter).toBeDefined();
    expect(restDayAfter?.some((a) => a.clinicianId === "clin-1")).toBe(true);
  });
});
