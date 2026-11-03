import { useEffect, type RefObject } from "react";

/**
 * Keyboard and screen-reader behaviour of a modal rendered in a portal
 * directly under <body>: while `open`, everything else under <body> is made
 * inert (no focus, no clicks, hidden from assistive technology), focus moves
 * into the modal (`initialFocusRef`, else the container) and returns to the
 * element that had it when the modal closes. Elements that were already inert
 * (an outer modal's background) are left alone, so modals can nest.
 */
export function useModalFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The modal's own node directly under <body> (its portal root).
    let root: HTMLElement = container;
    while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
    const madeInert: Element[] = [];
    if (root.parentElement === document.body) {
      for (const child of Array.from(document.body.children)) {
        if (child === root || child.hasAttribute("inert") || child.tagName === "SCRIPT") continue;
        child.setAttribute("inert", "");
        madeInert.push(child);
      }
    }
    (initialFocusRef?.current ?? container).focus();
    return () => {
      for (const element of madeInert) element.removeAttribute("inert");
      // Back to where focus was; if that element is gone (a confirm button)
      // or was the page itself, to the topmost modal still open (e.g. the
      // Export dialog under the export overlay).
      if (previous && previous.isConnected && previous !== document.body && !container.contains(previous)) {
        previous.focus();
      }
      if (document.activeElement === document.body || !document.activeElement) {
        const open = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
        ).filter((modal) => modal !== container && !container.contains(modal) && !modal.closest("[inert]"));
        open[open.length - 1]?.focus();
      }
    };
    // Runs when the modal opens or closes; the refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
