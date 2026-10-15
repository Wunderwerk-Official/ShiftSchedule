import { useCallback, useEffect, useRef, useState } from "react";
import {
  getUserPreferences,
  saveUserPreferences,
  type ColorBy,
  type Orientation,
  type PlanRange,
  type PlanScope,
  type SavedView,
  type UserPreferences,
  type ViewConfig,
} from "../api/client";

// Per-user UI preferences (My plan, saved views, start pages), stored via
// GET/PUT /v1/me/preferences — never in AppState. The hook applies changes
// optimistically and saves them debounced; a failed load or save never blocks
// the UI (defaults / local state stay usable, the next change retries). It
// never PUTs before one GET succeeded, so a failed load cannot overwrite the
// stored views with defaults.

export const MAX_SAVED_VIEWS = 12;
const SAVE_DEBOUNCE_MS = 600;

const PLAN_SCOPES: PlanScope[] = ["team", "me"];
const PLAN_RANGES: PlanRange[] = ["day", "week", "month"];
const ORIENTATIONS: Orientation[] = ["top", "left"];
const COLOR_BYS: ColorBy[] = ["section", "person"];

/** Mirrors the backend defaults (backend/models.py::UserPreferences). */
export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = Object.freeze<UserPreferences>({
  version: 1,
  clinicianId: null,
  orientationByRange: { day: "top", week: "top", month: "top" },
  myPlanRange: "week",
  teamColorBy: "section",
  savedViews: [],
  startViewDesktop: null,
  startViewMobile: null,
});

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pick = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const boundedString = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

/** A complete view from unknown input (missing fields → defaults), or null. */
export function normalizeViewConfig(raw: unknown): ViewConfig | null {
  if (!isRecord(raw)) return null;
  return {
    scope: pick(raw.scope, PLAN_SCOPES, "team"),
    range: pick(raw.range, PLAN_RANGES, "week"),
    orientation: pick(raw.orientation, ORIENTATIONS, "top"),
    colorBy: pick(raw.colorBy, COLOR_BYS, "section"),
  };
}

/**
 * Same scope/range/orientation, and colorBy for scope "team" (it has no
 * meaning in My plan, so it is ignored there); ids and names are ignored.
 */
export function sameViewConfig(a: ViewConfig | null, b: ViewConfig | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.scope === b.scope &&
    a.range === b.range &&
    a.orientation === b.orientation &&
    (a.scope === "me" || a.colorBy === b.colorBy)
  );
}

