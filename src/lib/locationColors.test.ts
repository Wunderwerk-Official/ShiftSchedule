import { describe, expect, it } from "vitest";
import { LOCATION_COLOR_OPTIONS } from "./colorPalette";
import {
  AUTO_LOCATION_COLORS,
  autoLocationColor,
  ownLocationColor,
  resolveLocationColors,
} from "./locationColors";

const color = (id: string) => LOCATION_COLOR_OPTIONS.find((option) => option.id === id)!.color;
const BLUE = color("blue");
const GREEN = color("green");
const AMBER = color("amber");
const VIOLET = color("violet");
const SAND = color("sand");

describe("resolveLocationColors", () => {
  it("gives uncolored locations the automatic colors in location order", () => {
    const colors = resolveLocationColors([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect([...colors.entries()]).toEqual([
      ["a", BLUE],
      ["b", GREEN],
      ["c", AMBER],
    ]);
  });

  it("keeps a chosen color and does not hand it out again", () => {
    const colors = resolveLocationColors([{ id: "a" }, { id: "b", color: BLUE.toLowerCase() }, { id: "c" }]);
    // "b" chose blue: "a" and "c" take the next free automatic colors.
    expect(colors.get("a")).toBe(GREEN);
    expect(colors.get("b")).toBe(BLUE);
    expect(colors.get("c")).toBe(AMBER);
  });

  it("treats a muted or custom choice as its own color and an invalid one as none", () => {
    const colors = resolveLocationColors([
      { id: "a", color: SAND },
      { id: "b", color: "#123456" },
      { id: "c", color: "red" },
    ]);
    expect(colors.get("a")).toBe(SAND);
    expect(colors.get("b")).toBe("#123456");
    expect(colors.get("c")).toBe(BLUE);
  });

  it("repeats the automatic colors once they run out", () => {
    const locations = Array.from({ length: AUTO_LOCATION_COLORS.length + 2 }, (_, index) => ({ id: `l${index}` }));
    const colors = resolveLocationColors(locations);
    expect(colors.get(`l${AUTO_LOCATION_COLORS.length}`)).toBe(BLUE);
    expect(colors.get(`l${AUTO_LOCATION_COLORS.length + 1}`)).toBe(GREEN);
    // Every automatic color was chosen: they still repeat in order.
    const allChosen = AUTO_LOCATION_COLORS.map((auto, index) => ({ id: `c${index}`, color: auto }));
    expect(resolveLocationColors([...allChosen, { id: "x" }]).get("x")).toBe(BLUE);
  });

  it("starts with four clearly different colors", () => {
    expect(AUTO_LOCATION_COLORS.slice(0, 4)).toEqual([BLUE, GREEN, AMBER, VIOLET]);
  });
});

describe("autoLocationColor / ownLocationColor", () => {
  it("names the color a location gets on Auto, ignoring its own choice", () => {
    const locations = [{ id: "a", color: VIOLET }, { id: "b", color: BLUE }, { id: "c" }];
    // Without its violet, "a" is the first automatic location; blue is taken by "b".
    expect(autoLocationColor(locations, "a")).toBe(GREEN);
    expect(autoLocationColor(locations, "c")).toBe(GREEN);
    expect(autoLocationColor([], "missing")).toBe(BLUE);
  });

  it("normalizes only valid #RRGGBB colors", () => {
    expect(ownLocationColor({ color: "#dbeafe" })).toBe("#DBEAFE");
    expect(ownLocationColor({ color: "#DBEAF" })).toBeNull();
    expect(ownLocationColor({})).toBeNull();
  });
});
