import { useRef, type CSSProperties } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  MINUTES_PER_DAY,
  addDaysISO,
  formatHours,
  formatTime,
  formatWeekday,
  parseISODate,
  type PersonPlan,
  type PlanDay,
} from "../../lib/myPlan";
import MonthListMobile from "./MonthListMobile";
import { vacationBandStyle, vacationColors, vacationLabelStyle } from "./absenceStyles";
import { OUTSIDE_LABEL_MIN_FREE_PX, freeBefore } from "./dayLanes";
import {
  dayEntries,
  dayGroundStyle,
  entryRadiusClass,
  entryStyle,
  monthWeekGroups,
  vacationSegments,
  weekTotalText,
  type DayEntry,
} from "./monthParts";
import { dayPct as pct, draftBadgeClass, formatLongDate, formatLongDay } from "./planChrome";
import { shiftAriaTail } from "./ShiftBlock";
import { LocationChips, dayHeadTone, tintBandsImage } from "./viewParts";
import type { MonthViewProps, SelectShift } from "./types";
import { useElementWidth } from "./useElementWidth";

// Month · date on left: one 28 px row per day with a 0–24 h mini timeline
// (same horizontal scale idea as week · left), week header rows with the
// full-week totals (plan §2.5, SPEC E6). A day with overlapping shifts gets
// a 44 px row with two lanes (R4, like week · left). Phones get the agenda
// variant.

const AXIS_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
const GRID = "grid grid-cols-[136px_minmax(0,1fr)_80px]";

/** 2-hour grid lines over the day's ground (two locations: the split bands below the lines). */
function trackBackground(day: PlanDay, isDark: boolean): CSSProperties {
  const line = isDark ? "#1E293B" : "#F1F5F9";
  const grid = `repeating-linear-gradient(90deg, ${line} 0 1px, transparent 1px ${100 / 12}%)`;
  const bands = tintBandsImage(day, isDark, "horizontal");
  return bands ? { backgroundImage: `${grid}, ${bands}` } : { backgroundImage: grid, ...dayGroundStyle(day, isDark) };
}

export default function MonthListView(props: MonthViewProps) {
  if (props.isMobile) return <MonthListMobile {...props} />;
  return <MonthListGrid {...props} />;
}

