import { describe, expect, it } from "vitest";
import type { Assignment } from "../api/client";
import { isProtectedAssignment, toggleAssignmentLock } from "./assignmentPolicy";

const shift = (extra: Partial<Assignment> = {}): Assignment => ({
  id: "a1",
  rowId: "slot-a",
  dateISO: "2026-01-07",
  clinicianId: "clin-1",
  ...extra,
});

describe("one lock for manual and planner shifts", () => {
  it("shows hand-placed and legacy shifts as locked, planner shifts as unlocked", () => {
    expect(isProtectedAssignment(shift({ source: "manual" }))).toBe(true);
    expect(isProtectedAssignment(shift())).toBe(true); // legacy: no source
    expect(isProtectedAssignment(shift({ source: "solver" }))).toBe(false);
    expect(isProtectedAssignment(shift({ source: "solver", locked: true }))).toBe(true);
  });

  it("unlocking a hand-placed shift hands it to the planner; locking it again keeps it", () => {
    const unlocked = toggleAssignmentLock(shift({ source: "manual" }));
    expect(unlocked).toEqual(shift({ source: "solver", locked: false }));
    expect(isProtectedAssignment(unlocked)).toBe(false);
    const relocked = toggleAssignmentLock(unlocked);
    expect(relocked).toEqual(shift({ source: "solver", locked: true }));
    expect(isProtectedAssignment(relocked)).toBe(true);
  });

  it("flips planner shifts and legacy entries the same way and keeps the identity", () => {
    const planner = shift({ source: "solver" });
    expect(toggleAssignmentLock(planner)).toEqual({ ...planner, locked: true });
    expect(toggleAssignmentLock(toggleAssignmentLock(planner))).toEqual({ ...planner, locked: false });
    const legacy = toggleAssignmentLock(shift());
    expect(legacy).toMatchObject({ id: "a1", rowId: "slot-a", dateISO: "2026-01-07", clinicianId: "clin-1" });
    expect(isProtectedAssignment(legacy)).toBe(false);
  });
});
