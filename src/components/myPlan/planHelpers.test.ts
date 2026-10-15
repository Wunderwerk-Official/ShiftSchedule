import { describe, expect, it, vi } from "vitest";
import type { Location } from "../../api/client";
import { buildPersonPlan, type PersonPlan } from "../../lib/myPlan";
import { LOCATIONS, makeSource } from "../../lib/myPlan/testFixtures";
import { DEFAULT_PREFERENCES, normalizePreferences } from "../../lib/userPreferences";
import { buildDayLanes } from "./buildDayLanes";
import { buildLegend } from "./legend";
import { formatDateSpan, monthWeekGroups, vacationSegments } from "./monthParts";
import { formatNextUpWhen } from "./NextUpChip";
import { initialsOf } from "./planChrome";
import { stepAnchor } from "./PeriodNavigator";
import { visibleRange } from "./useMyPlanData";
import {
  applyViewConfig,
  currentViewConfig,
  describeView,
  orientationLabel,
  orientationTooltip,
} from "./viewConfig";

const source = makeSource();
const locationsById = new Map<string, Location>(LOCATIONS.map((location) => [location.id, location]));
const TODAY = "2026-10-14";

function planFor(clinicianId: string, fromISO: string, toISO: string): PersonPlan {
  return buildPersonPlan({ ...source, clinicianId, fromISO, toISO, todayISO: TODAY });
}

describe("viewConfig", () => {
  it("labels orientations per range, with the Momentum wording in the tooltip", () => {
    expect(orientationLabel("week", "top")).toEqual({ title: "Date on top", subtitle: "Days side by side" });
    expect(orientationLabel("week", "left").subtitle).toBe("Days stacked");
    expect(orientationLabel("month", "left").subtitle).toBe("List");
    expect(orientationLabel("day", "left").subtitle).toBe("Time runs right");
    expect(orientationTooltip("week", "top")).toContain("In Momentum: 'timeline left'");
    expect(orientationTooltip("day", "left")).toContain("'timeline top'");
  });

  it("describes the current view; team views are canonical", () => {
    const prefs = normalizePreferences({
      myPlanRange: "month",
      orientationByRange: { month: "left" },
      teamColorBy: "person",
    });
    const me = currentViewConfig(prefs, "me");
    expect(me).toMatchObject({ scope: "me", range: "month", orientation: "left" });
    expect(describeView(me)).toBe("My plan · Month · List");
    const team = currentViewConfig(prefs, "team");
    expect(team).toEqual({ scope: "team", range: "week", orientation: "top", colorBy: "person" });
    expect(describeView(team)).toBe("Team · Color by person");
    expect(describeView({ ...me, range: "week", orientation: "top" })).toBe("My plan · Week · Date on top");
  });

  it("applies a view: My plan sets range + its orientation, team sets colorBy, scope last", () => {
    const calls: string[] = [];
    let prefs = { ...DEFAULT_PREFERENCES };
    const update = vi.fn((change) => {
      calls.push("prefs");
      prefs = typeof change === "function" ? change(prefs) : { ...prefs, ...change };
    });
    const scope = vi.fn(() => calls.push("scope"));
    applyViewConfig({ scope: "me", range: "day", orientation: "left", colorBy: "section" }, scope, update);
    expect(prefs.myPlanRange).toBe("day");
    expect(prefs.orientationByRange).toEqual({ day: "left", week: "top", month: "top" });
    expect(scope).toHaveBeenLastCalledWith("me");
    applyViewConfig({ scope: "team", range: "month", orientation: "left", colorBy: "person" }, scope, update);
    expect(prefs.teamColorBy).toBe("person");
    expect(prefs.myPlanRange).toBe("day");
    expect(calls).toEqual(["prefs", "scope", "prefs", "scope"]);
  });
});

describe("ranges and labels", () => {
  it("computes the visible range per period", () => {
    const anchor = new Date(2026, 9, 14);
    expect(visibleRange("day", anchor)).toEqual({ fromISO: TODAY, toISO: TODAY });
    expect(visibleRange("week", anchor)).toEqual({ fromISO: "2026-10-12", toISO: "2026-10-18" });
    expect(visibleRange("month", anchor)).toEqual({ fromISO: "2026-09-28", toISO: "2026-11-01" });
  });

  it("steps the anchor by one period (months from the first)", () => {
    const anchor = new Date(2026, 9, 31);
    expect(stepAnchor("day", anchor, 1).getDate()).toBe(1);
    expect(stepAnchor("week", anchor, -1).getDate()).toBe(24);
    const next = stepAnchor("month", anchor, 1);
    expect([next.getMonth(), next.getDate()]).toEqual([10, 1]);
  });

  it("formats initials, date spans and the next-up time", () => {
    expect(initialsOf("Dr. Lena Hoffmann")).toBe("LH");
    expect(initialsOf("Jonas")).toBe("J");
    expect(formatDateSpan("2026-10-19", "2026-10-23")).toBe("19–23 Oct");
    expect(formatDateSpan("2026-09-28", "2026-10-04")).toBe("28 Sep – 4 Oct");
    const week = planFor("lh", "2026-10-12", "2026-10-18");
    const night = week.shifts.get(week.days[2].segments[0].shiftId)!;
    expect(formatNextUpWhen(night, TODAY)).toBe("today 17:00 – Thu 08:00");
    expect(formatNextUpWhen(night, "2026-10-13")).toBe("tomorrow 17:00 – Thu 08:00");
  });
});

