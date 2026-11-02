import type { CSSProperties } from "react";
import type { ScheduleRow } from "../../lib/shiftRows";
import { cx } from "../../lib/classNames";
import { compactTimeLabel, type StackedRowMeta } from "../../lib/stackedTeamLayout";
type RowLabelProps = {
  row: ScheduleRow;
  /**
   * Text color on a location-colored label (team grid): all of the label's
   * text takes it instead of the slate defaults.
   */
  ink?: string;
  /** Stacked single-day layout: one lane of a class row in one label cell. */
  stacked?: StackedRowMeta;
};

const LABEL_FONT = { fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif' };

// Stacked label text, shared by the week (three cells) and the single day
// (one cell). Row band: bold capitals; section: medium, up to two lines (the
// week's spanning cells allow more, see StackedLabelCells); time: tabular
// digits, so every time has the same width and they line up.
const BAND_TEXT =
  "line-clamp-3 break-words text-[11px] font-semibold uppercase leading-4 tracking-wide text-slate-800 dark:text-slate-50";
const SECTION_TEXT =
  "line-clamp-2 break-words text-[11px] font-medium leading-4 text-slate-700 dark:text-slate-100";
const TIME_TEXT =
  "whitespace-nowrap text-[11px] font-medium leading-4 tabular-nums text-slate-600 dark:text-slate-300";

/**
 * Stacked dividers by level, as bottom borders (the cells' other border
 * colors stay): a hairline between the lanes of one section, a line between
 * the sections of a row, a stronger line between rows (row bands). See-through
 * ink, so a line looks the same on white, hatched, section-tinted and
 * location-colored cells (a slate line reads as a white gap on a tint).
 */
export const STACKED_DIVIDER = {
  lane: "border-b border-b-slate-900/[0.06] dark:border-b-white/[0.06]",
  section: "border-b border-b-slate-900/[0.13] dark:border-b-white/[0.13]",
  row: "border-b border-b-slate-900/[0.24] dark:border-b-white/[0.22]",
} as const;
export type StackedDividerLevel = keyof typeof STACKED_DIVIDER;

export const stackedDividerLevel = (meta: StackedRowMeta): StackedDividerLevel =>
  meta.isLastInGroup ? "row" : meta.isLastInSection ? "section" : "lane";

/** Tooltip of a lane: its section and time ("IRM neuro HK · 13:00–16:00"). */
const laneTooltip = (meta: StackedRowMeta) =>
  [meta.sectionName, meta.timeLabel ? compactTimeLabel(meta.timeLabel) : undefined]
    .filter(Boolean)
    .join(" · ") || undefined;

type StackedLabelCellsProps = {
  meta: StackedRowMeta;
  /** Location color of the row band (team grid): every label cell takes it. */
  tint?: { background: string; ink: string };
  /** Bottom border of the lane (its time cell). */
  laneDivider: string;
  /** Bottom border of the row band cell (spans the row's lanes); set on the first lane. */
  groupDivider?: string;
  /** Bottom border of the section cell (spans the section's lanes); set on its first lane. */
  sectionDivider?: string;
};

/**
 * Stacked week: the label column is three grid columns — row band, section,
 * time — so section names and times line up down the whole plan. The row
 * band cell spans all lanes of its row and the section cell all lanes of its
 * section (grid-row span), like merged cells in a table: location band →
 * row band → section → its times. Without location colors (print, PDF,
 * public) the section and time cells carry the section's color, the cells'
 * tint in the section look.
 */
export function StackedLabelCells({
  meta,
  tint,
  laneDivider,
  groupDivider,
  sectionDivider,
}: StackedLabelCellsProps) {
  const inkStyle: CSSProperties | undefined = tint ? { color: tint.ink } : undefined;
  const tintStyle: CSSProperties | undefined = tint
    ? { backgroundColor: tint.background }
    : meta.sectionColor
      ? ({ "--section-color": meta.sectionColor } as CSSProperties)
      : undefined;
  const sectionTintClass = tint
    ? undefined
    : meta.sectionColor
      ? "stacked-label-tint"
      : "bg-white dark:bg-slate-900";
  const shade = tint?.background;
  // A spanning cell has the height of all its lanes: long names wrap onto
  // more lines there instead of being cut off (a row band three at least,
  // one per lane; a section four at least, two per lane and one more).
  const bandLines = Math.max(3, meta.groupSpan ?? 1);
  const sectionLines = Math.max(4, 2 * (meta.sectionSpan ?? 1) + 1);
  // A later lane of a section shows only its time; screen readers still
  // hear which section it belongs to.
  const hiddenSection = !meta.isFirstInSection && meta.title ? meta.title : undefined;
  return (
    <>
      {meta.isFirstInGroup ? (
        <div
          data-stacked-label="band"
          data-label-shade={shade}
          className={cx(
            "row border-r border-r-slate-900/[0.07] py-[7px] pl-2.5 pr-1.5 dark:border-r-white/[0.08]",
            groupDivider,
            !tint && "bg-slate-50 dark:bg-slate-800/60",
          )}
          style={{
            gridRow: `span ${meta.groupSpan ?? 1}`,
            ...(tint ? { backgroundColor: tint.background } : null),
          }}
        >
          <span
            // Room for one long word (BEREITSCHAFT, HINTERGRUNDDIENST). A word
            // breaks only as a last resort: when the grid's auto label
            // columns must give way (A4 portrait with long names), which
            // overflow-wrap: anywhere allows instead of an overflowing week.
            // Print (.print-wrap) shows every line and keeps every word whole:
            // the label is never narrower than its longest word (min-w-min);
            // the page shrinks the week a little instead.
            className={cx(BAND_TEXT, "print-wrap max-w-[128px] [overflow-wrap:anywhere] print:min-w-min")}
            title={meta.groupLabel}
            style={{ ...LABEL_FONT, ...inkStyle, WebkitLineClamp: bandLines }}
          >
            {meta.groupLabel}
          </span>
        </div>
      ) : null}
      {meta.isFirstInSection ? (
        <div
          data-stacked-label="section"
          data-label-shade={shade}
          className={cx("row py-[7px] pl-2 pr-1.5", sectionDivider, sectionTintClass)}
          style={{ gridRow: `span ${meta.sectionSpan ?? 1}`, ...tintStyle }}
        >
          {meta.title ? (
            <span
              className={cx(
                SECTION_TEXT,
                // Print: whole words, like the row band above.
                "print-wrap max-w-[112px] [overflow-wrap:anywhere] lg:max-w-[160px] print:min-w-min",
              )}
              title={meta.title}
              style={{ ...LABEL_FONT, ...inkStyle, WebkitLineClamp: sectionLines }}
            >
              {meta.title}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        data-stacked-label="time"
        data-label-shade={shade}
        className={cx(
          "row flex justify-end border-r-2 border-slate-300 py-[7px] pl-1.5 pr-2.5 dark:border-slate-700",
          laneDivider,
          sectionTintClass,
        )}
        style={tintStyle}
        title={laneTooltip(meta)}
      >
        {hiddenSection ? <span className="sr-only">{hiddenSection} </span> : null}
        {meta.timeLabel ? (
          <span className={TIME_TEXT} style={{ ...LABEL_FONT, ...inkStyle }}>
            {compactTimeLabel(meta.timeLabel)}
          </span>
        ) : hiddenSection ? (
          // No time of its own: the lane still needs a name.
          <span
            className={cx(SECTION_TEXT, "max-w-[112px] text-right")}
            style={{ ...LABEL_FONT, ...inkStyle }}
            aria-hidden
          >
            {hiddenSection}
          </span>
        ) : null}
      </div>
    </>
  );
}

// Stacked single day (phone, one day on screen): one label cell per lane —
// row band name (first lane), the section and the time, right-aligned when
// there is room. Without the week's spanning section cell every lane names
// its section (a later lane of the same section a little quieter), so no
// label is just a time.
function StackedRowLabel({ meta, ink }: { meta: StackedRowMeta; ink?: string }) {
  const inkStyle: CSSProperties | undefined = ink ? { color: ink } : undefined;
  const section = meta.title;
  return (
    <div
      className="flex h-full flex-col justify-center gap-0.5 px-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-3"
      title={laneTooltip(meta)}
    >
      <div className="min-w-0 max-w-[128px] sm:max-w-[160px]" style={LABEL_FONT}>
        {meta.groupLabel ? (
          <span className={BAND_TEXT} title={meta.groupLabel} style={inkStyle}>
            {meta.groupLabel}
          </span>
        ) : null}
        {section ? (
          <span
            className={cx(SECTION_TEXT, !meta.isFirstInSection && "opacity-75")}
            title={section}
            style={inkStyle}
          >
            {section}
          </span>
        ) : null}
      </div>
      {meta.timeLabel ? (
        <span className={cx(TIME_TEXT, "shrink-0")} style={{ ...LABEL_FONT, ...inkStyle }}>
          {compactTimeLabel(meta.timeLabel)}
        </span>
      ) : null}
    </div>
  );
}

export default function RowLabel({ row, ink, stacked }: RowLabelProps) {
  if (stacked) return <StackedRowLabel meta={stacked} ink={ink} />;
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
        // Print: the label wraps within 10rem instead of widening the column.
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 print:max-w-[10rem]">
          <span
            className="print-wrap block min-w-0 truncate text-[11px] font-normal uppercase tracking-wide text-slate-700 dark:text-slate-200 sm:text-xs print:text-center"
            title={rowLabel}
            style={{
              fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
              ...(ink ? { color: ink, fontWeight: 600 } : null),
            }}
          >
            {rowLabel}
          </span>
          <span
            className="print-wrap w-full truncate text-center text-[9px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
            title={locationLabel}
            style={{
              fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
              ...(ink ? { color: ink, opacity: 0.8 } : null),
            }}
          >
            {locationLabel}
          </span>
        </div>
      ) : (
        <div className="flex w-full items-center">
          <span
            className="print-wrap max-w-[16ch] truncate text-[11px] font-normal uppercase tracking-wide text-slate-600 dark:text-slate-300 sm:max-w-[20ch] sm:text-xs"
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
