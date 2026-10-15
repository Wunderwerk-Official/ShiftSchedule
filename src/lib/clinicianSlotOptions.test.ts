import { describe, expect, it } from "vitest";
import type { RenderedAssignment, TimeRange } from "./schedule";
import type { ScheduleRow } from "./shiftRows";
import {
  buildClinicianOptionsForSlot,
  buildDateIntervalIndex,
  buildRowKindById,
  buildShiftIntervalsByRowId,
  canDropAssignment,
  DRAG_MIME,
  readDragPayload,
  type DragPayload,
} from "./clinicianSlotOptions";

const DATE = "2026-03-02";
const intervals = new Map<string, TimeRange>([
  ["early", { start: 8 * 60, end: 12 * 60 }],
  ["late", { start: 12 * 60, end: 16 * 60 }], // touches "early" at 12:00
  ["mid", { start: 10 * 60, end: 14 * 60 }], // overlaps both
]);
const rowKindById = new Map<string, "class" | "pool">([
  ["early", "class"],
  ["late", "class"],
  ["mid", "class"],
  ["broken", "class"], // no valid interval (e.g. 20:00-08:00 without +1 day)
  ["broken-2", "class"], // a second slot without a valid interval
  ["pool-rest-day", "pool"],
]);

const assignment = (rowId: string, clinicianId = "x"): [string, RenderedAssignment[]] => [
  `${rowId}__${DATE}`,
  [{ id: `${rowId}-${clinicianId}`, rowId, dateISO: DATE, clinicianId }],
];

const indexFor = (entries: Array<[string, RenderedAssignment[]]>) => ({
  rowKindById,
  shiftIntervalsByRowId: intervals,
  ...buildDateIntervalIndex(new Map(entries), rowKindById, intervals),
});

const drag = (rowId: string, dateISO = DATE): DragPayload => ({
  rowId,
  dateISO,
  assignmentId: `${rowId}-x`,
  clinicianId: "x",
});

describe("canDropAssignment", () => {
  it("always allows dropping into a pool row", () => {
    const index = indexFor([assignment("early"), assignment("broken")]);
    expect(canDropAssignment(drag("early"), "pool-rest-day", DATE, index)).toBe(true);
  });

  it("subtracts the dragged assignment's own interval on a same-day move", () => {
    const index = indexFor([assignment("early")]);
    expect(canDropAssignment(drag("early"), "mid", DATE, index)).toBe(true);
  });

  it("blocks a move that overlaps another assignment of the same clinician", () => {
    const index = indexFor([assignment("early"), assignment("late")]);
    expect(canDropAssignment(drag("late"), "mid", DATE, index)).toBe(false);
  });

  it("allows adjacent shifts (end == start)", () => {
    const index = indexFor([assignment("early")]);
    expect(canDropAssignment(drag("early", "2026-03-03"), "late", DATE, index)).toBe(true);
  });

  it("blocks a move when the clinician has another assignment without a valid interval", () => {
    const index = indexFor([assignment("early"), assignment("broken")]);
    expect(canDropAssignment(drag("early"), "late", DATE, index)).toBe(false);
  });

  it("moves an assignment out of a slot without a valid interval (its own unknown interval does not block)", () => {
    const index = indexFor([assignment("broken")]);
    expect(index.unknownIntervalsByDate.get(DATE)?.get("x")).toBe(1);
    expect(canDropAssignment(drag("broken"), "late", DATE, index)).toBe(true);
    // Known intervals of the clinician still count.
    const busy = indexFor([assignment("broken"), assignment("early")]);
    expect(canDropAssignment(drag("broken"), "mid", DATE, busy)).toBe(false);
    expect(canDropAssignment(drag("broken"), "late", DATE, busy)).toBe(true);
  });

  it("keeps blocking when a second unknown interval of the clinician remains", () => {
    const index = indexFor([assignment("broken"), assignment("broken-2")]);
    expect(index.unknownIntervalsByDate.get(DATE)?.get("x")).toBe(2);
    expect(canDropAssignment(drag("broken"), "late", DATE, index)).toBe(false);
  });

  it("does not subtract an unknown interval dragged in from another day", () => {
    const index = indexFor([assignment("broken")]);
    expect(canDropAssignment(drag("broken", "2026-03-01"), "late", DATE, index)).toBe(false);
  });

  it("ignores other clinicians' assignments", () => {
    const index = indexFor([assignment("early"), assignment("mid", "y")]);
    expect(canDropAssignment(drag("early"), "mid", DATE, index)).toBe(true);
  });
});

