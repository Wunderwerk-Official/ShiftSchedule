import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getState } from "../api/client";
import { printTestState } from "./printPage.fixture";
import PrintWeekPage from "./PrintWeekPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getState: vi.fn(async () => printTestState()),
}));

const renderAt = async (search: string) => {
  window.history.pushState({}, "", `/print/week${search}`);
  const view = render(<PrintWeekPage theme="light" />);
  await waitFor(() => expect(document.querySelector('[data-schedule-grid="true"]')).not.toBeNull());
  return view;
};

const columnCount = () => {
  const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
  // Day columns (the compact week repeats three label columns first).
  return Number(/repeat\((\d+), minmax/.exec(grid.style.gridTemplateColumns)?.[1]);
};

describe("PrintWeekPage layout", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  it("prints the compact week on an A4 portrait page for layout=portrait", async () => {
    const { container } = await renderAt("?start=2026-01-05&layout=portrait");
    // index.css says A4 landscape for every print: portrait must restate it.
    expect(container.querySelector("style")?.textContent).toContain("size: A4 portrait");
    expect(columnCount()).toBe(7);
    const page = container.querySelector(".print-page") as HTMLElement;
    expect(parseFloat(page.style.height)).toBeGreaterThan(parseFloat(page.style.width));
  });

  it("keeps the landscape page and the side-by-side columns by default", async () => {
    const { container } = await renderAt("?start=2026-01-05");
    expect(container.querySelector("style")).toBeNull();
    expect(columnCount()).toBeGreaterThan(7);
    const page = container.querySelector(".print-page") as HTMLElement;
    expect(parseFloat(page.style.width)).toBeGreaterThan(parseFloat(page.style.height));
    // Print: side-by-side columns sized by their widest word (ScheduleGrid print).
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("minmax(min-content, 1fr)");
    expect(page.style.contain).toBe("strict");
  });

  it("marks an unpublished week as a draft, also a week started mid-week", async () => {
    await renderAt("?start=2026-01-07");
    expect(screen.getByText("05.01.2026 – 11.01.2026")).toBeTruthy();
    expect(screen.getByText("Draft – not published")).toBeTruthy();
  });

  it("prints a published week without the draft marker", async () => {
    vi.mocked(getState).mockResolvedValueOnce({
      ...printTestState(),
      publishedWeekStartISOs: ["2026-01-05"],
    });
    await renderAt("?start=2026-01-07");
    expect(screen.queryByText("Draft – not published")).toBeNull();
  });
});
