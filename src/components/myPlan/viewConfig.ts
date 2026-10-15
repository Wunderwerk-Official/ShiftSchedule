import type {
  Orientation,
  PlanRange,
  PlanScope,
  UserPreferences,
  ViewConfig,
  ViewStartAt,
} from "../../api/client";
import { startOfWeek } from "../../lib/date";
import { parseISODate } from "../../lib/myPlan";
import type { PreferencesUpdate } from "../../lib/userPreferences";

// Pure helpers around ViewConfig (scope + range + orientation + colorBy):
// the "current view", labels for the star/toast/views menu, and applying a
// saved or start view. Shared by My plan and (via the integration) the team
// header, so both describe and apply views the same way.

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
export function rangeKey(isMobile: boolean): "myPlanRange" | "myPlanRangeMobile" {
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
export function orientationKey(isMobile: boolean): "orientationByRange" | "orientationByRangeMobile" {
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

/**
 * The view currently shown. Team views are canonical (week, date on top) so a
 * team start page does not depend on the last My-plan range; My plan uses the
 * remembered range and its orientation on this device class.
 */
export function currentViewConfig(prefs: UserPreferences, scope: PlanScope, isMobile = false): ViewConfig {
  if (scope === "team") {
    return { scope, range: "week", orientation: "top", colorBy: prefs.teamColorBy };
  }
  const range = rangeOf(prefs, isMobile);
  return {
    scope,
    range,
    orientation: orientationOf(prefs, range, isMobile),
    colorBy: prefs.teamColorBy,
  };
}

/** "My plan · Week · Date on top", "My plan · Month · Calendar", "Team · Color by person". */
export function describeView(view: ViewConfig): string {
  if (view.scope === "team") {
    return `Team · Color by ${view.colorBy === "person" ? "person" : "section"}`;
  }
  const orientation =
    view.range === "month"
      ? ORIENTATION_SUBTITLES.month[view.orientation]
      : ORIENTATION_TITLES[view.orientation];
  return `My plan · ${RANGE_LABELS[view.range]} · ${orientation}`;
}

/** Suggested name for "Save current view…" ("My week", "Team plan"). */
export function defaultViewName(view: ViewConfig): string {
  if (view.scope === "team") return "Team plan";
  return `My ${RANGE_LABELS[view.range].toLowerCase()}`;
}

/** Collision-safe id for a saved view (≤ 64 chars). */
export function createViewId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `view-${random}`.slice(0, 64);
}

/** Preferences patch that makes `view` the current view on this device class (scope is page state). */
export function viewPreferencesUpdate(view: ViewConfig, isMobile = false): PreferencesUpdate {
  return (prev) => {
    if (view.scope === "team") return { ...prev, teamColorBy: view.colorBy };
    const key = orientationKey(isMobile);
    return {
      ...prev,
      [rangeKey(isMobile)]: view.range,
      [key]: { ...prev[key], [view.range]: view.orientation },
    };
  };
}

/** Applies a saved/start view: scope via onScopeChange, the rest via the preferences. */
export function applyViewConfig(
  view: ViewConfig,
  onScopeChange: (scope: PlanScope) => void,
  onUpdatePrefs: (update: PreferencesUpdate) => void,
  isMobile = false,
): void {
  onUpdatePrefs(viewPreferencesUpdate(view, isMobile));
  onScopeChange(view.scope);
}

/** "Open at" choices of a saved view (SPEC E8 / R17). */
export const START_AT_LABELS: Record<ViewStartAt, string> = {
  today: "Today",
  nextShift: "Next shift",
  weekStart: "Week start",
};

/**
 * Anchor date a saved view opens at: today, this week's Monday, or the start
 * day of the next own shift (today when there is none). Start pages and
 * plain view configs have no startAt and keep the current anchor (null).
 */
export function viewStartDate(
  view: ViewConfig & { startAt?: ViewStartAt },
  now: Date,
  nextShiftISO: () => string | null,
): Date | null {
  if (!view.startAt) return null;
  if (view.startAt === "weekStart") return startOfWeek(now, 1);
  if (view.startAt === "nextShift") {
    const nextISO = nextShiftISO();
    if (nextISO) return parseISODate(nextISO);
  }
  return new Date(now);
}

/** Preference key of the start view for the device class. */
export function startViewKey(isMobile: boolean): "startViewDesktop" | "startViewMobile" {
  return isMobile ? "startViewMobile" : "startViewDesktop";
}

/** "on computers" / "on phones" (start pages are per device class). */
export function deviceLabel(isMobile: boolean): string {
  return isMobile ? "on phones" : "on computers";
}
