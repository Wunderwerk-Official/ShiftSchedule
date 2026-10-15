import { useEffect, useRef, useState } from "react";

/** Eases a displayed integer toward its target so stat changes count up or
 * down instead of jumping. Respects prefers-reduced-motion (snaps then). */
export function useAnimatedNumber(target: number, durationMs = 500): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  // Last value shown; a new target mid-animation continues from here.
  const displayRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === fromRef.current) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      fromRef.current = target;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const value = Math.round(from + (target - from) * eased);
      displayRef.current = value;
      setDisplay(value);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      fromRef.current = displayRef.current;
    };
  }, [target, durationMs]);

  return display;
}
