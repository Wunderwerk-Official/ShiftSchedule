import type { HoursStatus, HoursWeek } from "../../lib/workingHours";
import type { PersonTone } from "../../lib/myPlan";
import { cx } from "../../lib/classNames";

// Shared pieces of the working hours views (v1.78): status colors, the
// person avatar (team grid colors), week labels and the legend.

/** Cell ground + text of a status (year view cells). */
export const STATUS_CELL: Record<HoursStatus, string> = {
  under: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  on: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200",
  over: "bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
};

/** Text color of a status (differences, balances). */
export const STATUS_TEXT: Record<HoursStatus, string> = {
  under: "text-amber-700 dark:text-amber-300",
  on: "text-emerald-700 dark:text-emerald-300",
  over: "text-rose-700 dark:text-rose-300",
};

export const STATUS_BAR: Record<HoursStatus, string> = {
  under: "bg-amber-400 dark:bg-amber-400",
  on: "bg-emerald-500 dark:bg-emerald-400",
  over: "bg-rose-500 dark:bg-rose-400",
};

export const STATUS_LABEL: Record<HoursStatus, string> = {
  under: "Under target",
  on: "On target",
  over: "Over target",
};

/** Weeks that don't count yet in the year view: hatched (index.css), never read as zero hours. */
export const UNPLANNED_CELL = "hours-unplanned text-slate-500 dark:text-slate-400";

const pad = (value: number) => String(value).padStart(2, "0");

/** "02.11." */
export function shortDate(dateISO: string): string {
  const [, month, day] = dateISO.split("-");
  return `${day}.${month}.`;
}

/** "W45 · 02.11.–08.11.2026" */
export function weekTitle(week: HoursWeek): string {
  const first = week.dates[0];
  const last = week.dates[week.dates.length - 1];
  return `W${week.isoWeek} · ${shortDate(first)}–${shortDate(last)}${last.slice(0, 4)}`;
}

/** "Mon" … "Sun" of an ISO date (local calendar day). */
export function weekdayShort(dateISO: string): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", { weekday: "short" });
}

/** Today as ISO (local calendar day). */
export function todayISO(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Initials circle in the person's team color. */
export function PersonAvatar({ initials, tone }: { initials: string; tone?: PersonTone }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold leading-none",
        !tone && "bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-900",
      )}
      style={tone ? { backgroundColor: tone.strong, color: tone.onStrong } : undefined}
    >
      {initials}
    </span>
  );
}

/** Small colored dot for legends and summaries. */
export function StatusDot({ status }: { status: HoursStatus }) {
  return <span aria-hidden="true" className={cx("inline-block h-2.5 w-2.5 shrink-0 rounded-full", STATUS_BAR[status])} />;
}

export function HoursLegend({ showUnplanned }: { showUnplanned: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-600 dark:text-slate-300">
      {(["under", "on", "over"] as const).map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <StatusDot status={status} />
          {STATUS_LABEL[status]}
          {status === "on" ? <span className="text-slate-400 dark:text-slate-500">(± tolerance)</span> : null}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">Vac</span>
        Vacation (lowers the target)
      </span>
      {showUnplanned ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cx("inline-block h-3 w-4 rounded-sm border border-slate-200 dark:border-slate-700", UNPLANNED_CELL)} />
          Not counted yet (too little planned)
        </span>
      ) : null}
    </div>
  );
}
