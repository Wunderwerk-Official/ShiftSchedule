import type { MouseEvent } from "react";
import { cx } from "../../lib/classNames";

type EmptySlotPillProps = {
  label?: string;
  onRemove?: () => void;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  variant?: "default" | "ghost";
  showAddIcon?: boolean;
  highlighted?: boolean;
  className?: string;
};

export default function EmptySlotPill({
  label = "Open Slot",
  onRemove,
  onClick,
  variant = "default",
  showAddIcon = false,
  highlighted = false,
  className,
}: EmptySlotPillProps) {
  return (
    <div
      role={onClick ? "button" : undefined}
      onClick={onClick}
      // Border width is kept at border-2 in every state so that the
      // hover/highlighted styling (previously border → border-2) doesn't
      // grow the box by 1px on each side, which used to shift every row
      // below this one. Only the border color/style and ring change.
      className={cx(
        "no-print group/empty relative w-full rounded-xl border-2 px-2 py-1 text-center text-[11px] font-normal leading-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.7)]",
        highlighted
          ? "border-solid border-rose-500 bg-rose-50 text-rose-700 ring-2 ring-rose-200/80 dark:border-rose-400 dark:bg-rose-900/30 dark:text-rose-100 dark:ring-rose-500/40"
          : variant === "ghost"
            ? "border-dashed border-slate-200 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400"
            : "border-dashed border-slate-300 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-300",
        onClick && "cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700",
        className,
      )}
    >
      {label}
      {showAddIcon ? (
        <span className="no-print absolute right-1 top-0 -translate-y-1/2">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[12px] font-semibold text-slate-500 shadow-sm dark:bg-slate-700 dark:text-slate-300">
            +
          </span>
        </span>
      ) : null}
      {onRemove ? (
        <span
          role="button"
          aria-label="Remove open slot"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className={cx(
            "no-print absolute right-1 top-0 -translate-y-1/2 cursor-pointer opacity-0",
            "group-hover/empty:opacity-100",
          )}
        >
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[12px] font-semibold text-slate-500 shadow-sm dark:bg-slate-700 dark:text-slate-300">
            -
          </span>
        </span>
      ) : null}
    </div>
  );
}
