import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";

type CustomDatePickerProps = {
  value: string; // "DD.MM.YYYY" format
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hasError?: boolean;
  className?: string;
};

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"
      />
    </svg>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Parse DD.MM.YYYY to Date
function parseEuropeanDate(value: string): Date | null {
  const match = value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const [, dayRaw, monthRaw, yearRaw] = match;
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    return null;
  }
  return date;
}

// Format Date to DD.MM.YYYY
function formatEuropeanDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

// Get days for a month grid (including padding days from prev/next months)
// Always returns exactly 6 weeks to ensure consistent height
function getMonthDays(year: number, month: number): (Date | null)[][] {
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

  // Always pad to exactly 6 weeks (42 days) for consistent height
  while (days.length < 42) {
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

export default function CustomDatePicker({
  value,
  onChange,
  disabled = false,
  placeholder = "DD.MM.YYYY",
  hasError = false,
  className,
}: CustomDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openAbove, setOpenAbove] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Closing removes the popup; focus inside it would fall to <body> (out of
  // any dialog around the picker), so it goes back to the trigger.
  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };
  const parsedValue = parseEuropeanDate(value);
  const [viewDate, setViewDate] = useState(() => parsedValue ?? new Date());
  const today = new Date();

  // Update viewDate when value changes
  useEffect(() => {
    const parsed = parseEuropeanDate(value);
    if (parsed) {
      setViewDate(parsed);
    }
  }, [value]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const weeks = getMonthDays(year, month);
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(viewDate);

  const goToPrevMonth = () => {
    setViewDate(new Date(year, month - 1, 1));
  };

  const goToNextMonth = () => {
    setViewDate(new Date(year, month + 1, 1));
  };

  const handleSelectDate = (date: Date) => {
    onChange(formatEuropeanDate(date));
    closeAndFocusTrigger();
  };

  const displayValue = value || placeholder;

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && containerRef.current) {
      // Calculate whether to open above or below
      const rect = containerRef.current.getBoundingClientRect();
      const calendarHeight = 320; // Approximate height of calendar dropdown
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      setOpenAbove(spaceBelow < calendarHeight && spaceAbove > spaceBelow);
    }
    setIsOpen(!isOpen);
  };

  return (
    <div
      ref={containerRef}
      className={cx("relative", className)}
      onKeyDown={(e) => {
        // Escape closes only this popup, not a dialog around it.
        if (e.key === "Escape" && isOpen) {
          e.stopPropagation();
          closeAndFocusTrigger();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={cx(
          "flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors",
          "bg-white dark:bg-slate-900",
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:border-slate-300 dark:hover:border-slate-600",
          hasError
            ? "border-rose-400 dark:border-rose-500"
            : isOpen
              ? "border-sky-400 ring-1 ring-sky-400 dark:border-sky-500 dark:ring-sky-500"
              : "border-slate-200 dark:border-slate-700",
        )}
      >
        <span
          className={cx(
            value
              ? "font-normal text-slate-600 dark:text-slate-300"
              : "text-slate-400 dark:text-slate-500",
          )}
        >
          {displayValue}
        </span>
        <CalendarIcon className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
      </button>

      {isOpen && (
        <div
          className={cx(
            "absolute left-0 z-[100] w-[252px] rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-800",
            openAbove ? "bottom-full mb-1" : "top-full mt-1",
          )}
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

          {/* Weekday headers */}
          <div className="mb-1 grid grid-cols-7 gap-0">
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="h-6 w-8 text-center text-[10px] font-medium leading-6 text-slate-400 dark:text-slate-500"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="flex flex-col gap-0.5">
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="grid grid-cols-7 gap-0">
                {week.map((date, dayIndex) => {
                  if (!date) {
                    return <div key={`empty-${dayIndex}`} className="h-8 w-8" />;
                  }

                  const isSelected = parsedValue && isSameDay(date, parsedValue);
                  const isToday = isSameDay(date, today);
                  const isWeekend = date.getDay() === 0 || date.getDay() === 6;

                  return (
                    <button
                      key={date.toISOString()}
                      type="button"
                      onClick={() => handleSelectDate(date)}
                      className={cx(
                        "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors",
                        isSelected
                          ? "bg-sky-500 text-white dark:bg-sky-600"
                          : isToday
                            ? "bg-sky-100 font-bold text-sky-600 dark:bg-sky-900/40 dark:text-sky-400"
                            : isWeekend
                              ? "text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-700"
                              : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700",
                      )}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Today button */}
          <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-700">
            <button
              type="button"
              onClick={() => handleSelectDate(today)}
              className="w-full rounded-lg px-3 py-1.5 text-xs font-medium text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-900/30"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
