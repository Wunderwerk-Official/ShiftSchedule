import { describe, expect, it, vi } from "vitest";
import { printPagePx, printPageStyle, readPrintLayout, whenPrintLayoutSettles } from "./printPage";

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

describe("whenPrintLayoutSettles (final check)", () => {
  it("waits until the print content keeps its size for the given frames", async () => {
    const content = document.createElement("div");
    content.setAttribute("data-print-content", "true");
    document.body.appendChild(content);
    let height = 100;
    Object.defineProperty(content, "scrollHeight", { configurable: true, get: () => height });
    let settled = false;
    const cancel = whenPrintLayoutSettles(() => {
      settled = true;
    }, 3);
    // Names wrap a few frames in: the content grows, the count starts over.
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    height = 140;
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
    cancel();
    content.remove();
  });
});
