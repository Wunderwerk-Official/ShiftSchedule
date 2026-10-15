import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanScope, UserPreferences, ViewConfig } from "../api/client";
import type { PreferencesUpdate } from "../lib/userPreferences";
import {
  applyViewConfig,
  orientationOf,
  rangeOf,
  startViewKey,
  viewPreferencesUpdate,
} from "../components/myPlan/viewConfig";

/** Range/orientation (My plan, this device class) or colorBy (team) of `view` already in the preferences? */
function prefsMatchView(prefs: UserPreferences, view: ViewConfig, isMobile: boolean): boolean {
  if (view.scope === "team") return prefs.teamColorBy === view.colorBy;
  return (
    rangeOf(prefs, isMobile) === view.range &&
    orientationOf(prefs, view.range, isMobile) === view.orientation
  );
}

/** How long the calendar waits for the preferences before showing the team plan anyway. */
export const START_VIEW_WAIT_MS = 1000;

/**
 * Page scope "Team | My plan" (plan §2.1). Starts as "team" — today's
 * behaviour — and applies the start view of the device class ONCE after the
 * preferences loaded (scope plus range/orientation or colorBy); later
 * preference changes never yank the view, and neither does a late load after
 * the user already switched. `applyView` applies a saved view.
 *
 * `scopeReady` is false until the start view is settled (or START_VIEW_WAIT_MS
 * passed), so the page can hold the calendar back instead of painting the
 * team grid and swapping it for the start view a moment later; a slow or
 * failing preferences endpoint never blocks the team plan for long.
 */
export function usePlanScope({
  username,
  prefs,
  loaded,
  onUpdatePrefs,
  isMobile,
}: {
  username: string;
  prefs: UserPreferences;
  loaded: boolean;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  isMobile: boolean;
}) {
  const [planScope, setScope] = useState<PlanScope>("team");
  // Readiness per username: start view settled (applied or none) / waited long enough.
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const startAppliedFor = useRef<string | null>(null);
  const userSwitched = useRef(false);
  const setPlanScope = useCallback((scope: PlanScope) => {
    userSwitched.current = true;
    setScope(scope);
  }, []);

  useEffect(() => {
    if (!loaded || startAppliedFor.current === username) return;
    startAppliedFor.current = username;
    // Batched with setScope below: the first ready render already has the start scope.
    setSettledFor(username);
    const start = prefs[startViewKey(isMobile)];
    if (!start || userSwitched.current) return;
    // Only write when something differs: opening the app must not PUT.
    if (!prefsMatchView(prefs, start, isMobile)) onUpdatePrefs(viewPreferencesUpdate(start, isMobile));
    setScope(start.scope);
  }, [loaded, username, prefs, isMobile, onUpdatePrefs]);

  useEffect(() => {
    if (loaded) return;
    const timer = window.setTimeout(() => setWaitedFor(username), START_VIEW_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, username]);

  const applyView = useCallback(
    (view: ViewConfig) => applyViewConfig(view, setPlanScope, onUpdatePrefs, isMobile),
    [setPlanScope, onUpdatePrefs, isMobile],
  );

  const scopeReady = settledFor === username || waitedFor === username;
  return { planScope, setPlanScope, applyView, scopeReady };
}
