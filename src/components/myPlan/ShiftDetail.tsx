import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import ShiftDetailContent from "./ShiftDetailContent";
import type { ShiftDetailProps } from "./types";
import { useDismiss } from "./useDismiss";

// Shift detail (plan §2.6): desktop popover next to the anchor block, kept
// inside the viewport; mobile bottom sheet; or a static inline card (day
// views' detail column). Escape and outside clicks (sheet: its backdrop)
// close it; focus moves into the dialog and returns to the anchor on close.
// Clicking a block of the same shift (data-shift-id) is not "outside" — the
// block itself toggles.

export type ShiftDetailViewProps = ShiftDetailProps & {
  /** "auto" (default): popover on desktop, sheet on mobile. "inline": static card, no close. */
  variant?: "auto" | "inline";
  /** Inline card only: "columns" lays a wide card out in three columns (day · date on left). */
  layout?: "stack" | "columns";
};

const POPOVER_WIDTH = 360;
const GAP = 8;
const MARGIN = 8;

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Popover position: right of the anchor, else left, else below; clamped into
 * the viewport and — when it fits — into the plan grid (`bounds`, SPEC C5.9:
 * top = clamp(blockTop − 24, 8, gridHeight − popoverHeight − 8)), so it never
 * covers the footer and legend.
 */
export function placePopover(
  anchor: { top: number; left: number; right: number; bottom: number } | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  bounds?: { top: number; bottom: number } | null,
): { top: number; left: number } {
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  let minTop = MARGIN;
  let maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  if (bounds) {
    const gridMin = Math.max(minTop, bounds.top + MARGIN);
    const gridMax = Math.min(maxTop, bounds.bottom - size.height - MARGIN);
    if (gridMax >= gridMin) [minTop, maxTop] = [gridMin, gridMax];
  }
  const clampLeft = (value: number) => Math.min(Math.max(value, MARGIN), maxLeft);
  const clampTop = (value: number) => Math.min(Math.max(value, minTop), maxTop);
  if (!anchor) {
    return { left: clampLeft((viewport.width - size.width) / 2), top: clampTop((viewport.height - size.height) / 2) };
  }
  const top = clampTop(anchor.top - 24);
  if (anchor.right + GAP + size.width <= viewport.width - MARGIN) return { left: anchor.right + GAP, top };
  if (anchor.left - GAP - size.width >= MARGIN) return { left: anchor.left - GAP - size.width, top };
  return { left: clampLeft(anchor.left), top: clampTop(anchor.bottom + GAP) };
}

/** Selector of the plan body (MyPlanView) that bounds the popover vertically. */
export const PLAN_GRID_SELECTOR = "[data-plan-grid]";

export default function ShiftDetail(props: ShiftDetailViewProps) {
  const headingId = useId();
  if (props.variant === "inline") {
    return (
      <div
        role="region"
        aria-labelledby={headingId}
        className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
      >
        <ShiftDetailContent {...props} onClose={undefined} headingId={headingId} maxPerGroup={2} />
      </div>
    );
  }
  return <FloatingDetail {...props} headingId={headingId} />;
}

/**
 * The block the detail points at. When the view changed under an open detail
 * (e.g. an orientation switch) the original element is gone: find the shift's
 * block again by data-shift-id (prefer the tab stop of a split night).
 */
export function resolveAnchor(anchorEl: HTMLElement | null, shiftId: string): HTMLElement | null {
  if (anchorEl?.isConnected) return anchorEl;
  const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-shift-id]")).filter(
    (element) => element.getAttribute("data-shift-id") === shiftId && !element.closest('[role="dialog"]'),
  );
  return blocks.find((element) => element.tabIndex >= 0) ?? blocks[0] ?? null;
}

type Position = { top: number; left: number };

