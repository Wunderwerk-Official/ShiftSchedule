import type { Clinician, Location } from "../../api/client";
import { locationTint, personTone, tintTone, type PersonTone } from "../../lib/myPlan";
import { initialsOf } from "../myPlan/planChrome";

// Opt-in colors of the classic team grid (plan §2.9): "Color by: Person"
// pill styles and location tints. A person or location without an entry
// renders exactly as before, so the default look never changes.

/** Pill colors of one person in "Color by: Person". */
export type PersonPillStyle = {
  /**
   * Person palette entry by clinician list order, resolved for the theme
   * (light fill, strong border + initials circle, ink text, initials text).
   */
  color: PersonTone;
  initials: string;
};

/** The own outline ("That's me") is separate: ScheduleGrid's myClinicianId (set in person mode only). */
export function buildPersonPillStyles(clinicians: Clinician[], isDark = false): Map<string, PersonPillStyle> {
  return new Map(
    clinicians.map((clinician, index) => [
      clinician.id,
      { color: personTone(index, isDark), initials: initialsOf(clinician.name) },
    ]),
  );
}

/** Tint of a colored location for its rows' label cells and its separator row. */
export type LocationRowTint = {
  /** Ground of the theme (dark mode: the SPEC B7 dark ground). */
  ground: string;
  /** Label chip background and text of the theme. */
  chip: string;
  ink: string;
  /** Location name text on the ground; dark mode keeps the default text color. */
  text?: string;
};

/** Only locations with a valid color get an entry. */
export function buildLocationRowTints(
  locations: Location[],
  isDark: boolean,
): Map<string, LocationRowTint> {
  const tints = new Map<string, LocationRowTint>();
  for (const location of locations) {
    const tint = locationTint(location.color);
    if (!tint) continue;
    const tone = tintTone(tint, isDark);
    tints.set(location.id, {
      ground: tone.ground,
      chip: tone.chip,
      ink: tone.ink,
      text: isDark ? undefined : tone.ink,
    });
  }
  return tints;
}
