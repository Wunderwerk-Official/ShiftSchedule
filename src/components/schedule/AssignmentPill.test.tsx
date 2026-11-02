import { cleanup, render, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import AssignmentPill from "./AssignmentPill";
import { buildNameLabels, type PersonNameLabels } from "../../lib/personName";
import { buildPersonPillStyles } from "./teamColors";

// Person colors pick the name's abbreviation from canvas text widths.
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

const renderPerson = (name: string, width: number, labels?: PersonNameLabels) => {
  rowWidth = width;
  const { container } = render(
    <AssignmentPill name={name} labels={labels} personStyle={personStyle} isLocked onToggleLock={() => {}} />,
  );
  return within(container).getByText(/./, { selector: "span.min-w-0" });
};

describe("AssignmentPill with person colors", () => {
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

  it("shows the team-wide label of its level", () => {
    // 96 - 24 = 72 px: "Mehmet Yildirim" (90 px) misses, "Mehmet Yild." (72 px) fits.
    const labels = buildNameLabels([
      { id: "a", name: "Mehmet Yildirim" },
      { id: "b", name: "Mehmet Yılmaz" },
    ]).get("a");
    const name = renderPerson("Mehmet Yildirim", 96, labels);
    expect(name.textContent).toBe("Mehmet Yild.");
  });

  describe("two people whose cut names would read the same", () => {
    const team = buildNameLabels([
      { id: "wagner", name: "Sophie Wagner" },
      { id: "weber", name: "Sophie Weber" },
      { id: "neumann", name: "Sarah Neumann" },
    ]);

    it("show their team-unique \"F. L.\" instead of \"Sophie…\" (review: 'SW Sophie …' twice)", () => {
      // 66 - 24 = 42 px: "Sophie Wa." (60 px) misses, and the ellipsis would
      // leave "Sophie…" for both; "S. Wa." / "S. We." (36 px) fit.
      const wagner = renderPerson("Sophie Wagner", 66, team.get("wagner"));
      expect(wagner.textContent).toBe("S. Wa.");
      const weber = renderPerson("Sophie Weber", 66, team.get("weber"));
      expect(weber.textContent).toBe("S. We.");
    });

    it("leave other people's cut \"First L.\" alone", () => {
      // "Sa…" already tells Sarah Neumann apart from both Sophies.
      expect(renderPerson("Sarah Neumann", 66, team.get("neumann")).textContent).toBe("Sarah N.");
    });

    it("keep the cut \"First L.\" when not even \"F. L.\" fits", () => {
      // 58 - 24 = 34 px: "S. Wa." (36 px) misses too; the full name stays on hover.
      const wagner = renderPerson("Sophie Wagner", 58, team.get("wagner"));
      expect(wagner.textContent).toBe("Sophie Wa.");
      expect(wagner.className).toContain("truncate");
      expect(wagner.className).not.toContain("sr-only");
    });
  });

  it("keeps the distinguishing end when two names differ only by a degree or a note (final check)", () => {
    const team = buildNameLabels([
      { id: "a", name: "Anna Schmidt, MPH" },
      { id: "b", name: "Anna Schmidt (OA)" },
    ]);
    // 84 - 24 = 60 px = 10 characters: the end cut would read "Anna Schm…" for both.
    const mph = renderPerson("Anna Schmidt, MPH", 84, team.get("a"));
    expect(mph.textContent).toBe("Anna S…MPH");
    cleanup();
    const oa = renderPerson("Anna Schmidt (OA)", 84, team.get("b"));
    expect(oa.textContent).toBe("Anna…(OA)");
  });

  it("shortens 'Last, First' names with titles to the given name and the family initial", () => {
    // 66 - 24 = 42 px: "Jörg M." (42 px) fits; once "Müller, D." (QA).
    const name = renderPerson("Müller, Jörg; Dr.", 66);
    expect(name.textContent).toBe("Jörg M.");
  });
});

describe("AssignmentPill in the section look (print, public page)", () => {
  // The section look steps one level per frame while the name overflows its
  // row: faked here as 6 px per character in a 38 px row (portrait print).
  const undo: Array<() => void> = [];
  beforeAll(() => {
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains("[justify-content:safe_center]")) return 38;
        return client.get!.call(this);
      },
    });
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.tagName === "SPAN") return Array.from(this.textContent ?? "").length * 6;
        return 0;
      },
    });
    undo.push(() => {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    });
  });
  afterAll(() => undo.forEach((step) => step()));

  it("wraps a last-level label that still does not fit instead of cutting it on both sides (re-QA)", async () => {
    const labels = buildNameLabels([
      { id: "a", name: "Andreas Schulz" },
      { id: "b", name: "Schulz, Andrea" },
    ]).get("a")!;
    const { container } = render(<AssignmentPill name="Andreas Schulz" labels={labels} />);
    const name = () => container.querySelector("span.text-center") as HTMLElement;
    await waitFor(() => expect(name().className).toContain("whitespace-normal"));
    expect(name().textContent).toBe(labels.levels[4]);
    expect(name().className).not.toContain("whitespace-nowrap");
    // "Andreas" (42 px at 6 px per character) is wider than the 38 px pill:
    // the wrapped label gets a smaller font, so it wraps at the space instead
    // of splitting the word (final check).
    expect(name().style.fontSize).toBe("9.75px");
  });

  it("keeps a label that fits on one line", async () => {
    const { container } = render(<AssignmentPill name="Ida Ek" />);
    const name = container.querySelector("span.text-center") as HTMLElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(name.textContent).toBe("Ida Ek");
    expect(name.className).toContain("whitespace-nowrap");
  });
});
