import { cx } from "../../lib/classNames";

// Now-line (SPEC C5.8): 2 px in the "now" color (slate-900 / white in dark
// mode) with a 1 px halo, only in today's column/row. The time pill lives
// in the TimeAxis (nowMin prop). Decorative: times are in the block labels.

export type NowLineProps = {
  /** The time axis it sits on: "vertical" = time runs down → horizontal line. */
  axis: "vertical" | "horizontal";
  /** Position along the time axis in px (minutesToPx of nowMin). */
  offsetPx: number;
  /** Round dot at the line start (desktop). */
  showDot?: boolean;
  className?: string;
};

export default function NowLine({ axis, offsetPx, showDot = true, className }: NowLineProps) {
  const vertical = axis === "vertical";
  return (
    <div
      aria-hidden="true"
      data-now-line=""
      className={cx(
        "pointer-events-none absolute z-[3] bg-slate-900 shadow-[0_0_0_1px_#FFFFFF] dark:bg-slate-50 dark:shadow-[0_0_0_1px_#0F172A]",
        vertical ? "left-0 right-0 h-[2px]" : "bottom-0 top-0 w-[2px]",
        className,
      )}
      style={vertical ? { top: offsetPx - 1 } : { left: offsetPx - 1 }}
    >
      {showDot ? (
        <span
          className={cx(
            "absolute h-2 w-2 rounded-full bg-slate-900 shadow-[0_0_0_1px_#FFFFFF] dark:bg-slate-50 dark:shadow-[0_0_0_1px_#0F172A]",
            vertical ? "-left-1 -top-[3px]" : "-left-[3px] -top-1",
          )}
        />
      ) : null}
    </div>
  );
}
