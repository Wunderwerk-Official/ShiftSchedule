import { useRef, useState } from "react";
import type { PlanRange } from "../../api/client";
import { cx } from "../../lib/classNames";
import { addDays, addMonths, startOfMonth } from "../../lib/date";
import { buildMonthWeeks, formatPeriodLabel, isoWeekNumber } from "../../lib/myPlan";
import DatePickerPopover from "../schedule/DatePickerPopover";
import PlanIcon from "./PlanIcons";
import { roundIconButtonClass } from "./planChrome";
import { SHORTCUT_KEYS } from "./usePlanShortcuts";

// prev / label / next / Today for the visible period (plan §2.3). The label
// has a fixed minimum width so the arrows never jump; in the week range it
// opens the app's DatePickerPopover. "Today" is highlighted when today is not
// visible (SPEC R15).

const NOUNS: Record<PlanRange, string> = { day: "day", week: "week", month: "month" };

/** Anchor moved by one period. */
export function stepAnchor(range: PlanRange, anchor: Date, direction: -1 | 1): Date {
  if (range === "day") return addDays(anchor, direction);
  if (range === "week") return addDays(anchor, 7 * direction);
  return addMonths(startOfMonth(anchor), direction);
}

/** Bold main label + secondary text ("Week 42" + "12–18 Oct 2026"). */
function splitLabel(range: PlanRange, anchor: Date): { main: string; secondary: string } {
  const label = formatPeriodLabel(range, anchor);
  if (range === "week") {
    const [main, ...rest] = label.split(" · ");
    return { main, secondary: rest.join(" · ") };
  }
  if (range === "day") return { main: label, secondary: `Week ${isoWeekNumber(anchor)}` };
  const weeks = buildMonthWeeks(anchor);
  const first = isoWeekNumber(weeks[0][0]);
  const last = isoWeekNumber(weeks[weeks.length - 1][0]);
  return { main: label, secondary: `Weeks ${first}–${last}` };
}

type PeriodNavigatorProps = {
  range: PlanRange;
  anchorDate: Date;
  onChange: (date: Date) => void;
  /** Today lies in the visible period (Today pill stays neutral). */
  todayVisible: boolean;
  isMobile?: boolean;
};

export default function PeriodNavigator({
  range,
  anchorDate,
  onChange,
  todayVisible,
  isMobile = false,
}: PeriodNavigatorProps) {
  const labelRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { main, secondary } = splitLabel(range, anchorDate);
  const noun = NOUNS[range];
  // The app's picker selects whole weeks (it returns the Monday), so it is
  // offered for the week range only; day/month use the arrows (and the
  // month's "Open day").
  const canPick = range === "week";
  const labelClass = cx(
    "flex items-center justify-center rounded-lg px-2.5 tabular-nums text-slate-700 transition-colors dark:text-slate-200",
    isMobile ? "h-11 w-full flex-col leading-tight" : "h-8 min-w-[232px] gap-1.5 text-[15px]",
  );
  const labelContent = (
    <>
      <span className="font-semibold text-slate-900 dark:text-slate-100">{main}</span>
      {secondary ? (
        <span className={cx(isMobile && "text-xs text-slate-600 dark:text-slate-400")}>
          {isMobile ? secondary : `· ${secondary}`}
        </span>
      ) : null}
    </>
  );

  const todayButton = (
    <button
      type="button"
      onClick={() => onChange(new Date())}
      title={`Go to today (${SHORTCUT_KEYS.today})`}
      className={cx(
        "shrink-0 rounded-full border px-3.5 text-sm transition-colors focus-visible:rounded-full",
        // Phones: ≥ 44 px touch target.
        isMobile ? "h-11" : "h-8",
        todayVisible
          ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800"
          : "border-sky-300 bg-sky-50 font-semibold text-sky-900 hover:bg-sky-100 dark:border-sky-400/60 dark:bg-sky-900/30 dark:text-sky-100",
      )}
    >
      Today
    </button>
  );

  return (
    <div className={cx("flex items-center gap-1", isMobile && "w-full")}>
      <button
        type="button"
        onClick={() => onChange(stepAnchor(range, anchorDate, -1))}
        className={cx(roundIconButtonClass, isMobile && "h-11 w-11")}
        aria-label={`Previous ${noun}`}
      >
        <PlanIcon name="chevronLeft" />
      </button>
      <div className={cx("relative", isMobile && "min-w-0 flex-1")}>
        {canPick ? (
          <button
            ref={labelRef}
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-label={`Pick a week (${main}${secondary ? `, ${secondary}` : ""})`}
            aria-expanded={pickerOpen}
            className={cx(labelClass, "hover:bg-slate-100 dark:hover:bg-slate-800", pickerOpen && "bg-slate-100 dark:bg-slate-800")}
          >
            {labelContent}
            {isMobile ? null : (
              <PlanIcon name="calendar" className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            )}
          </button>
        ) : (
          <div className={labelClass}>{labelContent}</div>
        )}
        {canPick ? (
          <DatePickerPopover
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelectDate={(date) => {
              onChange(date);
              setPickerOpen(false);
            }}
            selectedDate={anchorDate}
            anchorRef={labelRef}
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onChange(stepAnchor(range, anchorDate, 1))}
        className={cx(roundIconButtonClass, isMobile && "h-11 w-11")}
        aria-label={`Next ${noun}`}
      >
        <PlanIcon name="chevronRight" />
      </button>
      <span className="ml-1 flex">{todayButton}</span>
      {/* Announces the period after paging, in every range (the week label is a button). */}
      <span className="sr-only" aria-live="polite">
        {secondary ? `${main}, ${secondary}` : main}
      </span>
    </div>
  );
}
