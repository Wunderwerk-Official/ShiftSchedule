import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import AssignmentPill from "./AssignmentPill";
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

const renderPerson = (name: string, width: number) => {
  rowWidth = width;
  render(<AssignmentPill name={name} personStyle={personStyle} isLocked onToggleLock={() => {}} />);
  return screen.getByText(/./, { selector: "span.min-w-0" });
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
});

describe("AssignmentPill find swap", () => {
  const pillOf = (button: HTMLElement) => button.closest('[data-assignment-pill="true"]') as HTMLElement;
  const findSwapButton = () => screen.getByRole("button", { name: "Find swap for Dr. Alice" });

  it("shows no swap button without onFindSwap", () => {
    render(<AssignmentPill name="Dr. Alice" onToggleLock={() => {}} />);
    expect(screen.queryByRole("button", { name: /Find swap/ })).toBeNull();
  });

  it("finds a swap from its button without clicking the pill", () => {
    const onFindSwap = vi.fn();
    const onClick = vi.fn();
    render(<AssignmentPill name="Dr. Alice" onToggleLock={() => {}} onFindSwap={onFindSwap} onClick={onClick} />);
    expect(findSwapButton()).toHaveAttribute("title", "Find swap (S)");
    fireEvent.click(findSwapButton());
    expect(onFindSwap).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("finds a swap with S while the lock has focus, without toggling the lock", () => {
    const onFindSwap = vi.fn();
    const onToggleLock = vi.fn();
    render(<AssignmentPill name="Dr. Alice" onToggleLock={onToggleLock} onFindSwap={onFindSwap} />);
    const lock = screen.getByRole("button", { name: "Lock assignment for Dr. Alice" });
    lock.focus();
    fireEvent.keyDown(lock, { key: "s" });
    expect(onFindSwap).toHaveBeenCalledOnce();
    fireEvent.keyDown(lock, { key: "s", ctrlKey: true });
    fireEvent.keyDown(lock, { key: "S", repeat: true });
    expect(onFindSwap).toHaveBeenCalledOnce();
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it("shows the button when a rerender adds onFindSwap", () => {
    const { rerender } = render(<AssignmentPill name="Dr. Alice" onToggleLock={() => {}} />);
    expect(screen.queryByRole("button", { name: /Find swap/ })).toBeNull();
    rerender(<AssignmentPill name="Dr. Alice" onToggleLock={() => {}} onFindSwap={() => {}} />);
    expect(findSwapButton()).toBeInTheDocument();
  });

  it("locked pill: the button sits left of the in-row lock, touch room comes from a row margin", () => {
    render(<AssignmentPill name="Dr. Alice" isLocked onToggleLock={() => {}} onFindSwap={() => {}} />);
    const swap = findSwapButton();
    const pill = pillOf(swap);
    const lock = within(pill).getByRole("button", { name: "Lock assignment for Dr. Alice" });
    expect(lock.compareDocumentPosition(swap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(swap.className).toContain("right-[21px]");
    expect(swap.className).toContain("pill-swap-reveal");
    const row = pill.firstElementChild as HTMLElement;
    expect(row.className).toContain("pill-swap-fade-inrow");
    expect(row.className).toContain("[@media(hover:none)]:mr-5");
    expect(row.className).not.toContain("pill-lock-fade");
    expect(pill.classList).toContain("pr-px");
    expect(pill.className).not.toContain("[@media(hover:none)]:pr-");
  });

  it("unlocked pill: the button sits left of the hover lock, with touch room for both", () => {
    render(<AssignmentPill name="Dr. Alice" onToggleLock={() => {}} onFindSwap={() => {}} />);
    const pill = pillOf(findSwapButton());
    expect(findSwapButton().className).toContain("right-[21px]");
    expect(pill.classList).toContain("[@media(hover:none)]:pr-[42px]");
    expect(pill.classList).not.toContain("[@media(hover:none)]:pr-[22px]");
    const row = pill.firstElementChild as HTMLElement;
    expect(row.classList).toContain("pill-swap-fade");
    expect(row.classList).not.toContain("pill-swap-fade-inrow");
    expect(row.classList).not.toContain("pill-lock-fade");
    expect(row.className).not.toContain("mr-5");
  });

  it("person colors: the button follows a hover lock to 22 px; next to an in-row lock it stays at 21 px", () => {
    const { unmount } = render(
      <AssignmentPill name="Dr. Alice" personStyle={personStyle} onToggleLock={() => {}} onFindSwap={() => {}} />,
    );
    expect(findSwapButton().className).toContain("right-[22px]");
    unmount();
    // The in-row lock takes 1–19 px in both looks; the touch row margin ends at 39 px.
    render(<AssignmentPill name="Dr. Alice" personStyle={personStyle} isLocked onToggleLock={() => {}} onFindSwap={() => {}} />);
    expect(findSwapButton().className).toContain("right-[21px]");
  });

  it("without a lock the button takes the lock's place", () => {
    render(<AssignmentPill name="Dr. Alice" onFindSwap={() => {}} />);
    const pill = pillOf(findSwapButton());
    expect(findSwapButton().className).toContain("right-0.5");
    expect(pill.classList).toContain("[@media(hover:none)]:pr-[22px]");
  });
});
