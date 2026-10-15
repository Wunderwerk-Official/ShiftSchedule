import { localDateTime } from "./dates";
import type { PersonPlan, PlanShift } from "./types";

export type NextShift = {
  shift: PlanShift;
  /** The shift has started and not ended yet. */
  running: boolean;
  /** Whole minutes until the start (0 while running). */
  minutesUntil: number;
  /** Whole minutes until the end. */
  minutesLeft: number;
};

const DEFAULT_HORIZON_DAYS = 14;

/**
 * The running or next own shift from `now`, within `horizonDays`. The plan
 * must cover today−1 … today+horizon (build a dedicated plan for the chip).
 * Minutes are counted between wall-clock minutes, so 14:32 → 17:00 = 148.
 */
export function findNextShift(
  plan: PersonPlan,
  now: Date,
  horizonDays = DEFAULT_HORIZON_DAYS,
): NextShift | null {
  const nowMinute = Math.floor(now.getTime() / 60_000);
  const horizon = nowMinute + horizonDays * 24 * 60;
  for (const shift of plan.shifts.values()) {
    const start = Math.floor(localDateTime(shift.dateISO, shift.startMin).getTime() / 60_000);
    const end = Math.floor(localDateTime(shift.dateISO, shift.endMin).getTime() / 60_000);
    if (end <= nowMinute) continue;
    if (start > horizon) return null;
    const running = start <= nowMinute;
    return {
      shift,
      running,
      minutesUntil: running ? 0 : start - nowMinute,
      minutesLeft: end - nowMinute,
    };
  }
  return null;
}
