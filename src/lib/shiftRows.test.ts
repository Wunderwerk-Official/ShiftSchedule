import { describe, expect, it } from "vitest";
import type { AppState, WorkplaceRow } from "../api/client";
import {
  buildShiftRowId,
  ensureLocations,
  normalizeAppState,
  normalizeSubShifts,
  parseShiftRowId,
  SHIFT_ROW_SEPARATOR,
} from "./shiftRows";

describe("buildShiftRowId", () => {
  it("creates a combined ID from class and subShift", () => {
    expect(buildShiftRowId("mri", "s1")).toBe(`mri${SHIFT_ROW_SEPARATOR}s1`);
  });
});

describe("parseShiftRowId", () => {
  it("parses a valid shift row ID", () => {
    const result = parseShiftRowId(`mri${SHIFT_ROW_SEPARATOR}s1`);
    expect(result).toEqual({ classId: "mri", subShiftId: "s1" });
  });

  it("returns classId only when no separator exists", () => {
    const result = parseShiftRowId("mri");
    expect(result).toEqual({ classId: "mri" });
  });

  it("round-trips correctly with buildShiftRowId", () => {
    const original = buildShiftRowId("section-a", "s2");
    const parsed = parseShiftRowId(original);
    expect(parsed.classId).toBe("section-a");
    expect(parsed.subShiftId).toBe("s2");
    const rebuilt = buildShiftRowId(parsed.classId, parsed.subShiftId!);
    expect(rebuilt).toBe(original);
  });
});

