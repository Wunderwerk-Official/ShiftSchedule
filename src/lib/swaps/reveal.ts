/**
 * How far a scroll box must scroll so that the span [start, end] lies inside
 * the window [min, max] (all in the same coordinates, e.g. viewport pixels),
 * by the CSSOM View "nearest" rule that scrollIntoView({ inline: "nearest" })
 * follows: 0 when the span already lies inside, or when it is larger than the
 * window and sticks out on both sides; otherwise align the edge it sticks out
 * on, or, when it is larger than the window, the other edge. Positive means
 * scroll forward (the content moves left or up).
 *
 * Reveal on hover computes its offsets with this instead of scrollIntoView with
 * scroll margins: with "nearest", Chromium 143 (CI's browser, Playwright 1.57's
 * headless shell) does not scroll at all when the element's own box already
 * lies inside the scroll box, as a shift under the swap drawer or under the
 * clinic sheet's sticky row labels does, so the margins have no effect there
 * (Chrome 153 honours them).
 */
export function nearestScrollDelta(start: number, end: number, min: number, max: number): number {
  const before = start < min;
  const after = end > max;
  if (before === after) return 0;
  const fits = end - start <= max - min;
  if (before) return fits ? start - min : end - max;
  return fits ? end - max : start - min;
}
