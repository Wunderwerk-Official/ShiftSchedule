import { describe, expect, it } from "vitest";
import type { Assignment } from "../api/client";
import { buildAssignmentMap } from "../data/mockData";
import { resetSolverAssignments, resetUnfixedAssignments } from "./resetSolverAssignments";

const RANGE = { startISO: "2026-01-05", endISO: "2026-01-11" };

const entry = (id: string, extra: Partial<Assignment> = {}): Assignment => ({
  id,
  rowId: "slot-a",
  dateISO: "2026-01-07",
  clinicianId: "clin-1",
  source: "solver",
  ...extra,
});

const ids = (map: Map<string, Assignment[]>) =>
  [...map.values()].flat().map((assignment) => assignment.id).sort();

describe("resetSolverAssignments (backend is_replaced_by_draft)", () => {
  it("removes unlocked solver entries in the range and keeps manual, legacy and locked ones", () => {
    const map = buildAssignmentMap([
      entry("solver"),
      entry("manual", { source: "manual", clinicianId: "clin-2" }),
      entry("legacy", { source: undefined, clinicianId: "clin-3" }),
      entry("locked", { locked: true, clinicianId: "clin-4" }),
    ]);
    expect(ids(resetSolverAssignments(map, RANGE))).toEqual(["legacy", "locked", "manual"]);
  });

  it("does not consult vacations: removal depends only on source, lock, pool row and range", () => {
    // The page used to keep solver entries on vacation days; the helper takes
    // no vacation data, so it matches what applying a draft replaces. The
    // vacation case itself is covered in e2e/team-page.spec.ts.
    const map = buildAssignmentMap([entry("unlocked-solver")]);
    const next = resetSolverAssignments(map, RANGE);
    expect(ids(next)).toEqual([]);
    expect(next.has("slot-a__2026-01-07")).toBe(false);
  });

  it("keeps pool entries and entries outside the range", () => {
    const map = buildAssignmentMap([
      entry("rest-day", { rowId: "pool-rest-day" }),
      entry("before", { dateISO: "2026-01-04" }),
      entry("after", { dateISO: "2026-01-12" }),
      entry("first-day", { dateISO: "2026-01-05", clinicianId: "clin-2" }),
      entry("last-day", { dateISO: "2026-01-11", clinicianId: "clin-3" }),
    ]);
    expect(ids(resetSolverAssignments(map, RANGE))).toEqual(["after", "before", "rest-day"]);
  });

  it("handles row ids containing '__' and returns the same map when nothing changes", () => {
    const map = buildAssignmentMap([
      entry("sub-shift", { rowId: "section-a__sub-shift-1" }),
      entry("manual", { rowId: "section-a__sub-shift-1", source: "manual", clinicianId: "clin-2" }),
    ]);
    const next = resetSolverAssignments(map, RANGE);
    expect(next.get("section-a__sub-shift-1__2026-01-07")?.map((a) => a.id)).toEqual(["manual"]);

    const untouched = buildAssignmentMap([entry("manual", { source: "manual" })]);
    expect(resetSolverAssignments(untouched, RANGE)).toBe(untouched);
  });
});

describe("resetUnfixedAssignments", () => {
  // clin-1 is on vacation on 2026-01-07 only.
  const onVacation = (clinicianId: string, dateISO: string) =>
    clinicianId === "clin-1" && dateISO === "2026-01-07";

  it("keeps locked entries and manual/legacy entries on vacation days, removes the rest", () => {
    const map = buildAssignmentMap([
      entry("solver-vacation"),
      entry("manual-vacation", { source: "manual", rowId: "slot-b" }),
      entry("legacy-vacation", { source: undefined, rowId: "slot-c" }),
      entry("manual", { source: "manual", clinicianId: "clin-2" }),
      entry("solver", { clinicianId: "clin-3" }),
      entry("locked", { locked: true, clinicianId: "clin-4" }),
      entry("rest-day", { rowId: "pool-rest-day", source: "manual", clinicianId: "clin-2" }),
    ]);
    expect(ids(resetUnfixedAssignments(map, RANGE, onVacation))).toEqual([
      "legacy-vacation",
      "locked",
      "manual-vacation",
    ]);
  });

  it("removes at least what Reset Solver Only removes", () => {
    const map = buildAssignmentMap([
      entry("solver-vacation"),
      entry("solver", { clinicianId: "clin-3", dateISO: "2026-01-08" }),
      entry("manual-vacation", { source: "manual", rowId: "slot-b" }),
    ]);
    const unfixed = new Set(ids(resetUnfixedAssignments(map, RANGE, onVacation)));
    for (const id of unfixed) {
      expect(ids(resetSolverAssignments(map, RANGE))).toContain(id);
    }
    expect([...unfixed]).toEqual(["manual-vacation"]);
  });

  it("keeps entries outside the range and returns the same map when nothing changes", () => {
    const map = buildAssignmentMap([
      entry("before", { dateISO: "2026-01-04", source: "manual" }),
      entry("after", { dateISO: "2026-01-12" }),
      entry("locked", { locked: true }),
    ]);
    expect(resetUnfixedAssignments(map, RANGE, onVacation)).toBe(map);
  });
});
