import { useState } from "react";
import type { Location } from "../../api/client";
import { cx } from "../../lib/classNames";
import {
  formatHours,
  isSameMonth,
  isoWeekNumber,
  type PersonPlan,
  type PlanDay,
} from "../../lib/myPlan";
import DayPopover, { DayDetails } from "./DayPopover";
import PlanIcon from "./PlanIcons";
import { vacationBandStyle, vacationColors, vacationLabelStyle } from "./absenceStyles";
import {
  EntryChip,
  dayAriaSummary,
  dayEntries,
  dayGroundStyle,
  monthWeekGroups,
  vacationSegments,
  weekTotalText,
} from "./monthParts";
import { TEXT_1, draftBadgeClass, formatDayMonth, formatLongDate } from "./planChrome";
import { LocationChips, dayHeadTone, showsFree } from "./viewParts";
import type { MonthViewProps } from "./types";

// Month · date on top: Monday-first calendar sheet (plan §2.5, SPEC E5/E13).
// Desktop: week column, 7 day cells (≤ 3 chips, "+n more"), week-sum column;
// a click on a day opens the day popover. Phone: compact cells (≤ 2 short
// chips) and the selected day's entries in a card below.

const WEEKDAY_HEADS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function MonthCalendarView(props: MonthViewProps) {
  const { plan, days, onSelectShift, isMobile, isDark, locationsById, monthAnchor, weekHours, onOpenDay } = props;
  const groups = monthWeekGroups(days, monthAnchor);
  const monthKey = `${monthAnchor.getFullYear()}-${monthAnchor.getMonth()}`;
  const [popover, setPopover] = useState<{ dateISO: string; anchor: HTMLElement } | null>(null);
  const [picked, setPicked] = useState<{ monthKey: string; dateISO: string } | null>(null);

  const defaultISO =
    days.find((day) => day.isToday && isSameMonth(day.date, monthAnchor))?.dateISO ??
    days.find((day) => isSameMonth(day.date, monthAnchor))?.dateISO ??
    days[0]?.dateISO;
  const mobileISO = picked?.monthKey === monthKey ? picked.dateISO : defaultISO;
  const selectedISO = isMobile ? mobileISO : popover?.dateISO;
  const popoverDay = popover ? days.find((day) => day.dateISO === popover.dateISO) : undefined;
  const mobileDay = days.find((day) => day.dateISO === mobileISO);

  const columns = isMobile
    ? "grid-cols-7"
    : "grid-cols-[56px_repeat(7,minmax(0,1fr))_76px]";
  const dayOffset = isMobile ? 1 : 2;

  const vacationLabelOf = (day: PlanDay) =>
    vacationSegments(days, [day])[0]?.label;
  const weekSubtitle = (day: PlanDay) => {
    const group = groups.find((item) => item.week.some((other) => other.dateISO === day.dateISO));
    const hours = group ? weekHours.get(group.mondayISO) ?? 0 : 0;
    const vacationDays = group?.vacationDays ?? 0;
    // SPEC A3.2: a vacation week says so instead of "0.0 h".
    const summary =
      hours === 0 && vacationDays > 0
        ? `Vacation · ${vacationDays} ${vacationDays === 1 ? "day" : "days"}`
        : `${formatHours(hours)} planned`;
    return `Week ${isoWeekNumber(day.date)} · ${summary}`;
  };

  return (
    <div className={cx(isMobile && "px-2 pb-4 pt-2")}>
      <div className={cx("grid border-b border-slate-300 dark:border-slate-600", columns)}>
        {isMobile ? null : <HeadCell>Wk</HeadCell>}
        {WEEKDAY_HEADS.map((head, index) => (
          <HeadCell key={head} weekend={index >= 5} center>
            {head}
          </HeadCell>
        ))}
        {isMobile ? null : <HeadCell right>Total</HeadCell>}
      </div>
      {groups.map(({ mondayISO, week, weekNumber, draft, vacationDays }) => {
        const total = weekTotalText(weekHours.get(mondayISO) ?? 0, vacationDays);
        return (
          <div key={mondayISO} className={cx("relative grid", columns)}>
            {isMobile ? null : (
              <div className="flex flex-col items-start gap-1 border-b border-slate-200 px-2 pt-2 dark:border-slate-700">
                <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                  Wk {weekNumber}
                </span>
                {draft ? <span className={draftBadgeClass}>Draft</span> : null}
              </div>
            )}
            {week.map((day, index) => (
              <MonthDayCell
                key={day.dateISO}
                day={day}
                plan={plan}
                column={index + dayOffset}
                inMonth={isSameMonth(day.date, monthAnchor)}
                selected={selectedISO === day.dateISO}
                isMobile={isMobile}
                isDark={isDark}
                locationsById={locationsById}
                onClick={(anchor) => {
                  if (isMobile) setPicked({ monthKey, dateISO: day.dateISO });
                  else setPopover((open) => (open?.dateISO === day.dateISO ? null : { dateISO: day.dateISO, anchor }));
                }}
              />
            ))}
            {isMobile ? null : (
              <div className="flex flex-col items-end gap-0.5 border-b border-l border-slate-200 bg-slate-50 px-2.5 pt-2 dark:border-slate-700 dark:bg-slate-800/40">
                {total.vacation ? (
                  <>
                    <span className="text-[13px] font-semibold" style={{ color: vacationColors(isDark).text }}>
                      {total.text}
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-600 dark:text-slate-400">
                      {vacationDays} {vacationDays === 1 ? "day" : "days"}
                    </span>
                  </>
                ) : (
                  <span className="text-[13px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {total.text}
                  </span>
                )}
              </div>
            )}
            {vacationSegments(days, week).map((segment) => (
              <div
                key={segment.key}
                aria-hidden="true"
                className={cx(
                  "pointer-events-none z-[2] mx-0.5 flex items-center self-start overflow-hidden rounded-md px-0.5",
                  isMobile ? "mt-[25px] h-[18px]" : "mt-7 h-6",
                )}
                style={{
                  ...vacationBandStyle(isDark),
                  gridRow: 1,
                  gridColumn: `${segment.startIndex + dayOffset} / ${segment.endIndex + dayOffset + 1}`,
                }}
              >
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 truncate rounded px-1.5 text-[11px] font-semibold tabular-nums sm:text-xs"
                  style={vacationLabelStyle(isDark)}
                >
                  {isMobile ? null : <PlanIcon name="suitcase" className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{isMobile ? segment.label.split(" · ")[0] : segment.label}</span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
      {isMobile && mobileDay ? (
        <div className={cx("mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900", TEXT_1)}>
          <DayDetails
            day={mobileDay}
            plan={plan}
            isDark={isDark}
            isMobile
            onOpenDay={onOpenDay}
            onSelectShift={onSelectShift}
            subtitle={weekSubtitle(mobileDay)}
            vacationLabel={vacationLabelOf(mobileDay)}
          />
        </div>
      ) : null}
      {!isMobile && popover && popoverDay ? (
        <DayPopover
          anchor={popover.anchor}
          day={popoverDay}
          plan={plan}
          isDark={isDark}
          onClose={() => setPopover(null)}
          onOpenDay={(dateISO) => {
            setPopover(null);
            onOpenDay(dateISO);
          }}
          onSelectShift={(shiftId, anchor) => {
            setPopover(null);
            onSelectShift(shiftId, anchor);
          }}
          subtitle={weekSubtitle(popoverDay)}
          vacationLabel={vacationLabelOf(popoverDay)}
        />
      ) : null}
    </div>
  );
}

type HeadCellProps = { children: string; weekend?: boolean; center?: boolean; right?: boolean };

function HeadCell({ children, weekend = false, center = false, right = false }: HeadCellProps) {
  return (
    <div
      className={cx(
        "flex h-8 items-center px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400",
        center && "justify-center",
        right && "justify-end",
        weekend && "bg-slate-100 dark:bg-slate-800",
      )}
    >
      {children}
    </div>
  );
}

type MonthDayCellProps = {
  day: PlanDay;
  plan: PersonPlan;
  column: number;
  inMonth: boolean;
  selected: boolean;
  isMobile: boolean;
  isDark: boolean;
  locationsById: Map<string, Location>;
  onClick: (anchor: HTMLElement) => void;
};

function MonthDayCell({ day, plan, column, inMonth, selected, isMobile, isDark, locationsById, onClick }: MonthDayCellProps) {
  const entries = dayEntries(plan, day, isMobile ? "short" : "chip");
  const max = isMobile ? 2 : 3;
  const shown = entries.length > max ? entries.slice(0, max - 1) : entries;
  const more = entries.length - shown.length;
  const holiday = Boolean(day.holidayName);
  const ground = dayGroundStyle(day, isDark);
  const showFree = !isMobile && inMonth && showsFree(day) && !day.isWeekend && !holiday;
  return (
    <button
      type="button"
      onClick={(event) => onClick(event.currentTarget)}
      aria-label={`${formatLongDate(day.dateISO)}: ${dayAriaSummary(plan, day, locationsById)}`}
      aria-current={day.isToday ? "date" : undefined}
      aria-expanded={isMobile ? undefined : selected}
      className={cx(
        "relative flex min-w-0 flex-col border-b border-l border-slate-200 text-left dark:border-slate-700",
        isMobile ? "min-h-[72px]" : "min-h-[128px]",
        "hover:brightness-[0.98] dark:hover:brightness-110",
      )}
      style={{ gridRow: 1, gridColumn: column }}
    >
      {/* Header strip: date and location chip; the holiday name opens the body (SPEC E5). */}
      <span
        className={cx(
          "flex w-full items-center justify-between gap-1",
          // Phones: 2 px room above the today ring, so the selection ring never clips it.
          isMobile ? "h-6 px-1 pt-0.5" : "h-6 px-2",
          dayHeadTone(day),
        )}
      >
        <DateNumber day={day} inMonth={inMonth} isMobile={isMobile} />
        {holiday && isMobile ? (
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-purple-800 dark:bg-purple-200" />
        ) : null}
        {!isMobile ? (
          <LocationChips
            ids={day.startLocationIds}
            locationsById={locationsById}
            size="sm"
            short
            max={2}
            maxChars={12}
            className="w-auto shrink-0"
          />
        ) : null}
      </span>
      <span
        className={cx(
          "flex w-full flex-1 flex-col gap-[3px]",
          isMobile ? "px-0.5 py-0.5" : "px-1.5 py-1",
          !ground && !inMonth && "bg-slate-50 dark:bg-slate-900/60",
          !ground && inMonth && day.isWeekend && "bg-slate-50 dark:bg-slate-800/30",
        )}
        style={ground}
      >
        {holiday && !isMobile ? (
          <span title={day.holidayName} className="truncate text-[11px] leading-[14px] text-purple-800 dark:text-purple-200">
            {day.holidayName}
          </span>
        ) : null}
        {shown.map((entry) => (
          <EntryChip key={entry.key} entry={entry} isDark={isDark} compact={isMobile} />
        ))}
        {more > 0 ? (
          <span className="whitespace-nowrap text-[11px] font-medium text-slate-700 dark:text-slate-300">
            {isMobile ? `+${more}` : `+${more} more`}
          </span>
        ) : null}
        {showFree ? <span className="text-xs text-slate-600 dark:text-slate-400">free</span> : null}
      </span>
      {selected ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[3] ring-2 ring-inset ring-slate-900 dark:ring-white"
        />
      ) : null}
    </button>
  );
}

function DateNumber({ day, inMonth, isMobile }: { day: PlanDay; inMonth: boolean; isMobile: boolean }) {
  const text = inMonth ? String(day.date.getDate()) : formatDayMonth(day.dateISO);
  return (
    <span
      className={cx(
        "inline-flex items-center justify-center tabular-nums leading-none",
        isMobile ? "text-xs" : "text-[13px]",
        inMonth ? "font-semibold text-slate-900 dark:text-slate-100" : "font-medium text-slate-600 dark:text-slate-400",
        day.isToday && "h-[22px] min-w-[22px] rounded-full px-1 ring-[1.5px] ring-inset ring-slate-900 dark:ring-white",
      )}
    >
      {isMobile && !inMonth ? day.date.getDate() : text}
    </span>
  );
}
