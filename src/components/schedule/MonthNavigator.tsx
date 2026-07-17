import { useRef, useState } from "react";
import { cx } from "../../lib/classNames";
import { formatMonthLabel } from "../../lib/date";
import { ChevronLeftIcon, ChevronRightIcon, CalendarIcon } from "./icons";
import DatePickerPopover from "./DatePickerPopover";

type MonthNavigatorProps = {
  month: Date;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onGoToDate?: (date: Date) => void;
  variant?: "page" | "card";
};

export default function MonthNavigator({
  month,
  onPrevMonth,
  onNextMonth,
  onToday,
  onGoToDate,
  variant = "page",
}: MonthNavigatorProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const handleDateClick = () => {
    if (onGoToDate) {
      setShowDatePicker((prev) => !prev);
    }
  };

  const handleSelectDate = (date: Date) => {
    if (onGoToDate) {
      onGoToDate(date);
    }
  };

  const panel = (
    <div
      className={cx(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        variant === "page" &&
          "rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm dark:border-slate-700 dark:bg-slate-900",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPrevMonth}
          className={cx(
            "grid h-8 w-8 place-items-center rounded-full border border-slate-200/70 bg-white text-slate-600",
            "hover:bg-slate-50 active:bg-slate-100",
            "dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            onClick={handleDateClick}
            disabled={!onGoToDate}
            className={cx(
              "flex min-w-[148px] items-center justify-center gap-1.5 text-center text-sm font-normal tracking-tight text-slate-700 dark:text-slate-200 sm:text-base",
              onGoToDate &&
                "cursor-pointer rounded-lg px-2 py-1 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800",
              showDatePicker && "bg-slate-100 dark:bg-slate-800",
            )}
            aria-label="Pick a month"
          >
            <span>{formatMonthLabel(month)}</span>
            {onGoToDate ? (
              <CalendarIcon className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            ) : null}
          </button>
          {onGoToDate && (
            <DatePickerPopover
              open={showDatePicker}
              onClose={() => setShowDatePicker(false)}
              onSelectDate={handleSelectDate}
              selectedDate={month}
              anchorRef={buttonRef}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onNextMonth}
          className={cx(
            "grid h-8 w-8 place-items-center rounded-full border border-slate-200/70 bg-white text-slate-600",
            "hover:bg-slate-50 active:bg-slate-100",
            "dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
          aria-label="Next month"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onToday}
          className={cx(
            "h-8 rounded-full border border-slate-200/70 bg-white px-3.5 text-sm font-normal text-slate-700",
            "hover:bg-slate-50 active:bg-slate-100",
            "dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800",
          )}
        >
          Today
        </button>
      </div>
    </div>
  );

  if (variant === "card") {
    return panel;
  }

  return <div className="mx-auto max-w-7xl px-6 pt-6">{panel}</div>;
}
