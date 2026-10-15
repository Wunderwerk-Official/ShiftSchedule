import type { Assignment } from "../../api/client";
import { getDayType } from "../dayTypes";
import { buildRenderedAssignmentMap, REST_DAY_POOL_ID, VACATION_POOL_ID } from "../schedule";
import { locationTint } from "./colors";
import {
  MINUTES_PER_DAY,
  addDaysISO,
  dayDiff,
  listDaysISO,
  parseISODate,
  weekStartISO,
} from "./dates";
import { countedHours, withCountedHours } from "./hours";
import { collectShifts, createPlanContext, isOnVacation, type PlanContext } from "./shifts";
import type {
  LocationTint,
  PersonPlan,
  PlanAbsence,
  PlanDay,
  PlanSegment,
  PlanShift,
  PlanSource,
  TintBand,
} from "./types";

// Builds one person's plan for a visible date range. Shifts are read from a
// week before to a week after the range: that loads the night that started
// the day before (and up to 3-day shifts), and gives rest/next lookups context.

const CONTEXT_DAYS = 7;

export type PersonPlanInput = PlanSource & {
  clinicianId: string;
  /** First visible day. */
  fromISO: string;
  /** Last visible day (inclusive). */
  toISO: string;
  todayISO: string;
};

export function buildPersonPlan(input: PersonPlanInput): PersonPlan {
  const ctx = createPlanContext(input);
  const contextFrom = addDaysISO(input.fromISO, -CONTEXT_DAYS);
  const contextTo = addDaysISO(input.toISO, CONTEXT_DAYS);
  const shiftList = withCountedHours(
    collectShifts(ctx, { fromISO: contextFrom, toISO: contextTo, clinicianId: input.clinicianId }),
  );
  const absences = buildAbsences(ctx, input.clinicianId, contextFrom, contextTo, shiftList);
  const absencesByDate = new Map<string, PlanAbsence[]>();
  for (const absence of absences) {
    absencesByDate.set(absence.dateISO, [...(absencesByDate.get(absence.dateISO) ?? []), absence]);
  }
  const days = listDaysISO(input.fromISO, input.toISO).map((dateISO) =>
    buildDay(ctx, dateISO, input.todayISO, shiftList, absencesByDate.get(dateISO) ?? []),
  );
  return {
    clinicianId: input.clinicianId,
    fromISO: input.fromISO,
    toISO: input.toISO,
    days,
    shifts: new Map(shiftList.map((shift) => [shift.id, shift])),
    absences,
  };
}

// Day-relative window of a shift on `dateISO` (may start < 0 or end > 1440).
function relativeSpan(shift: PlanShift, dateISO: string) {
  const offset = dayDiff(dateISO, shift.dateISO) * MINUTES_PER_DAY;
  return { start: offset + shift.startMin, end: offset + shift.endMin };
}

// Minute at which the day's own work ends (continuations and shifts of the
// day, capped at midnight); 0 = no work that day.
function workEnd(shifts: PlanShift[], dateISO: string): number {
  let end = 0;
  for (const shift of shifts) {
    const span = relativeSpan(shift, dateISO);
    if (span.start < MINUTES_PER_DAY && span.end > 0) end = Math.max(end, Math.min(span.end, MINUTES_PER_DAY));
  }
  return end;
}

