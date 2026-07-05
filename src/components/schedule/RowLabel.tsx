import type { ScheduleRow } from "../../lib/shiftRows";
import { cx } from "../../lib/classNames";
type RowLabelProps = {
  row: ScheduleRow;
};

export default function RowLabel({ row }: RowLabelProps) {
  const showVacationNote = row.id === "pool-vacation";
  const locationLabel = row.locationName ?? "";
  const rowLabel = row.rowBandLabel?.trim() ?? "";
  return (
    <div
      className={cx(
        "group relative flex h-full px-3 sm:px-4",
        row.kind === "class" ? "items-start" : "items-center",
      )}
    >
      {row.kind === "class" ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1">
          <span
            className="block min-w-0 truncate text-[11px] font-normal uppercase tracking-wide text-slate-700 dark:text-slate-200 sm:text-xs"
            title={rowLabel}
            style={{ fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif' }}
          >
            {rowLabel}
          </span>
          <span
            className="w-full truncate text-center text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
            title={locationLabel}
            style={{ fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif' }}
          >
            {locationLabel}
          </span>
        </div>
      ) : (
        <div className="flex w-full items-center">
          <span
            className="max-w-[16ch] truncate text-[11px] font-normal uppercase tracking-wide text-slate-600 dark:text-slate-300 sm:max-w-[20ch] sm:text-xs"
            title={row.name}
            style={{ fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif' }}
          >
            {row.name}
          </span>
        </div>
      )}
      {showVacationNote ? (
        <div className="pointer-events-none absolute left-4 top-full z-[600] mt-2 w-max max-w-[260px] rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 opacity-0 shadow-sm transition-opacity duration-75 group-hover:opacity-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          Drag people in or out to update vacations automatically.
        </div>
      ) : null}
    </div>
  );
}
