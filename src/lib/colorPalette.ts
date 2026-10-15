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

// Location tints for "My plan": `color` is the light ground stored on
// Location.color, `chip` the darker label background, `ink` the label text.
// `dark` holds the dark-mode tokens (SPEC B7): a deep ground of the same hue,
// a mid chip and a light ink (≥ 7:1 on the chip), so locations stay apart.
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
  dark: LocationColorTone;
};

export const LOCATION_COLOR_OPTIONS: LocationColorOption[] = [
  {
    id: "slate", color: "#E9EEF5", chip: "#D3DCEA", ink: "#1E3A5F",
    dark: { ground: "#162133", chip: "#2B3B55", ink: "#D5E2F3" },
  },
  {
    id: "sand", color: "#EEDFC4", chip: "#E2C99E", ink: "#5A3E0E",
    dark: { ground: "#3D2F18", chip: "#574321", ink: "#F2DEB8" },
  },
  {
    id: "sage", color: "#E3EFE6", chip: "#C9DDCD", ink: "#2F5A3A",
    dark: { ground: "#1A3220", chip: "#2F5137", ink: "#CFEDD6" },
  },
  {
    id: "lilac", color: "#ECE8F5", chip: "#D6CFEA", ink: "#4C3D6B",
    dark: { ground: "#2B233E", chip: "#43375C", ink: "#DDD5F1" },
  },
];

// Person colors for "Color by: Person" (assigned in clinician list order,
// repeating after 16). `strong` = initials circle + pill border (white text
// on it), `light` = pill fill, `ink` = pill text. `dark` holds the dark-mode
// tokens (SPEC B8): a lighter circle/border with dark initials (#0F172A), a
// deep fill and light text. Red/rose are left out because red marks rule
// violations.
export type PersonColorTone = {
  strong: string;
  light: string;
  ink: string;
};

export type PersonColor = PersonColorTone & {
  id: string;
  dark: PersonColorTone;
};

/** Initials text on `strong` (light mode) and on `dark.strong` (dark mode). */
export const PERSON_ON_STRONG = { light: "#FFFFFF", dark: "#0F172A" } as const;

export const PERSON_COLORS: PersonColor[] = [
  {
    id: "p01", strong: "#1D4ED8", light: "#DBEAFE", ink: "#1E3A8A",
    dark: { strong: "#7FA3F0", light: "#1E2D4C", ink: "#DBE8FF" },
  },
  {
    id: "p02", strong: "#B45309", light: "#FEF3C7", ink: "#78350F",
    dark: { strong: "#E18D5E", light: "#462410", ink: "#FFE1D1" },
  },
  {
    id: "p03", strong: "#047857", light: "#D1FAE5", ink: "#064E3B",
    dark: { strong: "#4CBC93", light: "#033727", ink: "#D0F1E2" },
  },
  {
    id: "p04", strong: "#6D28D9", light: "#EDE9FE", ink: "#4C1D95",
    dark: { strong: "#A796E9", light: "#2F2749", ink: "#E8E4FF" },
  },
  {
    id: "p05", strong: "#0E7490", light: "#CFFAFE", ink: "#164E63",
    dark: { strong: "#35B4DB", light: "#003444", ink: "#CCEEFC" },
  },
  {
    id: "p06", strong: "#A21CAF", light: "#FAE8FF", ink: "#701A75",
    dark: { strong: "#CA8ACF", light: "#3C233F", ink: "#F6DFF7" },
  },
  {
    id: "p07", strong: "#4D7C0F", light: "#ECFCCB", ink: "#365314",
    dark: { strong: "#89B462", light: "#233412", ink: "#DEEED3" },
  },
  {
    id: "p08", strong: "#C2410C", light: "#FFEDD5", ink: "#7C2D12",
    dark: { strong: "#E4896C", light: "#472216", ink: "#FFDFD5" },
  },
  {
    id: "p09", strong: "#4338CA", light: "#E0E7FF", ink: "#312E81",
    dark: { strong: "#929DEF", light: "#262A4B", ink: "#E1E6FF" },
  },
  {
    id: "p10", strong: "#0F766E", light: "#CCFBF1", ink: "#134E4A",
    dark: { strong: "#23BCB0", light: "#003732", ink: "#CBF1EC" },
  },
  {
    id: "p11", strong: "#BE185D", light: "#FCE7F3", ink: "#831843",
    dark: { strong: "#E3839C", light: "#46202A", ink: "#FFDDE5" },
  },
  {
    id: "p12", strong: "#57534E", light: "#F5F5F4", ink: "#292524",
    dark: { strong: "#D6D3D1", light: "#292524", ink: "#F5F5F4" },
  },
  {
    id: "p13", strong: "#A16207", light: "#FEF9C3", ink: "#713F12",
    dark: { strong: "#D7954B", light: "#422706", ink: "#FBE3CC" },
  },
  {
    id: "p14", strong: "#7E22CE", light: "#F3E8FF", ink: "#581C87",
    dark: { strong: "#B392E3", light: "#332647", ink: "#ECE2FF" },
  },
  {
    id: "p15", strong: "#15803D", light: "#DCFCE7", ink: "#14532D",
    dark: { strong: "#69BA7C", light: "#14361D", ink: "#D6F0DA" },
  },
  {
    id: "p16", strong: "#334155", light: "#F1F5F9", ink: "#0F172A",
    dark: { strong: "#CBD5E1", light: "#1E293B", ink: "#F1F5F9" },
  },
];
