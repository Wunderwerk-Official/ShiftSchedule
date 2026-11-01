import type { Orientation, PlanRange, UserPreferences } from "../../api/client";
import type { PreferencesUpdate } from "../../lib/userPreferences";

// Pure helpers around the My-plan view settings: range and orientation labels,
// and reading / updating the remembered range and orientations per device
// class. The start-page and saved-view helpers were removed together with the
// star and the "Views" menu in v1.71.

export const RANGE_LABELS: Record<PlanRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

const ORIENTATION_TITLES: Record<Orientation, string> = {
  top: "Date on top",
  left: "Date on left",
};

const ORIENTATION_SUBTITLES: Record<PlanRange, Record<Orientation, string>> = {
  week: { top: "Days side by side", left: "Days stacked" },
  month: { top: "Calendar", left: "List" },
  day: { top: "Time runs down", left: "Time runs right" },
};

/** Two-line label of an orientation segment ("Date on top" / "Days side by side"). */
export function orientationLabel(
  range: PlanRange,
  orientation: Orientation,
): { title: string; subtitle: string } {
  return {
    title: ORIENTATION_TITLES[orientation],
    subtitle: ORIENTATION_SUBTITLES[range][orientation],
  };
}

/** Tooltip incl. the Momentum wording (plan §2.3). */
export function orientationTooltip(range: PlanRange, orientation: Orientation): string {
  const { title, subtitle } = orientationLabel(range, orientation);
  const momentum = orientation === "top" ? "timeline left" : "timeline top";
  return `${title}: ${subtitle.toLowerCase()}. In Momentum: '${momentum}'.`;
}

/** Preference key of the remembered My-plan range: phones keep their own (SPEC R17). */
function rangeKey(isMobile: boolean): "myPlanRange" | "myPlanRangeMobile" {
  return isMobile ? "myPlanRangeMobile" : "myPlanRange";
}

/** Remembered My-plan range on this device class. */
export function rangeOf(prefs: UserPreferences, isMobile = false): PlanRange {
  return prefs[rangeKey(isMobile)];
}

/** Preferences patch remembering the My-plan range on this device class. */
export function rangeUpdate(range: PlanRange, isMobile = false): Partial<UserPreferences> {
  return { [rangeKey(isMobile)]: range };
}

/** Preference key of the remembered orientations: phones keep their own (SPEC A3.5). */
function orientationKey(isMobile: boolean): "orientationByRange" | "orientationByRangeMobile" {
  return isMobile ? "orientationByRangeMobile" : "orientationByRange";
}

/** Remembered orientation of a range on this device class. */
export function orientationOf(prefs: UserPreferences, range: PlanRange, isMobile = false): Orientation {
  return prefs[orientationKey(isMobile)][range];
}

/** Preferences patch remembering an orientation for a range on this device class. */
export function orientationUpdate(range: PlanRange, orientation: Orientation, isMobile = false): PreferencesUpdate {
  const key = orientationKey(isMobile);
  return (prev) => ({ ...prev, [key]: { ...prev[key], [range]: orientation } });
}
