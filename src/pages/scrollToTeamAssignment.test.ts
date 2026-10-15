import { describe, expect, it } from "vitest";
import { axisScrollDelta } from "./scrollToTeamAssignment";

// "Show in team plan" scrolls each axis only as far as needed (QA round 2:
// centring scrolled the day header and the row labels out of view).

const view = { start: 0, end: 1000 };

describe("axisScrollDelta", () => {
  it("does nothing when the target (and its context) is already visible", () => {
    expect(axisScrollDelta({ start: 400, end: 424 }, view)).toBe(0);
    expect(axisScrollDelta({ start: 400, end: 424 }, view, { context: { start: 100, end: 140 } })).toBe(0);
  });

  it("brings the day header into view together with the pill when both fit", () => {
    // Header scrolled 300 px above the window, pill at 500: header to the top margin.
    expect(axisScrollDelta({ start: 500, end: 524 }, view, { context: { start: -300, end: -260 }, fallback: "center" })).toBe(-316);
    // Pill below the window, header 200 px above it: scroll down only until the pill shows.
    expect(axisScrollDelta({ start: 1100, end: 1124 }, view, { context: { start: 200, end: 240 }, fallback: "center" })).toBe(140);
  });

  it("centres the pill when it does not fit on screen with the header", () => {
    expect(axisScrollDelta({ start: 1800, end: 1824 }, view, { context: { start: -200, end: -160 }, fallback: "center" })).toBe(1312);
  });

  it("keeps the label column clear and shows the whole day sideways when it fits", () => {
    // Visible area right of a 245 px label column; the day's columns span 1205–1445.
    const grid = { start: 245, end: 1226 };
    expect(axisScrollDelta({ start: 1331, end: 1431 }, grid, { context: { start: 1205, end: 1445 } })).toBe(235);
    // A day wider than the room: just the pill, as little as possible.
    expect(axisScrollDelta({ start: 1300, end: 1400 }, grid, { context: { start: 100, end: 1500 } })).toBe(190);
    // Left of the label column: back until the day starts right of it.
    expect(axisScrollDelta({ start: 120, end: 220 }, grid, { context: { start: 110, end: 350 } })).toBe(-151);
  });
});
