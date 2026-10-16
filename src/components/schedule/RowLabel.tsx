import type { ScheduleRow } from "../../lib/shiftRows";
import { cx } from "../../lib/classNames";
import { compactTimeLabel, type StackedRowMeta } from "../../lib/stackedTeamLayout";
import type { LocationRowTint } from "./teamColors";
type RowLabelProps = {
  row: ScheduleRow;
  /** Colored location: the location name uses the tint's text color. */
  tint?: LocationRowTint;
  /** Stacked layout: one time band of a class row (name on its first band). */
  stacked?: StackedRowMeta;
};

const LABEL_FONT = { fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif' };

// Stacked layout label: row band name (first lane only) and the lane's
// section on the left, its time right-aligned so times line up in a column.
// The location is named by the band above the rows, not repeated here. When
// some days of the lane belong to another section, a "+N" badge lists them
// (the cells name no section).
function StackedRowLabel({ meta }: { meta: StackedRowMeta }) {
  const others = meta.otherSections ?? [];
  const othersTitle = others.length > 0 ? `Other days: ${others.join(" · ")}` : undefined;
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 px-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-3">
      <div className="min-w-0 max-w-[128px] sm:max-w-[160px]" style={LABEL_FONT}>
        {meta.groupLabel ? (
          <span
            // Two lines before an ellipsis: long row names stay readable.
            className="line-clamp-2 break-words text-[11px] font-semibold uppercase leading-4 tracking-wide text-slate-800 dark:text-slate-50"
            title={meta.groupLabel}
          >
            {meta.groupLabel}
          </span>
        ) : null}
        {meta.title || others.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-slate-600 dark:text-slate-50">
            {meta.title ? (
              <span className="line-clamp-2 break-words" title={meta.title}>
                {meta.title}
              </span>
            ) : null}
            {others.length > 0 ? (
              <span
                className="shrink-0 rounded-full bg-white/70 px-1 text-[10px] font-semibold leading-4 text-slate-600 dark:bg-slate-950/50 dark:text-slate-50"
                title={othersTitle}
              >
                +{others.length}
                <span className="sr-only"> ({othersTitle})</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {meta.timeLabel ? (
        <span className="shrink-0 whitespace-nowrap text-[11px] font-medium leading-4 tabular-nums text-slate-600 dark:text-slate-50">
          {compactTimeLabel(meta.timeLabel)}
        </span>
      ) : null}
    </div>
  );
}

export default function RowLabel({ row, tint, stacked }: RowLabelProps) {
  if (stacked) return <StackedRowLabel meta={stacked} />;
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
            style={{
              fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
              ...(tint?.text ? { color: tint.text } : null),
            }}
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