function buildAbsences(
  ctx: PlanContext,
  clinicianId: string,
  fromISO: string,
  toISO: string,
  shifts: PlanShift[],
): PlanAbsence[] {
  const clinician = ctx.clinicianById.get(clinicianId);
  if (!clinician) return [];
  const dates = listDaysISO(fromISO, toISO);
  // Rest days exactly as the team grid shows them (explicit Rest Day pool
  // entries plus on-call rest days before/after), via the shared renderer.
  // On-call rest is derived from on-call shifts a few days away, so the
  // renderer gets assignments from a margin beyond the dates it renders.
  const ownAssignments = ctx.source.assignments.filter(
    (assignment) =>
      assignment.clinicianId === clinicianId &&
      assignment.dateISO >= addDaysISO(fromISO, -CONTEXT_DAYS) &&
      assignment.dateISO <= addDaysISO(toISO, CONTEXT_DAYS),
  );
  const assignmentMap = new Map<string, Assignment[]>();
  for (const assignment of ownAssignments) {
    const key = `${assignment.rowId}__${assignment.dateISO}`;
    assignmentMap.set(key, [...(assignmentMap.get(key) ?? []), assignment]);
  }
  const rendered = buildRenderedAssignmentMap(
    assignmentMap,
    [clinician],
    dates.map(parseISODate),
    { scheduleRows: ctx.source.scheduleRows, solverSettings: ctx.source.solverSettings },
  );
  const explicitVacation = new Set(
    ownAssignments.filter((a) => a.rowId === VACATION_POOL_ID).map((a) => a.dateISO),
  );
  const explicitRest = new Set(
    ownAssignments.filter((a) => a.rowId === REST_DAY_POOL_ID).map((a) => a.dateISO),
  );
  const shiftStartDays = new Set(shifts.map((shift) => shift.dateISO));
  const labelOf = (rowId: string, fallback: string) => ctx.rowById.get(rowId)?.name || fallback;
  const absences: PlanAbsence[] = [];
  for (const dateISO of dates) {
    if (isOnVacation(clinician, dateISO) || explicitVacation.has(dateISO)) {
      absences.push({
        kind: "vacation",
        dateISO,
        startMin: 0,
        label: labelOf(VACATION_POOL_ID, "Vacation"),
      });
    } else if (rendered.get(`${REST_DAY_POOL_ID}__${dateISO}`)?.length) {
      // SPEC R3: a rest day never sits next to work of the same day. A derived
      // on-call rest day is dropped where a shift starts; an explicit one
      // starts after the day's work (a night continuation, or the shift).
      if (!explicitRest.has(dateISO) && shiftStartDays.has(dateISO)) continue;
      const startMin = workEnd(shifts, dateISO);
      if (startMin >= MINUTES_PER_DAY) continue;
      absences.push({
        kind: "rest",
        dateISO,
        startMin,
        label: labelOf(REST_DAY_POOL_ID, "Rest day"),
      });
    }
  }
  return absences;
}

// Overlapping segments share the lane: clusters of overlapping segments get
// two lanes; the longer (earlier-sorted) segment takes lane 0.
function assignLanes(segments: PlanSegment[]): PlanSegment[] {
  const result: PlanSegment[] = [];
  let cluster: PlanSegment[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds = [-1, -1];
    for (const segment of cluster) {
      let lane: 0 | 1 = 0;
      if (cluster.length > 1) {
        if (segment.startMin >= laneEnds[0]) lane = 0;
        else if (segment.startMin >= laneEnds[1]) lane = 1;
        else lane = laneEnds[0] <= laneEnds[1] ? 0 : 1;
        laneEnds[lane] = Math.max(laneEnds[lane], segment.endMin);
      }
      result.push({ ...segment, lane, lanes: cluster.length > 1 ? 2 : 1 });
    }
    cluster = [];
  };
  for (const segment of segments) {
    if (cluster.length && segment.startMin >= clusterEnd) flush();
    if (!cluster.length) clusterEnd = segment.endMin;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.endMin);
  }
  if (cluster.length) flush();
  return result;
}

function buildSegments(shifts: PlanShift[], dateISO: string): PlanSegment[] {
  const segments: PlanSegment[] = [];
  for (const shift of shifts) {
    const span = relativeSpan(shift, dateISO);
    const startsHere = span.start >= 0 && span.start < MINUTES_PER_DAY;
    // Zero-length shifts (misconfigured slot) still show on their start day.
    const overlaps = span.start < MINUTES_PER_DAY && span.end > 0;
    if (!overlaps && !(startsHere && span.end === span.start)) continue;
    segments.push({
      key: `${shift.id}@${dateISO}`,
      shiftId: shift.id,
      dateISO,
      startMin: Math.max(0, span.start),
      endMin: Math.min(MINUTES_PER_DAY, span.end),
      cutStart: span.start < 0,
      cutEnd: span.end > MINUTES_PER_DAY,
      lane: 0,
      lanes: 1,
    });
  }
  segments.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  return assignLanes(segments);
}

