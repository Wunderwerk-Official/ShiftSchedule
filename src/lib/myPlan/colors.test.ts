import { describe, expect, it } from "vitest";
import { BLOCK_COLOR_SWATCH_OPTIONS, LOCATION_COLOR_OPTIONS } from "../colorPalette";
import { getLuminance } from "../shiftRows";
import {
  contrastRatio,
  deriveBlockColors,
  deriveDarkBlockColors,
  DUTY_COLORS,
  locationTint,
  personColor,
  personTone,
  tintTone,
} from "./colors";
import { deriveAbsenceShortLabel, deriveLocationShortName, deriveShortLabel, stripTimes } from "./shifts";

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

describe("deriveDarkBlockColors", () => {
  it.each([...BLOCK_COLOR_SWATCH_OPTIONS.map((option) => option.color), "#FF99CC", "#3B82F6"])(
    "%s: deep fill, light readable text, border visible on the dark card",
    (fill) => {
      const colors = deriveDarkBlockColors(fill);
      expect(contrastRatio(colors.fill, "#0F172A")).toBeLessThan(2);
      expect(contrastRatio(colors.text, colors.fill)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.secondaryText, colors.fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.border, "#0F172A")).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("personTone", () => {
  it("uses the B8 dark tokens with dark initials in dark mode", () => {
    expect(personTone(0)).toEqual({ strong: "#1D4ED8", light: "#DBEAFE", ink: "#1E3A8A", onStrong: "#FFFFFF" });
    expect(personTone(0, true)).toEqual({ strong: "#7FA3F0", light: "#1E2D4C", ink: "#DBE8FF", onStrong: "#0F172A" });
    for (let index = 0; index < 16; index += 1) {
      const tone = personTone(index, true);
      expect(contrastRatio(tone.ink, tone.light)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(tone.onStrong, tone.strong)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("locationTint / personColor", () => {
  it("returns the preset chip and ink for preset grounds (any case)", () => {
    expect(locationTint("#e9eef5")).toEqual({
      ground: "#E9EEF5",
      chip: "#D3DCEA",
      ink: "#1E3A5F",
      dark: { ground: "#162133", chip: "#2B3B55", ink: "#D5E2F3" },
    });
    for (const option of LOCATION_COLOR_OPTIONS) {
      expect(locationTint(option.color)?.chip).toBe(option.chip);
    }
  });

  it("gives every location a dark set that keeps the locations apart (SPEC B7)", () => {
    const card = "#0F172A";
    const darkGrounds = LOCATION_COLOR_OPTIONS.map((option) => locationTint(option.color)!.dark.ground);
    expect(new Set(darkGrounds).size).toBe(LOCATION_COLOR_OPTIONS.length);
    for (const color of [...LOCATION_COLOR_OPTIONS.map((option) => option.color), "#DDEEFF", "#F5E1E1"]) {
      const { dark } = locationTint(color)!;
      expect(contrastRatio(dark.ink, dark.chip)).toBeGreaterThanOrEqual(7);
      // A deep ground of the hue, not the light ground blended over the card.
      expect(getLuminance(dark.ground)).toBeLessThan(0.05);
      expect(contrastRatio(dark.ground, card)).toBeLessThan(1.6);
    }
    expect(tintTone(locationTint("#EEDFC4")!, true)).toEqual({ ground: "#3D2F18", chip: "#574321", ink: "#F2DEB8" });
    expect(tintTone(locationTint("#EEDFC4")!, false).ground).toBe("#EEDFC4");
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
    expect(deriveShortLabel("Konventionell")).toBe("Konv.");
    expect(deriveShortLabel("Kinder / Sono")).toBe("Kinder");
    expect(deriveShortLabel("Nachtdienst")).toBe("Nacht");
    expect(deriveShortLabel("Mammadiagnostik")).toBe("Mamma");
    expect(deriveShortLabel("LKE/DL")).toBe("LKE");
    expect(deriveShortLabel("Wissenschaft")).toBe("Wiss.");
    for (const name of ["kardiologischer Arbeitsplatz", "Demos/TuKos usw.", "SDI Station", "Intervention"]) {
      expect(deriveShortLabel(name).length).toBeLessThanOrEqual(6);
    }
  });

  it("derives compact labels of at most five characters for phones", () => {
    expect(deriveShortLabel("Angiographie", 5)).toBe("Ang.");
    expect(deriveShortLabel("Angio", 5)).toBe("Angio");
    expect(deriveShortLabel("Zusatzdienst", 5)).toBe("Zus.");
    expect(deriveShortLabel("Kinder / Sono", 5)).toBe("Kind.");
    expect(deriveShortLabel("CT-Intervention", 5)).toBe("CT-In");
    for (const name of ["kardiologischer Arbeitsplatz", "Demos/TuKos usw.", "Mammadiagnostik", "Konventionell"]) {
      expect(deriveShortLabel(name, 5).length).toBeLessThanOrEqual(5);
    }
  });

  it("derives short location names for chips", () => {
    expect(deriveLocationShortName("Klinikum Mitte")).toBe("Mitte");
    expect(deriveLocationShortName("MRT")).toBe("MRT");
    expect(deriveLocationShortName("Ambulanz/Station")).toBe("Ambulanz");
    expect(deriveLocationShortName("Konferenzen")).toBe("Konf.");
    expect(deriveLocationShortName("Intervention", 5)).toBe("Int.");
    expect(deriveLocationShortName("Dienste", 5)).toBe("Dien.");
  });

  it("derives absence labels (ND-Frei → NDF)", () => {
    expect(deriveAbsenceShortLabel("ND-Frei")).toBe("NDF");
    expect(deriveAbsenceShortLabel("Rest Day")).toBe("Rest");
    expect(deriveAbsenceShortLabel("Urlaub/FzA")).toBe("Url.");
    expect(deriveAbsenceShortLabel("Frei")).toBe("Frei");
  });
});
