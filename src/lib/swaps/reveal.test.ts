import { describe, expect, it } from "vitest";
import { nearestScrollDelta } from "./reveal";

describe("nearestScrollDelta (the CSSOM View nearest rule)", () => {
  it("does not scroll a span that lies inside the window, edges included", () => {
    expect(nearestScrollDelta(100, 200, 100, 400)).toBe(0);
    expect(nearestScrollDelta(150, 400, 100, 400)).toBe(0);
  });

  it("aligns the right edge of a span that sticks out on the right", () => {
    // A pill at 634–704 under the drawer at 900 px (drawer from 460): the target
    // window is 36–444 (8 px right of the grid, 16 px left of the drawer), so 260 forward.
    expect(nearestScrollDelta(634, 704, 36, 444)).toBe(260);
  });

  it("aligns the left edge of a span that sticks out on the left", () => {
    // A name at 48–107 under 190 px of sticky labels (free from 226) scrolls 178 back.
    expect(nearestScrollDelta(48, 107, 226, 1000)).toBe(-178);
  });

  it("scrolls a span that lies wholly outside the window to the nearer edge", () => {
    expect(nearestScrollDelta(1200, 1300, 0, 800)).toBe(500);
    expect(nearestScrollDelta(-300, -200, 0, 800)).toBe(-300);
  });

  it("does not scroll a span larger than the window that sticks out on both sides", () => {
    expect(nearestScrollDelta(-50, 900, 0, 800)).toBe(0);
  });

  it("fills the window with a span larger than it that sticks out on one side", () => {
    // Sticking out on the right: align the left edges.
    expect(nearestScrollDelta(100, 1000, 0, 800)).toBe(100);
    // Sticking out on the left: align the right edges, as the rule says.
    expect(nearestScrollDelta(-400, 700, 0, 800)).toBe(-100);
  });

  it("aligns both edges of a span exactly as wide as the window", () => {
    expect(nearestScrollDelta(50, 850, 0, 800)).toBe(50);
    expect(nearestScrollDelta(-50, 750, 0, 800)).toBe(-50);
  });

  it("treats a zero-width span like any other", () => {
    expect(nearestScrollDelta(300, 300, 0, 800)).toBe(0);
    expect(nearestScrollDelta(900, 900, 0, 800)).toBe(100);
  });

  it("handles a window with no room (min above max) as scroll margins did", () => {
    // Clinic sheet at about 660 px with the drawer open: right of the labels
    // (226) and left of the drawer (204) there is no room; the name's left
    // edge goes to 226, as scrollIntoView with the two margins put it.
    expect(nearestScrollDelta(300, 360, 226, 204)).toBe(74);
  });
});
