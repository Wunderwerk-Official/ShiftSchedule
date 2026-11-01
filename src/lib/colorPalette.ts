export type ColorOption = {
  id: string;
  color: string | null;
};

export const BLOCK_COLOR_OPTIONS: ColorOption[] = [
  { id: "none", color: null },
  { id: "rose", color: "#FDE2E4" },
  { id: "coral", color: "#FFD9C9" },
  { id: "peach", color: "#FFE8D6" },
  { id: "apricot", color: "#FFEFD1" },
  { id: "butter", color: "#FFF4C1" },
  { id: "lime", color: "#EEF6C8" },
  { id: "mint", color: "#E6F7D9" },
  { id: "seafoam", color: "#DDF6EE" },
  { id: "sky", color: "#D9F0FF" },
  { id: "periwinkle", color: "#DEE8FF" },
  { id: "lavender", color: "#E8E1F5" },
];

export const BLOCK_COLOR_SWATCH_OPTIONS: Array<{ id: string; color: string }> =
  BLOCK_COLOR_OPTIONS.filter(
    (option): option is { id: string; color: string } => !!option.color,
  );

// Location families. `color` is the light ground stored on Location.color,
// `chip` a stronger shade of the same hue, `ink` the text on both, `band` the
// strong color of the location band in the team grid (white text, both
// themes). The team grid (v1.71) tints the label column by location: a
// location's row bands (modalities) alternate between `color` and `chip`, so
// the hue says where and the alternation separates CT, MR, … My plan uses
// `color` as day ground and `chip` for location tags. `dark` holds the
// dark-mode tokens (SPEC B7): a deep ground of the same hue, a mid chip and a
// light ink (≥ 7:1 on the chip), so locations stay apart.
export type LocationColorTone = {
  ground: string;
  chip: string;
  ink: string;
};

export type LocationColorOption = {
  id: string;
  color: string;
  chip: string;
  ink: string;
  band: string;
  dark: LocationColorTone;
};

export const LOCATION_COLOR_OPTIONS: LocationColorOption[] = [
  {
    id: "blue", color: "#DBEAFE", chip: "#93C5FD", ink: "#172554", band: "#1D4ED8",
    dark: { ground: "#172554", chip: "#1E3A8A", ink: "#DBEAFE" },
  },
  {
    id: "green", color: "#DCFCE7", chip: "#86EFAC", ink: "#052E16", band: "#15803D",
    dark: { ground: "#052E16", chip: "#14532D", ink: "#DCFCE7" },
  },
  {
    id: "amber", color: "#FEF3C7", chip: "#FCD34D", ink: "#451A03", band: "#B45309",
    dark: { ground: "#451A03", chip: "#78350F", ink: "#FEF3C7" },
  },
  {
    id: "violet", color: "#EDE9FE", chip: "#C4B5FD", ink: "#2E1065", band: "#6D28D9",
    dark: { ground: "#2E1065", chip: "#4C1D95", ink: "#EDE9FE" },
  },
  {
    id: "rose", color: "#FFE4E6", chip: "#FDA4AF", ink: "#4C0519", band: "#BE123C",
    dark: { ground: "#4C0519", chip: "#881337", ink: "#FFE4E6" },
  },
  {
    id: "teal", color: "#CCFBF1", chip: "#5EEAD4", ink: "#042F2E", band: "#0F766E",
    dark: { ground: "#042F2E", chip: "#134E4A", ink: "#CCFBF1" },
  },
  {
    id: "orange", color: "#FFEDD5", chip: "#FDBA74", ink: "#431407", band: "#C2410C",
    dark: { ground: "#431407", chip: "#7C2D12", ink: "#FFEDD5" },
  },
  // The muted presets of v1.64 (stored colors keep working).
  {
    id: "slate", color: "#E9EEF5", chip: "#D3DCEA", ink: "#1E3A5F", band: "#456391",
    dark: { ground: "#162133", chip: "#2B3B55", ink: "#D5E2F3" },
  },
  {
    id: "sand", color: "#EEDFC4", chip: "#E2C99E", ink: "#5A3E0E", band: "#7A5E2E",
    dark: { ground: "#3D2F18", chip: "#574321", ink: "#F2DEB8" },
  },
  {
    id: "sage", color: "#E3EFE6", chip: "#C9DDCD", ink: "#2F5A3A", band: "#3B6D45",
    dark: { ground: "#1A3220", chip: "#2F5137", ink: "#CFEDD6" },
  },
  {
    id: "lilac", color: "#ECE8F5", chip: "#D6CFEA", ink: "#4C3D6B", band: "#6B51B3",
    dark: { ground: "#2B233E", chip: "#43375C", ink: "#DDD5F1" },
  },
];

/**
 * Colors a location without its own color gets in the team grid, in location
 * order (lib/locationColors skips the ones other locations chose): the first
 * four are the most distinct.
 */
export const AUTO_LOCATION_COLOR_IDS = ["blue", "green", "amber", "violet", "rose", "teal", "orange", "slate"] as const;

// Person colors of the team grid and My plan (assigned in clinician list
// order, repeating after 20). Chosen and ordered for distinctness (v1.71):
// the fills of any two of the first 12 differ by ≥ 15 ΔE00, of all 20 by
// ≥ 9 (the search also kept them apart under simulated red-green color
// blindness). Hue alone runs out, so two tones mix: a "light" person has a
// light fill with dark text, a "dark" person a saturated fill with white
// text, so even one hue family never looks alike twice. `strong` = initials
// circle + pill border (white initials), `light` = pill fill, `ink` = pill
// text. `dark` holds the dark-mode tokens (SPEC B8): the tones swap (light
// people get a deep fill, dark people a bright one) and the circle takes dark
// initials (#0F172A). Red/rose are left out because red marks rule
// violations.
export type PersonColorTone = {
  strong: string;
  light: string;
  ink: string;
};

