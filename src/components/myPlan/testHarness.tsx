import { render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import type { PlanScope, UserPreferences } from "../../api/client";
import { makeSource } from "../../lib/myPlan/testFixtures";
import { normalizePreferences, type PreferencesUpdate } from "../../lib/userPreferences";
import MyPlanView from "./MyPlanView";
import type { TeamPlanTarget } from "./types";

// Test-only harness: MyPlanView on the demo data (Lena's October 2026) with
// page-like state for preferences, anchor date and scope, plus spies on every
// callback. Preferences are applied like useUserPreferences does (normalized).

const source = makeSource();

/** Freeze "now" (Date only, timers stay real) for every test of the file: Wed 14 Oct 2026, 14:32. */
export function freezeClock(now = new Date(2026, 9, 14, 14, 32)) {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export type RenderPlanOptions = {
  /** Raw preferences (normalized like server data). */
  prefs?: Record<string, unknown>;
  isMobile?: boolean;
  isDark?: boolean;
  anchor?: Date;
  prefsLoaded?: boolean;
};

export function renderPlan({
  prefs: initialPrefs = {},
  isMobile = false,
  isDark = false,
  anchor: initialAnchor = new Date(2026, 9, 14),
  prefsLoaded = true,
}: RenderPlanOptions = {}) {
  const onUpdatePrefs = vi.fn<(update: PreferencesUpdate) => void>();
  const onScopeChange = vi.fn<(scope: PlanScope) => void>();
  const onShowInTeam = vi.fn<(target: TeamPlanTarget) => void>();
  const onAnchorDateChange = vi.fn<(date: Date) => void>();
  const state: { prefs: UserPreferences; anchor: Date; scope: PlanScope } = {
    prefs: normalizePreferences(initialPrefs),
    anchor: initialAnchor,
    scope: "me",
  };

  function Harness() {
    const [prefs, setPrefs] = useState(state.prefs);
    const [anchor, setAnchor] = useState(initialAnchor);
    const [scope, setScope] = useState<PlanScope>("me");
    state.prefs = prefs;
    state.anchor = anchor;
    state.scope = scope;
    return (
      <MyPlanView
        {...source}
        anchorDate={anchor}
        onAnchorDateChange={(date) => {
          onAnchorDateChange(date);
          setAnchor(date);
        }}
        isMobile={isMobile}
        isDark={isDark}
        prefs={prefs}
        prefsLoaded={prefsLoaded}
        onUpdatePrefs={(update) => {
          onUpdatePrefs(update);
          setPrefs((prev) =>
            normalizePreferences(typeof update === "function" ? update(prev) : { ...prev, ...update }),
          );
        }}
        currentScope={scope}
        onScopeChange={(next) => {
          onScopeChange(next);
          setScope(next);
        }}
        onShowInTeam={onShowInTeam}
      />
    );
  }

  const utils = render(<Harness />);
  return {
    ...utils,
    onUpdatePrefs,
    onScopeChange,
    onShowInTeam,
    onAnchorDateChange,
    /** Latest preferences after all updates. */
    prefs: () => state.prefs,
    anchor: () => state.anchor,
    scope: () => state.scope,
  };
}

/** Applies a recorded onUpdatePrefs argument to `prev` (patch or updater). */
export function applyPrefsUpdate(prev: UserPreferences, update: PreferencesUpdate): UserPreferences {
  return normalizePreferences(typeof update === "function" ? update(prev) : { ...prev, ...update });
}
