import { describe, expect, it } from "vitest";
import { BLOCK_COLOR_SWATCH_OPTIONS, LOCATION_COLOR_OPTIONS, PERSON_COLORS } from "../colorPalette";
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

// CIE L*a*b* (D65) and CIEDE2000, to keep the person fills apart.
function toLab(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [channel(1), channel(3), channel(5)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE2000Lab([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1 = Math.hypot(a1p, b1);
  const c2 = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(a1p, b1);
  const h2 = hue(a2p, b2);
  let dh = c1 * c2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
  const lBar = (L1 + L2) / 2;
  const cpBar = (c1 + c2) / 2;
  let hBar = h1 + h2;
  if (c1 * c2 !== 0) {
    hBar = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  }
  const t =
    1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const rt =
    -Math.sin(2 * 30 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad) *
    2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  return Math.sqrt(
    ((L2 - L1) / sl) ** 2 + ((c2 - c1) / sc) ** 2 + (dH / sh) ** 2 + rt * ((c2 - c1) / sc) * (dH / sh),
  );
}

const deltaE2000 = (hexA: string, hexB: string) => deltaE2000Lab(toLab(hexA), toLab(hexB));

describe("deltaE2000 (test helper)", () => {
  it.each([
    // Reference pairs of Sharma, Wu & Dalal (2005), CIEDE2000 test data.
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ])("Lab %j vs %j → %f", (a, b, expected) => {
    expect(deltaE2000Lab(a, b)).toBeCloseTo(expected, 3);
  });

  it("measures sRGB colors in CIELAB (white vs black ≈ 100)", () => {
    expect(deltaE2000("#FFFFFF", "#FFFFFF")).toBe(0);
    expect(deltaE2000("#000000", "#FFFFFF")).toBeCloseTo(100, 0);
  });
});

describe("person palette (v1.71)", () => {
  const minDistance = (count: number) => {
    let min = Infinity;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        min = Math.min(min, deltaE2000(PERSON_COLORS[i].light, PERSON_COLORS[j].light));
      }
    }
    return min;
  };

  it("keeps the pill fills apart: ≥ 15 ΔE00 among the first 12, ≥ 9 among all 20", () => {
    expect(PERSON_COLORS).toHaveLength(20);
    expect(new Set(PERSON_COLORS.map((color) => color.id)).size).toBe(20);
    expect(minDistance(12)).toBeGreaterThanOrEqual(15);
    expect(minDistance(20)).toBeGreaterThanOrEqual(9);
  });

  it("mixes light and dark tones and keeps every text readable in both themes", () => {
    const tones = PERSON_COLORS.map((color) => color.tone);
    expect(tones.filter((tone) => tone === "light").length).toBeGreaterThanOrEqual(8);
    expect(tones.filter((tone) => tone === "dark").length).toBeGreaterThanOrEqual(8);
    for (const color of PERSON_COLORS) {
      // Light tone: dark text on a light fill (AAA); dark tone: white text (AA).
      expect(contrastRatio(color.ink, color.light)).toBeGreaterThanOrEqual(color.tone === "light" ? 7 : 4.5);
      expect(contrastRatio("#FFFFFF", color.strong)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color.dark.ink, color.dark.light)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio("#0F172A", color.dark.strong)).toBeGreaterThanOrEqual(4.5);
      // A dark tone is really dark, a light tone really light.
      const light = getLuminance(color.light) > getLuminance("#808080");
      expect(light).toBe(color.tone === "light");
    }
  });

  it("leaves out red, which marks rule violations", () => {
    for (const color of PERSON_COLORS) {
      const r = parseInt(color.light.slice(1, 3), 16);
      const g = parseInt(color.light.slice(3, 5), 16);
      const b = parseInt(color.light.slice(5, 7), 16);
      // No red-dominated fill (rose, red, pink): red well above green and blue.
      expect(r > g + 60 && r > b + 60 && b > g).toBe(false);
    }
  });
});

describe("personTone", () => {
  it("uses the B8 dark tokens with dark initials in dark mode", () => {
    expect(personTone(0)).toEqual({ strong: "#4338CA", light: "#A5B4FC", ink: "#1E1B4B", onStrong: "#FFFFFF" });
    expect(personTone(0, true)).toEqual({ strong: "#818CF8", light: "#312E81", ink: "#E0E7FF", onStrong: "#0F172A" });
    // A dark-tone person swaps in dark mode: bright fill, dark text.
    expect(personTone(1)).toEqual({ strong: "#7C2D12", light: "#C2410C", ink: "#FFFFFF", onStrong: "#FFFFFF" });
    expect(personTone(1, true)).toEqual({ strong: "#F97316", light: "#FDBA74", ink: "#431407", onStrong: "#0F172A" });
    for (let index = 0; index < PERSON_COLORS.length; index += 1) {
      const tone = personTone(index, true);
      expect(contrastRatio(tone.ink, tone.light)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(tone.onStrong, tone.strong)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("locationTint / personColor", () => {
  it("returns the preset chip, ink and band for preset grounds (any case)", () => {
    expect(locationTint("#e9eef5")).toEqual({
      ground: "#E9EEF5",
      chip: "#D3DCEA",
      ink: "#1E3A5F",
      band: "#456391",
      dark: { ground: "#162133", chip: "#2B3B55", ink: "#D5E2F3" },
    });
    for (const option of LOCATION_COLOR_OPTIONS) {
      expect(locationTint(option.color)?.chip).toBe(option.chip);
      expect(locationTint(option.color)?.band).toBe(option.band);
    }
  });

  it("gives every preset readable label shades and a band for white text (team grid, v1.71)", () => {
    expect(new Set(LOCATION_COLOR_OPTIONS.map((option) => option.id)).size).toBe(LOCATION_COLOR_OPTIONS.length);
    for (const option of LOCATION_COLOR_OPTIONS) {
      // Label text on both alternating shades, in both themes.
      expect(contrastRatio(option.ink, option.color)).toBeGreaterThanOrEqual(5.5);
      expect(contrastRatio(option.ink, option.chip)).toBeGreaterThanOrEqual(5.5);
      expect(contrastRatio(option.dark.ink, option.dark.ground)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(option.dark.ink, option.dark.chip)).toBeGreaterThanOrEqual(7);
      // The location band carries white capitals.
      expect(contrastRatio("#FFFFFF", option.band)).toBeGreaterThanOrEqual(4.5);
      // The two shades stay apart, so the row bands alternate visibly.
      expect(deltaE2000(option.color, option.chip)).toBeGreaterThanOrEqual(5);
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
  ])("derives a darker chip, readable ink and a band for the custom color %s", (color, minRatio) => {
    const tint = locationTint(color)!;
    expect(getLuminance(tint.chip)).toBeLessThan(getLuminance(tint.ground));
    expect(contrastRatio(tint.ink, tint.chip)).toBeGreaterThanOrEqual(minRatio);
    expect(contrastRatio("#FFFFFF", tint.band)).toBeGreaterThanOrEqual(5);
  });

  it("returns null (no tint) for missing or invalid colors", () => {
    expect(locationTint(null)).toBeNull();
    expect(locationTint("")).toBeNull();
    expect(locationTint("red")).toBeNull();
  });

  it("cycles the 20 person colors in list order", () => {
    expect(personColor(0)).toMatchObject({ id: "p01", strong: "#4338CA" });
    expect(personColor(19).id).toBe("p20");
    expect(personColor(20).id).toBe("p01");
    expect(personColor(-1).id).toBe("p20");
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