describe("normalizeSubShifts", () => {
  it("returns default shift when empty", () => {
    const result = normalizeSubShifts([]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
    expect(result[0].name).toBe("Shift 1");
    expect(result[0].order).toBe(1);
  });

  it("normalizes time format", () => {
    const result = normalizeSubShifts([
      { id: "s1", name: "Morning", order: 1, startTime: "8:00", endTime: "12:00" },
    ]);
    expect(result[0].startTime).toBe("08:00");
    expect(result[0].endTime).toBe("12:00");
  });

  it("limits to 3 shifts", () => {
    const shifts = [
      { id: "s1", name: "Shift 1", order: 1 },
      { id: "s2", name: "Shift 2", order: 2 },
      { id: "s3", name: "Shift 3", order: 3 },
      { id: "s4", name: "Shift 4", order: 4 },
    ];
    const result = normalizeSubShifts(shifts as any);
    expect(result).toHaveLength(3);
  });
});

describe("ensureLocations", () => {
  it("adds default location when empty", () => {
    const result = ensureLocations([]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("loc-default");
  });

  it("preserves existing locations", () => {
    const locations = [{ id: "loc-1", name: "Berlin" }];
    const result = ensureLocations(locations);
    expect(result.some((loc) => loc.id === "loc-1")).toBe(true);
  });

  it("keeps valid location colors (uppercased) and drops invalid ones", () => {
    const plain = { id: "loc-plain", name: "Plain" };
    const valid = { id: "loc-valid", name: "Mitte", color: "#E9EEF5" };
    const result = ensureLocations([
      plain,
      valid,
      { id: "loc-lower", name: "Nord", color: "#eedfc4" },
      { id: "loc-bad", name: "Bad", color: "red" },
      { id: "loc-null", name: "None", color: null },
    ]);
    expect(result[0]).toBe(plain);
    expect(result[1]).toBe(valid);
    expect(result[2]).toEqual({ id: "loc-lower", name: "Nord", color: "#EEDFC4" });
    expect(result[3]).toEqual({ id: "loc-bad", name: "Bad" });
    expect(result[4]).toEqual({ id: "loc-null", name: "None" });
  });
});

describe("normalizeAppState", () => {
  const makeMinimalState = (overrides: Partial<AppState> = {}): AppState => ({
    locations: [{ id: "loc-default", name: "Default" }],
    locationsEnabled: true,
    rows: [
      {
        id: "section-a",
        name: "MRI",
        kind: "class",
        dotColorClass: "bg-slate-400",
        subShifts: [{ id: "s1", name: "Shift 1", order: 1, startTime: "08:00", endTime: "16:00" }],
      },
      {
        id: "pool-rest-day",
        name: "Rest Day",
        kind: "pool",
        dotColorClass: "bg-slate-200",
      },
      {
        id: "pool-vacation",
        name: "Vacation",
        kind: "pool",
        dotColorClass: "bg-emerald-500",
      },
    ],
    clinicians: [],
    assignments: [],
    minSlotsByRowId: {},
    slotOverridesByKey: {},
    solverSettings: {
      enforceSameLocationPerDay: false,
      onCallRestEnabled: false,
      onCallRestDaysBefore: 0,
      onCallRestDaysAfter: 0,
      preferContinuousShifts: true,
    },
    solverRules: [],
    weeklyTemplate: {
      version: 4,
      blocks: [{ id: "block-a", sectionId: "section-a", requiredSlots: 0 }],
      locations: [
        {
          locationId: "loc-default",
          rowBands: [{ id: "row-1", label: "Row 1", order: 1 }],
          colBands: [{ id: "col-mon-1", label: "", order: 1, dayType: "mon" }],
          slots: [
            {
              id: "slot-a__mon",
              locationId: "loc-default",
              rowBandId: "row-1",
              colBandId: "col-mon-1",
              blockId: "block-a",
            },
          ],
        },
      ],
    },
    holidays: [],
    ...overrides,
  });

  it("keeps a valid location color through normalization and drops an invalid one", () => {
    const { state: normalized } = normalizeAppState(
      makeMinimalState({
        locations: [
          { id: "loc-default", name: "Default", color: "#e9eef5" },
          { id: "loc-nord", name: "Nord", color: "#12345" },
        ],
      }),
    );
    expect(normalized.locations).toEqual([
      { id: "loc-default", name: "Default", color: "#E9EEF5" },
      { id: "loc-nord", name: "Nord" },
    ]);
  });

  describe("deprecated pool removal", () => {
    it("removes Distribution Pool (pool-not-allocated) from rows", () => {
      const state = makeMinimalState({
        rows: [
          { id: "section-a", name: "MRI", kind: "class", dotColorClass: "bg-slate-400" },
          { id: "pool-not-allocated", name: "Distribution Pool", kind: "pool", dotColorClass: "bg-slate-200" },
          { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" },
        ],
      });

      const { state: normalized, changed } = normalizeAppState(state);

      expect(normalized.rows.some((row) => row.id === "pool-not-allocated")).toBe(false);
      expect(changed).toBe(true);
    });

    it("removes Reserve Pool (pool-manual) from rows", () => {
      const state = makeMinimalState({
        rows: [
          { id: "section-a", name: "MRI", kind: "class", dotColorClass: "bg-slate-400" },
          { id: "pool-manual", name: "Reserve Pool", kind: "pool", dotColorClass: "bg-slate-200" },
          { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" },
        ],
      });

      const { state: normalized, changed } = normalizeAppState(state);

      expect(normalized.rows.some((row) => row.id === "pool-manual")).toBe(false);
      expect(changed).toBe(true);
    });

    it("preserves Rest Day pool (pool-rest-day)", () => {
      const state = makeMinimalState();

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.rows.some((row) => row.id === "pool-rest-day")).toBe(true);
    });

    it("preserves Vacation pool (pool-vacation)", () => {
      const state = makeMinimalState();

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.rows.some((row) => row.id === "pool-vacation")).toBe(true);
    });

    it("removes assignments to deprecated pools", () => {
      const state = makeMinimalState({
        assignments: [
          { id: "a1", rowId: "pool-not-allocated", dateISO: "2026-01-05", clinicianId: "clin-1" },
          { id: "a2", rowId: "pool-manual", dateISO: "2026-01-05", clinicianId: "clin-1" },
          { id: "a3", rowId: "pool-rest-day", dateISO: "2026-01-05", clinicianId: "clin-1" },
        ],
      });

      const { state: normalized, changed } = normalizeAppState(state);

      const assignmentRowIds = normalized.assignments.map((a) => a.rowId);
      expect(assignmentRowIds).not.toContain("pool-not-allocated");
      expect(assignmentRowIds).not.toContain("pool-manual");
      expect(assignmentRowIds).toContain("pool-rest-day");
      expect(changed).toBe(true);
    });
  });

  describe("deprecated solver settings removal", () => {
    it("removes allowMultipleShiftsPerDay", () => {
      // Using 'as any' to simulate loading legacy data with deprecated keys
      const state = makeMinimalState({
        solverSettings: { allowMultipleShiftsPerDay: true } as any,
      });

      const { state: normalized } = normalizeAppState(state);

      expect("allowMultipleShiftsPerDay" in (normalized.solverSettings ?? {})).toBe(false);
    });

    it("removes showDistributionPool", () => {
      const state = makeMinimalState({
        solverSettings: { showDistributionPool: true } as any,
      });

      const { state: normalized } = normalizeAppState(state);

      expect("showDistributionPool" in (normalized.solverSettings ?? {})).toBe(false);
    });

    it("removes showReservePool", () => {
      const state = makeMinimalState({
        solverSettings: { showReservePool: true } as any,
      });

      const { state: normalized } = normalizeAppState(state);

      expect("showReservePool" in (normalized.solverSettings ?? {})).toBe(false);
    });

    it("preserves valid solver settings", () => {
      const state = makeMinimalState({
        solverSettings: {
          enforceSameLocationPerDay: true,
          onCallRestEnabled: true,
          onCallRestDaysBefore: 1,
          onCallRestDaysAfter: 1,
          preferContinuousShifts: true,
        },
      });

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.enforceSameLocationPerDay).toBe(true);
      expect(normalized.solverSettings?.onCallRestEnabled).toBe(true);
    });
  });

  describe("solver settings defaults", () => {
    it("clamps onCallRestDaysBefore between 0 and 7", () => {
      const state = makeMinimalState({
        solverSettings: {
          enforceSameLocationPerDay: false,
          onCallRestEnabled: false,
          onCallRestDaysBefore: 20,
          onCallRestDaysAfter: 0,
          preferContinuousShifts: true,
        },
      });

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.onCallRestDaysBefore).toBe(7);
    });

    it("clamps onCallRestDaysAfter between 0 and 7", () => {
      const state = makeMinimalState({
        solverSettings: {
          enforceSameLocationPerDay: false,
          onCallRestEnabled: false,
          onCallRestDaysBefore: 0,
          onCallRestDaysAfter: -5,
          preferContinuousShifts: true,
        },
      });

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.onCallRestDaysAfter).toBe(0);
    });
  });

  describe("schedule layout setting", () => {
    it("defaults scheduleLayout to classic when absent", () => {
      const state = makeMinimalState();

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.scheduleLayout).toBe("classic");
    });

    it("preserves clinicSheet", () => {
      const state = makeMinimalState({
        solverSettings: {
          enforceSameLocationPerDay: false,
          onCallRestEnabled: false,
          onCallRestDaysBefore: 0,
          onCallRestDaysAfter: 0,
          preferContinuousShifts: true,
          scheduleLayout: "clinicSheet",
        },
      });

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.scheduleLayout).toBe("clinicSheet");
    });

    it("sanitizes unknown layout values to classic", () => {
      const state = makeMinimalState({
        // Using 'as any' to simulate corrupted/foreign data
        solverSettings: { scheduleLayout: "table-flip" } as any,
      });

      const { state: normalized } = normalizeAppState(state);

      expect(normalized.solverSettings?.scheduleLayout).toBe("classic");
    });

    it("normalizing the layout twice is idempotent", () => {
      const state = makeMinimalState({
        solverSettings: { scheduleLayout: "clinicSheet" } as any,
      });

      const { state: first } = normalizeAppState(state);
      const { state: second } = normalizeAppState(first);

      expect(second.solverSettings?.scheduleLayout).toBe("clinicSheet");
      expect(second.solverSettings).toEqual(first.solverSettings);
    });
  });

  describe("planningWishes", () => {
    const wishClinician = (planningWishes?: string) => ({
      id: "clin-1",
      name: "Alice",
      qualifiedClassIds: ["section-a"],
      preferredClassIds: [],
      vacations: [],
      planningWishes,
    });

    it("preserves a set wish", () => {
      const { state } = normalizeAppState(
        makeMinimalState({ clinicians: [wishClinician("Prefers early shifts.")] }),
      );
      expect(state.clinicians[0].planningWishes).toBe("Prefers early shifts.");
    });

    it("trims and drops empty wishes", () => {
      const { state } = normalizeAppState(
        makeMinimalState({ clinicians: [wishClinician("   ")] }),
      );
      expect(state.clinicians[0].planningWishes).toBeUndefined();
    });

    it("caps at 500 characters", () => {
      const { state } = normalizeAppState(
        makeMinimalState({ clinicians: [wishClinician("x".repeat(600))] }),
      );
      expect(state.clinicians[0].planningWishes).toHaveLength(500);
    });
  });

  it("gives sections without a color the same default palette as the backend", () => {
    // Same list and order as SECTION_BLOCK_COLORS in backend/state.py; the
    // backend test test_default_section_colors_match_the_frontend_palette
    // compares that list with colorPalette.ts, so drift on either side fails.
    const backendPalette = [
      "#FDE2E4", "#FFD9C9", "#FFE8D6", "#FFEFD1", "#FFF4C1", "#EEF6C8",
      "#E6F7D9", "#DDF6EE", "#D9F0FF", "#DEE8FF", "#E8E1F5",
    ];
    const rows: WorkplaceRow[] = Array.from({ length: 12 }, (_, index) => ({
      id: `section-${index}`,
      name: `Section ${index}`,
      kind: "class",
      dotColorClass: "bg-slate-400",
    }));
    const { state } = normalizeAppState(makeMinimalState({ rows, weeklyTemplate: undefined }));
    expect(state.rows.filter((row) => row.kind === "class").map((row) => row.blockColor)).toEqual([
      ...backendPalette,
      backendPalette[0],
    ]);
  });

  describe("migrated sub-shift slot ids", () => {
    const MONDAY = "2026-01-05";
    // Template migrated from rows: one slot per sub-shift and day type,
    // e.g. "section-a::s2__mon". Mirrors _migrated_two_shift_state (backend).
    const migratedTwoShiftState = (): AppState => {
      const twoShiftRows: WorkplaceRow[] = [
        {
          id: "section-a",
          name: "MRI",
          kind: "class",
          dotColorClass: "bg-slate-400",
          subShifts: [
            { id: "s1", name: "Early", order: 1, startTime: "08:00", endTime: "16:00" },
            { id: "s2", name: "Late", order: 2, startTime: "16:00", endTime: "23:00" },
          ],
        },
      ];
      return normalizeAppState(makeMinimalState({ rows: twoShiftRows, weeklyTemplate: undefined }))
        .state;
    };
    const assignmentOn = (id: string, rowId: string, dateISO = MONDAY) => ({
      id,
      rowId,
      dateISO,
      clinicianId: "c1",
    });

    it("keeps an assignment on `section-a::s2__mon` next to its override", () => {
      const { state } = normalizeAppState({
        ...migratedTwoShiftState(),
        assignments: [
          assignmentOn("a1", "section-a::s1__mon"),
          assignmentOn("a2", "section-a::s2__mon"),
        ],
        slotOverridesByKey: { "section-a::s2__mon__2026-01-05": 1 },
      });

      expect(state.assignments.map((a) => [a.id, a.rowId])).toEqual([
        ["a1", "section-a::s1__mon"],
        ["a2", "section-a::s2__mon"],
      ]);
      expect(state.slotOverridesByKey).toEqual({ "section-a::s2__mon__2026-01-05": 1 });
      expect(normalizeAppState(state).changed).toBe(false);
    });

    it.each([
      { dateISO: MONDAY, holidayDates: [MONDAY], from: "mon", to: "holiday" },
      { dateISO: MONDAY, holidayDates: [], from: "holiday", to: "mon" },
      { dateISO: "2026-01-06", holidayDates: [], from: "mon", to: "tue" },
    ])(
      "moves assignments on `$from` slots to the same sub-shift's `$to` slot",
      ({ dateISO, holidayDates, from, to }) => {
        const { state, changed } = normalizeAppState({
          ...migratedTwoShiftState(),
          holidays: holidayDates.map((date) => ({ dateISO: date, name: "Holiday" })),
          assignments: [
            assignmentOn("a1", `section-a::s1__${from}`, dateISO),
            assignmentOn("a2", `section-a::s2__${from}`, dateISO),
          ],
        });

        expect(changed).toBe(true);
        expect(state.assignments.map((a) => [a.id, a.rowId])).toEqual([
          ["a1", `section-a::s1__${to}`],
          ["a2", `section-a::s2__${to}`],
        ]);
        expect(normalizeAppState(state).changed).toBe(false);
      },
    );

    it("keeps an assignment on a migrated slot moved into another day's column", () => {
      // Dragging "slot-a__mon" into the Tuesday column keeps its id. Its column
      // fits a Tuesday, so the assignment stays on it instead of following the
      // id suffix to the sibling "slot-a__tue" (another row and time).
      const migrated = migratedTwoShiftState();
      const template = migrated.weeklyTemplate!;
      const location = template.locations.find((loc) => loc.slots.length > 0)!;
      const tueBand = location.colBands.find((band) => band.dayType === "tue")!;
      const base = location.slots.find((slot) => slot.colBandId === tueBand.id)!;
      const tuesday = "2026-01-13";
      const { state } = normalizeAppState({
        ...migrated,
        weeklyTemplate: {
          ...template,
          locations: template.locations.map((loc) =>
            loc !== location
              ? loc
              : {
                  ...loc,
                  slots: [
                    ...loc.slots,
                    { ...base, id: "slot-a__mon", startTime: "08:00", endTime: "12:00" },
                    { ...base, id: "slot-a__tue", startTime: "13:00", endTime: "17:00" },
                  ],
                },
          ),
        },
        holidays: [],
        assignments: [assignmentOn("a1", "slot-a__mon", tuesday)],
        slotOverridesByKey: { [`slot-a__mon__${tuesday}`]: 1 },
      });

      expect(state.assignments.map((a) => [a.id, a.rowId])).toEqual([["a1", "slot-a__mon"]]);
      expect(state.slotOverridesByKey).toEqual({ [`slot-a__mon__${tuesday}`]: 1 });
      expect(normalizeAppState(state).changed).toBe(false);
    });

    it("drops an assignment on a deleted migrated slot instead of moving it to s1", () => {
      const migrated = migratedTwoShiftState();
      const template = migrated.weeklyTemplate!;
      const { state } = normalizeAppState({
        ...migrated,
        weeklyTemplate: {
          ...template,
          locations: template.locations.map((location) => ({
            ...location,
            slots: location.slots.filter((slot) => !slot.id.startsWith("section-a::s2__")),
          })),
        },
        assignments: [
          assignmentOn("a1", "section-a::s1__mon"),
          assignmentOn("a2", "section-a::s2__mon"),
        ],
      });

      expect(state.assignments.map((a) => [a.id, a.rowId])).toEqual([
        ["a1", "section-a::s1__mon"],
      ]);
    });
  });

  describe("idempotence", () => {
    it("normalizing twice produces the same result", () => {
      const state = makeMinimalState({
        rows: [
          { id: "section-a", name: "MRI", kind: "class", dotColorClass: "bg-slate-400" },
          { id: "pool-not-allocated", name: "Distribution Pool", kind: "pool", dotColorClass: "bg-slate-200" },
        ],
        // Using 'as any' to simulate loading legacy data with deprecated keys
        solverSettings: { allowMultipleShiftsPerDay: true, showDistributionPool: true } as any,
      });

      const { state: first } = normalizeAppState(state);
      const { state: second } = normalizeAppState(first);

      // Second normalization should produce same rows
      expect(second.rows.map((r) => r.id).sort()).toEqual(first.rows.map((r) => r.id).sort());
      // Solver settings should be identical
      expect(second.solverSettings).toEqual(first.solverSettings);
    });
  });
});
