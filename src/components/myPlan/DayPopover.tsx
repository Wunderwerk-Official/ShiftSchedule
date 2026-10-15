import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import { formatHours, formatShiftTimeRange, type PersonPlan, type PlanDay } from "../../lib/myPlan";
import type { SelectShift } from "./types";
import PlanIcon from "./PlanIcons";
import { vacationBandStyle, vacationColors } from "./absenceStyles";
import { dayEntries, entryRadiusClass, entryStyle } from "./monthParts";
import {
  TEXT_1,
  draftBadgeClass,
  formatLongDate,
  popoverPanelClass,
  solidButtonBaseClass,
  solidButtonClass,
} from "./planChrome";
import { useDismiss } from "./useDismiss";

// Month day detail (SPEC E5/E13): entries of one day + "Open day". Desktop:
// a 300 px popover next to the clicked cell; phones: the same content as a
// card under the calendar (DayDetails).

type DayDetailsProps = {
  day: PlanDay;
  plan: PersonPlan;
  isDark: boolean;
  onOpenDay: (dateISO: string) => void;
  /** Select a shift; the anchor positions the shift detail. */
  onSelectShift: SelectShift;
  /** Element the shift detail should point at (the day cell). */
  shiftAnchor?: HTMLElement | null;
  /** Extra line under the title (e.g. "Week 42 · 53.0 h planned"). */
  subtitle?: string;
  /** Vacation label of the day's run ("Vacation · 19–23 Oct (5 days)"). */
  vacationLabel?: string;
  isMobile?: boolean;
};

