import { describe, expect, it } from "vitest";
import { toISODate } from "../date";
import { blockDetailLevel, dayWindow, minutesToPx, segmentBox } from "./layout";
import { absenceRuns, buildMonthWeeks, isSameMonth, monthSheetRange } from "./month";
import { findCoworkers } from "./coworkers";
import { buildPersonPlan } from "./timeline";
import { makeSource } from "./testFixtures";
import type { PlanSegment } from "./types";

const source = makeSource();
const plan = buildPersonPlan({
  ...source,
  clinicianId: "lh",
  fromISO: "2026-10-12",
  toISO: "2026-10-18",
  todayISO: "2026-10-14",
});
const night = [...plan.shifts.values()].find(
  (shift) => shift.title === "Nachtdienst" && shift.dateISO === "2026-10-14",
)!;
const segment = (startMin: number, endMin: number, key = `${startMin}`): PlanSegment => ({
  key,
  shiftId: key,
  dateISO: "2026-10-12",
  startMin,
  endMin,
  cutStart: false,
  cutEnd: false,
  lane: 0,
  lanes: 1,
});
const WEEK_TOP = { windowStartMin: 0, windowEndMin: 1440, pxPerHour: 24 };

describe("segmentBox (SPEC R5)", () => {
  it("grows a short block upwards when the next shift starts right after", () => {
    const [fb, mrt] = plan.days[0].segments;
    expect(minutesToPx(fb.startMin, 0, 24)).toBe(180);
    expect(segmentBox(fb, plan.days[0].segments, WEEK_TOP)).toEqual({ offsetPx: 174, sizePx: 18 });
    expect(segmentBox(mrt, plan.days[0].segments, WEEK_TOP)).toEqual({ offsetPx: 192, sizePx: 204 });
  });

  it("grows downwards into free time otherwise and stays inside the window", () => {
    const short = segment(600, 615);
    expect(segmentBox(short, [short], WEEK_TOP)).toEqual({ offsetPx: 240, sizePx: 18 });
    const atMidnight = segment(1430, 1440);
    expect(segmentBox(atMidnight, [atMidnight], WEEK_TOP)).toEqual({ offsetPx: 558, sizePx: 18 });
    // At the window start it cannot grow up: it fills the gap instead of covering the next one.
    const first = segment(0, 10, "a");
    const next = segment(10, 600, "b");
    expect(segmentBox(first, [first, next], WEEK_TOP)).toEqual({ offsetPx: 0, sizePx: 4 });
  });

  it("stops at a neighbour that starts a few minutes later and grows up instead", () => {
    const short = segment(480, 495, "short"); // 08:00–08:15 → 192–198 px
    const next = segment(500, 720, "next"); // 08:20 → 200 px
    expect(segmentBox(short, [short, next], WEEK_TOP)).toEqual({ offsetPx: 182, sizePx: 18 });
  });

  it("never lets a chain of short touching blocks overlap", () => {
    const chain = [segment(470, 480, "a"), segment(480, 490, "b"), segment(490, 720, "c")];
    const boxes = chain.map((item) => segmentBox(item, chain, WEEK_TOP));
    expect(boxes).toEqual([
      { offsetPx: 174, sizePx: 18 }, // grows up into free time
      { offsetPx: 192, sizePx: 4 }, // squeezed: fills the gap
      { offsetPx: 196, sizePx: 92 },
    ]);
  });

  it("ignores segments in the other lane of a two-lane cluster", () => {
    const left = { ...segment(480, 490, "left"), lanes: 2 as const };
    const right = { ...segment(485, 600, "right"), lane: 1 as const, lanes: 2 as const };
    const below = { ...segment(495, 600, "below"), lanes: 2 as const };
    expect(segmentBox(left, [left, right], WEEK_TOP)).toEqual({ offsetPx: 192, sizePx: 18 });
    expect(segmentBox(left, [left, right, below], WEEK_TOP)).toEqual({ offsetPx: 180, sizePx: 18 });
  });
});

describe("dayWindow / blockDetailLevel", () => {
  it("extends the day view to the night's end and to the continuation's start (SPEC D7)", () => {
    const { sameDuty, sameTimeAtLocation } = findCoworkers(source, night);
    const lanes = [night, ...[...sameDuty, ...sameTimeAtLocation].map((c) => c.shift)];
    expect(dayWindow(plan.days[2], lanes)).toEqual({ startMin: 360, endMin: 1920 });
    expect(dayWindow(plan.days[3], plan.shifts.values())).toEqual({ startMin: 0, endMin: 1320 });
    expect(dayWindow(plan.days[5], plan.shifts.values())).toEqual({ startMin: 360, endMin: 1320 });
  });

  it("caps the window at next day 12:00", () => {
    const longShift = { ...night, endMin: 1020 + 24 * 60 };
    expect(dayWindow(plan.days[2], [longShift]).endMin).toBe(2160);
  });

  it("picks the text level by block size", () => {
    expect(blockDetailLevel(204, "vertical")).toBe("full");
    expect(blockDetailLevel(40, "vertical")).toBe("medium");
    expect(blockDetailLevel(18, "vertical")).toBe("line");
    expect(blockDetailLevel(12, "vertical")).toBe("tiny");
    expect(blockDetailLevel(357, "horizontal")).toBe("full");
    expect(blockDetailLevel(20, "horizontal")).toBe("tiny");
  });
});

describe("month helpers", () => {
  it("covers October 2026 with five Monday-first weeks (SPEC D5: 28.09.–01.11.)", () => {
    const weeks = buildMonthWeeks(new Date(2026, 9, 14));
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7 && week[0].getDay() === 1)).toBe(true);
    expect(monthSheetRange(new Date(2026, 9, 14))).toEqual({ fromISO: "2026-09-28", toISO: "2026-11-01" });
    expect(isSameMonth(weeks[0][0], new Date(2026, 9, 1))).toBe(false);
    expect(toISODate(weeks[4][6])).toBe("2026-11-01");
  });

  it("merges consecutive vacation days into one run", () => {
    const month = buildPersonPlan({
      ...source,
      clinicianId: "lh",
      ...monthSheetRange(new Date(2026, 9, 1)),
      todayISO: "2026-10-14",
    });
    expect(absenceRuns(month.days)).toEqual([
      { kind: "vacation", startISO: "2026-10-19", endISO: "2026-10-23", days: 5 },
    ]);
    expect(absenceRuns(month.days, "rest").map((run) => run.startISO)).toEqual(["2026-10-09", "2026-10-15"]);
  });
});
