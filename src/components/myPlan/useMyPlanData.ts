import { useMemo } from "react";
import type { Location, PlanRange } from "../../api/client";
import { toISODate } from "../../lib/date";
import {
  addDaysISO,
  buildPersonPlan,
  countAbsenceDays,
  findCoworkers,
  monthSheetRange,
  sumHours,
  weekStartISO,
  type PersonPlan,
  type PlanSource,
} from "../../lib/myPlan";
import { buildDayLanes, type DayLanesResult } from "./buildDayLanes";
import { buildLegend, type LegendResult } from "./legend";
import type { BlockCoworker } from "./types";

// Data of the My-plan container: the visible range, the viewed person's
// plan, day-view lanes, week sums and the legend — all memoized on the
// inputs that matter (the clock only changes `todayISO` once a day).

/** First and last visible day of a range around the anchor. */
export function visibleRange(range: PlanRange, anchor: Date): { fromISO: string; toISO: string } {
  const anchorISO = toISODate(anchor);
  if (range === "day") return { fromISO: anchorISO, toISO: anchorISO };
  if (range === "week") {
    const fromISO = weekStartISO(anchorISO);
    return { fromISO, toISO: addDaysISO(fromISO, 6) };
  }
  return monthSheetRange(anchor);
}

export type MyPlanData = {
  fromISO: string;
  toISO: string;
  plan: PersonPlan | null;
  dayLanes: DayLanesResult | null;
  /** Week range: same-duty colleagues per own shift starting in the week (block avatars). */
  sameDutyByShift: Map<string, BlockCoworker[]>;
  /** Hours per ISO week of the visible days (month views), keyed by Monday. */
  weekHours: Map<string, number>;
  /** ISO week of the anchor (footer). */
  week: { fromISO: string; toISO: string; hours: number; vacationDays: number };
  legend: LegendResult;
};

export function useMyPlanData(input: {
  source: PlanSource;
  locationsById: Map<string, Location>;
  viewedId: string | null;
  myClinicianId: string | null;
  range: PlanRange;
  anchorDate: Date;
  todayISO: string;
}): MyPlanData {
  const { source, locationsById, viewedId, myClinicianId, range, anchorDate, todayISO } = input;
  const anchorISO = toISODate(anchorDate);
  const { fromISO, toISO } = useMemo(
    () => visibleRange(range, anchorDate),
    // anchorISO stands for anchorDate (often a new Date object per render upstream).
    [range, anchorISO],
  );

  const plan = useMemo(
    () => (viewedId ? buildPersonPlan({ ...source, clinicianId: viewedId, fromISO, toISO, todayISO }) : null),
    [source, viewedId, fromISO, toISO, todayISO],
  );

  const dayLanes = useMemo(
    () =>
      plan && range === "day"
        ? buildDayLanes({ source, plan, dateISO: fromISO, todayISO, myClinicianId })
        : null,
    [plan, range, source, fromISO, todayISO, myClinicianId],
  );

  const sameDutyByShift = useMemo(() => {
    const map = new Map<string, BlockCoworker[]>();
    if (!plan || range !== "week") return map;
    const indexById = new Map(source.clinicians.map((clinician, index) => [clinician.id, index]));
    for (const shift of plan.shifts.values()) {
      if (shift.dateISO < fromISO || shift.dateISO > toISO) continue;
      const { sameDuty } = findCoworkers(source, shift);
      if (sameDuty.length === 0) continue;
      map.set(
        shift.id,
        sameDuty.map((coworker) => ({
          clinicianId: coworker.clinicianId,
          name: coworker.name,
          colorIndex: indexById.get(coworker.clinicianId) ?? 0,
        })),
      );
    }
    return map;
  }, [plan, range, source, fromISO, toISO]);

  const weekHours = useMemo(() => {
    const map = new Map<string, number>();
    if (!plan) return map;
    for (let i = 0; i < plan.days.length; i += 7) {
      const monday = weekStartISO(plan.days[i].dateISO);
      map.set(monday, sumHours(plan, monday, addDaysISO(monday, 6)));
    }
    return map;
  }, [plan]);

  const week = useMemo(() => {
    const weekFrom = weekStartISO(anchorISO);
    const weekTo = addDaysISO(weekFrom, 6);
    return {
      fromISO: weekFrom,
      toISO: weekTo,
      hours: plan ? sumHours(plan, weekFrom, weekTo) : 0,
      vacationDays: plan ? countAbsenceDays(plan, "vacation", weekFrom, weekTo) : 0,
    };
  }, [plan, anchorISO]);

  const legend = useMemo<LegendResult>(() => {
    if (!plan) return { items: [], hasDraft: false };
    const lanePlans = dayLanes ? dayLanes.lanes.slice(1).map((lane) => lane.plan) : [];
    return buildLegend({ days: plan.days, plans: [plan, ...lanePlans], locationsById });
  }, [plan, dayLanes, locationsById]);

  return { fromISO, toISO, plan, dayLanes, sameDutyByShift, weekHours, week, legend };
}
