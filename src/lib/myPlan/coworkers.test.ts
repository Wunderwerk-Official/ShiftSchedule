import { describe, expect, it } from "vitest";
import { findCoworkers } from "./coworkers";
import { buildPersonPlan } from "./timeline";
import { makeSource } from "./testFixtures";
import type { PlanShift } from "./types";

const source = makeSource();
const plan = buildPersonPlan({
  ...source,
  clinicianId: "lh",
  fromISO: "2026-10-12",
  toISO: "2026-10-18",
  todayISO: "2026-10-14",
});
const shiftOn = (dateISO: string, title: string): PlanShift => {
  const shift = [...plan.shifts.values()].find((s) => s.dateISO === dateISO && s.title === title);
  if (!shift) throw new Error(`no ${title} on ${dateISO}`);
  return shift;
};
const names = (list: Array<{ name: string }>) => list.map((entry) => entry.name);

describe("findCoworkers (interval overlap at the same location)", () => {
  it("groups the night's colleagues, including next-morning overlap (SPEC D4 #5)", () => {
    const groups = findCoworkers(source, shiftOn("2026-10-14", "Nachtdienst"));
    // Both duties (overnight) and overlapping → same duty.
    expect(names(groups.sameDuty)).toEqual(["Jonas Weber"]);
    // Sorted by start relative to Wednesday: CT-Int 08:00, MRT spät 11:00,
    // Zusatzdienst 17:00, and Thursday's Frühbesprechung 07:30 (overlaps until 08:00).
    expect(names(groups.sameTimeAtLocation)).toEqual([
      "Nina Werner", "Sophie Klein", "Felix Wagner", "Max Braun",
    ]);
    const max = groups.sameTimeAtLocation[3].shift;
    expect([max.dateISO, max.title, max.startMin]).toEqual(["2026-10-15", "Frühbesprechung", 450]);
    // Same start day and location, no overlap; ties sorted by name.
    expect(names(groups.otherAtLocation)).toEqual(["Anna Becker", "Mia Schulz", "Tim Krüger"]);
  });

  it("uses the same section as same duty and ignores other locations and vacations", () => {
    const groups = findCoworkers(source, shiftOn("2026-10-12", "MRT"));
    expect(names(groups.sameDuty)).toEqual(["Sophie Klein"]);
    expect(names(groups.sameTimeAtLocation)).toEqual(["Jonas Weber", "Tim Krüger", "Paul Richter"]);
    expect(names(groups.otherAtLocation)).toEqual(["Anna Becker", "Max Braun"]);
    const everyone = [...groups.sameDuty, ...groups.sameTimeAtLocation, ...groups.otherAtLocation];
    expect(everyone.some((c) => c.clinicianId === "fw")).toBe(false); // MVZ Nord
    expect(everyone.some((c) => c.clinicianId === "ls")).toBe(false); // on vacation
    expect(everyone.some((c) => c.clinicianId === "lh")).toBe(false); // herself
  });

  it("does not count touching shifts of the same section as overlap", () => {
    const groups = findCoworkers(source, shiftOn("2026-10-13", "CT"));
    // Felix: Sono 08:00–12:00 overlaps; his CT 12:00–16:30 only touches.
    expect(names(groups.sameTimeAtLocation)).toEqual(["Felix Wagner"]);
    expect(groups.sameTimeAtLocation[0].shift.title).toBe("Sonographie");
    expect(groups.sameDuty).toEqual([]);
  });
});
