import { cx } from "../../lib/classNames";
import { toISODate } from "../../lib/date";
import { addDaysISO, formatWeekday, parseISODate, weekStartISO, type PersonPlan } from "../../lib/myPlan";
import { MICRO_LABEL, TEXT_1, TEXT_3, formatLongDate } from "./planChrome";
import { blockColorsOf } from "./viewParts";

// 7-day strip above the desktop day detail (SPEC E3 item 2): the ISO week of
// the shown day, one 56 px button per day with a 14 × 4 stripe per shift
// starting that day; the shown day is ringed. The day plan's context window
// (a week around the day) holds every shift of that week.

type WeekStripProps = {
  plan: PersonPlan;
  /** The day shown in the day view. */
  dateISO: string;
  isDark: boolean;
  onPickDay: (dateISO: string) => void;
};

export default function WeekStrip({ plan, dateISO, isDark, onPickDay }: WeekStripProps) {
  const monday = weekStartISO(dateISO);
  const todayISO = toISODate(new Date());
  const shifts = [...plan.shifts.values()];
  return (
    <div role="group" aria-label="Days of this week" className="grid grid-cols-7 gap-1">
      {Array.from({ length: 7 }, (_, index) => {
        const iso = addDaysISO(monday, index);
        const starting = shifts.filter((shift) => shift.dateISO === iso);
        const active = iso === dateISO;
        const summary = starting.length > 0 ? starting.map((shift) => shift.title).join(", ") : "no shift";
        return (
          <button
            key={iso}
            type="button"
            onClick={() => onPickDay(iso)}
            aria-current={active ? "date" : undefined}
            aria-label={`${formatLongDate(iso)}: ${summary}`}
            className={cx(
              "flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border focus-visible:rounded-xl",
              active
                ? "border-slate-900 ring-1 ring-inset ring-slate-900 dark:border-white dark:ring-white"
                : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
            )}
          >
            <span className={cx(MICRO_LABEL, TEXT_3)}>{formatWeekday(iso)}</span>
            <span
              className={cx(
                "text-[13px] font-semibold leading-4 tabular-nums",
                TEXT_1,
                iso === todayISO && "underline decoration-2 underline-offset-2",
              )}
            >
              {parseISODate(iso).getDate()}
            </span>
            <span aria-hidden="true" className="flex h-1 items-center gap-0.5">
              {starting.slice(0, 3).map((shift) => {
                const colors = blockColorsOf(shift, isDark);
                return (
                  <span
                    key={shift.id}
                    className="h-1 w-3.5 rounded-full"
                    style={{ backgroundColor: colors.fill, boxShadow: `inset 0 0 0 1px ${colors.border}` }}
                  />
                );
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
