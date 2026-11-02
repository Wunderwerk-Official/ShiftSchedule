import type { ReactNode } from "react";
import { cx } from "../../lib/classNames";
import type { PersonTone } from "../../lib/myPlan";
import {
  COUNTED_WEEK_SHARE,
  formatHours,
  formatSignedHours,
  hoursStatus,
  type HoursStatus,
  type HoursWeek,
  type PersonWeekHours,
  type PersonYearHours,
  type TeamWeekHours,
} from "../../lib/workingHours";
import {
  PersonAvatar,
  shortDate,
  STATUS_BAR,
  STATUS_LABEL,
  STATUS_TEXT,
  StatusDot,
  weekdayShort,
} from "./WorkingHoursParts";

// Week view of the working hours (v1.78): one row per person with the hours
// of each day, planned vs target, the difference as a bar around the target
// and the year's running balance through this week. Team sums on top and in
// the footer.

export type HoursPerson = {
  id: string;
  name: string;
  initials: string;
  tone?: PersonTone;
  hours: PersonYearHours;
};

export type WeekSort = "list" | "difference";

const MIN_BAR_SCALE_MINUTES = 8 * 60;

/** Difference as a bar left (under) or right (over) of the target line, tolerance band shaded. */
function DifferenceBar({
  difference,
  tolerance,
  status,
  scale,
}: {
  difference: number;
  tolerance: number;
  status: HoursStatus;
  scale: number;
}) {
  const clamp = (value: number) => Math.max(-50, Math.min(50, value));
  const bar = clamp((difference / scale) * 50);
  const band = Math.min(50, (tolerance / scale) * 50);
  return (
    <span aria-hidden="true" className="relative block h-2 w-28 shrink-0 rounded-full bg-slate-100 dark:bg-slate-800">
      <span
        className="absolute inset-y-0 rounded-full bg-slate-200/80 dark:bg-slate-700/70"
        style={{ left: `${50 - band}%`, width: `${band * 2}%` }}
      />
      <span
        className={cx("absolute inset-y-0 rounded-full", STATUS_BAR[status])}
        style={{ left: `${bar < 0 ? 50 + bar : 50}%`, width: `${Math.max(Math.abs(bar), 1.5)}%` }}
      />
      <span className="absolute -inset-y-0.5 left-1/2 w-px -translate-x-1/2 bg-slate-500 dark:bg-slate-400" />
    </span>
  );
}

function DayCell({ week, dateISO, isToday, slotLabelById }: {
  week: PersonWeekHours;
  dateISO: string;
  isToday: boolean;
  slotLabelById: Map<string, string>;
}) {
  const minutes = week.minutesByDate.get(dateISO) ?? 0;
  const labels = (week.rowIdsByDate.get(dateISO) ?? []).map((rowId) => slotLabelById.get(rowId) ?? "Shift");
  let content: ReactNode;
  if (minutes > 0) {
    content = <span className="tabular-nums text-slate-800 dark:text-slate-100">{formatHours(minutes)}</span>;
  } else if (week.vacationDates.has(dateISO)) {
    content = (
      <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">
        Vac
      </span>
    );
  } else if (week.restDates.has(dateISO)) {
    content = <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">Rest</span>;
  } else {
    content = <span className="text-slate-300 dark:text-slate-600">–</span>;
  }
  return (
    <td
      className={cx(
        "border-b border-slate-100 px-1 text-center text-xs dark:border-slate-800",
        isToday && "bg-sky-50/70 dark:bg-sky-900/20",
      )}
      title={labels.length > 0 ? labels.join("\n") : undefined}
      data-testid="hours-day"
    >
      {content}
    </td>
  );
}