export function DayDetails({
  day,
  plan,
  isDark,
  onOpenDay,
  onSelectShift,
  shiftAnchor,
  subtitle,
  vacationLabel,
  isMobile = false,
}: DayDetailsProps) {
  const entries = dayEntries(plan, day);
  const onVacation = day.absences.some((absence) => absence.kind === "vacation");
  const hasDraft = entries.some((entry) => entry.kind === "shift" && !entry.shift.published);
  return (
    <div className="flex flex-col gap-3">
      <div className={cx("flex flex-col gap-0.5", !isMobile && "pr-8")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={cx("font-semibold", isMobile ? "text-[15px]" : "text-base", TEXT_1)}>
            {formatLongDate(day.dateISO)}
          </h3>
          {day.isToday ? (
            <span className="inline-flex h-5 items-center rounded-full bg-slate-900 px-2 text-[11px] font-semibold text-white dark:bg-white dark:text-slate-900">
              today
            </span>
          ) : null}
        </div>
        {subtitle ? <p className="text-xs tabular-nums text-slate-600 dark:text-slate-400">{subtitle}</p> : null}
      </div>
      {day.holidayName ? (
        <p className="text-[13px] font-medium text-purple-800 dark:text-purple-200">{day.holidayName}</p>
      ) : null}
      {onVacation ? (
        <div className="flex items-center gap-2 text-[13px]" style={{ color: vacationColors(isDark).text }}>
          <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded" style={vacationBandStyle(isDark)} />
          <span className="font-semibold">{vacationLabel ?? "Vacation"}</span>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => {
            const swatch = (
              <span
                aria-hidden="true"
                className={cx("h-3.5 w-3.5 shrink-0", entryRadiusClass(entry, "rounded"))}
                style={entryStyle(entry, isDark)}
              />
            );
            // A night starting this day shows its whole range ("17:00 → Thu 08:00").
            const time =
              entry.kind === "shift" && entry.segment.cutEnd && !entry.segment.cutStart
                ? formatShiftTimeRange(entry.shift)
                : entry.time;
            // Title over time: a night's full range leaves no room for both on one line.
            const text = (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-slate-900 dark:text-slate-100">{entry.title}</span>
                <span className="truncate text-xs tabular-nums text-slate-700 dark:text-slate-300">{time}</span>
              </span>
            );
            if (entry.kind === "rest") {
              return (
                <li key={entry.key} className="flex min-h-11 items-center gap-2 px-2 py-1 text-[13px]">
                  {swatch}
                  {text}
                </li>
              );
            }
            const startsHere = !entry.segment.cutStart;
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={(event) => onSelectShift(entry.shift.id, shiftAnchor ?? event.currentTarget)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label={`${entry.title.replace(/^↳\s?/, "")} ${time} – show details`}
                >
                  {swatch}
                  {text}
                  <span className="w-12 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {startsHere ? formatHours(entry.shift.hours) : "–"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : !onVacation && day.published ? (
        <p className="text-[13px] text-slate-600 dark:text-slate-400">free</p>
      ) : null}
      {hasDraft ? <span className={cx(draftBadgeClass, "self-start")}>Draft – not published</span> : null}
      <button
        type="button"
        onClick={() => onOpenDay(day.dateISO)}
        className={cx(
          "gap-1.5",
          isMobile ? cx(solidButtonBaseClass, "h-12 w-full px-4 text-[15px]") : solidButtonClass,
        )}
      >
        Open day
        <PlanIcon name="chevronRight" />
      </button>
    </div>
  );
}

const POPOVER_WIDTH = 300;
const GAP = 8;

type DayPopoverProps = Omit<DayDetailsProps, "shiftAnchor" | "isMobile"> & {
  anchor: HTMLElement;
  onClose: () => void;
};

/** Desktop popover next to the cell: right of Mon–Thu, left of Fri–Sun; Escape/outside click close. */
export default function DayPopover({ anchor, onClose, ...details }: DayPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const weekday = details.day.date.getDay();
  const placeRight = weekday >= 1 && weekday <= 4;

  // Bails out when nothing moved (cheap on every scroll frame).
  const placeRef = useRef(() => {});
  placeRef.current = () => {
    const rect = anchor.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 0;
    const maxTop = Math.max(GAP, window.innerHeight - height - GAP);
    let left = placeRight ? rect.right + GAP : rect.left - POPOVER_WIDTH - GAP;
    left = Math.min(Math.max(GAP, left), Math.max(GAP, window.innerWidth - POPOVER_WIDTH - GAP));
    const top = Math.min(Math.max(GAP, rect.top), maxTop);
    setPosition((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  };

  useLayoutEffect(() => {
    placeRef.current();
  }, [anchor, placeRight, details.day.dateISO]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeRef.current();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Focus moves in once the panel is positioned (browsers ignore focus() while it is visibility: hidden).
  const visible = position !== null;
  useEffect(() => {
    if (visible) panelRef.current?.focus({ preventScroll: true });
  }, [visible, anchor]);

  const closeToAnchor = () => {
    onClose();
    anchor.focus();
  };

  useDismiss(
    true,
    (reason) => {
      onClose();
      if (reason === "escape") anchor.focus();
    },
    (target) => Boolean(panelRef.current?.contains(target)) || anchor.contains(target),
  );

  // The panel is portaled to the end of <body>: tabbing out of it closes it and returns to the cell.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    const items = Array.from(panel?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? []);
    const active = document.activeElement;
    const atStart = active === items[0] || active === panel;
    const atEnd = active === items[items.length - 1] || items.length === 0;
    if ((event.shiftKey && atStart) || (!event.shiftKey && atEnd)) {
      event.preventDefault();
      closeToAnchor();
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Day detail ${formatLongDate(details.day.dateISO)}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cx(popoverPanelClass, "fixed z-40 outline-none")}
      style={{
        width: POPOVER_WIDTH,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <button
        type="button"
        onClick={closeToAnchor}
        aria-label="Close"
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full text-slate-600 hover:bg-slate-100 focus-visible:rounded-full dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <PlanIcon name="x" />
      </button>
      <DayDetails {...details} shiftAnchor={anchor} />
    </div>,
    document.body,
  );
}
