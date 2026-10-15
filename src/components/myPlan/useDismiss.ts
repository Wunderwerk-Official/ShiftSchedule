import { useEffect, useRef } from "react";

// Escape / outside-press dismissal shared by the shift detail, the month day
// popover and the header menus. Layers stack: only the most recently opened
// one reacts to Escape (and swallows it), so closing a nested layer never
// closes the one below in the same key press.
//
// Modal layers (the phone bottom sheet) pass `outsidePress: false` and close
// from an onClick on their own backdrop instead: a document touchstart would
// unmount the backdrop before the tap's click, which would then land on (and
// activate) whatever lies underneath.

export type DismissReason = "escape" | "outside";

const openLayers: object[] = [];

export function useDismiss(
  active: boolean,
  onDismiss: (reason: DismissReason) => void,
  /** Presses on these targets are not "outside" (the panel, its toggle, …). */
  isInside: (target: Node) => boolean,
  options: { outsidePress?: boolean } = {},
): void {
  const outsidePress = options.outsidePress ?? true;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const insideRef = useRef(isInside);
  insideRef.current = isInside;

  useEffect(() => {
    if (!active) return;
    const layer = {};
    openLayers.push(layer);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openLayers[openLayers.length - 1] !== layer) return;
      event.stopPropagation();
      dismissRef.current("escape");
    };
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || insideRef.current(target)) return;
      dismissRef.current("outside");
    };
    document.addEventListener("keydown", onKey);
    if (outsidePress) {
      document.addEventListener("mousedown", onPointer);
      document.addEventListener("touchstart", onPointer);
    }
    return () => {
      openLayers.splice(openLayers.indexOf(layer), 1);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [active, outsidePress]);
}
