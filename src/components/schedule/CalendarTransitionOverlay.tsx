import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import { useModalFocus } from "../../lib/useModalFocus";

type CalendarTransitionOverlayProps = {
  /** What the page is doing: "Updating calendar…", "Creating PDF for 2 weeks…". */
  message: string;
  /** Offered while it can be stopped (a running PDF export); also on Escape. */
  onCancel?: () => void;
};

/**
 * Blocks the page while the calendar is replaced or exported. A modal dialog:
 * the page behind it (and the Export dialog) is inert, so nothing can be
 * clicked or focused there; focus sits on Cancel when it is offered.
 */
export default function CalendarTransitionOverlay({ message, onCancel }: CalendarTransitionOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, containerRef, cancelRef);
  const canCancel = !!onCancel;
  // Cancel appears once the export request runs (not while saving first).
  useEffect(() => {
    if (canCancel) cancelRef.current?.focus();
  }, [canCancel]);

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-transition-status"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onCancel) {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-white/70 outline-none dark:bg-slate-950/70"
    >
      {/* A card behind the text, so it never runs into the fields of a dialog underneath. */}
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white px-6 py-4 text-sm font-medium text-slate-700 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
        <p id="calendar-transition-status" role="status" aria-live="polite">
          {message}
        </p>
        {onCancel ? (
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className={cx(
              "rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-900 shadow-sm",
              "hover:bg-slate-50 active:bg-slate-100",
              "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
            )}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
