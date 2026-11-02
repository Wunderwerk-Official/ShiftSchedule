import { describe, expect, it } from "vitest";
import { printPagePx, printPageStyle, readPrintLayout } from "./printPage";

describe("printPage", () => {
  it("reads portrait only from layout=portrait", () => {
    expect(readPrintLayout("?start=2026-01-05&layout=portrait")).toBe("portrait");
    expect(readPrintLayout("?start=2026-01-05")).toBe("landscape");
    expect(readPrintLayout("?layout=sideways")).toBe("landscape");
  });

  it("swaps the A4 sides for portrait and subtracts the margins", () => {
    const landscape = printPagePx("landscape", 8);
    const portrait = printPagePx("portrait", 8);
    expect(Math.round(landscape.page.width)).toBe(1123);
    expect(Math.round(landscape.page.height)).toBe(794);
    expect(portrait.page).toEqual({ width: landscape.page.height, height: landscape.page.width });
    expect(Math.round(portrait.area.width)).toBe(733);
    expect(Math.round(portrait.margin)).toBe(30);
  });

  it("makes every printed page one monolithic sheet that never reaches the next one", () => {
    for (const layout of ["landscape", "portrait"] as const) {
      const { page } = printPagePx(layout, 8);
      const style = printPageStyle(layout, 8, false);
      expect(Number(style.height)).toBeLessThanOrEqual(page.height);
      expect(Number(style.height)).toBeGreaterThan(page.height - 1);
      expect(Number(style.width)).toBeLessThanOrEqual(page.width);
      // Size containment: Chromium can neither push nor split the content
      // (a transform-scaled week) at a page boundary.
      expect(style.contain).toBe("strict");
      expect(style.overflow).toBe("hidden");
      expect(style.breakAfter).toBe("page");
    }
    expect(printPageStyle("landscape", 8, true).breakAfter).toBe("auto");
  });
});
