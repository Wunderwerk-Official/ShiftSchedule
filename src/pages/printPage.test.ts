import { describe, expect, it } from "vitest";
import { printPagePx, readPrintLayout } from "./printPage";

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
});
