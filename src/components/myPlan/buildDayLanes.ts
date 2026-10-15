import {
  buildPersonPlan,
  findCoworkers,
  type PersonPlan,
  type PlanSource,
} from "../../lib/myPlan";
import type { DayLane } from "./types";

// Day-view lanes (plan §2.5): the viewed person first, then colleagues who
// work with them that day — "Same duty" before "Same time at location",
// each by start time. Colleagues beyond the lane limit, and those at the
// location without overlap, are only counted ("+N more at location").

export const MAX_DAY_LANES = 6;

export type DayLanesResult = { lanes: DayLane[]; hiddenColleagueCount: number };

export function buildDayLanes(input: {
  source: PlanSource;
  /** Plan of the viewed person covering exactly the visible day. */
  plan: PersonPlan;
  dateISO: string;
  todayISO: string;
  /** Linked "I am" person (lane.isMe); the first lane is group "me" either way. */
  myClinicianId: string | null;
  maxLanes?: number;
}): DayLanesResult {
  const { source, plan, dateISO, todayISO, myClinicianId, maxLanes = MAX_DAY_LANES } = input;
  const nameById = new Map(source.clinicians.map((clinician) => [clinician.id, clinician.name]));
  const indexById = new Map(source.clinicians.map((clinician, index) => [clinician.id, index]));
  const ownerLane: DayLane = {
    clinicianId: plan.clinicianId,
    name: nameById.get(plan.clinicianId) ?? plan.clinicianId,
    colorIndex: indexById.get(plan.clinicianId) ?? 0,
    isMe: plan.clinicianId === myClinicianId,
    group: "me",
    plan,
  };

  const day = plan.days.find((item) => item.dateISO === dateISO);
  const shiftIds = [...new Set(day?.segments.map((segment) => segment.shiftId) ?? [])];
  const groupById = new Map<string, "sameDuty" | "sameTimeAtLocation">();
  const sameDuty: string[] = [];
  const sameTime: string[] = [];
  const others = new Set<string>();
  for (const shiftId of shiftIds) {
    const shift = plan.shifts.get(shiftId);
    if (!shift) continue;
    const groups = findCoworkers(source, shift);
    for (const coworker of groups.sameDuty) {
      if (groupById.get(coworker.clinicianId) === "sameDuty") continue;
      groupById.set(coworker.clinicianId, "sameDuty");
      sameDuty.push(coworker.clinicianId);
    }
    for (const coworker of groups.sameTimeAtLocation) {
      if (groupById.has(coworker.clinicianId)) continue;
      groupById.set(coworker.clinicianId, "sameTimeAtLocation");
      sameTime.push(coworker.clinicianId);
    }
    // "Others at the location" share the start day — only for shifts starting today.
    if (shift.dateISO === dateISO) {
      for (const coworker of groups.otherAtLocation) others.add(coworker.clinicianId);
    }
  }
  // A colleague promoted to "same duty" by a later shift leaves "same time".
  const ordered = [...sameDuty, ...sameTime.filter((id) => groupById.get(id) === "sameTimeAtLocation")];

  // Only colleagues who actually appear on the visible day get a lane (a
  // night overlaps colleagues of the evening before, too).
  const colleagues: DayLane[] = [];
  for (const clinicianId of ordered) {
    if (clinicianId === plan.clinicianId) continue;
    const lanePlan = buildPersonPlan({ ...source, clinicianId, fromISO: dateISO, toISO: dateISO, todayISO });
    if (!lanePlan.days[0]?.segments.length) continue;
    colleagues.push({
      clinicianId,
      name: nameById.get(clinicianId) ?? clinicianId,
      colorIndex: indexById.get(clinicianId) ?? 0,
      isMe: clinicianId === myClinicianId,
      group: groupById.get(clinicianId) ?? "sameTimeAtLocation",
      plan: lanePlan,
    });
  }

  const shown = colleagues.slice(0, Math.max(0, maxLanes - 1));
  const shownIds = new Set(shown.map((lane) => lane.clinicianId));
  const hidden = new Set(colleagues.filter((lane) => !shownIds.has(lane.clinicianId)).map((lane) => lane.clinicianId));
  for (const id of others) {
    if (id !== plan.clinicianId && !shownIds.has(id)) hidden.add(id);
  }
  return { lanes: [ownerLane, ...shown], hiddenColleagueCount: hidden.size };
}