describe("buildLegend", () => {
  it("lists visible sections, duties, absences and tinted locations in group order", () => {
    const week = planFor("lh", "2026-10-12", "2026-10-18");
    const { items, hasDraft } = buildLegend({ days: week.days, plans: [week], locationsById });
    const groups = items.map((item) => item.group);
    expect(groups).toEqual([...groups].sort((a, b) =>
      ["section", "duty", "absence", "location", "state"].indexOf(a) -
      ["section", "duty", "absence", "location", "state"].indexOf(b)));
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["Frühbesprechung", "MRT", "Nachtdienst", "Klinikum Mitte", "MVZ Nord"]));
    expect(items.find((item) => item.label === "Nachtdienst")?.group).toBe("duty");
    expect(items.some((item) => item.swatch.kind === "rest")).toBe(true);
    expect(hasDraft).toBe(false);
  });

  it("flags drafts in unpublished weeks", () => {
    const week44 = planFor("lh", "2026-10-26", "2026-11-01");
    expect(buildLegend({ days: week44.days, plans: [week44], locationsById }).hasDraft).toBe(true);
  });
});

describe("month helpers", () => {
  it("groups the month list per ISO week and keeps full-week vacation runs", () => {
    const sheet = planFor("lh", "2026-09-28", "2026-11-01");
    const groups = monthWeekGroups(sheet.days, new Date(2026, 9, 1));
    expect(groups.map((group) => group.weekNumber)).toEqual([40, 41, 42, 43, 44]);
    expect(groups[0].days).toHaveLength(4);
    expect(groups[3].vacationDays).toBe(5);
    expect(groups[4].draft).toBe(true);
    expect(groups[2].draft).toBe(false);
    const week43 = sheet.days.slice(21, 28);
    const [bar] = vacationSegments(sheet.days, week43);
    expect(bar).toMatchObject({ startIndex: 0, endIndex: 4 });
    expect(bar.label).toContain("19–23 Oct (5 days)");
  });
});

describe("buildDayLanes", () => {
  it("puts me first, then same duty before same time at location, and counts the rest", () => {
    const day = planFor("lh", TODAY, TODAY);
    const { lanes, hiddenColleagueCount } = buildDayLanes({
      source,
      plan: day,
      dateISO: TODAY,
      todayISO: TODAY,
      myClinicianId: "lh",
    });
    expect(lanes[0]).toMatchObject({ clinicianId: "lh", isMe: true, group: "me" });
    expect(lanes.length).toBeLessThanOrEqual(6);
    const groups = lanes.slice(1).map((lane) => lane.group);
    expect(groups.indexOf("sameTimeAtLocation")).toBeGreaterThan(groups.lastIndexOf("sameDuty"));
    expect(lanes.find((lane) => lane.clinicianId === "jw")?.group).toBe("sameDuty");
    for (const lane of lanes.slice(1)) expect(lane.plan.days[0].segments.length).toBeGreaterThan(0);
    expect(hiddenColleagueCount).toBeGreaterThanOrEqual(0);
  });

  it("limits the lanes and counts hidden colleagues", () => {
    const day = planFor("lh", TODAY, TODAY);
    const all = buildDayLanes({ source, plan: day, dateISO: TODAY, todayISO: TODAY, myClinicianId: "lh", maxLanes: 20 });
    const two = buildDayLanes({ source, plan: day, dateISO: TODAY, todayISO: TODAY, myClinicianId: "lh", maxLanes: 2 });
    expect(two.lanes).toHaveLength(2);
    expect(two.hiddenColleagueCount).toBe(all.hiddenColleagueCount + all.lanes.length - 2);
  });

  it("marks isMe only for the linked person when viewing someone else", () => {
    const day = planFor("jw", TODAY, TODAY);
    const { lanes } = buildDayLanes({ source, plan: day, dateISO: TODAY, todayISO: TODAY, myClinicianId: "lh" });
    expect(lanes[0]).toMatchObject({ clinicianId: "jw", isMe: false, group: "me" });
    expect(lanes.find((lane) => lane.clinicianId === "lh")?.isMe).toBe(true);
  });
});
