import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getState } from "../api/client";
import { printPagePx } from "./printPage";
import { printTestState } from "./printPage.fixture";
import PrintWeeksPage from "./PrintWeeksPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getState: vi.fn(async () => printTestState()),
}));

const renderAt = async (search: string) => {
  window.history.pushState({}, "", `/print/weeks${search}`);
  const view = render(<PrintWeeksPage theme="light" />);
  await waitFor(() =>
    expect(document.querySelectorAll('[data-schedule-grid="true"]').length).toBe(2),
  );
  return view;
};

const columnCounts = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-schedule-grid="true"]')).map((grid) =>
    // Day columns (the compact week repeats three label columns first).
    Number(/repeat\((\d+), minmax/.exec(grid.style.gridTemplateColumns)?.[1]),
  );

describe("PrintWeeksPage layout", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  it("prints every week as the compact week on A4 portrait for layout=portrait", async () => {
    const { container } = await renderAt("?start=2026-01-05&weeks=2&layout=portrait");
    expect(container.querySelector("style")?.textContent).toContain("size: A4 portrait");
    expect(columnCounts()).toEqual([7, 7]);
    const pages = container.querySelectorAll<HTMLElement>(".print-page");
    expect(pages).toHaveLength(2);
    // Every page keeps its margins.
    for (const page of pages) expect(parseFloat(page.style.padding)).toBeGreaterThan(20);
  });

  it("gives every week one whole sheet that page breaking cannot push or split", async () => {
    const { container } = await renderAt("?start=2026-01-05&weeks=2&layout=portrait");
    const sheet = printPagePx("portrait", 8).page;
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".print-page"));
    for (const page of pages) {
      expect(parseFloat(page.style.height)).toBeLessThanOrEqual(sheet.height);
      expect(parseFloat(page.style.height)).toBeGreaterThan(sheet.height - 1);
      expect(page.style.contain).toBe("strict");
      expect(page.style.overflow).toBe("hidden");
    }
    expect(pages.map((page) => page.style.breakAfter)).toEqual(["page", "auto"]);
  });

  it("marks every week that is not published as a draft", async () => {
    vi.mocked(getState).mockResolvedValueOnce({
      ...printTestState(),
      publishedWeekStartISOs: ["2026-01-12"],
    });
    const { container } = await renderAt("?start=2026-01-05&weeks=2");
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".print-page"));
    expect(pages.map((page) => page.textContent?.includes("Draft – not published"))).toEqual([
      true,
      false,
    ]);
    expect(pages[0].textContent).toContain("05.01.2026 – 11.01.2026");
  });

  it("keeps landscape pages with the side-by-side columns by default", async () => {
    const { container } = await renderAt("?start=2026-01-05&weeks=2");
    expect(container.querySelector("style")).toBeNull();
    expect(columnCounts().every((count) => count > 7)).toBe(true);
  });
});
