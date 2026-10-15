import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Content width of an element, kept up to date with ResizeObserver. Returns
 * `fallback` until measured (and in environments without layout, e.g. jsdom),
 * so horizontal time axes always have a usable px-per-hour.
 */
export function useElementWidth(ref: RefObject<HTMLElement>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
