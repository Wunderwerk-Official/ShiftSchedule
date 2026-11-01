import type { Clinician, Location } from "../../api/client";
import { resolveLocationColors } from "../../lib/locationColors";
import { locationTint, personTone, tintTone, type PersonTone } from "../../lib/myPlan";
import { initialsOf } from "../myPlan/planChrome";

// Colors of the classic team grid (plan §2.9): the person pill styles
// (always on since v1.69) and, since v1.71, the location colors of the label
// column: the hue says where, alternating shades separate the row bands.

/** Pill colors of one person (team grid, always on since v1.69). */
export type PersonPillStyle = {
  /**
   * Person palette entry by clinician list order, resolved for the theme
   * (light fill, strong border + initials circle, ink text, initials text).
   */
  color: PersonTone;
  initials: string;
};

/** The own outline ("That's me") is separate: ScheduleGrid's myClinicianId (the linked person, whenever one is linked). */
export function buildPersonPillStyles(clinicians: Clinician[], isDark = false): Map<string, PersonPillStyle> {
  return new Map(
    clinicians.map((clinician, index) => [
      clinician.id,
      { color: personTone(index, isDark), initials: initialsOf(clinician.name) },
    ]),
  );
}

/**
 * Colors of a location in the team grid (v1.71): its row bands' label cells
 * alternate between `ground` and `chip` (1st, 3rd, … row band: ground), with
 * `ink` text on both; its separator row is a `band` with `bandInk` text.
 */
export type LocationRowTint = {
  /** Label ground of the location's 1st, 3rd, … row band (lighter shade). */
  ground: string;
  /** Label ground of its 2nd, 4th, … row band (stronger shade). */
  chip: string;
  /** Label text on both shades. */
  ink: string;
  /** The location band above its rows. */
  band: string;
  bandInk: string;
};

/** Label shade of a row band by its position in its location (0, 1, 2, …). */
export function labelShade(tint: LocationRowTint, bandIndex: number): string {
  return bandIndex % 2 === 0 ? tint.ground : tint.chip;
}

/**
 * Every location gets an entry: its own color, or an automatic one in
 * location order (lib/locationColors). Theme-resolved (dark: SPEC B7 set).
 */
export function buildLocationRowTints(
  locations: Location[],
  isDark: boolean,
): Map<string, LocationRowTint> {
  const tints = new Map<string, LocationRowTint>();
  const colors = resolveLocationColors(locations);
  for (const location of locations) {
    const tint = locationTint(colors.get(location.id));
    if (!tint) continue;
    const tone = tintTone(tint, isDark);
    tints.set(location.id, {
      ground: tone.ground,
      chip: tone.chip,
      ink: tone.ink,
      band: tint.band,
      bandInk: "#FFFFFF",
    });
  }
  return tints;
}
