import { useEffect, useRef } from "react";

// Global single-key shortcuts of My plan (SPEC R16). They act without
// Ctrl/Alt/Meta, not while a modal sheet is open, and not while focus is in an
// editable element or inside a popover, list, menu or dialog (modal or not:
// the person picker, the shift detail, the day popover, the date picker). The
// one exception: N / Shift+N also step on from the shift detail they open.

export type PlanShortcut =
  | "day"
  | "week"
  | "month"
  | "today"
  | "orientation"
  | "scope"
  | "nextShift"
  | "previousShift"
  | "help";

/** Key hint per shortcut, for tooltips ("Week (W)"). */
export const SHORTCUT_KEYS: Record<PlanShortcut, string> = {
  day: "T",
  week: "W",
  month: "M",
  today: "H",
  orientation: "O",
  scope: "P",
  nextShift: "N",
  previousShift: "Shift+N",
  help: "?",
};

/** One-line overview for the "?" toast. */
export const SHORTCUT_HELP =
  "Shortcuts: T / W / M day, week, month · H today · O date on top / left · P team plan · N / Shift+N next / previous shift";

const BY_KEY: Record<string, PlanShortcut> = {
  t: "day",
  w: "week",
  m: "month",
  h: "today",
  o: "orientation",
  p: "scope",
  "?": "help",
};

// Focus inside one of these belongs to that control, not to the page.
const FOCUS_OWNERS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  "[popover]",
].join(", ");

// The shift detail popover: N / Shift+N keep stepping from there.
const SHIFT_STEP_ZONE = "[data-shift-steps]";

function focusOwner(target: EventTarget | null): "page" | "shiftDetail" | "control" {
  if (!(target instanceof HTMLElement)) return "page";
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
    return "control";
  }
  const owner = target.closest(FOCUS_OWNERS);
  if (!owner) return "page";
  return owner.matches(SHIFT_STEP_ZONE) ? "shiftDetail" : "control";
}

export function usePlanShortcuts(handlers: Partial<Record<PlanShortcut, () => void>>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const owner = focusOwner(event.target);
      const key = event.key.toLowerCase();
      if (owner === "control" || (owner === "shiftDetail" && key !== "n")) return;
      const shortcut = key === "n" ? (event.shiftKey ? "previousShift" : "nextShift") : BY_KEY[key];
      const handler = shortcut ? handlersRef.current[shortcut] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
