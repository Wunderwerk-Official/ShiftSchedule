import type { PdfLayout } from "../api/client";

// Page geometry of the PDF print routes (/print/week, /print/weeks). The
// backend renders them on A4 in the orientation of `?layout=` and passes the
// same orientation to Chromium's PDF writer (backend/pdf.py).

const PRINT_DPI = 96;
const MM_TO_PX = PRINT_DPI / 25.4;
const A4_LONG_MM = 297;
const A4_SHORT_MM = 210;

/**
 * Page rule for portrait prints. index.css declares `@page { size: A4
 * landscape }` for every print, and Chromium's PDF writer follows a CSS page
 * size over its own landscape flag, so a portrait print route must restate it
 * (a later @page rule wins).
 */
export const PORTRAIT_PAGE_CSS = "@media print { @page { size: A4 portrait; margin: 0; } }";

/** "portrait" = the compact week ("Times: Stacked") on A4 portrait. */
export function readPrintLayout(search: string): PdfLayout {
  return new URLSearchParams(search).get("layout") === "portrait" ? "portrait" : "landscape";
}

/**
 * Width the compact (portrait) week is laid out at: the printable width
 * before the page's safety scale-down, so after scaling it fills the width.
 * A fixed width makes long names abbreviate instead of the week shrinking.
 */
export const portraitContentWidth = (areaWidth: number, safetyScale: number) =>
  areaWidth / safetyScale;

/** Page and printable area (page minus margins) in CSS pixels. */
export function printPagePx(layout: PdfLayout, marginMm: number) {
  const widthMm = layout === "portrait" ? A4_SHORT_MM : A4_LONG_MM;
  const heightMm = layout === "portrait" ? A4_LONG_MM : A4_SHORT_MM;
  return {
    page: { width: widthMm * MM_TO_PX, height: heightMm * MM_TO_PX },
    area: {
      width: (widthMm - marginMm * 2) * MM_TO_PX,
      height: (heightMm - marginMm * 2) * MM_TO_PX,
    },
    margin: marginMm * MM_TO_PX,
  };
}
