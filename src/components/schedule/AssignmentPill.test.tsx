import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import AssignmentPill from "./AssignmentPill";
import { buildPersonPillStyles } from "./teamColors";

// Color by: Person picks the name's abbreviation from canvas text widths.
// jsdom has no layout or canvas metrics, so both are faked here: 6 px per
// character, a 20 px initials circle and a name row of `rowWidth` px.
let rowWidth = 66;
const restore: Array<() => void> = [];

function fakeWidth(prop: "clientWidth" | "offsetWidth") {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("w-5")) return 20; // initials circle
      if (this.classList.contains("justify-start")) return rowWidth; // name row
      return 0;
    },
  });
  // jsdom defines clientWidth on Element.prototype: without an own original,
  // removing the override lets the inherited getter show through again.
  restore.push(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
    else Reflect.deleteProperty(HTMLElement.prototype, prop);
  });
}

beforeAll(() => {
  fakeWidth("clientWidth");
  fakeWidth("offsetWidth");
  const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 test");
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(
      () =>
        ({
          font: "",
          measureText: (text: string) => ({ width: text.length * 6 }),
        }) as unknown as CanvasRenderingContext2D,
    );
  restore.push(() => userAgent.mockRestore(), () => getContext.mockRestore());
});

afterAll(() => restore.forEach((undo) => undo()));

const personStyle = buildPersonPillStyles([
  { id: "c1", name: "Sarah Neumann", qualifiedClassIds: [], preferredClassIds: [], vacations: [] },
]).get("c1");

const renderPerson = (name: string, width: number) => {
  rowWidth = width;
  render(<AssignmentPill name={name} personStyle={personStyle} isManual />);
  return screen.getByText(/./, { selector: "span.min-w-0" });
};

describe("AssignmentPill in Color by: Person", () => {
  it("shows the full name when it fits next to the circle", () => {
    // 66 - 20 (circle) - 4 (gap) = 42 px; "Tim Lang" = 48 px, "Mia Fox" = 42 px.
    const name = renderPerson("Mia Fox", 66);
    expect(name.textContent).toBe("Mia Fox");
    expect(name.className).not.toContain("sr-only");
  });

  it("cuts \"First L.\" with an ellipsis instead of leaving the circle alone", () => {
    // "Sarah N." = 48 px misses the 42 px by a few pixels.
    const name = renderPerson("Sarah Neumann", 66);
    expect(name.textContent).toBe("Sarah N.");
    expect(name.className).toContain("truncate");
    expect(name.className).not.toContain("sr-only");
    // On the pill: its content ignores the pointer, so a title there never shows.
    expect(name.closest('[data-assignment-pill="true"]')?.getAttribute("title")).toBe("Sarah Neumann");
  });

  it("keeps only the initials circle when there is no room for a few letters", () => {
    // 50 - 24 = 26 px, below the minimum: the name is only read out.
    const name = renderPerson("Sarah Neumann", 50);
    expect(name.textContent).toBe("Sarah Neumann");
    expect(name.className).toContain("sr-only");
  });
});
