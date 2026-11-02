import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";

type Option = {
  value: string;
  label: string;
};

type CustomSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Accessible name of the trigger button (when no visible label names it). */
  ariaLabel?: string;
  /** Tooltip on the trigger button. */
  title?: string;
};

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

export default function CustomSelect({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = "Select...",
  className,
  ariaLabel,
  title,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((opt) => opt.value === value);

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

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={cx("relative", className)}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
        className={cx(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors",
          "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950",
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:border-slate-300 dark:hover:border-slate-600",
          isOpen && "border-sky-400 ring-1 ring-sky-400 dark:border-sky-500 dark:ring-sky-500",
        )}
      >
        <span
          className={cx(
            "truncate",
            selectedOption
              ? "text-slate-900 dark:text-slate-100"
              : "text-slate-400 dark:text-slate-500",
          )}
        >
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDownIcon
          className={cx(
            "h-4 w-4 shrink-0 text-slate-400 transition-transform dark:text-slate-500",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={cx(
                "flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors",
                option.value === value
                  ? "bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/50",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
