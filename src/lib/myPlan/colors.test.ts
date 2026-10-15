import { describe, expect, it } from "vitest";
import { BLOCK_COLOR_SWATCH_OPTIONS, LOCATION_COLOR_OPTIONS } from "../colorPalette";
import { getLuminance } from "../shiftRows";
import { contrastRatio, deriveBlockColors, DUTY_COLORS, locationTint, personColor } from "./colors";
import { deriveShortLabel, stripTimes } from "./shifts";

describe("deriveBlockColors", () => {
  it.each(BLOCK_COLOR_SWATCH_OPTIONS.map((option) => option.color))(
    "keeps %s as fill with a ≥3:1 border and readable text",
    (fill) => {
      const colors = deriveBlockColors(fill);
      expect(colors.fill).toBe(fill);
      expect(contrastRatio(colors.border, "#FFFFFF")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colors.text, fill)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.secondaryText, fill)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(["#3B82F6", "#808080", "#777777", "#EF4444", "#6366F1"])(
    "keeps the border of the mid-tone custom fill %s visibly darker than the fill",
    (fill) => {
      const colors = deriveBlockColors(fill);
      expect(contrastRatio(colors.border, "#FFFFFF")).toBeGreaterThanOrEqual(3);
      expect(getLuminance(colors.border)).toBeLessThan(getLuminance(fill));
      expect(contrastRatio(colors.border, fill)).toBeGreaterThanOrEqual(1.4);
      // 7:1 is out of reach for mid-tones; black text still clears 4.5:1.
      expect(contrastRatio(colors.text, fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.secondaryText, fill)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("caches by normalized fill", () => {
    expect(deriveBlockColors("#bcd2ff")).toBe(deriveBlockColors("#BCD2FF"));
  });

  it("falls back to slate-200 and handles dark custom fills", () => {
    expect(deriveBlockColors(null).fill).toBe("#E2E8F0");
    expect(deriveBlockColors("not-a-color").fill).toBe("#E2E8F0");
    const dark = deriveBlockColors("#1e3a8a");
    expect(dark).toMatchObject({ fill: "#1E3A8A", text: "#FFFFFF" });
    expect(contrastRatio(dark.secondaryText, dark.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DUTY_COLORS.text, DUTY_COLORS.fill)).toBeGreaterThan(7);
  });
});

describe("locationTint / personColor", () => {
  it("returns the preset chip and ink for preset grounds (any case)", () => {
    expect(locationTint("#e9eef5")).toEqual({ ground: "#E9EEF5", chip: "#D3DCEA", ink: "#1E3A5F" });
    for (const option of LOCATION_COLOR_OPTIONS) {
      expect(locationTint(option.color)?.chip).toBe(option.chip);
    }
  });

  it.each([
    ["#DDEEFF", 5.5],
    ["#1E293B", 5.5], // dark ground → light ink
    ["#3B82F6", 4.5],
    ["#808080", 4.5],
  ])("derives a darker chip and readable ink for the custom color %s", (color, minRatio) => {
    const tint = locationTint(color)!;
    expect(getLuminance(tint.chip)).toBeLessThan(getLuminance(tint.ground));
    expect(contrastRatio(tint.ink, tint.chip)).toBeGreaterThanOrEqual(minRatio);
  });

  it("returns null (no tint) for missing or invalid colors", () => {
    expect(locationTint(null)).toBeNull();
    expect(locationTint("")).toBeNull();
    expect(locationTint("red")).toBeNull();
  });

  it("cycles the 16 person colors in list order", () => {
    expect(personColor(0)).toMatchObject({ id: "p01", strong: "#1D4ED8" });
    expect(personColor(15).id).toBe("p16");
    expect(personColor(16).id).toBe("p01");
    expect(personColor(-1).id).toBe("p16");
    expect(personColor(Number.NaN).id).toBe("p01");
  });
});

describe("titles and short labels (SPEC R8)", () => {
  it("strips times from section names", () => {
    expect(stripTimes("MRT 08:00–17:00")).toBe("MRT");
    expect(stripTimes("CT 10:00-19:00")).toBe("CT");
    expect(stripTimes("Hintergrund OA · 17:00–08:00")).toBe("Hintergrund OA");
    expect(stripTimes("MRT (08:00 - 16:30 Uhr)")).toBe("MRT");
    expect(stripTimes("Kinder / Sono")).toBe("Kinder / Sono");
    expect(stripTimes("08:00–16:00")).toBe("08:00–16:00");
  });

  it("derives labels of at most six characters", () => {
    expect(deriveShortLabel("MRT")).toBe("MRT");
    expect(deriveShortLabel("MRT spät")).toBe("MRT-S");
    expect(deriveShortLabel("CT-Intervention")).toBe("CT-Int");
    expect(deriveShortLabel("Konventionell")).toBe("Konve.");
    expect(deriveShortLabel("Kinder / Sono")).toBe("Kinder");
    for (const name of ["kardiologischer Arbeitsplatz", "Demos/TuKos usw.", "LKE/DL", "SDI Station"]) {
      expect(deriveShortLabel(name).length).toBeLessThanOrEqual(6);
    }
  });
});
