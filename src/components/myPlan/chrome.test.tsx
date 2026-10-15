import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Location } from "../../api/client";
import { DUTY_COLORS, buildPersonPlan, contrastRatio } from "../../lib/myPlan";
import { LOCATIONS, makeSource } from "../../lib/myPlan/testFixtures";
import PlanLegend from "./PlanLegend";
import Toast from "./Toast";
import { buildLegend } from "./legend";
import { DUTY_COLORS_DARK, LocationChips, blockColorsOf, restAfterCaption, showsFree } from "./viewParts";

// Shared chrome: theme-aware colors, location chips, legend swatches, toast.

const source = makeSource();
const locationsById = new Map<string, Location>(LOCATIONS.map((location) => [location.id, location]));
const week42 = buildPersonPlan({ ...source, clinicianId: "lh", fromISO: "2026-10-12", toISO: "2026-10-18", todayISO: "2026-10-14" });
const night = week42.shifts.get(week42.days[2].segments[0].shiftId)!;
const mrt = week42.shifts.get(week42.days[0].segments[1].shiftId)!;

describe("theme helpers", () => {
  it("switches only duties to the light indigo palette in dark mode", () => {
    expect(blockColorsOf(night, false)).toBe(DUTY_COLORS);
    expect(blockColorsOf(night, true)).toBe(DUTY_COLORS_DARK);
    // Dark mode: a deep fill of the section hue instead of the raw pastel.
    const darkMrt = blockColorsOf(mrt, true);
    expect(darkMrt).not.toBe(mrt.colors);
    expect(contrastRatio(darkMrt.text, darkMrt.fill)).toBeGreaterThanOrEqual(7);
  });

  it("names the shift a rest band follows and shows 'free' only in published weeks", () => {
    expect(restAfterCaption(week42, week42.days[3])).toBe("after Nachtdienst");
    expect(restAfterCaption(week42, week42.days[0])).toBeUndefined();
    const saturday = week42.days[5];
    expect(showsFree(saturday)).toBe(true);
    expect(showsFree({ ...saturday, published: false })).toBe(false);
  });
});

describe("LocationChips", () => {
  it("shows the first chips and '+N' with every name in the tooltip", () => {
    render(<LocationChips ids={["mitte", "nord"]} locationsById={locationsById} size="sm" short />);
    expect(screen.getByText("Mitte")).toBeInTheDocument();
    expect(screen.queryByText("Nord")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toHaveAttribute("title", "Klinikum Mitte, MVZ Nord");
  });

  it("shows two short chips where they fit (SPEC R9), else the colored one before '+1'", () => {
    const withGroup = new Map<string, Location>([
      ...locationsById,
      ["konf", { id: "konf", name: "Konferenzen" }],
      ["amb", { id: "amb", name: "Ambulanz/Station" }],
    ]);
    const { unmount } = render(
      <LocationChips ids={["konf", "mitte"]} locationsById={withGroup} size="sm" short max={2} maxChars={11} />,
    );
    // Start order when both fit.
    expect(screen.getByText("Konf.").compareDocumentPosition(screen.getByText("Mitte"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    unmount();
    // "Ambulanz" + "Mitte" exceed the budget: the colored (tinting) location stays visible.
    render(<LocationChips ids={["amb", "mitte"]} locationsById={withGroup} size="sm" short max={2} maxChars={11} />);
    expect(screen.getByText("Mitte")).toBeInTheDocument();
    expect(screen.queryByText("Ambulanz")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toHaveAttribute("title", "Ambulanz/Station, Klinikum Mitte");
  });
});

describe("PlanLegend", () => {
  it("uses dark-mode duty colors and the dark location chip (SPEC B7) for dark swatches", () => {
    const { items } = buildLegend({ days: week42.days, plans: [week42], locationsById });
    const { rerender } = render(<PlanLegend items={items} isDark={false} />);
    const swatchOf = (label: string) =>
      screen.getByText(label).closest("[role='listitem']")!.querySelector<HTMLElement>("[aria-hidden='true']")!;
    expect(swatchOf("Nachtdienst").style.backgroundColor).toBe("rgb(49, 46, 129)"); // #312E81
    rerender(<PlanLegend items={items} isDark />);
    expect(swatchOf("Nachtdienst").style.backgroundColor).toBe("rgb(165, 180, 252)"); // #A5B4FC
    expect(swatchOf("Klinikum Mitte").style.backgroundColor).toBe("rgb(43, 59, 85)"); // dark chip #2B3B55
  });
});

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits longer with an action and pauses while hovered or focused", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toast = { id: 1, message: "Saved", actionLabel: "Undo", onAction: vi.fn() };
    render(<Toast toast={toast} onDismiss={onDismiss} isMobile={false} />);
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(onDismiss).not.toHaveBeenCalled(); // 10 s with an action
    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.mouseEnter(undo.parentElement!);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(undo.parentElement!);
    fireEvent.focus(undo);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(undo);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
