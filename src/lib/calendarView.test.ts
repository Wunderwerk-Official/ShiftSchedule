import { describe, expect, it } from "vitest";
import { buildColumnTimeMetaByKey, buildLocationColumnTimeMetaByKey } from "./calendarView";
import type { ScheduleRow } from "./shiftRows";

const slot = (
  id: string,
  overrides: Partial<ScheduleRow> & Pick<ScheduleRow, "startTime" | "endTime">,
): ScheduleRow => ({
  id,
  name: id,
  kind: "class",
  dotColorClass: "bg-slate-200",
  dayType: "mon",
  colBandOrder: 1,
  locationId: "loc-a",
  ...overrides,
});

const rows: ScheduleRow[] = [
  slot("a1", { startTime: "08:00", endTime: "16:00" }),
  slot("a2", { startTime: "08:00", endTime: "16:00" }),
  slot("b1", { locationId: "loc-b", startTime: "07:00", endTime: "15:00" }),
  // Night shift on the second Monday column, no location.
  slot("n1", { colBandOrder: 2, locationId: undefined, startTime: "20:00", endTime: "08:00", endDayOffset: 1 }),
  // Tuesday column whose only slot has no valid time.
  slot("t1", { dayType: "tue", startTime: "20:00", endTime: "08:00" }),
  { id: "pool-rest-day", name: "Rest Day", kind: "pool", dotColorClass: "bg-slate-200" },
];

describe("buildColumnTimeMetaByKey", () => {
  it("marks a column mixed when its slots have different times", () => {
    const meta = buildColumnTimeMetaByKey(rows);
    expect(meta.get("mon-1")).toEqual({ label: undefined, mixed: true });
    expect(meta.get("mon-2")).toEqual({ label: "20:00 - 08:00 +1d", mixed: false });
    expect(meta.has("tue-1")).toBe(false);
    expect([...meta.keys()].sort()).toEqual(["mon-1", "mon-2"]);
  });
});

describe("buildLocationColumnTimeMetaByKey", () => {
  it("keys per location, skipping rows without a location or a valid time", () => {
    const meta = buildLocationColumnTimeMetaByKey(rows);
    expect(meta.get("loc-a__mon-1")).toEqual({ label: "08:00 - 16:00", mixed: false });
    expect(meta.get("loc-b__mon-1")).toEqual({ label: "07:00 - 15:00", mixed: false });
    expect([...meta.keys()].sort()).toEqual(["loc-a__mon-1", "loc-b__mon-1"]);
  });
});