function FloatingDetail(props: ShiftDetailViewProps & { headingId: string }) {
  const { anchorEl, isMobile, onClose, shift } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef(anchorEl);
  anchorRef.current = anchorEl;

  // Desktop: next to the (re-resolved) anchor, inside the viewport. Bails out
  // when nothing moved, so calling it on every render and scroll frame is cheap.
  const placeRef = useRef(() => {});
  placeRef.current = () => {
    const dialog = dialogRef.current;
    if (isMobile || !dialog) return;
    const anchor = resolveAnchor(anchorRef.current, shift.id);
    const grid = anchor?.closest(PLAN_GRID_SELECTOR);
    const next = placePopover(
      anchor ? anchor.getBoundingClientRect() : null,
      { width: dialog.offsetWidth || POPOVER_WIDTH, height: dialog.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      grid ? grid.getBoundingClientRect() : null,
    );
    setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  };
  // Every render: the view under the detail may have moved the block.
  useLayoutEffect(() => {
    placeRef.current();
  });
  // Scrolling, resizing and content growth: at most once per frame.
  useEffect(() => {
    if (isMobile) return;
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer && dialogRef.current) observer.observe(dialogRef.current);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [isMobile]);

  // Focus moves in only once the dialog is visible: browsers ignore focus()
  // on the still unpositioned (visibility: hidden) popover.
  const visible = isMobile || position !== null;
  useEffect(() => {
    if (visible) dialogRef.current?.focus({ preventScroll: true });
  }, [visible, shift.id]);

  // On close, focus returns to the block (found again if the view changed).
  useEffect(() => {
    const dialog = dialogRef.current;
    const shiftId = shift.id;
    return () => {
      const active = document.activeElement;
      const focusWasInside = !active || active === document.body || (dialog?.contains(active) ?? false);
      const anchor = resolveAnchor(anchorRef.current, shiftId);
      if (focusWasInside && anchor) anchor.focus({ preventScroll: true });
    };
  }, [shift.id]);

  // Phone sheet: the page must not scroll behind the modal.
  useEffect(() => {
    if (!isMobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile]);

  // Escape (anywhere) closes. Desktop: outside presses close too, but a block
  // of the same shift toggles itself. The modal sheet closes from its
  // backdrop's onClick (see useDismiss).
  useDismiss(
    true,
    onClose,
    (target) => {
      if (dialogRef.current?.contains(target)) return true;
      const block = (target as Element).closest?.("[data-shift-id]");
      return block?.getAttribute("data-shift-id") === shift.id;
    },
    { outsidePress: !isMobile },
  );

  // Tab: cycles inside the modal sheet; leaving the desktop popover (portaled
  // to the end of <body>) closes it, and focus returns to the block.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    const items = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const atStart = active === first || active === dialog;
    const atEnd = active === last || items.length === 0;
    if (isMobile) {
      if (items.length === 0) return;
      if (event.shiftKey && atStart) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if ((event.shiftKey && atStart) || (!event.shiftKey && atEnd)) {
      event.preventDefault();
      onClose();
    }
  };

  // The 360 px popover and the sheet are always stacked (columns: inline card only).
  const content = <ShiftDetailContent {...props} layout="stack" onClose={onClose} headingId={props.headingId} />;

  if (isMobile) {
    return createPortal(
      <div className="fixed inset-0 z-[60] flex flex-col justify-end">
        <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-slate-900/30 dark:bg-black/50" />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={props.headingId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative max-h-[75vh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-slate-200 bg-white px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 shadow-lg focus:outline-none focus-visible:rounded-t-2xl focus-visible:shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <span aria-hidden="true" className="mx-auto mb-2 block h-1 w-9 rounded-full bg-slate-300 dark:bg-slate-600" />
          {content}
        </div>
      </div>,
      document.body,
    );
  }

  const style: CSSProperties = position
    ? { top: position.top, left: position.left }
    : { top: 0, left: 0, visibility: "hidden" };
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby={props.headingId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cx(
        "fixed z-[60] max-h-[calc(100vh-16px)] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-lg",
        // The dialog itself only receives focus programmatically: keep its own shape.
        "focus:outline-none focus-visible:rounded-2xl focus-visible:shadow-lg",
        "dark:border-slate-700 dark:bg-slate-900",
      )}
      style={style}
    >
      {content}
    </div>,
    document.body,
  );
}
