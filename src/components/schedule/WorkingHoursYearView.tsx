import { forwardRef } from "react";
import { cx } from "../../lib/classNames";
import {
  formatHours,
  formatSignedHours,
  hoursStatus,
  type HoursStatus,
  type HoursWeek,
  type PersonWeekHours,
  type TeamWeekHours,
} from "../../lib/workingHours";
import type { HoursPerson } from "./WorkingHoursWeekView";
import { PersonAvatar, shortDate, STATUS_CELL, STATUS_LABEL, STATUS_TEXT, UNPLANNED_CELL, weekTitle } from "./WorkingHoursParts";

// Year view of the working hours (v1.78): one row per person, one cell per
// week, tinted by how the week compares with the target (or, for the
// running balance, how the balance compares with a week's tolerance).
// Weeks that don't count yet (not enough planned) are hatched and show only
// the hours planned so far. A week's header opens it in the week view.

export type YearMetric = "hours" | "difference" | "balance";

export const YEAR_METRIC_LABEL: Record<YearMetric, string> = {
  hours: "Hours",
  difference: "Difference",
  balance: "Balance",
};

const WEEK_WIDTH = 46;
const TOTAL_WIDTH = 64;

function cellText(metric: YearMetric, week: PersonWeekHours): string {
  // Not counted: only the hours planned so far, no target to compare with.
  if (!week.counted) return metric === "hours" && week.plannedMinutes > 0 ? formatHours(week.plannedMinutes) : "";
  const fullVacation = week.targetMinutes === 0 && week.plannedMinutes === 0;
  if (metric === "balance") return formatSignedHours(week.balanceMinutes);
  if (fullVacation) return "Vac";
  if (metric === "difference") return formatSignedHours(week.differenceMinutes);
  if (week.plannedMinutes === 0) return week.status ? "0" : "–";
  return formatHours(week.plannedMinutes);
}

function cellStatus(metric: YearMetric, week: PersonWeekHours, toleranceHours: number): HoursStatus | null {
  if (!week.counted) return null;
  if (metric === "balance") {
    return week.balanceMinutes === null ? null : hoursStatus(week.balanceMinutes, toleranceHours * 60);
  }
  return week.status;
}

function cellTitle(week: HoursWeek, personWeek: PersonWeekHours): string {
  const title = weekTitle(week);
  if (!personWeek.counted) {
    return personWeek.plannedMinutes > 0
      ? `${title}: ${formatHours(personWeek.plannedMinutes)} h planned · week not counted yet`
      : `${title}: not counted yet (not enough planned)`;
  }
  const parts = [`${formatHours(personWeek.plannedMinutes) === "–" ? "0" : formatHours(personWeek.plannedMinutes)} h planned`];
  if (personWeek.targetMinutes !== null) {
    parts.push(`target ${personWeek.targetMinutes === 0 ? "0" : formatHours(personWeek.targetMinutes)} h`);
  }
  if (personWeek.vacationDates.size > 0) {
    parts.push(`${personWeek.vacationDates.size} vacation day${personWeek.vacationDates.size === 1 ? "" : "s"}`);
  }
  if (personWeek.status && personWeek.differenceMinutes !== null) {
    parts.push(`${formatSignedHours(personWeek.differenceMinutes)} h (${STATUS_LABEL[personWeek.status].toLowerCase()})`);
  }
  if (personWeek.balanceMinutes !== null) parts.push(`balance ${formatSignedHours(personWeek.balanceMinutes)} h`);
  return `${title}: ${parts.join(" · ")}`;
}

type YearViewProps = {
  weeks: HoursWeek[];
  /** Team sums per week index: which weeks count. */
  team: TeamWeekHours[];
  people: HoursPerson[];
  metric: YearMetric;
  /** Index of today's week in this year, or -1. */
  currentWeekIndex: number;
  onOpenWeek: (weekIndex: number) => void;
};

