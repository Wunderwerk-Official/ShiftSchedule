import { useMemo } from "react";
import { cx } from "../../lib/classNames";
import { toISODate } from "../../lib/date";
import {
  MINUTES_PER_DAY,
  addDaysISO,
  buildPersonPlan,
  dayDiff,
  findNextShift,
  formatCountdown,
  formatDuration,
  formatTime,
  formatWeekday,
  formatDayLabel,
  type PlanShift,
  type PlanSource,
} from "../../lib/myPlan";
import PlanIcon from "./PlanIcons";
import { blockColorsOf } from "./viewParts";

// "Next up" header chip (plan §2.7): the running or next own shift within 14
// days, with a countdown. Hidden when there is none. Click → day view. While
// someone else's plan is shown it follows that person and names them
// ("Next up · Jonas"), so it matches the plan it opens.

const HORIZON_DAYS = 14;

function dayWord(dateISO: string, todayISO: string): string {
  const diff = dayDiff(todayISO, dateISO);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return formatDayLabel(dateISO);
}

/** "today 17:00 – Thu 08:00" / "tomorrow 08:00–16:30". */
export function formatNextUpWhen(shift: PlanShift, todayISO: string): string {
  const start = `${dayWord(shift.dateISO, todayISO)} ${formatTime(shift.startMin)}`;
  if (shift.endMin <= MINUTES_PER_DAY) return `${start}–${formatTime(shift.endMin)}`;
  const endISO = addDaysISO(shift.dateISO, Math.floor(shift.endMin / MINUTES_PER_DAY));
  return `${start} – ${formatWeekday(endISO)} ${formatTime(shift.endMin)}`;
}

type NextUpChipProps = {
  source: PlanSource;
  clinicianId: string;
  now: Date;
  onOpenDay: (dateISO: string) => void;
  isMobile?: boolean;
  isDark?: boolean;
  /** First name of the viewed person when it is not the linked user ("Next up · Jonas"). */
  forName?: string;
};

export default function NextUpChip({
  source,
  clinicianId,
  now,
  onOpenDay,
  isMobile = false,
  isDark = false,
  forName,
}: NextUpChipProps) {
  const todayISO = toISODate(now);
  const plan = useMemo(
    () =>
      buildPersonPlan({
        ...source,
        clinicianId,
        fromISO: todayISO,
        toISO: addDaysISO(todayISO, HORIZON_DAYS),
        todayISO,
      }),
    [source, clinicianId, todayISO],
  );
  const next = findNextShift(plan, now, HORIZON_DAYS);
  if (!next) return null;

  const { shift, running } = next;
  const when = running
    ? `until ${formatTime(shift.endMin)}`
    : formatNextUpWhen(shift, todayISO);
  const details = [shift.title, when, shift.locationName].filter(Boolean).join(" · ");
  const countdown = running ? `${formatDuration(next.minutesLeft)} left` : formatCountdown(next.minutesUntil);
  const label = `${running ? "Now" : "Next up"}${forName ? ` · ${forName}` : ""}`;
  const colors = blockColorsOf(shift, isDark);

  const icon = (
    <span
      aria-hidden="true"
      className={cx("grid shrink-0 place-items-center rounded-lg border", isMobile ? "h-8 w-8" : "h-6 w-6")}
      style={{ backgroundColor: colors.fill, borderColor: colors.border, color: colors.text }}
    >
      <PlanIcon name={shift.kind === "duty" ? "moon" : "clock"} className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
    </span>
  );

  return (
    <button
      type="button"
      onClick={() => onOpenDay(shift.dateISO)}
      title="Open this day"
      aria-label={`${label}: ${details}, ${countdown}. Open this day.`}
      className={cx(
        "flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white text-[13px] leading-[18px] text-slate-900",
        "hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
        isMobile ? "w-full px-2 py-1.5 text-left" : "h-9 pl-1.5 pr-3",
      )}
    >
      {icon}
      {isMobile ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">{label}</span>
            <span className="shrink-0 font-semibold tabular-nums">{countdown}</span>
          </span>
          <span className="truncate tabular-nums">{details}</span>
        </span>
      ) : (
        <>
          <span className="shrink-0 text-xs font-semibold text-slate-600 dark:text-slate-400">{label}</span>
          <span className="min-w-0 truncate tabular-nums">{details}</span>
          <span className="shrink-0 font-semibold tabular-nums">{countdown}</span>
        </>
      )}
    </button>
  );
}