export default function WorkingHoursWeekView({
  week,
  team,
  people,
  slotLabelById,
  sort,
  today,
}: {
  week: HoursWeek;
  /** Team sums of the week: it counts (targets apply) once enough is planned. */
  team: TeamWeekHours;
  people: HoursPerson[];
  slotLabelById: Map<string, string>;
  sort: WeekSort;
  /** Today (ISO), highlighted when it is one of the week's days. */
  today: string;
}) {
  const counted = team.counted;
  const rows = people.map((person) => ({ person, week: person.hours.weeks[week.index] }));
  if (sort === "difference") {
    // Most under target first; people without a target last.
    rows.sort((a, b) => {
      const da = a.week.differenceMinutes;
      const db = b.week.differenceMinutes;
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  }
  const withTarget = rows.filter((row) => row.week.targetMinutes !== null);
  const plannedTotal = rows.reduce((sum, row) => sum + row.week.plannedMinutes, 0);
  const targetTotal = withTarget.reduce((sum, row) => sum + (row.week.targetMinutes ?? 0), 0);
  const differenceTotal = withTarget.reduce((sum, row) => sum + (row.week.differenceMinutes ?? 0), 0);
  const counts: Record<HoursStatus, number> = { under: 0, on: 0, over: 0 };
  for (const row of rows) if (row.week.status) counts[row.week.status] += 1;
  const scale = Math.max(
    MIN_BAR_SCALE_MINUTES,
    ...withTarget.map((row) => Math.abs(row.week.differenceMinutes ?? 0)),
  );
  const dayTotals = week.dates.map((dateISO) =>
    rows.reduce((sum, row) => sum + (row.week.minutesByDate.get(dateISO) ?? 0), 0),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-100 px-6 py-3 text-sm dark:border-slate-800">
        <div className="flex items-baseline gap-4" data-testid="hours-week-summary">
          <span className="text-slate-500 dark:text-slate-400">
            Planned <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatHours(plannedTotal)} h</span>
          </span>
          {withTarget.length > 0 && counted ? (
            <>
              <span className="text-slate-500 dark:text-slate-400">
                Target <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatHours(targetTotal)} h</span>
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                Difference{" "}
                <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {formatSignedHours(differenceTotal)} h
                </span>
              </span>
            </>
          ) : null}
        </div>
        {counted ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
            {(["under", "on", "over"] as const).map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5" data-testid={`hours-count-${status}`}>
                <StatusDot status={status} />
                <span className="font-semibold tabular-nums">{counts[status]}</span> {STATUS_LABEL[status].toLowerCase()}
              </span>
            ))}
          </div>
        ) : (
          <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300" data-testid="hours-week-not-counted">
            {team.targetMinutes > 0
              ? `${Math.floor((team.plannedMinutes / team.targetMinutes) * 100)}% of the team's target hours are planned. The week counts from ${Math.round(COUNTED_WEEK_SHARE * 100)}%.`
              : "Nobody has a shift in this week yet."}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[920px] border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
            <tr className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <th scope="col" className="sticky left-0 z-30 w-56 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900">
                Person
              </th>
              {week.dates.map((dateISO) => (
                <th
                  key={dateISO}
                  scope="col"
                  className={cx(
                    "w-14 border-b border-slate-200 px-1 py-2 text-center dark:border-slate-700",
                    dateISO === today && "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
                  )}
                >
                  <span className="block">{weekdayShort(dateISO)}</span>
                  <span className="block text-[10px] font-normal normal-case tracking-normal">{shortDate(dateISO)}</span>
                </th>
              ))}
              <th scope="col" className="w-20 border-b border-l border-slate-200 px-2 py-2 text-right dark:border-slate-700">Planned</th>
              <th scope="col" className="w-20 border-b border-slate-200 px-2 py-2 text-right dark:border-slate-700">Target</th>
              <th scope="col" className="w-56 border-b border-slate-200 px-2 py-2 dark:border-slate-700">Difference</th>
              <th scope="col" className="w-24 border-b border-slate-200 px-3 py-2 text-right dark:border-slate-700" title="Year to date: planned minus target over the weeks with a plan, through this week">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ person, week: personWeek }) => {
              const balanceStatus =
                personWeek.balanceMinutes === null
                  ? null
                  : hoursStatus(personWeek.balanceMinutes, person.hours.toleranceHours * 60);
              const vacationDays = personWeek.vacationDates.size;
              return (
                <tr key={person.id} data-testid={`hours-week-row-${person.id}`} className="group">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-1.5 font-normal group-hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:group-hover:bg-slate-800/60"
                  >
                    <span className="flex items-center gap-2">
                      <PersonAvatar initials={person.initials} tone={person.tone} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-slate-800 dark:text-slate-100" title={person.name}>
                          {person.name}
                        </span>
                        <span className="block text-[10px] text-slate-400 dark:text-slate-500">
                          {person.hours.weeklyHours !== null ? `${person.hours.weeklyHours} h/wk` : "No contract hours"}
                        </span>
                      </span>
                    </span>
                  </th>
                  {week.dates.map((dateISO) => (
                    <DayCell
                      key={dateISO}
                      week={personWeek}
                      dateISO={dateISO}
                      isToday={dateISO === today}
                      slotLabelById={slotLabelById}
                    />
                  ))}
                  <td className="border-b border-l border-slate-100 px-2 text-right text-xs font-semibold tabular-nums text-slate-900 dark:border-slate-800 dark:text-slate-100" data-testid="hours-planned">
                    {formatHours(personWeek.plannedMinutes)}
                  </td>
                  <td
                    className="border-b border-slate-100 px-2 text-right text-xs tabular-nums text-slate-600 dark:border-slate-800 dark:text-slate-300"
                    data-testid="hours-target"
                    title={
                      personWeek.targetMinutes !== null && vacationDays > 0
                        ? `${person.hours.weeklyHours} h/wk × ${week.dates.length - vacationDays}/7 days (${vacationDays} vacation day${vacationDays === 1 ? "" : "s"})`
                        : undefined
                    }
                  >
                    {personWeek.targetMinutes === null ? "–" : personWeek.targetMinutes === 0 ? "0" : formatHours(personWeek.targetMinutes)}
                    {personWeek.targetMinutes !== null && vacationDays > 0 ? (
                      <span className="block text-[10px] font-normal text-slate-400 dark:text-slate-500">
                        {vacationDays} d vac
                      </span>
                    ) : null}
                  </td>
                  <td className="border-b border-slate-100 px-2 dark:border-slate-800" data-testid="hours-difference">
                    {personWeek.status && personWeek.differenceMinutes !== null && personWeek.toleranceMinutes !== null ? (
                      <span className="flex items-center gap-2" title={`${STATUS_LABEL[personWeek.status]} (tolerance ± ${formatHours(personWeek.toleranceMinutes)} h)`}>
                        <span className={cx("w-12 text-right text-xs font-semibold tabular-nums", STATUS_TEXT[personWeek.status])}>
                          {formatSignedHours(personWeek.differenceMinutes)}
                        </span>
                        <DifferenceBar
                          difference={personWeek.differenceMinutes}
                          tolerance={personWeek.toleranceMinutes}
                          status={personWeek.status}
                          scale={scale}
                        />
                        <span className="sr-only">{STATUS_LABEL[personWeek.status]}</span>
                      </span>
                    ) : (
                      <span className="block w-12 text-right text-xs text-slate-300 dark:text-slate-600">
                        {personWeek.targetMinutes === 0 ? "Vac" : "–"}
                      </span>
                    )}
                  </td>
                  <td
                    className={cx(
                      "border-b border-slate-100 px-3 text-right text-xs font-medium tabular-nums dark:border-slate-800",
                      balanceStatus ? STATUS_TEXT[balanceStatus] : "text-slate-300 dark:text-slate-600",
                    )}
                    data-testid="hours-balance"
                  >
                    {formatSignedHours(personWeek.balanceMinutes)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={week.dates.length + 5} className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
                  No clinicians added yet.
                </td>
              </tr>
            ) : null}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="sticky bottom-0 z-20 bg-slate-50 dark:bg-slate-800">
              <tr className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                <th scope="row" className="sticky left-0 z-30 border-t border-slate-200 bg-slate-50 px-4 py-2 text-left dark:border-slate-700 dark:bg-slate-800">
                  Team
                </th>
                {dayTotals.map((minutes, index) => (
                  <td key={week.dates[index]} className="border-t border-slate-200 px-1 text-center tabular-nums dark:border-slate-700">
                    {formatHours(minutes)}
                  </td>
                ))}
                <td className="border-l border-t border-slate-200 px-2 text-right tabular-nums dark:border-slate-700">{formatHours(plannedTotal)}</td>
                <td className="border-t border-slate-200 px-2 text-right tabular-nums dark:border-slate-700">
                  {withTarget.length > 0 && counted ? formatHours(targetTotal) : "–"}
                </td>
                <td className="border-t border-slate-200 px-2 dark:border-slate-700">
                  <span className="block w-12 text-right tabular-nums">
                    {withTarget.length > 0 && counted ? formatSignedHours(differenceTotal) : "–"}
                  </span>
                </td>
                <td className="border-t border-slate-200 dark:border-slate-700" />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
