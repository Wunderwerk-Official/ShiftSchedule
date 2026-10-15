import { toISODate } from "../../lib/date";
import {
  MINUTES_PER_DAY,
  dayDiff,
  dayWindow,
  type PersonPlan,
  type PlanDay,
  type PlanSegment,
  type PlanShift,
} from "../../lib/myPlan";
import type { DayLane } from "./types";

// Day-view geometry: shifts are drawn unsplit (a night runs past midnight
// down to its end), clipped to the day window. Each lane gets pseudo
// segments so segmentBox / ShiftBlock work exactly as in the week views.

export type DayWindow = { startMin: number; endMin: number };

/**
 * The lane of the person whose plan is shown (always first, group "me"). It
 * gets the large row/column, "free until" hints and location tags; `isMe`
 * only adds the "Me" badge (the linked person, who may be a colleague lane
 * while someone else's plan is viewed).
 */
export function isOwnerLane(lane: DayLane): boolean {
  return lane.group === "me";
}

/** The lane plan's day for `dateISO` (lanes are built for the visible day). */
export function laneDay(plan: PersonPlan, dateISO: string): PlanDay | undefined {
  return plan.days.find((day) => day.dateISO === dateISO);
}

/** Window covering every lane's shifts of the day (06–22, extended; max next day 12:00). */
export function dayViewWindow(day: PlanDay, lanes: DayLane[], fallback: PersonPlan): DayWindow {
  const shifts: PlanShift[] = [];
  const plans = lanes.length > 0 ? lanes.map((lane) => lane.plan) : [fallback];
  for (const plan of plans) shifts.push(...plan.shifts.values());
  return dayWindow(day, shifts);
}

function overlaps(a: PlanSegment, b: PlanSegment): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/** Two-lane overlap layout (same rule as the week timeline: lane 1 only when needed). */
export function assignOverlapLanes(segments: PlanSegment[]): PlanSegment[] {
  const sorted = [...segments].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );
  const laneEnds = [-Infinity, -Infinity];
  const placed = sorted.map((segment) => {
    const lane: 0 | 1 = laneEnds[0] <= segment.startMin ? 0 : 1;
    laneEnds[lane] = Math.max(laneEnds[lane], segment.endMin);
    return { ...segment, lane };
  });
  return placed.map((segment) => ({
    ...segment,
    lanes: placed.some((other) => other.key !== segment.key && overlaps(other, segment)) ? 2 : 1,
  }));
}

/**
 * Pseudo segments (day-relative minutes, clipped to the window) of every
 * shift of `plan` that touches the window on `dateISO` — including the
 * previous night's continuation and next-morning starts inside an extended
 * window. cutStart/cutEnd mark the clipped (flat) edges.
 */
export function daySegments(plan: PersonPlan, dateISO: string, window: DayWindow): PlanSegment[] {
  const segments: PlanSegment[] = [];
  for (const shift of plan.shifts.values()) {
    const offset = dayDiff(dateISO, shift.dateISO) * MINUTES_PER_DAY;
    const start = offset + shift.startMin;
    const end = offset + shift.endMin;
    if (end <= window.startMin || start >= window.endMin) continue;
    segments.push({
      key: `${shift.id}@day`,
      shiftId: shift.id,
      dateISO,
      startMin: Math.max(start, window.startMin),
      endMin: Math.min(end, window.endMin),
      cutStart: start < window.startMin,
      cutEnd: end > window.endMin,
      lane: 0,
      lanes: 1,
    });
  }
  return assignOverlapLanes(segments);
}

/**
 * "Now" in the day window's frame (minutes from the viewed day's midnight):
 * today → nowMin; yesterday → nowMin + 24 h (its window may run past
 * midnight into today, e.g. a night until 08:00); otherwise null.
 */
export function nowInDayFrame(day: PlanDay, nowMin: number, todayISO = toISODate(new Date())): number | null {
  if (day.isToday) return nowMin;
  return dayDiff(day.dateISO, todayISO) === 1 ? nowMin + MINUTES_PER_DAY : null;
}

/** First own segment start after the window start → "free until 17:00" (null if none/at start). */
export function freeUntil(segments: PlanSegment[], window: DayWindow): number | null {
  if (segments.length === 0) return null;
  const first = Math.min(...segments.map((segment) => segment.startMin));
  return first - window.startMin >= 60 ? first : null;
}

/** Hours of the shifts starting on that day in a lane (null = none start that day). */
export function laneHours(plan: PersonPlan, dateISO: string): number | null {
  return laneDay(plan, dateISO)?.hours ?? null;
}

/** Free px before a segment: to the previous segment's end in its lane, or the window start. */
export function freeBefore(
  segment: PlanSegment,
  segments: PlanSegment[],
  toPx: (min: number) => number,
  windowStartMin = 0,
): number {
  let previousEnd = toPx(windowStartMin);
  for (const other of segments) {
    if (other.key === segment.key || other.endMin > segment.startMin) continue;
    if (segment.lanes === 2 && other.lanes === 2 && other.lane !== segment.lane) continue;
    previousEnd = Math.max(previousEnd, toPx(other.endMin));
  }
  return toPx(segment.startMin) - previousEnd;
}

/** R7: a tiny horizontal block gets its label outside when ≥ 64 px are free to its left. */
export const OUTSIDE_LABEL_MIN_FREE_PX = 64;
