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
export type LocationColorOption = {
  id: string;
  color: string;
  chip: string;
  ink: string;
};

export const LOCATION_COLOR_OPTIONS: LocationColorOption[] = [
  { id: "slate", color: "#E9EEF5", chip: "#D3DCEA", ink: "#1E3A5F" },
  { id: "sand", color: "#EEDFC4", chip: "#E2C99E", ink: "#5A3E0E" },
  { id: "sage", color: "#E3EFE6", chip: "#C9DDCD", ink: "#2F5A3A" },
  { id: "lilac", color: "#ECE8F5", chip: "#D6CFEA", ink: "#4C3D6B" },
];

// Person colors for "Color by: Person" (assigned in clinician list order,
// repeating after 16). `strong` = initials circle + pill border (white text
// on it), `light` = pill fill, `ink` = pill text. Red/rose are left out
// because red marks rule violations.
export type PersonColor = {
  id: string;
  strong: string;
  light: string;
  ink: string;
};

export const PERSON_COLORS: PersonColor[] = [
  { id: "p01", strong: "#1D4ED8", light: "#DBEAFE", ink: "#1E3A8A" },
  { id: "p02", strong: "#B45309", light: "#FEF3C7", ink: "#78350F" },
  { id: "p03", strong: "#047857", light: "#D1FAE5", ink: "#064E3B" },
  { id: "p04", strong: "#6D28D9", light: "#EDE9FE", ink: "#4C1D95" },
  { id: "p05", strong: "#0E7490", light: "#CFFAFE", ink: "#164E63" },
  { id: "p06", strong: "#A21CAF", light: "#FAE8FF", ink: "#701A75" },
  { id: "p07", strong: "#4D7C0F", light: "#ECFCCB", ink: "#365314" },
  { id: "p08", strong: "#C2410C", light: "#FFEDD5", ink: "#7C2D12" },
  { id: "p09", strong: "#4338CA", light: "#E0E7FF", ink: "#312E81" },
  { id: "p10", strong: "#0F766E", light: "#CCFBF1", ink: "#134E4A" },
  { id: "p11", strong: "#BE185D", light: "#FCE7F3", ink: "#831843" },
  { id: "p12", strong: "#57534E", light: "#F5F5F4", ink: "#292524" },
  { id: "p13", strong: "#A16207", light: "#FEF9C3", ink: "#713F12" },
  { id: "p14", strong: "#7E22CE", light: "#F3E8FF", ink: "#581C87" },
  { id: "p15", strong: "#15803D", light: "#DCFCE7", ink: "#14532D" },
  { id: "p16", strong: "#334155", light: "#F1F5F9", ink: "#0F172A" },
];
