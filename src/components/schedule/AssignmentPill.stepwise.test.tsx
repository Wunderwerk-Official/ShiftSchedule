import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import AssignmentPill from "./AssignmentPill";
import { buildPersonPillStyles } from "./teamColors";

// Color by: Person without canvas text metrics (jsdom's own user agent, no
// canvas mock): the pill falls back to the stepwise check, one level per
// frame. Kept apart from AssignmentPill.test.tsx because the pill caches its
// canvas context per module. Layout is faked: 6 px per character, a 20 px
// initials circle and a name row of `rowWidth` px.
let rowWidth = 66;
const restore: Array<() => void> = [];

function fakeWidth(prop: "clientWidth" | "offsetWidth" | "scrollWidth") {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("w-5")) return 20; // initials circle
      if (this.classList.contains("justify-start")) return rowWidth; // name row
      if (this.classList.contains("truncate")) return (this.textContent ?? "").length * 6; // name
      return 0;
    },
  });
  restore.push(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
    else Reflect.deleteProperty(HTMLElement.prototype, prop);
  });
}

beforeAll(() => {
  fakeWidth("clientWidth");
  fakeWidth("offsetWidth");
  fakeWidth("scrollWidth");
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

// A few more frames, so a level change that should not happen would show.
const nextFrames = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("AssignmentPill in Color by: Person without canvas metrics", () => {
  it("stops at \"First L.\" with an ellipsis while at least 30 px are left", async () => {
    // 66 - 24 = 42 px: "Sarah Neumann" (78 px) and "Sarah N." (48 px) overflow.
    const name = renderPerson("Sarah Neumann", 66);
    await waitFor(() => expect(name.textContent).toBe("Sarah N."));
    await nextFrames();
    expect(name.textContent).toBe("Sarah N.");
    expect(name.className).toContain("truncate");
    expect(name.className).not.toContain("sr-only");
  });

  it("falls back to the initials circle when less room is left", async () => {
    // 50 - 24 = 26 px, below the minimum.
    const name = renderPerson("Sarah Neumann", 50);
    await waitFor(() => expect(name.className).toContain("sr-only"));
    expect(name.textContent).toBe("Sarah Neumann");
  });
});
