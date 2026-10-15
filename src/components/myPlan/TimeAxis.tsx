import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  addDaysISO,
  formatDayLabel,
  formatTime,
  formatWeekday,
  minutesToPx,
  parseISODate,
} from "../../lib/myPlan";
import PlanIcon from "./PlanIcons";

// Time axis (SPEC C5.15): hour labels every 2 h (mobile 3 h), shaded night
// zones 00–06 and 22–24 with a moon, a now-pill, and — when a day-view window
// runs past midnight — a chip with the next date instead of "00".
// HourLines draws the matching grid lines inside a day column/row.

type AxisGeometry = {
  /** "vertical" = time runs down (date on top); "horizontal" = time runs right. */
  axis: "vertical" | "horizontal";
  windowStartMin: number;
  windowEndMin: number;
  pxPerHour: number;
};

export type TimeAxisProps = AxisGeometry & {
  labelEveryHours?: number;
  /** Minutes in the window's frame for the now-pill; null/undefined = no pill. */
  nowMin?: number | null;
  /** Window start day; names the midnight crossing ("Thu 15"). */
  dateISO?: string;
  compact?: boolean;
  className?: string;
};

const NIGHT_MORNING_END = 6 * 60;
const NIGHT_EVENING_START = 22 * 60;

/** Night zones (00–06, 22–24 of every day) inside the window, merged across midnight. */
export function nightZones(startMin: number, endMin: number): Array<[number, number]> {
  const zones: Array<[number, number]> = [];
  const firstDay = Math.floor(startMin / MINUTES_PER_DAY);
  const lastDay = Math.floor((endMin - 1) / MINUTES_PER_DAY);
  for (let day = firstDay; day <= lastDay; day += 1) {
    const base = day * MINUTES_PER_DAY;
    for (const [a, b] of [
      [base, base + NIGHT_MORNING_END],
      [base + NIGHT_EVENING_START, base + MINUTES_PER_DAY],
    ]) {
      const from = Math.max(a, startMin);
      const to = Math.min(b, endMin);
      if (to <= from) continue;
      const last = zones[zones.length - 1];
      if (last && last[1] === from) last[1] = to;
      else zones.push([from, to]);
    }
  }
  return zones;
}

