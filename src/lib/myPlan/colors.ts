import { LOCATION_COLOR_OPTIONS, PERSON_COLORS, type PersonColor } from "../colorPalette";
import { getLuminance } from "../shiftRows";
import type { BlockColors, LocationTint } from "./types";

// Block, duty, absence and location colors for "My plan" (SPEC B4–B7).
// Section blocks keep the existing pastel `blockColor` as fill; border and
// text are derived in the same hue so they stay readable on any pastel.

const FALLBACK_FILL = "#E2E8F0";
const WHITE = "#FFFFFF";
const BLACK = "#000000";

export const DUTY_COLORS: BlockColors = {
  fill: "#312E81",
  border: "#1E1B4B",
  text: "#FFFFFF",
  secondaryText: "#C7D2FE",
};

/** Absence bands (light + dark mode). Rest-day border is 1.5px dashed. */
export const ABSENCE_COLORS = {
  vacation: {
    fill: "#F0FDF4",
    stripes: "repeating-linear-gradient(135deg,#BBF7D0 0 2px,#F0FDF4 2px 8px)",
    border: "#16A34A",
    text: "#14532D",
    dark: {
      fill: "#052E16",
      stripes: "repeating-linear-gradient(135deg,#14532D 0 2px,#052E16 2px 8px)",
      border: "#22C55E",
      text: "#DCFCE7",
    },
  },
  rest: {
    fill: "#FFFFFF",
    border: "#64748B",
    text: "#334155",
    dark: { fill: "#0F172A", border: "#94A3B8", text: "#E2E8F0" },
  },
} as const;

type Hsl = { h: number; s: number; l: number };

function normalizeHex(value?: string | null): string | null {
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toUpperCase();
}

function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/** WCAG contrast ratio of two "#RRGGBB" colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = getLuminance(a);
  const lb = getLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Walks the lightness down (same hue) until `accept` passes; black otherwise.
function darkenUntil(base: Hsl, startL: number, accept: (hex: string) => boolean): string {
  for (let l = startL; l > 0; l -= 0.01) {
    const hex = hslToHex({ ...base, l });
    if (accept(hex)) return hex;
  }
  return BLACK;
}

// Light tint of the hue for text on a dark ground, or white if it falls short.
function lightInk(hsl: Hsl, ground: string, minRatio: number): string {
  const tint = hslToHex({ h: hsl.h, s: Math.min(hsl.s, 0.5), l: 0.88 });
  return contrastRatio(tint, ground) >= minRatio ? tint : WHITE;
}

// Pure but ~300 contrast checks per fill, and toPlanShift calls it for every
// shift (coworker lookups for every colleague), so cache by normalized fill.
const blockColorCache = new Map<string, BlockColors>();

/**
 * Block colors for a section fill: border ≥ 3:1 against white and clearly
 * darker than the fill (≥ 1.4:1); text ≥ 7:1 against the fill where reachable
 * (mid-tones: black, always ≥ 4.5:1); secondary text ≥ 4.5:1. Dark fills get
 * white text. Missing/invalid fill → slate-200.
 */
export function deriveBlockColors(fill?: string | null): BlockColors {
  const base = normalizeHex(fill) ?? FALLBACK_FILL;
  const cached = blockColorCache.get(base);
  if (cached) return cached;
  const hsl = hexToHsl(base);
  let colors: BlockColors;
  if (contrastRatio(base, WHITE) >= 4.5) {
    // Dark custom fill: white text, a slightly darker border.
    colors = {
      fill: base,
      border: hslToHex({ ...hsl, l: Math.max(0, hsl.l - 0.12) }),
      text: WHITE,
      secondaryText: lightInk(hsl, base, 4.5),
    };
  } else {
    const muted = { h: hsl.h, s: Math.min(hsl.s, 0.45), l: hsl.l };
    const baseLuminance = getLuminance(base);
    colors = {
      fill: base,
      border: darkenUntil(
        muted,
        hsl.l,
        (hex) =>
          contrastRatio(hex, WHITE) >= 3.15 &&
          (baseLuminance + 0.05) / (getLuminance(hex) + 0.05) >= 1.4,
      ),
      text: darkenUntil(muted, 0.3, (hex) => contrastRatio(hex, base) >= 7),
      secondaryText: darkenUntil(
        { ...muted, s: Math.min(hsl.s, 0.3) },
        0.42,
        (hex) => contrastRatio(hex, base) >= 4.5,
      ),
    };
  }
  blockColorCache.set(base, Object.freeze(colors));
  return colors;
}

/**
 * Tint for a Location.color: one of LOCATION_COLOR_OPTIONS, or for a custom
 * hex a slightly darker chip and an ink with ≥ 5.5:1 against the chip where
 * reachable (light ink on dark chips; always ≥ 4.5:1). Null = no tint.
 */
export function locationTint(color?: string | null): LocationTint | null {
  const ground = normalizeHex(color);
  if (!ground) return null;
  const preset = LOCATION_COLOR_OPTIONS.find((option) => option.color === ground);
  if (preset) return { ground, chip: preset.chip, ink: preset.ink };
  const hsl = hexToHsl(ground);
  const chip = hslToHex({ ...hsl, l: Math.max(0, hsl.l - 0.08) });
  const ink =
    contrastRatio(WHITE, chip) > contrastRatio(BLACK, chip)
      ? lightInk(hsl, chip, 5.5)
      : darkenUntil(
          { h: hsl.h, s: Math.min(hsl.s, 0.5), l: hsl.l },
          0.3,
          (hex) => contrastRatio(hex, chip) >= 5.5,
        );
  return { ground, chip, ink };
}

/** Person color by clinician list index; repeats after 16. */
export function personColor(index: number): PersonColor {
  const count = PERSON_COLORS.length;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return PERSON_COLORS[((i % count) + count) % count];
}
