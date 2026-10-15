import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

type DatePickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  // firstDayInMonth: the row's first day inside the displayed month (rows
  // are single buttons, so this is not necessarily the day under the cursor).
  onSelectDate: (weekStart: Date, firstDayInMonth: Date) => void;
  selectedDate: Date;
  anchorRef: React.RefObject<HTMLElement>;
};

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Get the Monday of the week containing a date
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Get weeks as rows of 7 days for a month (including partial weeks with nulls)
function getMonthWeeks(year: number, month: number): (Date | null)[][] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Get day of week for first day (0 = Sunday, convert to Monday-based)
  let startDayOfWeek = firstDay.getDay();
  startDayOfWeek = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;

  const days: (Date | null)[] = [];

  // Add empty cells for days before the first of the month
  for (let i = 0; i < startDayOfWeek; i++) {
    days.push(null);
  }

  // Add all days of the month
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(new Date(year, month, d));
  }

  // Pad to complete the last week
  while (days.length % 7 !== 0) {
    days.push(null);
  }

  // Split into weeks
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  return weeks;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameWeek(a: Date, b: Date): boolean {
  const weekStartA = getWeekStart(a);
  const weekStartB = getWeekStart(b);
  return isSameDay(weekStartA, weekStartB);
}

export default function DatePickerPopover({
  open,
  onClose,
  onSelectDate,
  selectedDate,
  anchorRef,
}: DatePickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [viewDate, setViewDate] = useState(() => new Date(selectedDate));
  const [hoveredWeek, setHoveredWeek] = useState<Date | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const today = new Date();

  // Update viewDate when selectedDate changes
  useEffect(() => {
    setViewDate(new Date(selectedDate));
  }, [selectedDate]);

  // Calculate position based on anchor element
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popoverWidth = 280;
    // Position below the anchor, centered horizontally
    setPosition({
      top: rect.bottom + 8,
      left: rect.left + rect.width / 2 - popoverWidth / 2,
    });
  }, [open, anchorRef]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose, anchorRef]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const weeks = getMonthWeeks(year, month);

  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(viewDate);

  const goToPrevMonth = () => {
    setViewDate(new Date(year, month - 1, 1));
  };

  const goToNextMonth = () => {
    setViewDate(new Date(year, month + 1, 1));
  };

  const handleSelectWeek = (firstDayInMonth: Date) => {
    // Navigate to the Monday of the selected week; the row's first day in the
    // displayed month is passed too (month pickers need it: the Monday may
    // lie in the previous month).
    const weekStart = getWeekStart(firstDayInMonth);
    onSelectDate(weekStart, firstDayInMonth);
    onClose();
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[1000] rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800"
      style={{ minWidth: 280, top: position.top, left: position.left }}
    >
      {/* Header with month/year navigation */}
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={goToPrevMonth}
          className="grid h-7 w-7 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {monthName} {year}
        </span>
        <button
          type="button"
          onClick={goToNextMonth}
          className="grid h-7 w-7 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          aria-label="Next month"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Hint text */}
      <div className="mb-2 text-center text-[10px] text-slate-400 dark:text-slate-500">
        Select a week
      </div>

      {/* Weekday headers */}
      <div className="mb-1 grid grid-cols-7 gap-0">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="h-6 text-center text-[10px] font-medium leading-6 text-slate-400 dark:text-slate-500"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid - weeks as rows */}
      <div className="flex flex-col gap-0.5">
        {weeks.map((week, weekIndex) => {
          // Find first non-null date in the week to determine week identity
          const weekDate = week.find((d) => d !== null);
          if (!weekDate) return null;

          const isSelectedWeek = isSameWeek(weekDate, selectedDate);
          const isHoveredWeek = hoveredWeek && isSameWeek(weekDate, hoveredWeek);
          const isCurrentWeek = isSameWeek(weekDate, today);

          return (
            <button
              key={weekIndex}
              type="button"
              onClick={() => handleSelectWeek(weekDate)}
              onMouseEnter={() => setHoveredWeek(weekDate)}
              onMouseLeave={() => setHoveredWeek(null)}
              className={cx(
                "grid grid-cols-7 gap-0 rounded-lg transition-colors",
                isSelectedWeek
                  ? "bg-sky-500 dark:bg-sky-600"
                  : isHoveredWeek
                    ? "bg-sky-100 dark:bg-sky-900/40"
                    : isCurrentWeek
                      ? "bg-slate-100 dark:bg-slate-700/50"
                      : "hover:bg-slate-50 dark:hover:bg-slate-700/30",
              )}
            >
              {week.map((date, dayIndex) => {
                if (!date) {
                  return <div key={`empty-${dayIndex}`} className="h-8 w-8" />;
                }

                const isToday = isSameDay(date, today);
                const isWeekend = date.getDay() === 0 || date.getDay() === 6;

                return (
                  <div
                    key={date.toISOString()}
                    className={cx(
                      "flex h-8 w-8 items-center justify-center text-xs font-medium",
                      isSelectedWeek
                        ? "text-white"
                        : isToday
                          ? "font-bold text-sky-600 dark:text-sky-400"
                          : isWeekend
                            ? "text-slate-400 dark:text-slate-500"
                            : "text-slate-700 dark:text-slate-300",
                    )}
                  >
                    {date.getDate()}
                  </div>
                );
              })}
            </button>
          );
        })}
      </div>

      {/* This week button */}
      <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-700">
        <button
          type="button"
          onClick={() => handleSelectWeek(today)}
          className="w-full rounded-lg px-3 py-1.5 text-xs font-medium text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-900/30"
        >
          This week
        </button>
      </div>
    </div>,
    document.body,
  );
}
