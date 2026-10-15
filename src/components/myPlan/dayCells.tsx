import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  formatHours,
  formatWeekday,
  type PersonPlan,
  type PlanDay,
} from "../../lib/myPlan";
import { dayHeadClass, DayNumber, LocationChip, LocationChips, showsFree } from "./viewParts";
import { formatDayMonth, formatLongDay, MICRO_LABEL, TEXT_1, TEXT_2, TEXT_3 } from "./planChrome";

// Day header (date on top, SPEC C5.3), date cell (date on left, C5.4) and
// the day-total cell shared by the week views.

type CellProps = {
  day: PlanDay;
  locationsById: Map<string, Location>;
  isMobile: boolean;
};

/** Location chips of the day, "free" (published weeks only), or nothing (continuation-only / absence days). */
function DayLocations({ day, locationsById, isMobile }: CellProps) {
  if (day.startLocationIds.length > 0) {
    // Phones (≈ 45 px columns, SPEC E11): one mini chip, a second location as "+1".
    if (isMobile) return <LocationChips ids={day.startLocationIds} locationsById={locationsById} size="mini" wrap />;
    const size = day.startLocationIds.length > 1 ? "sm" : "md";
    return (
      <span className="flex min-w-0 max-w-full items-center gap-1">
        {day.startLocationIds.map((id) => (
          <LocationChip key={id} location={locationsById.get(id)} name={id} size={size} />
        ))}
      </span>
    );
  }
  if (showsFree(day)) {
    return <span className={cx(isMobile ? "text-[11px]" : "text-xs", TEXT_3)}>free</span>;
  }
  return null;
}

/** Header cell above a day column (week · date on top). */
export function DayHeaderTop({ day, locationsById, isMobile }: CellProps) {
  return (
    <div
      className={cx(
        // min-h: a holiday with a shift (date, name, chip) or a wrapped "+1" needs more room;
        // the grid row stretches every header cell to the tallest one.
        // Phones align to the top: a column whose "+1" wraps must not move its
        // weekday, date and chip off the line of the other days.
        "flex min-w-0 flex-col items-center overflow-hidden",
        isMobile
          ? "min-h-12 justify-start gap-0.5 px-0.5 py-1"
          : cx("min-h-16 justify-center px-1 py-1", day.holidayName ? "gap-1" : "gap-1.5"),
        dayHeadClass(day),
      )}
      aria-current={day.isToday ? "date" : undefined}
      title={day.holidayName ? `${formatLongDay(day.date)} · ${day.holidayName}` : formatLongDay(day.date)}
    >
      {/* Fixed date-line height: the today ring is taller than a plain number,
          and the chips below must line up across the days. */}
      <span className={cx("flex items-center", isMobile ? "flex-col gap-0" : "h-[26px] gap-1.5")}>
        <span className={cx(MICRO_LABEL, TEXT_3)}>{formatWeekday(day.dateISO)}</span>
        <span className={cx("inline-flex items-center", isMobile && "h-6")}>
          <DayNumber day={day} size={isMobile ? "sm" : "md"} />
        </span>
      </span>
      {day.holidayName && !isMobile ? (
        <span className="max-w-full truncate text-[11px] leading-[14px] text-purple-800 dark:text-purple-200">
          {day.holidayName}
        </span>
      ) : null}
      {day.holidayName && isMobile ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-purple-800 dark:bg-purple-200" />
      ) : null}
      <span className={cx("flex max-w-full items-center justify-center", isMobile ? "min-h-4" : "min-h-5")}>
        <DayLocations day={day} locationsById={locationsById} isMobile={isMobile} />
      </span>
    </div>
  );
}

/** Date cell left of a day row (week · date on left). */
export function DateCellLeft({ day, locationsById }: Omit<CellProps, "isMobile">) {
  return (
    <div
      className={cx("flex h-full min-w-0 flex-col justify-center gap-1 overflow-hidden pl-4 pr-3", dayHeadClass(day))}
      aria-current={day.isToday ? "date" : undefined}
      title={day.holidayName ? `${formatLongDay(day.date)} · ${day.holidayName}` : formatLongDay(day.date)}
    >
      <span className="flex items-baseline gap-1.5">
        <span className={cx(MICRO_LABEL, TEXT_3)}>{formatWeekday(day.dateISO)}</span>
        <span
          className={cx(
            "text-[15px] font-semibold leading-5 tabular-nums",
            TEXT_1,
            day.isToday && "rounded-full px-1.5",
          )}
          style={day.isToday ? { boxShadow: "inset 0 0 0 1.5px currentColor" } : undefined}
        >
          {formatDayMonth(day.dateISO)}
        </span>
      </span>
      {day.holidayName ? (
        <span className="truncate text-[11px] leading-[14px] text-purple-800 dark:text-purple-200">
          {day.holidayName}
        </span>
      ) : null}
      {/* Short chips (≤ 8 characters, SPEC C5.4): two where they fit, else "+1". */}
      <LocationChips ids={day.startLocationIds} locationsById={locationsById} size="sm" short max={2} maxChars={11} />
      {day.startLocationIds.length === 0 && showsFree(day) ? <span className={cx("text-xs", TEXT_3)}>free</span> : null}
    </div>
  );
}

/** "–" title: a night counts to its start day. */
export function dayTotalTitle(day: PlanDay, plan: PersonPlan): string | undefined {
  if (day.hours !== null) return undefined;
  const continuation = day.segments.find((segment) => segment.cutStart);
  const shift = continuation ? plan.shifts.get(continuation.shiftId) : undefined;
  if (shift) return `${shift.title} counts to its start day (${formatWeekday(shift.dateISO)})`;
  return undefined;
}

/** Day total: "8.5 h" (mobile "8.5"), "–" when nothing starts that day. */
export function DayTotal({
  day,
  plan,
  isMobile,
  emphasis = false,
}: {
  day: PlanDay;
  plan: PersonPlan;
  isMobile: boolean;
  /** Larger, primary text (the total column of week · date on left). */
  emphasis?: boolean;
}) {
  const text = day.hours === null ? "–" : isMobile ? day.hours.toFixed(1) : formatHours(day.hours);
  const size = emphasis ? "text-[13px]" : isMobile ? "text-[11px]" : "text-xs";
  return (
    <span className={cx("font-semibold tabular-nums", size, emphasis ? TEXT_1 : TEXT_2)} title={dayTotalTitle(day, plan)}>
      {text}
    </span>
  );
}
