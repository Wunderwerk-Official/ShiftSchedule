import { useEffect, useRef } from "react";

// Global single-key shortcuts of My plan (SPEC R16). They only act outside
// text inputs, without Ctrl/Alt/Meta, and not while a modal sheet is open.

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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function usePlanShortcuts(handlers: Partial<Record<PlanShortcut, () => void>>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
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