/** Coerces anything (server JSON, old shapes) into valid preferences; pure. */
export function normalizePreferences(raw: unknown): UserPreferences {
  const source = isRecord(raw) ? raw : {};
  const orientationSource = isRecord(source.orientationByRange) ? source.orientationByRange : {};
  const orientationByRange = Object.fromEntries(
    PLAN_RANGES.map((range) => [
      range,
      pick(orientationSource[range], ORIENTATIONS, DEFAULT_PREFERENCES.orientationByRange[range]),
    ]),
  ) as Record<PlanRange, Orientation>;

  const savedViews: SavedView[] = [];
  const seenIds = new Set<string>();
  for (const item of Array.isArray(source.savedViews) ? source.savedViews : []) {
    const view = normalizeViewConfig(item);
    const id = isRecord(item) ? boundedString(item.id, 64) : null;
    const name = isRecord(item) ? boundedString(item.name, 60) : null;
    if (!view || !id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    savedViews.push({ ...view, id, name });
    if (savedViews.length === MAX_SAVED_VIEWS) break;
  }

  return {
    version: 1,
    clinicianId: boundedString(source.clinicianId, 200),
    orientationByRange,
    myPlanRange: pick(source.myPlanRange, PLAN_RANGES, "week"),
    teamColorBy: pick(source.teamColorBy, COLOR_BYS, "section"),
    savedViews,
    startViewDesktop: normalizeViewConfig(source.startViewDesktop),
    startViewMobile: normalizeViewConfig(source.startViewMobile),
  };
}

export type PreferencesUpdate =
  | Partial<UserPreferences>
  | ((prev: UserPreferences) => UserPreferences);

const applyUpdate = (prev: UserPreferences, update: PreferencesUpdate) =>
  normalizePreferences(typeof update === "function" ? update(prev) : { ...prev, ...update });

/**
 * Loads the user's preferences once per username and keeps them in sync.
 * `update` is optimistic; saves are debounced (600 ms), serialized, and a
 * pending save is flushed when the tab is hidden or closed and on unmount.
 * Changes made before a load succeeds are replayed on top of the server data;
 * after a failed load the next change retries it, nothing is saved until then.
 * Switching the username drops a pending save instead of writing it under
 * another account.
 */
export function useUserPreferences(username: string | null | undefined): {
  prefs: UserPreferences;
  loaded: boolean;
  update: (update: PreferencesUpdate) => void;
} {
  const [prefs, setPrefs] = useState<UserPreferences>(() => normalizePreferences(null));
  const [loaded, setLoaded] = useState(false);
  const latestRef = useRef(prefs);
  // True once a GET succeeded for this username: only then may we PUT.
  const syncedRef = useRef(false);
  const loadFailedRef = useRef(false);
  // Bumped per username (and on unmount) so late GET results are ignored.
  const generationRef = useRef(0);
  const pendingUpdatesRef = useRef<PreferencesUpdate[]>([]);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);

  const commit = useCallback((next: UserPreferences) => {
    latestRef.current = next;
    setPrefs(next);
  }, []);

  const runSave = useCallback(async () => {
    timerRef.current = null;
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    savingRef.current = true;
    try {
      await saveUserPreferences(latestRef.current);
    } catch (error) {
      // Local state stays; the next change saves the full object again.
      console.warn("Saving preferences failed:", error);
    } finally {
      savingRef.current = false;
    }
    if (saveAgainRef.current) {
      saveAgainRef.current = false;
      void runSave();
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void runSave(), SAVE_DEBOUNCE_MS);
  }, [runSave]);

  // Flush a pending debounced save when the tab is hidden/closed and on
  // unmount (runSave is stable, so the cleanup only runs on unmount).
  useEffect(() => {
    const flush = () => {
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      void runSave();
    };
    const flushIfHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushIfHidden);
      flush();
    };
  }, [runSave]);

  const load = useCallback(() => {
    const generation = generationRef.current;
    loadFailedRef.current = false;
    getUserPreferences().then(
      (raw) => {
        if (generation !== generationRef.current) return;
        const pending = pendingUpdatesRef.current;
        pendingUpdatesRef.current = [];
        commit(pending.reduce(applyUpdate, normalizePreferences(raw)));
        syncedRef.current = true;
        setLoaded(true);
        if (pending.length) scheduleSave();
      },
      (error) => {
        if (generation !== generationRef.current) return;
        // Usable with defaults, but saving waits for a successful load.
        console.warn("Loading preferences failed, using defaults:", error);
        loadFailedRef.current = true;
        setLoaded(true);
      },
    );
  }, [commit, scheduleSave]);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    saveAgainRef.current = false;
    syncedRef.current = false;
    loadFailedRef.current = false;
    pendingUpdatesRef.current = [];
    commit(normalizePreferences(null));
    setLoaded(false);
    if (username) load();
    return () => {
      generationRef.current += 1;
    };
  }, [username, commit, load]);

  const update = useCallback(
    (change: PreferencesUpdate) => {
      commit(applyUpdate(latestRef.current, change));
      if (syncedRef.current) {
        scheduleSave();
        return;
      }
      pendingUpdatesRef.current.push(change);
      if (loadFailedRef.current) load();
    },
    [commit, scheduleSave, load],
  );

  return { prefs, loaded, update };
}