describe("readDragPayload", () => {
  // Only the grids' own drag data type is read.
  const transfer = (raw: string) => ({
    getData: (format: string) => (format === DRAG_MIME ? raw : ""),
  });

  it("reads a complete payload", () => {
    const payload = { rowId: "early", dateISO: DATE, assignmentId: "a1", clinicianId: "x" };
    expect(readDragPayload(transfer(JSON.stringify(payload)))).toEqual(payload);
  });

  it("returns null for empty, invalid or incomplete data", () => {
    expect(readDragPayload(transfer(""))).toBeNull();
    expect(readDragPayload(transfer("{not json"))).toBeNull();
    expect(readDragPayload(transfer("null"))).toBeNull();
    expect(
      readDragPayload(transfer(JSON.stringify({ rowId: "early", dateISO: DATE, clinicianId: "x" }))),
    ).toBeNull();
  });

  it("ignores data stored under another type", () => {
    const payload = { rowId: "early", dateISO: DATE, assignmentId: "a1", clinicianId: "x" };
    expect(readDragPayload({ getData: () => "" })).toBeNull();
    expect(
      readDragPayload({
        getData: (format: string) => (format === "text/plain" ? JSON.stringify(payload) : ""),
      }),
    ).toBeNull();
  });
});

describe("buildClinicianOptionsForSlot", () => {
  const slotRow = (id: string, locationId: string, startTime: string, endTime: string): ScheduleRow => ({
    id,
    kind: "class",
    name: id,
    dotColorClass: "bg-slate-200",
    sectionId: "sec",
    locationId,
    startTime,
    endTime,
  });
  const rows = [
    slotRow("a-early", "loc-a", "08:00", "12:00"),
    slotRow("b-late", "loc-b", "13:00", "17:00"),
    slotRow("a-broken", "loc-a", "20:00", "08:00"),
  ];
  const clinicians = ["x", "y", "z"].map((id) => ({
    id,
    name: id,
    qualifiedClassIds: ["sec"],
    vacations: [],
  }));
  const optionsFor = (rowId: string, map: Map<string, RenderedAssignment[]>, enforceSameLocationPerDay: boolean) => {
    const rowKindById = buildRowKindById(rows);
    const shiftIntervalsByRowId = buildShiftIntervalsByRowId(rows);
    return buildClinicianOptionsForSlot({
      rowId,
      dateISO: DATE,
      rows,
      assignmentMap: map,
      clinicians,
      enforceSameLocationPerDay,
      shiftIntervalsByRowId,
      ...buildDateIntervalIndex(map, rowKindById, shiftIntervalsByRowId),
    });
  };
  const map = new Map<string, RenderedAssignment[]>([
    [`a-early__${DATE}`, [{ id: "1", rowId: "a-early", dateISO: DATE, clinicianId: "x" }]],
    [`a-broken__${DATE}`, [{ id: "2", rowId: "a-broken", dateISO: DATE, clinicianId: "z" }]],
  ]);

  it("flags a location conflict only when one location per day is enforced", () => {
    const enforced = optionsFor("b-late", map, true);
    expect(enforced.find((o) => o.id === "x")?.hasLocationConflict).toBe(true);
    expect(enforced.find((o) => o.id === "y")?.hasLocationConflict).toBe(false);
    const free = optionsFor("b-late", map, false);
    expect(free.find((o) => o.id === "x")?.hasLocationConflict).toBe(false);
  });

  it("reports a time conflict for an unknown interval, never for the slot's own people", () => {
    const options = optionsFor("b-late", map, false);
    expect(options.find((o) => o.id === "z")?.hasTimeConflict).toBe(true);
    expect(options.find((o) => o.id === "x")?.hasTimeConflict).toBe(false);
    const own = optionsFor("a-broken", map, false).find((o) => o.id === "z");
    expect(own?.alreadyAssigned).toBe(true);
    expect(own?.hasTimeConflict).toBe(false);
  });
});
