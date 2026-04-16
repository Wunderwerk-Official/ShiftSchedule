import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";

type CustomTimePickerProps = {
  value: string; // "HH:MM" format
  onChange: (value: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  step?: number; // minutes between options, default 30
  className?: string;
};

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// Generate time options with configurable step
function generateTimeOptions(step: number): string[] {
  const options: string[] = [];
  const validStep = Math.max(1, Math.min(60, step)); // Clamp to 1-60 minutes
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += validStep) {
      const h = String(hour).padStart(2, "0");
      const m = String(minute).padStart(2, "0");
      options.push(`${h}:${m}`);
    }
  }
  return options;
}

// Cache common step options
const TIME_OPTIONS_30 = generateTimeOptions(30);
const TIME_OPTIONS_15 = generateTimeOptions(15);

export default function CustomTimePicker({
  value,
  onChange,
  disabled = false,
  hasError = false,
  step = 30,
  className,
}: CustomTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Use cached options for common steps, generate for others
  const TIME_OPTIONS = step === 30 ? TIME_OPTIONS_30 : step === 15 ? TIME_OPTIONS_15 : generateTimeOptions(step);

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

  // Scroll to selected value when opening
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const selectedIndex = TIME_OPTIONS.indexOf(value);
    if (selectedIndex >= 0) {
      const itemHeight = 32; // approximate height of each item
      listRef.current.scrollTop = Math.max(0, selectedIndex * itemHeight - 64);
    }
  }, [isOpen, value]);

  const handleSelect = (time: string) => {
    onChange(time);
    setIsOpen(false);
  };

  // Display value - show as-is or placeholder
  const displayValue = value || "--:--";

  return (
    <div ref={containerRef} className={cx("relative", className)}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cx(
          "flex w-full items-center justify-between gap-1 rounded-lg border px-2 py-1 text-left text-[11px] font-medium transition-colors",
          "bg-white dark:bg-slate-900",
          disabled
            ? "cursor-not-allowed bg-slate-50 text-slate-400 dark:bg-slate-900/60 dark:text-slate-500"
            : "cursor-pointer text-slate-900 dark:text-slate-100",
          hasError
            ? "border-rose-400 dark:border-rose-500"
            : isOpen
              // Match the sky-400 focus ring used by CustomSelect / CustomNumberInput /
              // CustomDatePicker so all picker-style fields open with the same highlight.
              ? "border-sky-400 ring-1 ring-sky-400 dark:border-sky-500 dark:ring-sky-500"
              : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
        )}
      >
        <span className={!value ? "text-slate-400" : ""}>{displayValue}</span>
        <ClockIcon className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
      </button>

      {isOpen && (
        <div
          ref={listRef}
          className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {TIME_OPTIONS.map((time) => (
            <button
              key={time}
              type="button"
              onClick={() => handleSelect(time)}
              className={cx(
                "flex w-full items-center justify-center px-2 py-1.5 text-[11px] font-medium transition-colors",
                time === value
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/50",
              )}
            >
              {time}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
