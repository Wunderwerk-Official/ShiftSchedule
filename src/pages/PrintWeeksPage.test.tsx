import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import defaultState from "../../backend/default_state.json";
import PrintWeeksPage from "./PrintWeeksPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getState: vi.fn(async () => structuredClone(defaultState)),
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
    Number(/repeat\((\d+),/.exec(grid.style.gridTemplateColumns)?.[1]),
  );

describe("PrintWeeksPage layout", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  it("prints every week as the compact week on A4 portrait for layout=portrait", async () => {
    const { container } = await renderAt("?start=2026-01-05&weeks=2&layout=portrait");
    expect(container.querySelector("style")?.textContent).toContain("size: A4 portrait");
    expect(columnCounts()).toEqual([7, 7]);
    const pages = container.querySelectorAll<HTMLElement>(".print-page");
    expect(pages).toHaveLength(2);
    // Every page keeps a left and top margin.
    for (const page of pages) expect(parseFloat(page.style.paddingLeft)).toBeGreaterThan(20);
  });

  it("keeps landscape pages with the side-by-side columns by default", async () => {
    const { container } = await renderAt("?start=2026-01-05&weeks=2");
    expect(container.querySelector("style")).toBeNull();
    expect(columnCounts().every((count) => count > 7)).toBe(true);
  });
});
