import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";

type CustomNumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
};

function ChevronUpDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15L12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9" />
    </svg>
  );
}

export default function CustomNumberInput({
  value,
  onChange,
  min = 0,
  max = 100,
  disabled = false,
  className,
}: CustomNumberInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Generate options from min to max. Clamp the length at zero so a caller
  // passing max < min renders an empty dropdown instead of crashing on a
  // negative Array.from length.
  const options = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);

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

  const handleSelect = (num: number) => {
    onChange(num);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={cx("relative", className)}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cx(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors",
          "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950",
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:border-slate-300 dark:hover:border-slate-600",
          isOpen && "border-sky-400 ring-1 ring-sky-400 dark:border-sky-500 dark:ring-sky-500",
        )}
      >
        <span className="text-slate-900 dark:text-slate-100">{value}</span>
        <ChevronUpDownIcon
          className={cx(
            "h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500",
          )}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800">
          {options.map((num) => (
            <button
              key={num}
              type="button"
              onClick={() => handleSelect(num)}
              className={cx(
                "flex w-full items-center justify-center px-3 py-1.5 text-sm transition-colors",
                num === value
                  ? "bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/50",
              )}
            >
              {num}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
