import { describe, expect, it } from "vitest";
import { REST_DAY_POOL_ID } from "../schedule";
import { DEFAULT_LOCATION_ID } from "../shiftRows";
import { buildPersonPlan } from "./timeline";
import { ASSIGNMENTS, assign, LOCATIONS, makeSource } from "./testFixtures";
import type { PlanSource } from "./types";

const week42 = (source: PlanSource = makeSource(), clinicianId = "lh") =>
  buildPersonPlan({
    ...source,
    clinicianId,
    fromISO: "2026-10-12",
    toISO: "2026-10-18",
    todayISO: "2026-10-14",
  });

const dayOf = (plan: ReturnType<typeof week42>, dateISO: string) => {
  const day = plan.days.find((item) => item.dateISO === dateISO);
  if (!day) throw new Error(`no day ${dateISO}`);
  return day;
};

describe("buildPersonPlan — Lena's week 42 (SPEC D3)", () => {
  const plan = week42();

  it("lists the seven visible days with today, weekend and day totals", () => {
    expect(plan.days.map((day) => day.dateISO)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
      "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
    expect(plan.days.map((day) => day.hours)).toEqual([9, 8.5, 15, null, 8.5, null, 12]);
    expect(dayOf(plan, "2026-10-14").isToday).toBe(true);
    expect(plan.days.filter((day) => day.isWeekend).map((day) => day.dateISO)).toEqual([
      "2026-10-17", "2026-10-18",
    ]);
  });

  it("derives shift titles, times, kinds and colors from the slots", () => {
    const mon = dayOf(plan, "2026-10-12");
    const [fb, mrt] = mon.segments.map((segment) => plan.shifts.get(segment.shiftId)!);
    expect(fb).toMatchObject({ title: "Frühbesprechung", startMin: 450, endMin: 480, hours: 0.5 });
    // Times in the section name are stripped from the title.
    expect(mrt).toMatchObject({ title: "MRT", shortLabel: "MRT", kind: "shift", hours: 8.5 });
    expect(mrt.colors.fill).toBe("#BCD2FF");
    expect(mrt.locationName).toBe("Klinikum Mitte");
    // onCallRestClassId is only "on call" while on-call rest is enabled.
    expect(fb.kind).toBe("shift");
  });

  it("splits the night at midnight into two segments sharing one shiftId", () => {
    const wed = dayOf(plan, "2026-10-14");
    const thu = dayOf(plan, "2026-10-15");
    expect(wed.segments).toHaveLength(1);
    expect(wed.segments[0]).toMatchObject({ startMin: 1020, endMin: 1440, cutStart: false, cutEnd: true });
    expect(thu.segments[0]).toMatchObject({ startMin: 0, endMin: 480, cutStart: true, cutEnd: false });
    expect(thu.segments[0].shiftId).toBe(wed.segments[0].shiftId);
    expect(thu.segments[0].key).not.toBe(wed.segments[0].key);
    const night = plan.shifts.get(wed.segments[0].shiftId)!;
    expect(night).toMatchObject({ kind: "duty", startMin: 1020, endMin: 1920, hours: 15 });
    expect(night.colors.fill).toBe("#312E81");
  });

  it("starts the rest day after the night continuation and keeps Thursday neutral", () => {
    const thu = dayOf(plan, "2026-10-15");
    expect(thu.absences).toEqual([
      { kind: "rest", dateISO: "2026-10-15", startMin: 480, label: "ND-Frei" },
    ]);
    expect(thu.isContinuationOnly).toBe(true);
    expect(thu.hours).toBeNull();
    expect(thu.tint).toBeNull();
    expect(thu.isFree).toBe(false);
  });

  it("tints only days where a shift starts, with that location's color", () => {
    expect(dayOf(plan, "2026-10-12").tint?.ground).toBe("#E9EEF5");
    expect(dayOf(plan, "2026-10-13")).toMatchObject({
      startLocationId: "nord",
      startLocationIds: ["nord"],
      tint: { ground: "#EEDFC4", chip: "#E2C99E", ink: "#5A3E0E" },
    });
    expect(dayOf(plan, "2026-10-17")).toMatchObject({ isFree: true, tint: null });
    const uncolored = week42(
      makeSource({ locations: LOCATIONS.map((location) => ({ ...location, color: null })) }),
    );
    expect(uncolored.days.every((day) => day.tint === null)).toBe(true);
  });

  it("shows no location chip or tint while locations are disabled", () => {
    // Rows then all sit on the default location, which may still carry a color.
    const locations = [...LOCATIONS, { id: DEFAULT_LOCATION_ID, name: "Default", color: "#ECE8F5" }];
    const disabled = week42(makeSource({ locations }, { locationsEnabled: false }));
    const mon = dayOf(disabled, "2026-10-12");
    expect(mon.segments).toHaveLength(2);
    expect(mon).toMatchObject({ startLocationIds: [], tint: null });
    expect(mon.startLocationId).toBeUndefined();
  });

  it("marks published weeks and keeps a week of context shifts for rest/next lookups", () => {
    expect(plan.days.every((day) => day.published)).toBe(true);
    const shiftDates = [...plan.shifts.values()].map((shift) => shift.dateISO);
    expect(shiftDates).toContain("2026-10-08"); // week 41 night (context before)
    expect(shiftDates).toContain("2026-10-12");
    expect(plan.absences.some((absence) => absence.dateISO === "2026-10-19")).toBe(true);
  });
});

describe("buildPersonPlan — edges", () => {
  it("loads a night that started the day before the range (Sunday night on Monday)", () => {
    const plan = buildPersonPlan({
      ...makeSource(),
      clinicianId: "fw",
      fromISO: "2026-10-19",
      toISO: "2026-10-25",
      todayISO: "2026-10-14",
    });
    const mon = plan.days[0];
    expect(mon.segments).toHaveLength(1);
    expect(mon.segments[0]).toMatchObject({ startMin: 0, endMin: 480, cutStart: true });
    expect(mon.isContinuationOnly).toBe(true);
    expect(mon.hours).toBeNull();
    expect(plan.shifts.get(mon.segments[0].shiftId)?.dateISO).toBe("2026-10-18");
  });

  it("shows vacation days and hides shifts planned on them", () => {
    const source = makeSource({ assignments: [...ASSIGNMENTS, assign("lh", "mrt", "2026-10-20")] });
    const plan = buildPersonPlan({
      ...source,
      clinicianId: "lh",
      fromISO: "2026-10-19",
      toISO: "2026-10-25",
      todayISO: "2026-10-14",
    });
    expect(plan.days.map((day) => day.absences.map((absence) => absence.kind))).toEqual([
      ["vacation"], ["vacation"], ["vacation"], ["vacation"], ["vacation"], [], [],
    ]);
    expect(plan.days[0].absences[0]).toMatchObject({ startMin: 0, label: "Urlaub/FzA" });
    expect(plan.days[1].segments).toEqual([]);
    expect(plan.days[5].isFree).toBe(true);
  });

  it("puts overlapping shifts of the same person into two lanes", () => {
    const source = makeSource({ assignments: [...ASSIGNMENTS, assign("lh", "demo", "2026-10-15")] });
    const thu = week42(source).days[3];
    expect(thu.segments.map((s) => [s.startMin, s.endMin, s.lane, s.lanes])).toEqual([
      [0, 480, 0, 2], // night continuation (longer → lane 0)
      [435, 465, 1, 2], // Demos 07:15–07:45
    ]);
    // Touching shifts (FB 07:30–08:00, MRT 08:00) do not overlap.
    expect(week42(source).days[0].segments.map((s) => s.lanes)).toEqual([1, 1]);
  });

  it("derives on-call rest days like the team grid when on-call rest is enabled", () => {
    const source = makeSource({
      assignments: ASSIGNMENTS.filter((a) => a.rowId !== REST_DAY_POOL_ID),
      solverSettings: {
        enforceSameLocationPerDay: true,
        onCallRestEnabled: true,
        onCallRestClassId: "nacht",
        onCallRestDaysBefore: 0,
        onCallRestDaysAfter: 1,
        preferContinuousShifts: true,
      },
    });
    const thu = week42(source).days[3];
    expect(thu.absences).toEqual([
      { kind: "rest", dateISO: "2026-10-15", startMin: 480, label: "ND-Frei" },
    ]);
  });

  it("styles the on-call section as duty only while on-call rest is enabled", () => {
    const base = makeSource();
    const onCall = { ...base.solverSettings!, onCallRestEnabled: true, onCallRestClassId: "lke" };
    const sunday = (source: PlanSource) => {
      const plan = week42(source);
      return plan.shifts.get(plan.days[6].segments[0].shiftId)!.kind;
    };
    expect(sunday(base)).toBe("shift");
    expect(sunday(makeSource({ solverSettings: onCall }))).toBe("duty");
  });

  it("ignores assignments on slots of another day type (like the team grid)", () => {
    const wrongDay = { ...assign("lh", "mrt", "2026-10-17"), rowId: "mrt-mon" };
    const plan = week42(makeSource({ assignments: [...ASSIGNMENTS, wrongDay] }));
    expect(plan.days[5].isFree).toBe(true);
  });

  it("marks unpublished weeks as draft and resolves holidays", () => {
    const plan = buildPersonPlan({
      ...makeSource(),
      clinicianId: "lh",
      fromISO: "2026-09-28",
      toISO: "2026-11-01",
      todayISO: "2026-10-14",
    });
    const oct3 = plan.days.find((day) => day.dateISO === "2026-10-03")!;
    expect(oct3).toMatchObject({ dayType: "holiday", holidayName: "Tag der Deutschen Einheit", hours: 12 });
    const oct26 = plan.days.find((day) => day.dateISO === "2026-10-26")!;
    expect(oct26.published).toBe(false);
    expect(plan.shifts.get(oct26.segments[0].shiftId)?.published).toBe(false);
    expect(plan.days.at(-1)).toMatchObject({ dateISO: "2026-11-01", holidayName: "Allerheiligen" });
  });
});
