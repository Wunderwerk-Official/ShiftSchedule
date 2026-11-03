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

describe("PrintWeekPage colors (v1.83)", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  const withShift = () => {
    const state = printTestState();
    const slot = state.weeklyTemplate!.locations[0].slots[0];
    return {
      ...state,
      assignments: [{ id: "a1", rowId: slot.id, dateISO: "2026-01-05", clinicianId: state.clinicians[0].id }],
    };
  };

  it.each(["", "&layout=portrait"])("prints the team grid's person colors and location labels%s", async (layout) => {
    vi.mocked(getState).mockResolvedValueOnce(withShift());
    await renderAt(`?start=2026-01-05${layout}`);
    const pill = await waitFor(() => {
      const element = document.querySelector('[data-assignment-pill="true"]') as HTMLElement | null;
      expect(element).not.toBeNull();
      return element!;
    });
    // Person colors: the pill's own fill and border, as on screen.
    expect(pill.style.backgroundColor).not.toBe("");
    expect(pill.style.borderColor).not.toBe("");
    // The label column carries the location's shades.
    expect(document.querySelector("[data-label-shade]")).not.toBeNull();
  });

  it("keeps the portrait labels on one line and sizes the days for a circle beside the name", async () => {
    vi.mocked(getState).mockResolvedValueOnce(withShift());
    await renderAt("?start=2026-01-05&layout=portrait");
    const grid = document.querySelector('[data-schedule-grid="true"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(3, max-content)");
    const dayMin = Number(/repeat\(7, minmax\((\d+)px/.exec(grid.style.gridTemplateColumns)?.[1]);
    expect(dayMin).toBeGreaterThan(64);
    expect(dayMin).toBeLessThanOrEqual(140);
  });
});