export default function TimeAxis({
  axis,
  windowStartMin,
  windowEndMin,
  pxPerHour,
  labelEveryHours = 2,
  nowMin,
  dateISO,
  compact = false,
  className,
}: TimeAxisProps) {
  const vertical = axis === "vertical";
  const toPx = (min: number) => minutesToPx(min, windowStartMin, pxPerHour);
  const total = toPx(windowEndMin);
  const nowPx = nowMin != null && nowMin >= windowStartMin && nowMin <= windowEndMin ? toPx(nowMin) : null;
  // Hour labels near the now-pill are hidden (SPEC C5.8): vertically the
  // 14 px label and the 18 px pill touch below 16 px apart, so keep 18 px.
  const hideNear = vertical ? 18 : 30;

  const labels: Array<{ min: number; text: string; chip: boolean }> = [];
  for (let h = Math.ceil(windowStartMin / 60); h * 60 < windowEndMin; h += 1) {
    const min = h * 60;
    const midnight = min > 0 && min % MINUTES_PER_DAY === 0;
    if (midnight && dateISO) {
      const next = addDaysISO(dateISO, min / MINUTES_PER_DAY);
      const text = compact
        ? formatWeekday(next)
        : vertical
          ? `${formatWeekday(next)} ${parseISODate(next).getDate()}`
          : formatDayLabel(next);
      labels.push({ min, text, chip: true });
      continue;
    }
    if ((h % 24) % labelEveryHours !== 0) continue;
    labels.push({ min, text: formatTime(min).slice(0, 2), chip: false });
  }

  return (
    <div
      aria-hidden="true"
      className={cx("relative select-none", vertical ? "w-full" : "h-full", className)}
      style={vertical ? { height: total } : { width: total }}
    >
      {nightZones(windowStartMin, windowEndMin).map(([from, to]) => {
        const a = toPx(from);
        const size = toPx(to) - a;
        return (
          <div
            key={from}
            className={cx(
              "absolute bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
              vertical ? "left-0 right-0" : "bottom-0 top-0",
            )}
            style={vertical ? { top: a, height: size } : { left: a, width: size }}
          >
            {!compact && size >= 40 ? (
              <PlanIcon name="moon"
                size={12}
                className={cx("absolute", vertical ? "right-2" : "top-1/2 -translate-y-1/2")}
                style={vertical ? { top: from === windowStartMin ? 18 : 10 } : { left: from === windowStartMin ? 22 : 16 }}
              />
            ) : null}
          </div>
        );
      })}
      {labels.map(({ min, text, chip }) => {
        const px = toPx(min);
        if (nowPx !== null && Math.abs(px - nowPx) < hideNear) return null;
        const atStart = px < 1;
        return (
          <span
            key={min}
            className={cx(
              "absolute whitespace-nowrap text-[11px] leading-[14px] tabular-nums",
              chip
                ? "rounded-full border border-slate-300 bg-white px-1 font-semibold text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
                : "text-slate-600 dark:text-slate-400",
              vertical && (compact ? "right-1" : "right-2"),
              !vertical && "top-1/2 -translate-y-1/2",
            )}
            style={
              vertical
                ? { top: atStart ? 2 : px - 7 }
                : atStart
                  ? { left: 4 }
                  : { left: px, transform: "translate(-50%, -50%)" }
            }
          >
            {text}
          </span>
        );
      })}
      {nowPx !== null ? (
        <span
          data-now-pill=""
          className={cx(
            "absolute z-[4] h-[18px] whitespace-nowrap rounded-full bg-slate-900 px-1.5 text-[11px] font-semibold leading-[18px] tabular-nums text-white dark:bg-slate-50 dark:text-slate-900",
            // Compact axes are narrower than the pill: align left, overflow into the first column.
            vertical && (compact ? "left-0" : "right-0.5"),
          )}
          style={
            vertical
              ? { top: nowPx - 9 }
              : { left: nowPx, top: "50%", transform: "translate(-50%, -50%)" }
          }
        >
          {formatTime(nowMin ?? 0)}
        </span>
      ) : null}
    </div>
  );
}

export type HourLinesProps = AxisGeometry & {
  /** Dashed line at midnight when the window crosses it (day views). */
  showMidnight?: boolean;
};

/** Hour grid lines (06/12/18 stronger) above the ground and below the blocks. */
export function HourLines({ axis, windowStartMin, windowEndMin, pxPerHour, showMidnight = true }: HourLinesProps) {
  const vertical = axis === "vertical";
  const lines: Array<{ min: number; strong: boolean; midnight: boolean }> = [];
  for (let h = Math.floor(windowStartMin / 60) + 1; h * 60 < windowEndMin; h += 1) {
    const min = h * 60;
    const midnight = min % MINUTES_PER_DAY === 0;
    lines.push({ min, strong: (h % 24) % 6 === 0, midnight });
  }
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      {lines.map(({ min, strong, midnight }) => {
        const px = minutesToPx(min, windowStartMin, pxPerHour);
        if (midnight && showMidnight) {
          return (
            <div
              key={min}
              data-midnight-line=""
              className={cx(
                "absolute border-dashed border-slate-600 dark:border-slate-400",
                vertical ? "left-0 right-0 border-t" : "bottom-0 top-0 border-l",
              )}
              style={vertical ? { top: px } : { left: px }}
            />
          );
        }
        return (
          <div
            key={min}
            className={cx(
              "absolute",
              strong ? "bg-slate-200 dark:bg-slate-700" : "bg-slate-100 dark:bg-slate-800",
              vertical ? "left-0 right-0 h-px" : "bottom-0 top-0 w-px",
            )}
            style={vertical ? { top: px } : { left: px }}
          />
        );
      })}
    </div>
  );
}
