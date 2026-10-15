import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/classNames";

// Small confirmation toast with an optional action ("Undo"), SPEC C5.12.
// Dark pill (slate-900 / white in dark mode), bottom-center on desktop and
// full-width above the bottom edge on phones. Auto-dismisses — later when it
// offers an action, and never while hovered or focused (WCAG 2.2.1).

export type ToastMessage = {
  /** Changes per toast so a repeated message restarts the timer. */
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

const DEFAULT_DURATION_MS = 6000;
const ACTION_DURATION_MS = 10000;

/** Toast state for a container: show(message, action?) and dismiss(). */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const counter = useRef(0);
  const show = useCallback((message: string, action?: { label: string; onAction: () => void }) => {
    counter.current += 1;
    setToast({
      id: counter.current,
      message,
      actionLabel: action?.label,
      onAction: action?.onAction,
    });
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  return { toast, show, dismiss };
}

export type NotifyFn = ReturnType<typeof useToast>["show"];

type ToastProps = {
  toast: ToastMessage | null;
  onDismiss: () => void;
  isMobile: boolean;
  durationMs?: number;
};

export default function Toast({ toast, onDismiss, isMobile, durationMs }: ToastProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const hasAction = Boolean(toast?.actionLabel && toast.onAction);
  const duration = durationMs ?? (hasAction ? ACTION_DURATION_MS : DEFAULT_DURATION_MS);
  // The timer restarts per toast and after a pause ends.
  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss, duration, paused]);
  // A new toast (or none) starts unpaused.
  useEffect(() => {
    setHovered(false);
    setFocused(false);
  }, [toast?.id]);

  // The live region stays mounted so screen readers announce new messages.
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "pointer-events-none fixed z-50",
        isMobile ? "inset-x-4 bottom-4" : "bottom-8 left-1/2 -translate-x-1/2",
      )}
    >
      {toast ? (
        <div
          key={toast.id}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={cx(
            "pointer-events-auto flex items-center gap-4 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] leading-[18px] text-white shadow-lg",
            "dark:bg-slate-50 dark:text-slate-900",
            isMobile ? "justify-between" : "whitespace-nowrap",
          )}
        >
          <span>{toast.message}</span>
          {toast.actionLabel && toast.onAction ? (
            <button
              type="button"
              onClick={() => {
                toast.onAction?.();
                onDismiss();
              }}
              className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
