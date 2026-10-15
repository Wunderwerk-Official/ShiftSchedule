import type { CSSProperties } from "react";
import { ABSENCE_COLORS } from "../../lib/myPlan";

// Inline styles of the absence kinds (plan §3.2), shared by the bands of the
// week/day views, the month chips and bars, the agenda mini timeline and the
// legend: vacation = green stripes, rest day = white with a dashed border.

/** Vacation colors for the theme ({ fill, stripes, border, text }). */
export function vacationColors(isDark: boolean) {
  return isDark ? ABSENCE_COLORS.vacation.dark : ABSENCE_COLORS.vacation;
}

/** Rest-day colors for the theme ({ fill, border, text }). */
export function restColors(isDark: boolean) {
  return isDark ? ABSENCE_COLORS.rest.dark : ABSENCE_COLORS.rest;
}

/** Striped vacation band (text color for labels drawn directly on it). */
export function vacationBandStyle(isDark: boolean): CSSProperties {
  const colors = vacationColors(isDark);
  return { background: colors.stripes, border: `1px solid ${colors.border}`, color: colors.text };
}

/** Solid label chip on top of the stripes (readable text). */
export function vacationLabelStyle(isDark: boolean): CSSProperties {
  const colors = vacationColors(isDark);
  return { backgroundColor: colors.fill, color: colors.text };
}

/** Rest-day band: card fill, dashed border (1.5 px; 1 px for tiny marks). */
export function restBandStyle(isDark: boolean, borderPx = 1.5): CSSProperties {
  const colors = restColors(isDark);
  return { backgroundColor: colors.fill, border: `${borderPx}px dashed ${colors.border}`, color: colors.text };
}
