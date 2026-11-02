import { describe, expect, it } from "vitest";
import type { Assignment } from "../api/client";
import {
  buildWorkingHoursYear,
  COUNTED_WEEK_SHARE,
  formatHours,
  formatSignedHours,
  getWeeksInYear,
  hoursStatus,
  slotMinutesFromTemplate,
  weekIndexOf,
  type HoursClinician,
} from "./workingHours";

describe("getWeeksInYear", () => {
  it("covers Jan 1 to Dec 31 in Monday weeks, partial at both ends", () => {
    const weeks = getWeeksInYear(2026); // Jan 1 2026 is a Thursday
    expect(weeks[0].dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(weeks[0].isoWeek).toBe(1);
    expect(weeks[1].dates[0]).toBe("2026-01-05");
    expect(weeks.at(-1)!.dates.at(-1)).toBe("2026-12-31");
    expect(weeks.reduce((sum, week) => sum + week.dates.length, 0)).toBe(365);
    expect(getWeeksInYear(2024).reduce((sum, week) => sum + week.dates.length, 0)).toBe(366);
    expect(weeks.map((week) => week.index)).toEqual(weeks.map((_, index) => index));
  });

  it("labels weeks with their ISO number, like calendars and My plan", () => {
    const weeks2026 = getWeeksInYear(2026);
    expect(weeks2026[weekIndexOf(weeks2026, "2026-11-04")].isoWeek).toBe(45);
    // Jan 1 2027 is a Friday: those three days belong to ISO week 53 of 2026.
    const weeks2027 = getWeeksInYear(2027);
    expect(weeks2027[0]).toMatchObject({ isoWeek: 53, dates: ["2027-01-01", "2027-01-02", "2027-01-03"] });
    expect(weeks2027[1].isoWeek).toBe(1);
    expect(weekIndexOf(weeks2027, "2026-12-31")).toBe(-1);
  });
});

describe("hoursStatus / formatting", () => {
  it("is on target inside the tolerance, over or under outside it", () => {
    expect(hoursStatus(0, 300)).toBe("on");
    expect(hoursStatus(300, 300)).toBe("on");
    expect(hoursStatus(-300, 300)).toBe("on");
    expect(hoursStatus(301, 300)).toBe("over");
    expect(hoursStatus(-301, 300)).toBe("under");
  });

  it("formats hours and signed differences", () => {
    expect(formatHours(0)).toBe("–");
    expect(formatHours(null)).toBe("–");
    expect(formatHours(480)).toBe("8");
    expect(formatHours(450)).toBe("7.5");
    expect(formatSignedHours(270)).toBe("+4.5");
    expect(formatSignedHours(-120)).toBe("−2");
    expect(formatSignedHours(2)).toBe("0");
    expect(formatSignedHours(null)).toBe("–");
  });
});

describe("buildWorkingHoursYear", () => {
  const slotMinutesById = slotMinutesFromTemplate({
    version: 4,
    blocks: [],
    locations: [
      {
        locationId: "loc",
        rowBands: [],
        colBands: [],
        slots: [
          { id: "day", locationId: "loc", rowBandId: "r", colBandId: "c", blockId: "b", startTime: "08:00", endTime: "16:00" },
          { id: "night", locationId: "loc", rowBandId: "r", colBandId: "c", blockId: "b", startTime: "19:00", endTime: "07:00", endDayOffset: 1 },
        ],
      },
    ],
  });
  const W44 = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
  const W45 = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  const W46 = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
  let nextId = 0;
  const shift = (clinicianId: string, dateISO: string, rowId = "day"): Assignment => ({
    id: `a${(nextId += 1)}`,
    rowId,
    dateISO,
    clinicianId,
  });
  const clinicians: HoursClinician[] = [
    { id: "ann", workingHoursPerWeek: 40 },
    // 20 h a week, ± 2 h, on vacation Wed–Fri of W45.
    { id: "ben", workingHoursPerWeek: 20, workingHoursToleranceHours: 2, vacations: [{ startISO: "2026-11-04", endISO: "2026-11-06" }] },
    { id: "cat" }, // no contract hours
  ];
  const assignments: Assignment[] = [
    // W44: a single test entry, far below half of the team's 60 h target.
    shift("ann", W44[6], "night"),
    // W45: Ann Mon–Fri (40 h), Ben Mon + Tue (16 h), Cat Wed (8 h), rest day and other years.
    ...W45.slice(0, 5).map((dateISO) => shift("ann", dateISO)),
    shift("ben", W45[0]),
    shift("ben", W45[1]),
    shift("cat", W45[2]),
    { id: "rest", rowId: "pool-rest-day", dateISO: W45[5], clinicianId: "ann" },
    shift("ann", "2025-11-03"),
    shift("ghost", W45[0]),
    // W46: Ann 3 days (24 h, under), Ben 3 days with an unknown slot (8 h each).
    ...W46.slice(0, 3).map((dateISO) => shift("ann", dateISO)),
    ...W46.slice(0, 3).map((dateISO) => shift("ben", dateISO, "unknown-slot")),
  ];
  const data = buildWorkingHoursYear({ year: 2026, clinicians, assignments, slotMinutesById });
  const [ann, ben, cat] = data.people;
  const i44 = weekIndexOf(data.weeks, W44[0]);
  const i45 = weekIndexOf(data.weeks, W45[0]);
  const i46 = weekIndexOf(data.weeks, W46[0]);

  it("counts a week once half of the team's target hours are planned", () => {
    expect(COUNTED_WEEK_SHARE).toBe(0.5);
    // W44: 12 of 60 target hours (20 %) → not counted; W45 and W46 are.
    expect(data.team[i44]).toMatchObject({ plannedMinutes: 720, targetMinutes: 3600, counted: false });
    expect([...data.countedWeeks]).toEqual([i45, i46]);
    // The test entry still shows as planned hours of its week, without a target.
    expect(ann.weeks[i44]).toMatchObject({ plannedMinutes: 720, counted: false, targetMinutes: null, status: null, balanceMinutes: null });
  });

  it("compares a counted week with the contract, scaled by the days not on vacation", () => {
    expect(ann.weeks[i45]).toMatchObject({ plannedMinutes: 2400, targetMinutes: 2400, differenceMinutes: 0, status: "on" });
    expect(ann.weeks[i45].toleranceMinutes).toBe(300);
    // Ben: 3 vacation days → target 20 h × 4/7, tolerance 2 h × 4/7.
    const benWeek = ben.weeks[i45];
    expect(benWeek.vacationDates).toEqual(new Set(["2026-11-04", "2026-11-05", "2026-11-06"]));
    expect(benWeek.targetMinutes).toBeCloseTo((20 * 60 * 4) / 7);
    expect(benWeek.toleranceMinutes).toBeCloseTo((2 * 60 * 4) / 7);
    expect(benWeek.status).toBe("over");
    // No contract: hours, but nothing to compare with.
    expect(cat.weeks[i45]).toMatchObject({ plannedMinutes: 480, targetMinutes: null, status: null });
    expect(cat).toMatchObject({ weeklyHours: null, targetMinutes: null, balanceMinutes: null });
  });

  it("keeps day details: minutes, shifts and rest days per date", () => {
    const week = ann.weeks[i45];
    expect(week.minutesByDate.get(W45[0])).toBe(480);
    expect(week.rowIdsByDate.get(W45[0])).toEqual(["day"]);
    expect(week.restDates).toEqual(new Set([W45[5]]));
    expect(week.minutesByDate.has(W45[5])).toBe(false);
  });

  it("runs the balance over the counted weeks and sums only those", () => {
    expect(ann.weeks[i46]).toMatchObject({ plannedMinutes: 1440, differenceMinutes: -960, status: "under", balanceMinutes: -960 });
    // An unknown slot counts 8 hours.
    expect(ben.weeks[i46].plannedMinutes).toBe(3 * 480);
    expect(ann).toMatchObject({ plannedMinutes: 3840, targetMinutes: 4800, balanceMinutes: -960 });
    expect(ben.balanceMinutes).toBeCloseTo(960 - (20 * 60 * 4) / 7 + 1440 - 1200);
  });

  it("gives a week spent on vacation no target and no status", () => {
    const away = buildWorkingHoursYear({
      year: 2026,
      clinicians: [...clinicians, { id: "dan", workingHoursPerWeek: 30, vacations: [{ startISO: "2026-11-02", endISO: "2026-11-08" }] }],
      assignments,
      slotMinutesById,
    }).people[3];
    expect(away.weeks[i45]).toMatchObject({ counted: true, targetMinutes: 0, status: null, balanceMinutes: 0 });
  });

  it("falls back to 'any shift' when nobody has contract hours", () => {
    const loose = buildWorkingHoursYear({
      year: 2026,
      clinicians: [{ id: "cat" }],
      assignments: [shift("cat", W44[2])],
      slotMinutesById,
    });
    expect([...loose.countedWeeks]).toEqual([i44]);
    expect(loose.people[0]).toMatchObject({ plannedMinutes: 480, targetMinutes: null });
  });
});

describe("buildWorkingHoursYear with real shift time (v1.82 merge)", () => {
  it("counts a night across the October clock change with its real length", () => {
    // 16:00–08:00 from Saturday 24.10.2026: 17 h in Europe/Berlin (the clocks go back).
    const data = buildWorkingHoursYear({
      year: 2026,
      clinicians: [{ id: "n", vacations: [] }],
      assignments: [{ id: "a", rowId: "duty", dateISO: "2026-10-24", clinicianId: "n" }],
      slotMinutesById: new Map([["duty", 16 * 60]]),
      minutesOf: (rowId, dateISO) => (rowId === "duty" && dateISO === "2026-10-24" ? 17 * 60 : undefined),
    });
    const week = data.people[0].weeks[weekIndexOf(data.weeks, "2026-10-24")];
    expect(week.minutesByDate.get("2026-10-24")).toBe(17 * 60);
    expect(week.plannedMinutes).toBe(17 * 60);
  });
});