export type PersonColor = PersonColorTone & {
  id: string;
  /** "light": light fill, dark text; "dark": saturated fill, white text. */
  tone: "light" | "dark";
  dark: PersonColorTone;
};

/** Initials text on `strong` (light mode) and on `dark.strong` (dark mode). */
export const PERSON_ON_STRONG = { light: "#FFFFFF", dark: "#0F172A" } as const;

export const PERSON_COLORS: PersonColor[] = [
  {
    id: "p01", tone: "light", strong: "#4338CA", light: "#A5B4FC", ink: "#1E1B4B",
    dark: { strong: "#818CF8", light: "#312E81", ink: "#E0E7FF" },
  }, // periwinkle
  {
    id: "p02", tone: "dark", strong: "#7C2D12", light: "#C2410C", ink: "#FFFFFF",
    dark: { strong: "#F97316", light: "#FDBA74", ink: "#431407" },
  }, // rust
  {
    id: "p03", tone: "light", strong: "#A16207", light: "#FDE047", ink: "#422006",
    dark: { strong: "#FACC15", light: "#713F12", ink: "#FEF9C3" },
  }, // yellow
  {
    id: "p04", tone: "dark", strong: "#064E3B", light: "#047857", ink: "#FFFFFF",
    dark: { strong: "#10B981", light: "#6EE7B7", ink: "#022C22" },
  }, // forest
  {
    id: "p05", tone: "light", strong: "#0E7490", light: "#67E8F9", ink: "#083344",
    dark: { strong: "#22D3EE", light: "#164E63", ink: "#CFFAFE" },
  }, // aqua
  {
    id: "p06", tone: "dark", strong: "#581C87", light: "#7E22CE", ink: "#FFFFFF",
    dark: { strong: "#A855F7", light: "#D8B4FE", ink: "#3B0764" },
  }, // purple
  {
    id: "p07", tone: "light", strong: "#C2410C", light: "#FDBA74", ink: "#431407",
    dark: { strong: "#FB923C", light: "#7C2D12", ink: "#FFEDD5" },
  }, // apricot
  {
    id: "p08", tone: "dark", strong: "#1C1917", light: "#44403C", ink: "#FFFFFF",
    dark: { strong: "#A8A29E", light: "#D6D3D1", ink: "#0C0A09" },
  }, // charcoal
  {
    id: "p09", tone: "light", strong: "#047857", light: "#6EE7B7", ink: "#022C22",
    dark: { strong: "#34D399", light: "#064E3B", ink: "#D1FAE5" },
  }, // mint
  {
    id: "p10", tone: "dark", strong: "#164E63", light: "#0E7490", ink: "#FFFFFF",
    dark: { strong: "#06B6D4", light: "#67E8F9", ink: "#083344" },
  }, // petrol
  {
    id: "p11", tone: "light", strong: "#44403C", light: "#E7E5E4", ink: "#0C0A09",
    dark: { strong: "#A8A29E", light: "#1C1917", ink: "#F5F5F4" },
  }, // light gray
  {
    id: "p12", tone: "light", strong: "#4D7C0F", light: "#D9F99D", ink: "#1A2E05",
    dark: { strong: "#A3E635", light: "#365314", ink: "#ECFCCB" },
  }, // pale lime
  {
    id: "p13", tone: "dark", strong: "#1E40AF", light: "#2563EB", ink: "#FFFFFF",
    dark: { strong: "#3B82F6", light: "#60A5FA", ink: "#020617" },
  }, // royal blue
  {
    id: "p14", tone: "dark", strong: "#86198F", light: "#C026D3", ink: "#FFFFFF",
    dark: { strong: "#D946EF", light: "#E879F9", ink: "#020617" },
  }, // magenta
  {
    id: "p15", tone: "dark", strong: "#365314", light: "#4D7C0F", ink: "#FFFFFF",
    dark: { strong: "#84CC16", light: "#BEF264", ink: "#1A2E05" },
  }, // olive
  {
    id: "p16", tone: "dark", strong: "#1E293B", light: "#475569", ink: "#FFFFFF",
    dark: { strong: "#CBD5E1", light: "#94A3B8", ink: "#020617" },
  }, // slate
  {
    id: "p17", tone: "light", strong: "#0369A1", light: "#7DD3FC", ink: "#082F49",
    dark: { strong: "#38BDF8", light: "#0C4A6E", ink: "#E0F2FE" },
  }, // sky
  {
    id: "p18", tone: "light", strong: "#A21CAF", light: "#F5D0FE", ink: "#4A044E",
    dark: { strong: "#E879F9", light: "#701A75", ink: "#FAE8FF" },
  }, // orchid
  {
    id: "p19", tone: "light", strong: "#0F766E", light: "#99F6E4", ink: "#042F2E",
    dark: { strong: "#2DD4BF", light: "#134E4A", ink: "#CCFBF1" },
  }, // pale teal
  {
    id: "p20", tone: "dark", strong: "#78350F", light: "#92400E", ink: "#FFFFFF",
    dark: { strong: "#F59E0B", light: "#FDE68A", ink: "#451A03" },
  }, // brown
];