// The colored start location with the most counted hours (first on ties).
function dayTint(
  starting: PlanShift[],
  locationIds: string[],
  tintOf: (locationId: string) => LocationTint | null,
): LocationTint | null {
  let best: { tint: LocationTint; hours: number } | null = null;
  for (const locationId of locationIds) {
    const tint = tintOf(locationId);
    if (!tint) continue;
    const hours = starting
      .filter((shift) => shift.locationId === locationId)
      .reduce((sum, shift) => sum + countedHours(shift), 0);
    if (!best || hours > best.hours) best = { tint, hours };
  }
  return best?.tint ?? null;
}

// SPEC R9: consecutive runs of shifts at one location; the ground changes at
// the middle of the gap between two runs (at the next start when they touch
// or overlap).
function tintBands(
  starting: PlanShift[],
  tintOf: (locationId: string) => LocationTint | null,
): TintBand[] {
  const runs: Array<{ locationId: string; start: number; end: number }> = [];
  for (const shift of starting) {
    if (!shift.locationId || !shift.locationName) continue;
    const last = runs[runs.length - 1];
    const end = Math.min(shift.endMin, MINUTES_PER_DAY);
    if (last && last.locationId === shift.locationId) last.end = Math.max(last.end, end);
    else runs.push({ locationId: shift.locationId, start: shift.startMin, end });
  }
  const bands: TintBand[] = [];
  let from = 0;
  runs.forEach((run, index) => {
    const next = runs[index + 1];
    const to = next ? (run.end <= next.start ? Math.round((run.end + next.start) / 2) : next.start) : MINUTES_PER_DAY;
    if (to > from) bands.push({ startMin: from, endMin: to, tint: tintOf(run.locationId) });
    from = Math.max(from, to);
  });
  return bands.some((band) => band.tint) ? bands : [];
}

function buildDay(
  ctx: PlanContext,
  dateISO: string,
  todayISO: string,
  shifts: PlanShift[],
  absences: PlanAbsence[],
): PlanDay {
  const date = parseISODate(dateISO);
  const segments = buildSegments(shifts, dateISO);
  const starting = shifts.filter((shift) => shift.dateISO === dateISO);
  // Shifts carry a locationName only while locations are enabled; without a
  // name to show there is no location chip and no tint.
  const startLocationIds = [
    ...new Set(
      starting.flatMap((shift) =>
        shift.locationId && shift.locationName ? [shift.locationId] : [],
      ),
    ),
  ];
  const startLocationId = startLocationIds[0];
  const minutes = Math.round(starting.reduce((sum, shift) => sum + countedHours(shift) * 60, 0));
  const tintOf = (locationId: string) => locationTint(ctx.locationById.get(locationId)?.color);
  return {
    dateISO,
    date,
    dayType: getDayType(dateISO, ctx.holidayDates),
    isWeekend: date.getDay() === 0 || date.getDay() === 6,
    isToday: dateISO === todayISO,
    holidayName: ctx.source.holidays.find((holiday) => holiday.dateISO === dateISO)?.name,
    published: ctx.publishedWeeks.has(weekStartISO(dateISO)),
    segments,
    absences,
    startLocationId,
    startLocationIds,
    tint: dayTint(starting, startLocationIds, tintOf),
    tintBands: startLocationIds.length > 1 ? tintBands(starting, tintOf) : [],
    hours: starting.length && minutes > 0 ? minutes / 60 : null,
    isContinuationOnly: segments.length > 0 && starting.length === 0,
    isFree: segments.length === 0 && absences.length === 0,
  };
}
