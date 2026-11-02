import { useEffect, useRef, type RefObject } from "react";

// Keeps keyboard focus in the swap drawer when the drawer itself takes it
// away: a focused control that it disables, hides or removes (a busy button,
// a refreshed list, an Undo that is done). The browser would move focus to
// <body>, where the panel's Escape and the phone sheet's Tab trap no longer
// work. A press outside the drawer lets focus go: the desktop drawer is
// non-modal, so focus then stays wherever the planner put it.
//
// Mutations are checked in the observer's microtask, after the commit and its
// effects (which may have moved focus already) and before the browser's own
// focus fixup moves focus off a disabled control.

export function useFocusSafetyNet(
  panelRef: RefObject<HTMLElement>,
  /** The new target, given the ancestors of the element that lost focus (innermost first). */
  fallback: (lostPath: Element[]) => HTMLElement | null,
  /** Binds again when the panel element changes (phone sheet ↔ desktop drawer). */
  panelKey: unknown,
): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  // Whether focus was last inside the panel, and where; kept across a new panel element.
  const last = useRef<{ held: boolean; path: Element[] }>({ held: false, path: [] });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const track = last.current;
    const remember = (element: Element | null) => {
      track.held = element !== null && panel.contains(element);
      track.path = [];
      for (let node = track.held ? element : null; node && node !== panel; node = node.parentElement) {
        track.path.push(node);
      }
    };
    const restore = () => {
      if (!track.held || !panel.isConnected) return;
      const active = document.activeElement;
      const lost =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        !active.isConnected ||
        (panel.contains(active) && (active.matches(":disabled") || active.closest("[hidden]") !== null));
      if (!lost) return;
      const target = fallbackRef.current(track.path);
      target?.focus({ preventScroll: true });
      // In view, inside the drawer's own scroll area (the drawer is fixed, so the page stays).
      target?.scrollIntoView?.({ block: "nearest" });
    };
    // A new panel element took the place of the one that had focus.
    restore();
    remember(document.activeElement);

    const onFocusIn = (event: FocusEvent) => remember(event.target instanceof Element ? event.target : null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !panel.contains(event.target)) remember(null);
    };
    const observer = new MutationObserver(restore);
    observer.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [panelRef, panelKey]);
}
