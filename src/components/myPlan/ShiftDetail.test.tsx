import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Location } from "../../api/client";
import { buildPersonPlan } from "../../lib/myPlan";
import { LOCATIONS, makeSource } from "../../lib/myPlan/testFixtures";
import ShiftDetail, { placePopover, resolveAnchor } from "./ShiftDetail";
import { sectionLine } from "./ShiftDetailContent";

const source = makeSource();
const locationsById = new Map<string, Location>(LOCATIONS.map((location) => [location.id, location]));
const plan = buildPersonPlan({
  ...source,
  clinicianId: "lh",
  fromISO: "2026-10-12",
  toISO: "2026-10-18",
  todayISO: "2026-10-14",
});
const night = plan.shifts.get(plan.days[2].segments[0].shiftId)!;

function renderDetail(overrides: Partial<Parameters<typeof ShiftDetail>[0]> = {}) {
  const anchor = document.createElement("button");
  anchor.setAttribute("data-shift-id", night.id);
  document.body.appendChild(anchor);
  anchor.focus();
  const onClose = vi.fn();
  const onShowInTeam = vi.fn();
  const utils = render(
    <ShiftDetail
      shift={night}
      plan={plan}
      source={source}
      isMe
      anchorEl={anchor}
      isMobile={false}
      isDark={false}
      locationsById={locationsById}
      onClose={onClose}
      onShowInTeam={onShowInTeam}
      {...overrides}
    />,
  );
  return { ...utils, anchor, onClose, onShowInTeam };
}

