import type { CSSProperties } from "react";
import { cx } from "../../lib/classNames";
import { deriveAbsenceShortLabel, formatTime, type PlanAbsence } from "../../lib/myPlan";
import { restBandStyle, vacationBandStyle, vacationLabelStyle } from "./absenceStyles";
import PlanIcon from "./PlanIcons";

// Absence bands (SPEC C5.7): vacation = green stripes with a label chip,
// rest day = white band with a 1.5 px dashed border, starting after a night
// continuation. Position comes from the caller (style); content adapts to
// a column (vertical axis) or row (horizontal axis / all-day row) layout.

export type AbsenceBandProps = {
  absence: PlanAbsence;
  /** Absolute position/size inside the day column or row. */
  style: CSSProperties;
  layout: "column" | "row";
  isDark: boolean;
  compact?: boolean;
  /** Extra text: "Mon 19 – Fri 23 Oct (5 days)", "after Nachtdienst", … */
  detail?: string;
  /** Continues past the visible start/end edge (flat corners). */
  flatStart?: boolean;
  flatEnd?: boolean;
};

/** Screen-reader / tooltip text of an absence: "Rest Day from 08:00". */
export function absenceText(absence: PlanAbsence, detail?: string): string {
  const from = absence.kind === "rest" && absence.startMin > 0 ? ` from ${formatTime(absence.startMin)}` : "";
  return `${absence.label}${from}${detail ? ` · ${detail}` : ""}`;
}

export default function AbsenceBand({
  absence,
  style,
  layout,
  isDark,
  compact = false,
  detail,
  flatStart = false,
  flatEnd = false,
}: AbsenceBandProps) {
  const r = compact ? 6 : 8;
  const rs = flatStart ? 0 : r;
  const re = flatEnd ? 0 : r;
  const radius =
    layout === "column" ? `${rs}px ${rs}px ${re}px ${re}px` : `${rs}px ${re}px ${re}px ${rs}px`;
  const full = absenceText(absence, detail);
  const from = absence.startMin > 0 ? `from ${formatTime(absence.startMin)}` : null;

  if (absence.kind === "vacation") {
    return (
      <div
        title={full}
        className={cx("absolute z-[1] flex overflow-hidden p-[3px]", layout === "column" ? "items-start" : "items-center")}
        style={{ ...vacationBandStyle(isDark), ...style, borderRadius: radius }}
      >
        <span className="sr-only">{full}</span>
        <span
          aria-hidden="true"
          className="inline-flex h-[18px] min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs font-semibold"
          style={vacationLabelStyle(isDark)}
        >
          {!compact ? <PlanIcon name="suitcase" size={14} className="shrink-0" /> : null}
          <span className="truncate">{compact ? absence.label : full}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      title={full}
      className={cx(
        "absolute z-[1] flex overflow-hidden",
        layout === "column" ? "flex-col items-start gap-0.5" : "items-center gap-1.5",
        compact ? "px-1 py-[3px]" : "px-2 py-1.5",
      )}
      style={{ ...restBandStyle(isDark), ...style, borderRadius: radius }}
    >
      <span className="sr-only">{full}</span>
      <span aria-hidden="true" className="flex min-w-0 max-w-full items-center gap-1.5 text-xs font-semibold leading-4">
        {!compact ? <PlanIcon name="rest" size={14} className="shrink-0" /> : null}
        {/* Phone columns (≈ 45 px): "NDF" instead of a cut-off "ND…". */}
        <span className="truncate">{compact ? deriveAbsenceShortLabel(absence.label) : absence.label}</span>
      </span>
      {!compact && (from || detail) ? (
        <span
          aria-hidden="true"
          className={cx(
            "max-w-full text-[11px] leading-[14px] tabular-nums opacity-90",
            layout === "column" ? "line-clamp-2" : "truncate",
          )}
        >
          {[from, detail].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </div>
  );
}
