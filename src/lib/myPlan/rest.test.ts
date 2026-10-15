import { describe, expect, it } from "vitest";
import { REST_DAY_POOL_ID } from "../schedule";
import { findNextShift } from "./nextUp";
import { nextAfter, restBefore } from "./rest";
import { buildPersonPlan } from "./timeline";
import { ASSIGNMENTS, assign, makeSource } from "./testFixtures";
import type { PlanShift } from "./types";

const WEEK_42 = { fromISO: "2026-10-12", toISO: "2026-10-18", todayISO: "2026-10-14" };
const plan = buildPersonPlan({ ...makeSource(), clinicianId: "lh", ...WEEK_42 });
const shiftOn = (dateISO: string, title: string): PlanShift =>
  [...plan.shifts.values()].find((s) => s.dateISO === dateISO && s.title === title)!;

describe("restBefore / nextAfter (SPEC D4)", () => {
  it("measures the rest before a shift from the previous shift's end", () => {
    expect(restBefore(plan, shiftOn("2026-10-14", "Nachtdienst"))).toMatchObject({
      hours: 24.5,
      fromLabel: "Tue 16:30",
      toLabel: "Wed 17:00",
      direct: false,
    });
    expect(restBefore(plan, shiftOn("2026-10-13", "CT"))?.hours).toBe(15.5);
    expect(restBefore(plan, shiftOn("2026-10-16", "Angiographie"))).toMatchObject({
      hours: 24,
      fromLabel: "Thu 08:00",
    });
    expect(restBefore(plan, shiftOn("2026-10-18", "LKE/DL"))?.hours).toBe(39.5);
  });

  it("flags directly following shifts and reaches into the previous week", () => {
    const mrt = restBefore(plan, shiftOn("2026-10-12", "MRT"));
    expect(mrt).toMatchObject({ hours: 0, direct: true });
    expect(mrt?.previous.title).toBe("Frühbesprechung");
    // Monday's first shift: last shift was the night of Thu 8 Oct (until Fri 08:00).
    expect(restBefore(plan, shiftOn("2026-10-12", "Frühbesprechung"))).toMatchObject({
      hours: 71.5,
      fromLabel: "Fri 08:00",
    });
  });

  it("names what comes next: shift, rest day after a night, vacation range", () => {
    expect(nextAfter(plan, shiftOn("2026-10-12", "Frühbesprechung"))).toBe("MRT 08:00 (directly after)");
    expect(nextAfter(plan, shiftOn("2026-10-12", "MRT"))).toBe("Tue 13 Oct · CT 08:00");
    expect(nextAfter(plan, shiftOn("2026-10-13", "Sonographie"))).toBe("Wed 14 Oct · Nachtdienst 17:00");
    expect(nextAfter(plan, shiftOn("2026-10-14", "Nachtdienst"))).toBe("Thu 15 Oct · ND-Frei from 08:00");
    expect(nextAfter(plan, shiftOn("2026-10-18", "LKE/DL"))).toBe(
      "Mon 19 Oct – Fri 23 Oct · Urlaub/FzA",
    );
  });

  it("flags a shift directly after a night on the next day", () => {
    const restId = assign("lh", REST_DAY_POOL_ID, "2026-10-15").id;
    const source = makeSource({
      assignments: [...ASSIGNMENTS.filter((a) => a.id !== restId), assign("lh", "mrt", "2026-10-15")],
    });
    const withMrt = buildPersonPlan({ ...source, clinicianId: "lh", ...WEEK_42 });
    const night = [...withMrt.shifts.values()].find(
      (s) => s.title === "Nachtdienst" && s.dateISO === "2026-10-14",
    )!;
    expect(nextAfter(withMrt, night)).toBe("Thu 15 Oct · MRT 08:00 (directly after)");
  });

  it("skips what starts during the shift: a meeting before the night ends is not 'next'", () => {
    // Demos 07:15–07:45 on Thu runs inside the night (until 08:00).
    const source = makeSource({ assignments: [...ASSIGNMENTS, assign("lh", "demo", "2026-10-15")] });
    const withDemos = buildPersonPlan({ ...source, clinicianId: "lh", ...WEEK_42 });
    const night = [...withDemos.shifts.values()].find(
      (s) => s.title === "Nachtdienst" && s.dateISO === "2026-10-14",
    )!;
    expect(nextAfter(withDemos, night)).toBe("Thu 15 Oct · ND-Frei from 08:00");
    // Without the rest day, the next shift after the night's end follows (not Demos).
    const restId = assign("lh", REST_DAY_POOL_ID, "2026-10-15").id;
    const noRest = makeSource({
      assignments: [...ASSIGNMENTS.filter((a) => a.id !== restId), assign("lh", "demo", "2026-10-15")],
    });
    const plain = buildPersonPlan({ ...noRest, clinicianId: "lh", ...WEEK_42 });
    const plainNight = [...plain.shifts.values()].find(
      (s) => s.title === "Nachtdienst" && s.dateISO === "2026-10-14",
    )!;
    expect(nextAfter(plain, plainNight)).toBe("Fri 16 Oct · Angiographie 08:00");
  });

  it("still names a shift that starts during this one and runs past its end", () => {
    // MRT spät 11:00–20:00 overlaps Monday's MRT (until 16:30) but outlasts it.
    const source = makeSource({ assignments: [...ASSIGNMENTS, assign("lh", "mrts", "2026-10-12")] });
    const withLate = buildPersonPlan({ ...source, clinicianId: "lh", ...WEEK_42 });
    const mrt = [...withLate.shifts.values()].find((s) => s.title === "MRT" && s.dateISO === "2026-10-12")!;
    expect(nextAfter(withLate, mrt)).toBe("MRT spät 11:00");
  });

  it("names a vacation that starts on the morning a night ends from its first day", () => {
    const lkeId = assign("lh", "lke", "2026-10-18").id;
    const source = makeSource({
      assignments: [...ASSIGNMENTS.filter((a) => a.id !== lkeId), assign("lh", "nacht", "2026-10-18")],
    });
    const withNight = buildPersonPlan({ ...source, clinicianId: "lh", ...WEEK_42 });
    const sundayNight = [...withNight.shifts.values()].find(
      (s) => s.title === "Nachtdienst" && s.dateISO === "2026-10-18",
    )!;
    expect(nextAfter(withNight, sundayNight)).toBe("Mon 19 Oct – Fri 23 Oct · Urlaub/FzA");
  });
});

describe("findNextShift", () => {
  it("finds the next shift with a wall-clock countdown (SPEC A3.8: 14:32 → 17:00)", () => {
    const next = findNextShift(plan, new Date(2026, 9, 14, 14, 32, 40));
    expect(next?.shift.title).toBe("Nachtdienst");
    expect(next).toMatchObject({ running: false, minutesUntil: 148, minutesLeft: 1048 });
  });

  it("reports a running night until its end, then the next shift", () => {
    expect(findNextShift(plan, new Date(2026, 9, 15, 3, 0))).toMatchObject({
      running: true,
      minutesUntil: 0,
      minutesLeft: 300,
    });
    expect(findNextShift(plan, new Date(2026, 9, 15, 8, 0))?.shift.title).toBe("Angiographie");
  });

  it("returns null when nothing starts within the horizon", () => {
    expect(findNextShift(plan, new Date(2026, 9, 18, 21, 0))).toBeNull(); // only context left
    expect(findNextShift(plan, new Date(2026, 9, 14, 14, 32), 0)).toBeNull();
  });
});