/** The ref goes to the scroll container (the modal centers today's week in it). */
const WorkingHoursYearView = forwardRef<HTMLDivElement, YearViewProps>(function WorkingHoursYearView(
  { weeks, team, people, metric, currentWeekIndex, onOpenWeek },
  ref,
) {
  const stickyRight = (offset: number) => ({ right: offset, width: TOTAL_WIDTH, minWidth: TOTAL_WIDTH });
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto" data-testid="hours-year-scroll">
      <table className="border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-30 w-56 min-w-56 border-b border-r border-slate-200 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
            >
              Person
            </th>
            {weeks.map((week) => {
              const isCurrent = week.index === currentWeekIndex;
              const counted = team[week.index]?.counted ?? false;
              return (
                <th
                  key={week.index}
                  scope="col"
                  data-current-week={isCurrent ? "true" : undefined}
                  className={cx(
                    "border-b border-slate-200 p-0 text-center dark:border-slate-700",
                    isCurrent && "bg-sky-50 dark:bg-sky-900/30",
                  )}
                  style={{ width: WEEK_WIDTH, minWidth: WEEK_WIDTH }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenWeek(week.index)}
                    aria-label={`Open ${weekTitle(week)} in the week view`}
                    title={`${weekTitle(week)}${counted ? "" : " (not counted yet)"} – open the week`}
                    className={cx(
                      "flex w-full flex-col items-center px-0.5 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800",
                      isCurrent ? "text-sky-700 dark:text-sky-300" : counted ? "text-slate-600 dark:text-slate-300" : "text-slate-400 dark:text-slate-500",
                    )}
                  >
                    <span className="text-[11px] font-semibold">W{week.isoWeek}</span>
                    <span className="text-[9px] font-normal">{shortDate(week.dates[0])}</span>
                  </button>
                </th>
              );
            })}
            {(["Planned", "Target", "Balance"] as const).map((label, index) => (
              <th
                key={label}
                scope="col"
                className={cx(
                  "sticky z-30 border-b border-slate-200 bg-slate-100 px-2 py-2 text-right text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
                  index === 0 && "border-l-2 border-l-slate-300 dark:border-l-slate-600",
                )}
                style={stickyRight((2 - index) * TOTAL_WIDTH)}
                title={label === "Planned" ? "Hours in the weeks that count" : label === "Balance" ? "Planned minus target over the weeks that count" : undefined}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => {
            const balanceStatus =
              person.hours.balanceMinutes === null
                ? null
                : hoursStatus(person.hours.balanceMinutes, person.hours.toleranceHours * 60);
            return (
              <tr key={person.id} className="group" data-testid={`hours-year-row-${person.id}`}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-4 py-1 font-normal group-hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:group-hover:bg-slate-800"
                >
                  <span className="flex items-center gap-2">
                    <PersonAvatar initials={person.initials} tone={person.tone} />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800 dark:text-slate-100" title={person.name}>
                      {person.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                      {person.hours.weeklyHours !== null ? `${person.hours.weeklyHours} h` : ""}
                    </span>
                  </span>
                </th>
                {weeks.map((week) => {
                  const personWeek = person.hours.weeks[week.index];
                  const status = cellStatus(metric, personWeek, person.hours.toleranceHours);
                  const isCurrent = week.index === currentWeekIndex;
                  return (
                    <td
                      key={week.index}
                      data-testid={`hours-${person.id}-w${week.isoWeek}`}
                      title={cellTitle(week, personWeek)}
                      className={cx(
                        "h-9 border-b border-r border-white text-center text-[11px] tabular-nums dark:border-slate-900",
                        !personWeek.counted
                          ? UNPLANNED_CELL
                          : status
                            ? STATUS_CELL[status]
                            : "bg-white text-slate-500 dark:bg-slate-900 dark:text-slate-400",
                        isCurrent && "shadow-[inset_0_0_0_2px_rgb(14_165_233/0.55)]",
                      )}
                    >
                      {cellText(metric, personWeek)}
                    </td>
                  );
                })}
                <td
                  className="sticky z-10 border-b border-l-2 border-slate-100 border-l-slate-300 bg-slate-50 px-2 text-right text-xs font-semibold tabular-nums text-slate-800 dark:border-slate-800 dark:border-l-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  style={stickyRight(2 * TOTAL_WIDTH)}
                  data-testid={`hours-${person.id}-total`}
                >
                  {formatHours(person.hours.plannedMinutes)}
                </td>
                <td
                  className="sticky z-10 border-b border-slate-100 bg-slate-50 px-2 text-right text-xs tabular-nums text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
                  style={stickyRight(TOTAL_WIDTH)}
                  data-testid={`hours-${person.id}-target`}
                >
                  {person.hours.targetMinutes === null ? "–" : formatHours(person.hours.targetMinutes)}
                </td>
                <td
                  className={cx(
                    "sticky z-10 border-b border-slate-100 bg-slate-50 px-2 text-right text-xs font-semibold tabular-nums dark:border-slate-800 dark:bg-slate-800",
                    balanceStatus ? STATUS_TEXT[balanceStatus] : "text-slate-400 dark:text-slate-500",
                  )}
                  style={stickyRight(0)}
                  data-testid={`hours-${person.id}-balance`}
                >
                  {formatSignedHours(person.hours.balanceMinutes)}
                </td>
              </tr>
            );
          })}
          {people.length === 0 ? (
            <tr>
              <td colSpan={weeks.length + 4} className="px-4 py-10 text-sm text-slate-400 dark:text-slate-500">
                No clinicians added yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
});

export default WorkingHoursYearView;
