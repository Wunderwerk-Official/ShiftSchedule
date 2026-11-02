import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

/** Phone day view (team calendar and public link): one day with Prev/Next. */
export default function MobileDayNavigator({
  date,
  onPrevDay,
  onNextDay,
  onToday,
}: {
  date: Date;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
}) {
  const label = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onPrevDay}
        className="grid h-8 w-8 place-items-center rounded-md border border-slate-200/70 bg-white text-slate-600 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Previous day"
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <div className="min-w-[96px] text-center text-sm font-normal tracking-tight text-slate-700 dark:text-slate-200">
        {label}
      </div>
      <button
        type="button"
        onClick={onNextDay}
        className="grid h-8 w-8 place-items-center rounded-md border border-slate-200/70 bg-white text-slate-600 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Next day"
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToday}
        className="h-8 rounded-md border border-slate-200/70 bg-white px-3 text-sm font-normal text-slate-700 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        Today
      </button>
    </div>
  );
}
