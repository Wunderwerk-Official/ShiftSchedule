import { MINUTES_PER_DAY, dayDiff } from "./dates";
import type { PlanDay, PlanSegment, PlanShift } from "./types";

// Pixel geometry shared by the time-axis views (vertical "date on top",
// horizontal "date on left").

export const DAY_VIEW_DEFAULT_START = 6 * 60;
export const DAY_VIEW_DEFAULT_END = 22 * 60;
/** Day view never extends further than +12 h into the next day. */
export const DAY_VIEW_MAX_END = MINUTES_PER_DAY + 12 * 60;
export const MIN_BLOCK_PX = 18;

export type BlockDetailLevel = "full" | "medium" | "line" | "tiny";

export function minutesToPx(min: number, windowStartMin: number, pxPerHour: number): number {
  return ((min - windowStartMin) * pxPerHour) / 60;
}

/**
 * Day-view window: 06:00–22:00, extended (to whole hours) to cover every
 * given shift that starts or continues on the day — earlier starts and
 * continuations pull the start down to 00:00, shifts running past midnight
 * push the end up to at most next day 12:00. Pass mine and the coworkers'.
 */
export function dayWindow(
  day: PlanDay,
  shifts: Iterable<PlanShift>,
): { startMin: number; endMin: number } {
  let startMin = DAY_VIEW_DEFAULT_START;
  let endMin = DAY_VIEW_DEFAULT_END;
  for (const shift of shifts) {
    const offset = dayDiff(day.dateISO, shift.dateISO) * MINUTES_PER_DAY;
    const start = offset + shift.startMin;
    const end = offset + shift.endMin;
    if (end <= 0 || start >= MINUTES_PER_DAY) continue;
    startMin = Math.min(startMin, Math.max(0, start));
    endMin = Math.max(endMin, Math.min(end, DAY_VIEW_MAX_END));
  }
  return {
    startMin: Math.floor(startMin / 60) * 60,
    endMin: Math.min(DAY_VIEW_MAX_END, Math.ceil(endMin / 60) * 60),
  };
}

/** How much text fits in a block of this size (height when vertical, width when horizontal). */
export function blockDetailLevel(
  sizePx: number,
  axis: "vertical" | "horizontal",
): BlockDetailLevel {
  const [full, medium, line] = axis === "vertical" ? [56, 36, 18] : [160, 88, 24];
  if (sizePx >= full) return "full";
  if (sizePx >= medium) return "medium";
  if (sizePx >= line) return "line";
  return "tiny";
}

/**
 * Position and size of a segment along the time axis. Blocks shorter than
 * `minPx` grow into free time: downwards up to the next segment, then upwards
 * down to the previous one. Neighbours (same lane, or full-width) are never
 * moved or covered — squeezed between two, a block fills the gap and may stay
 * below `minPx`. The box stays inside the window.
 */
export function segmentBox(
  segment: PlanSegment,
  daySegments: PlanSegment[],
  opts: { windowStartMin: number; windowEndMin: number; pxPerHour: number; minPx?: number },
): { offsetPx: number; sizePx: number } {
  const minPx = opts.minPx ?? MIN_BLOCK_PX;
  const toPx = (min: number) => minutesToPx(min, opts.windowStartMin, opts.pxPerHour);
  const start = toPx(segment.startMin);
  const end = toPx(segment.endMin);
  // Free space around the segment: previous neighbour's end … next one's start.
  let freeFrom = 0;
  let freeTo = toPx(opts.windowEndMin);
  for (const other of daySegments) {
    if (other.key === segment.key) continue;
    if (segment.lanes === 2 && other.lanes === 2 && other.lane !== segment.lane) continue;
    if (other.endMin <= segment.startMin) freeFrom = Math.max(freeFrom, toPx(other.endMin));
    else if (other.startMin >= segment.endMin) freeTo = Math.min(freeTo, toPx(other.startMin));
  }
  const boxEnd = Math.min(freeTo, Math.max(end, start + minPx));
  const boxStart = Math.max(freeFrom, Math.min(start, boxEnd - minPx));
  return { offsetPx: boxStart, sizePx: Math.max(0, boxEnd - boxStart) };
}