describe("ShiftDetail", () => {
  it("shows when, location, coworkers, rest before, next and status", () => {
    const { anchor } = renderDetail();
    const dialog = screen.getByRole("dialog", { name: "Nachtdienst" });
    expect(dialog).toHaveTextContent("Wed 14 Oct, 17:00 → Thu 15 Oct, 08:00 · 15.0 h");
    expect(dialog).toHaveTextContent("Klinikum Mitte");
    expect(dialog).toHaveTextContent("Same duty (1)");
    expect(dialog).toHaveTextContent("Jonas Weber");
    expect(dialog).toHaveTextContent("Rest before: 24.5 h (Tue 16:30 → Wed 17:00)");
    expect(dialog).toHaveTextContent("Next: Thu 15 Oct · ND-Frei from 08:00");
    expect(dialog).toHaveTextContent("Published");
    expect(document.activeElement).toBe(dialog);
    anchor.remove();
  });

  it("moves focus in only once the popover is positioned (visible)", () => {
    const calls: Array<{ role: string | null; visibility: string }> = [];
    const original = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      calls.push({ role: this.getAttribute("role"), visibility: this.style.visibility });
      original.call(this, options);
    });
    const { anchor } = renderDetail();
    const dialogFocus = calls.filter((call) => call.role === "dialog");
    expect(dialogFocus.length).toBeGreaterThan(0);
    expect(dialogFocus.every((call) => call.visibility !== "hidden")).toBe(true);
    spy.mockRestore();
    anchor.remove();
  });

  it("collapses long coworker groups behind '+N more'", () => {
    const { anchor } = renderDetail();
    // Same time at location: Nina Werner, Sophie Klein, Felix Wagner, Max Braun → 3 rows + "+1 more".
    const group = screen.getByText("Same time at location (4)").parentElement!;
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(group).getByRole("button", { name: "+1 more" }));
    expect(within(group).getAllByRole("listitem")).toHaveLength(4);
    expect(within(group).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    anchor.remove();
  });

  it("closes on Escape and on outside clicks, but not on the shift's own block", () => {
    const { anchor, onClose } = renderDetail();
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    anchor.remove();
  });

  it("returns focus to the anchor when it unmounts", () => {
    const { anchor, unmount } = renderDetail();
    expect(document.activeElement).not.toBe(anchor);
    unmount();
    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  });

  it("runs the actions", () => {
    const { anchor, onClose, onShowInTeam } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Show in team plan" }));
    expect(onShowInTeam).toHaveBeenCalledWith(expect.objectContaining({ dateISO: "2026-10-14", clinicianId: "lh" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    anchor.remove();
  });

  it("closes when Tab leaves the desktop popover", () => {
    const { anchor, onClose } = renderDetail();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
    // Tab between the controls inside does not close it.
    const team = screen.getByRole("button", { name: "Show in team plan" });
    fireEvent.keyDown(team, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(2);
    anchor.remove();
  });

  it("mobile sheet: closes from its backdrop's click only (no tap-through), locks page scroll", () => {
    const { anchor, onClose, unmount, baseElement } = renderDetail({ isMobile: true });
    expect(document.body.style.overflow).toBe("hidden");
    const backdrop = baseElement.querySelector<HTMLElement>(".fixed.inset-0 > [aria-hidden='true']")!;
    fireEvent.touchStart(backdrop);
    fireEvent.mouseDown(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.body.style.overflow).toBe("");
    anchor.remove();
  });

  it("renders a modal bottom sheet on mobile and a static card inline", () => {
    const { anchor, unmount } = renderDetail({ isMobile: true });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    unmount();
    anchor.remove();
    render(
      <ShiftDetail
        variant="inline"
        shift={night}
        plan={plan}
        source={source}
        isMe={false}
        anchorEl={null}
        isMobile={false}
        isDark={false}
        locationsById={locationsById}
        onClose={vi.fn()}
        onShowInTeam={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Nachtdienst" })).not.toHaveTextContent("Rest before");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("marks draft shifts", () => {
    const { anchor } = renderDetail({ shift: { ...night, published: false } });
    expect(screen.getByText("Draft – not published")).toBeInTheDocument();
    anchor.remove();
  });
});

describe("resolveAnchor", () => {
  it("finds the shift's block again when the original anchor is gone", () => {
    const stale = document.createElement("button");
    const hidden = document.createElement("button");
    hidden.setAttribute("data-shift-id", "s1");
    hidden.tabIndex = -1;
    const block = document.createElement("button");
    block.setAttribute("data-shift-id", "s1");
    document.body.append(hidden, block);
    expect(resolveAnchor(stale, "s1")).toBe(block);
    expect(resolveAnchor(hidden, "s1")).toBe(hidden);
    expect(resolveAnchor(null, "missing")).toBeNull();
    hidden.remove();
    block.remove();
  });
});

describe("placePopover", () => {
  const size = { width: 360, height: 500 };
  const viewport = { width: 1440, height: 900 };

  it("prefers the right side, then the left side of the anchor", () => {
    expect(placePopover({ top: 300, left: 200, right: 360, bottom: 500 }, size, viewport)).toEqual({ left: 368, top: 276 });
    expect(placePopover({ top: 300, left: 1100, right: 1260, bottom: 500 }, size, viewport)).toEqual({ left: 732, top: 276 });
  });

  it("clamps into the viewport and falls back below a wide anchor", () => {
    expect(placePopover({ top: 800, left: 200, right: 360, bottom: 850 }, size, viewport).top).toBe(392);
    expect(placePopover({ top: 100, left: 20, right: 380, bottom: 160 }, size, { width: 390, height: 844 })).toEqual({ left: 20, top: 168 });
  });

  it("stays inside the plan grid when it fits (never over the footer)", () => {
    const evening = { top: 700, left: 200, right: 360, bottom: 860 };
    // Grid 200–860 of a 1000 px viewport: top ≤ 860 − 500 − 8 = 352.
    expect(placePopover(evening, size, { width: 1440, height: 1000 }, { top: 200, bottom: 860 }).top).toBe(352);
    // A grid shorter than the popover falls back to the viewport.
    expect(placePopover(evening, size, { width: 1440, height: 1000 }, { top: 600, bottom: 900 }).top).toBe(492);
  });
});

describe("sectionLine", () => {
  it("names location and section once each; nothing beyond the location chip → no line", () => {
    expect(sectionLine({ title: "Nachtdienst", locationName: "Klinikum Mitte" })).toBe("Klinikum Mitte · Nachtdienst");
    expect(sectionLine({ title: "MRT", role: "Oberärzte", locationName: "MRT" })).toBe("MRT · Oberärzte");
    // Clinic sheet: a section named like its location ("MRT" at "MRT") read "MRT · MRT".
    expect(sectionLine({ title: "MRT", locationName: "MRT" })).toBeNull();
    expect(sectionLine({ title: "CT", slotLabel: "CT", locationName: "Nord" })).toBe("Nord · CT");
    expect(sectionLine({ title: "CT" })).toBe("Section: CT");
  });
});