function MonthListGrid(props: MonthViewProps) {
  const { plan, days, monthAnchor, weekHours, isDark, locationsById, nowMin, onOpenDay } = props;
  const groups = monthWeekGroups(days, monthAnchor);
  // Track width (all rows share the header's 0–24 h scale) for the outside labels.
  const axisRef = useRef<HTMLDivElement>(null);
  const pxPerMin = useElementWidth(axisRef, 1008) / MINUTES_PER_DAY;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className={cx(GRID, "h-8 border-b border-slate-300 dark:border-slate-600")}>
          <div className="flex items-center px-4 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Day
          </div>
          <div ref={axisRef} className="relative border-l border-slate-200 dark:border-slate-700" aria-hidden="true">
            <div className="absolute inset-y-0 left-0 bg-slate-100 dark:bg-slate-800" style={{ width: pct(360) }} />
            <div className="absolute inset-y-0 right-0 bg-slate-100 dark:bg-slate-800" style={{ width: pct(120) }} />
            {AXIS_HOURS.map((hour) => (
              <span
                key={hour}
                className={cx(
                  "absolute top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-slate-600 dark:text-slate-400",
                  hour === 0 ? "pl-1" : "-translate-x-1/2",
                )}
                style={{ left: pct(hour * 60) }}
              >
                {String(hour).padStart(2, "0")}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-end border-l border-slate-200 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:border-slate-700 dark:text-slate-400">
            Total
          </div>
        </div>
        {groups.map((group) => {
          const total = weekTotalText(weekHours.get(group.mondayISO) ?? 0, group.vacationDays);
          return (
            <div key={group.mondayISO}>
              <div className={cx(GRID, "h-7 border-t border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800/50")}>
                <div className="col-span-2 flex items-center gap-2 px-4 text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                  {group.label}
                  {group.days.length < 7 ? <span className="font-normal">(whole week)</span> : null}
                  {group.draft ? <span className={draftBadgeClass}>Draft – not published</span> : null}
                </div>
                <div
                  className="flex items-center justify-end px-3 text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100"
                  style={total.vacation ? { color: vacationColors(isDark).text } : undefined}
                >
                  {total.text}
                </div>
              </div>
              {group.days.map((day) => (
                <MonthListRow
                  key={day.dateISO}
                  day={day}
                  plan={plan}
                  allDays={days}
                  isDark={isDark}
                  nowMin={nowMin}
                  selectedShiftId={props.selectedShiftId}
                  onSelectShift={props.onSelectShift}
                  onOpenDay={onOpenDay}
                  locationsById={locationsById}
                  pxPerMin={pxPerMin}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type MonthListRowProps = {
  day: PlanDay;
  plan: PersonPlan;
  allDays: PlanDay[];
  isDark: boolean;
  nowMin: number;
  selectedShiftId: string | null;
  onSelectShift: SelectShift;
  onOpenDay: (dateISO: string) => void;
  locationsById: Map<string, Location>;
  /** Track px per minute (outside labels need ≥ 64 px free). */
  pxPerMin: number;
};

function MonthListRow(props: MonthListRowProps) {
  const { day, plan, allDays, isDark, nowMin, selectedShiftId, onSelectShift, onOpenDay, locationsById, pxPerMin } =
    props;
  const entries = dayEntries(plan, day);
  const twoLanes = day.segments.some((segment) => segment.lanes === 2);
  const toPx = (min: number) => min * pxPerMin;
  const onVacation = day.absences.some((absence) => absence.kind === "vacation");
  const vacation = onVacation ? vacationSegments(allDays, [day])[0] : undefined;
  // The run label sits on the run's first row of the month only.
  const previous = allDays.find((other) => other.dateISO === addDaysISO(day.dateISO, -1));
  const runStartsHere =
    !!vacation &&
    (!previous ||
      previous.date.getMonth() !== day.date.getMonth() ||
      !previous.absences.some((absence) => absence.kind === "vacation"));
  const weekday = formatWeekday(day.dateISO);
  const openLabel = [
    `Open ${formatLongDate(day.dateISO)}`,
    day.holidayName,
    ...day.startLocationIds.map((id) => locationsById.get(id)?.name ?? id),
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className={cx(GRID, twoLanes ? "h-11" : "h-7", "border-t border-slate-100 dark:border-slate-800")}>
      <button
        type="button"
        onClick={() => onOpenDay(day.dateISO)}
        aria-label={openLabel}
        title={day.holidayName ?? "Open day"}
        className={cx(
          "flex min-w-0 items-center justify-between gap-1 px-4 text-left hover:underline",
          dayHeadTone(day),
        )}
      >
        <span
          className={cx(
            "inline-flex shrink-0 items-baseline gap-1 tabular-nums",
            day.isToday && "rounded-full bg-slate-900 px-1.5 text-white dark:bg-white dark:text-slate-900",
          )}
        >
          <span className={cx("text-[11px] font-semibold", !day.isToday && "text-slate-600 dark:text-slate-400")}>
            {weekday}
          </span>
          <span className={cx("text-xs font-medium", !day.isToday && "text-slate-900 dark:text-slate-100")}>
            {String(day.date.getDate()).padStart(2, "0")}
          </span>
        </span>
        <LocationChips ids={day.startLocationIds} locationsById={locationsById} size="sm" short className="w-auto" />
      </button>
      <div
        className="relative overflow-hidden border-l border-slate-200 dark:border-slate-700"
        style={trackBackground(day, isDark)}
      >
        {day.holidayName ? (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 truncate text-[11px] text-purple-800 dark:text-purple-200">
            {day.holidayName}
          </span>
        ) : null}
        {vacation ? (
          <div className="absolute inset-x-0 inset-y-1 flex items-center rounded-[5px]" style={vacationBandStyle(isDark)}>
            {runStartsHere ? (
              <span
                className="absolute truncate rounded px-1.5 text-[11px] font-semibold tabular-nums"
                style={{ ...vacationLabelStyle(isDark), left: pct(8 * 60) }}
              >
                {vacation.label}
              </span>
            ) : null}
          </div>
        ) : null}
        {entries.map((entry) => (
          <MonthListBar
            key={entry.key}
            entry={entry}
            isDark={isDark}
            tall={twoLanes}
            outsideLabel={
              entry.kind === "shift" &&
              freeBefore(entry.segment, day.segments, toPx) >= OUTSIDE_LABEL_MIN_FREE_PX
            }
            selected={entry.kind === "shift" && entry.shift.id === selectedShiftId}
            onSelectShift={onSelectShift}
          />
        ))}
        {day.isToday ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 z-[3] w-0.5 -translate-x-1/2 bg-slate-900 dark:bg-white"
            style={{ left: pct(nowMin) }}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-end border-l border-slate-200 px-3 text-xs tabular-nums text-slate-700 dark:border-slate-700 dark:text-slate-300">
        {day.hours != null ? formatHours(day.hours) : "–"}
      </div>
    </div>
  );
}

type MonthListBarProps = {
  entry: DayEntry;
  isDark: boolean;
  /** 44 px row of a day with overlaps (two 17 px lanes). */
  tall: boolean;
  /** R7: a block too short for text gets "Demos 07:15" left of it (caller checks ≥ 64 px free). */
  outsideLabel: boolean;
  selected: boolean;
  onSelectShift: SelectShift;
};

function MonthListBar({ entry, isDark, tall, outsideLabel, selected, onSelectShift }: MonthListBarProps) {
  if (entry.kind === "rest") {
    const start = entry.absence.startMin;
    return (
      <div
        className="absolute inset-y-1 flex items-center overflow-hidden rounded-[5px] px-1.5 text-[11px] font-semibold"
        style={{ ...entryStyle(entry, isDark), left: `calc(${pct(start)} + 1px)`, right: 1 }}
      >
        <span className="truncate">
          {entry.title} {start > 0 ? `from ${formatTime(start)}` : ""}
        </span>
      </div>
    );
  }
  const { segment, shift } = entry;
  const duration = segment.endMin - segment.startMin;
  // Overlapping shifts split the (tall) row into a top and a bottom lane, so
  // neither hides the other; single shifts stay 20 px, centered.
  const half = segment.lanes === 2;
  const top = half ? (segment.lane === 1 ? 23 : 4) : tall ? 12 : 4;
  const label = duration >= 180 ? "full" : duration >= 60 ? "short" : "none";
  const outside = label === "none" && outsideLabel;
  // Starts like the bar ("MRT 08:00–16:30"), then the row's date, location,
  // hours and status like the other views' labels.
  const ariaLabel = [
    `${shift.title} ${entry.time}`,
    formatLongDay(parseISODate(segment.dateISO)),
    ...shiftAriaTail(shift),
  ].join(", ");
  return (
    <button
      type="button"
      data-shift-id={shift.id}
      onClick={(event) => onSelectShift(selected ? null : shift.id, selected ? null : event.currentTarget)}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={selected}
      title={`${shift.title} ${entry.time}`}
      className={cx(
        "absolute flex items-center gap-1 whitespace-nowrap px-1.5 text-[11px] tabular-nums",
        // Lifted like ShiftBlock, so a bar in the other lane cannot cover the selection outline.
        selected ? "z-[4]" : "z-[2]",
        // The outside label sits left of the block, so only that bar may overflow.
        !outside && "overflow-hidden",
        half && "leading-[14px]",
        entryRadiusClass(entry, "rounded-[5px]"),
        // focus-visible:* keeps the selection outline while focused (the global focus style drops outlines).
        selected &&
          "outline outline-2 outline-offset-1 outline-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900 dark:outline-white dark:focus-visible:outline-white",
      )}
      style={{
        ...entryStyle(entry, isDark),
        left: `calc(${pct(segment.startMin)} + ${segment.cutStart ? 0 : 1}px)`,
        width: `calc(${pct(duration)} - ${(segment.cutStart ? 0 : 1) + (segment.cutEnd ? 0 : 1)}px)`,
        top,
        height: half ? 17 : 20,
      }}
    >
      {outside ? (
        <span className="pointer-events-none absolute right-[calc(100%+4px)] top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums text-slate-700 dark:text-slate-300">
          {shift.shortLabel} {formatTime(shift.startMin)}
        </span>
      ) : null}
      {label === "none" ? null : (
        <>
          <span className="truncate font-semibold">{label === "full" ? entry.title : shift.shortLabel}</span>
          {label === "full" ? <span className="truncate">{entry.time}</span> : null}
        </>
      )}
    </button>
  );
}
