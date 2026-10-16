import { useCallback, useEffect, useRef, useState } from "react";
import {
  getUserPreferences,
  saveUserPreferences,
  type ColorBy,
  type Orientation,
  type PlanRange,
  type PlanScope,
  type SavedView,
  type TeamTimeLayout,
  type UserPreferences,
  type ViewConfig,
  type ViewStartAt,
} from "../api/client";

// Per-user UI preferences (My plan, saved views, start pages), stored via
// GET/PUT /v1/me/preferences — never in AppState. The hook applies changes
// optimistically and saves them debounced; a failed load or save never blocks
// the UI (defaults / local state stay usable, the next change retries). It
// never PUTs before one GET succeeded, so a failed load cannot overwrite the
// stored views with defaults. The PUT stores only the top-level keys it
// names, so each save sends just the keys changed since the last one.

export const MAX_SAVED_VIEWS = 12;
const SAVE_DEBOUNCE_MS = 600;

const PLAN_SCOPES: PlanScope[] = ["team", "me"];
const PLAN_RANGES: PlanRange[] = ["day", "week", "month"];
const ORIENTATIONS: Orientation[] = ["top", "left"];
const COLOR_BYS: ColorBy[] = ["section", "person"];
const TIME_LAYOUTS: TeamTimeLayout[] = ["stacked", "columns"];
const START_ATS: ViewStartAt[] = ["today", "nextShift", "weekStart"];

/** Mirrors the backend defaults (backend/models.py::UserPreferences). */
export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = Object.freeze<UserPreferences>({
  version: 1,
  clinicianId: null,
  orientationByRange: { day: "top", week: "top", month: "top" },
  orientationByRangeMobile: { day: "top", week: "left", month: "top" },
  myPlanRange: "week",
  myPlanRangeMobile: "week",
  teamColorBy: "section",
  teamTimeLayout: "stacked",
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
  const orientations = (key: "orientationByRange" | "orientationByRangeMobile") => {
    const record = isRecord(source[key]) ? source[key] : {};
    return Object.fromEntries(
      PLAN_RANGES.map((range) => [range, pick(record[range], ORIENTATIONS, DEFAULT_PREFERENCES[key][range])]),
    ) as Record<PlanRange, Orientation>;
  };

  const savedViews: SavedView[] = [];
  const seenIds = new Set<string>();
  for (const item of Array.isArray(source.savedViews) ? source.savedViews : []) {
    const view = normalizeViewConfig(item);
    const id = isRecord(item) ? boundedString(item.id, 64) : null;
    const name = isRecord(item) ? boundedString(item.name, 60) : null;
    if (!view || !id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    const startAt = pick(isRecord(item) ? item.startAt : undefined, START_ATS, "today");
    savedViews.push({ ...view, id, name, startAt });
    if (savedViews.length === MAX_SAVED_VIEWS) break;
  }

  return {
    version: 1,
    clinicianId: boundedString(source.clinicianId, 200),
    orientationByRange: orientations("orientationByRange"),
    orientationByRangeMobile: orientations("orientationByRangeMobile"),
    myPlanRange: pick(source.myPlanRange, PLAN_RANGES, "week"),
    myPlanRangeMobile: pick(source.myPlanRangeMobile, PLAN_RANGES, "week"),
    teamColorBy: pick(source.teamColorBy, COLOR_BYS, "section"),
    teamTimeLayout: pick(source.teamTimeLayout, TIME_LAYOUTS, "stacked"),
    savedViews,
    startViewDesktop: normalizeViewConfig(source.startViewDesktop),
    startViewMobile: normalizeViewConfig(source.startViewMobile),
  };
}

export type PreferencesUpdate =
  | Partial<UserPreferences>
  | ((prev: UserPreferences) => UserPreferences);

type PreferenceKey = keyof UserPreferences;

const applyUpdate = (prev: UserPreferences, update: PreferencesUpdate) =>
  normalizePreferences(typeof update === "function" ? update(prev) : { ...prev, ...update });

// Both sides are normalized (fixed key order), so the JSON compare is stable.
const changedKeys = (before: UserPreferences, after: UserPreferences): PreferenceKey[] =>
  (Object.keys(after) as PreferenceKey[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );

const pickKeys = (prefs: UserPreferences, keys: Iterable<PreferenceKey>) =>
  Object.fromEntries([...keys].map((key) => [key, prefs[key]])) as Partial<UserPreferences>;

/**
 * Loads the user's preferences per username and keeps them in sync.
 * `update` is optimistic; saves are debounced (600 ms) and serialized. Each
 * PUT sends only the top-level keys changed since the last successful save
 * (keys changed while it runs stay dirty for the next one) and adopts the
 * merged document the server returns, except for keys changed meanwhile.
 * Pending changes are flushed when the tab is hidden or closed, on unmount
 * and by `flush()`, which sign-out awaits while the token is still valid
 * (changes made while a GET runs are sent once it answered).
 * When the tab comes back to the foreground with nothing pending, the
 * preferences are re-read, so a stale tab picks up other devices' changes
 * before it edits (`loaded` stays true, so the start view is not re-applied).
 * Changes made while a GET runs are replayed on top of the server data;
 * after a failed load the next change retries it, nothing is saved until then.
 * Switching the username drops a pending save instead of writing it under
 * another account.
 */
export function useUserPreferences(username: string | null | undefined): {
  prefs: UserPreferences;
  loaded: boolean;
  update: (update: PreferencesUpdate) => void;
  /** Sends pending changes now; resolves when no save runs. Never rejects. */
  flush: () => Promise<void>;
} {
  const [prefs, setPrefs] = useState<UserPreferences>(() => normalizePreferences(null));
  const [loaded, setLoaded] = useState(false);
  const latestRef = useRef(prefs);
  // True once a GET succeeded for this username: only then may we PUT.
  const syncedRef = useRef(false);
  const loadFailedRef = useRef(false);
  // Bumped per username (and on unmount) so late GET/PUT results are ignored.
  const generationRef = useRef(0);
  const pendingUpdatesRef = useRef<PreferencesUpdate[]>([]);
  // The running GET (load or re-read), null while none runs.
  const readingRef = useRef<Promise<void> | null>(null);
  // Top-level keys changed since the last successful save: what the next PUT sends.
  const dirtyRef = useRef(new Set<PreferenceKey>());
  const timerRef = useRef<number | null>(null);
  // The running save loop (null while idle) and whether it must go round again.
  const savingRef = useRef<Promise<void> | null>(null);
  const saveAgainRef = useRef(false);

  const commit = useCallback((next: UserPreferences) => {
    latestRef.current = next;
    setPrefs(next);
  }, []);

  // One PUT of the dirty keys. They count as clean once sent; a failure marks
  // them dirty again (local state stays, the next save retries them).
  const saveDirty = useCallback(async () => {
    if (!syncedRef.current || dirtyRef.current.size === 0) return;
    const generation = generationRef.current;
    const keys = [...dirtyRef.current];
    dirtyRef.current.clear();
    try {
      const saved = normalizePreferences(await saveUserPreferences(pickKeys(latestRef.current, keys)));
      if (generation !== generationRef.current) return;
      // The merged document (other devices' changes included), keeping the
      // keys changed while the request ran.
      const next = { ...saved, ...pickKeys(latestRef.current, dirtyRef.current) };
      if (changedKeys(latestRef.current, next).length) commit(next);
    } catch (error) {
      if (generation !== generationRef.current) return;
      console.warn("Saving preferences failed:", error);
      for (const key of keys) dirtyRef.current.add(key);
    }
  }, [commit]);

  // Serialized: a save requested while one runs makes the loop go round once
  // more. Changes made while a GET runs only become dirty when it answers,
  // so a save requested meanwhile waits for it (flush() must send them too).
  // The promise resolves when no save runs.
  const runSave = useCallback(
    function run(): Promise<void> {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      if (savingRef.current) {
        saveAgainRef.current = true;
        return savingRef.current;
      }
      if (readingRef.current && pendingUpdatesRef.current.length) return readingRef.current.then(run);
      if (!syncedRef.current || dirtyRef.current.size === 0) return Promise.resolve();
      const loop = async () => {
        try {
          do {
            saveAgainRef.current = false;
            await saveDirty();
          } while (saveAgainRef.current);
        } finally {
          savingRef.current = null;
        }
      };
      savingRef.current = loop();
      return savingRef.current;
    },
    [saveDirty],
  );

  // Keeps a running GET (handled, so it never rejects) in readingRef.
  const trackReading = useCallback((handled: Promise<void>) => {
    const reading = handled.finally(() => {
      if (readingRef.current === reading) readingRef.current = null;
    });
    readingRef.current = reading;
  }, []);

  const scheduleSave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void runSave(), SAVE_DEBOUNCE_MS);
  }, [runSave]);

  // Flush pending changes when the tab is hidden/closed and on unmount
  // (runSave is stable, so the cleanup only runs on unmount). The PUT uses
  // fetch keepalive, so it survives the page going away.
  useEffect(() => {
    const flush = () => void runSave();
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

  // Server data with the changes made while the GET ran replayed on top; the
  // keys they change are saved. Unchanged data keeps the state object, so
  // nothing renders.
  const applyServerPreferences = useCallback(
    (raw: unknown) => {
      const server = normalizePreferences(raw);
      const next = pendingUpdatesRef.current.reduce(applyUpdate, server);
      pendingUpdatesRef.current = [];
      if (JSON.stringify(next) !== JSON.stringify(latestRef.current)) commit(next);
      syncedRef.current = true;
      const changed = changedKeys(server, next);
      for (const key of changed) dirtyRef.current.add(key);
      if (changed.length) scheduleSave();
    },
    [commit, scheduleSave],
  );

  const load = useCallback(() => {
    const generation = generationRef.current;
    loadFailedRef.current = false;
    trackReading(
      getUserPreferences().then(
        (raw) => {
          if (generation !== generationRef.current) return;
          applyServerPreferences(raw);
          setLoaded(true);
        },
        (error) => {
          if (generation !== generationRef.current) return;
          // Usable with defaults, but saving waits for a successful load.
          console.warn("Loading preferences failed, using defaults:", error);
          loadFailedRef.current = true;
          setLoaded(true);
        },
      ),
    );
  }, [applyServerPreferences, trackReading]);

  // A tab left open for hours shows what it loaded back then; an edit based
  // on that (e.g. adding a view) would save the old list over one another
  // device saved meanwhile. Re-read when the tab comes back (visible /
  // focus), only while idle: synced, nothing dirty, waiting or in flight.
  // Changes made during the GET are replayed on the fresh data, as on load.
  const refresh = useCallback(() => {
    if (
      !syncedRef.current ||
      timerRef.current !== null ||
      savingRef.current ||
      dirtyRef.current.size > 0
    ) {
      return;
    }
    const generation = generationRef.current;
    const before = latestRef.current;
    syncedRef.current = false;
    trackReading(
      getUserPreferences().then(
        (raw) => {
          if (generation !== generationRef.current) return;
          applyServerPreferences(raw);
        },
        (error) => {
          if (generation !== generationRef.current) return;
          // The local copy stays; only the keys changed meanwhile are saved
          // (the server keeps the other keys as other devices left them).
          console.warn("Refreshing preferences failed:", error);
          pendingUpdatesRef.current = [];
          syncedRef.current = true;
          const changed = changedKeys(before, latestRef.current);
          for (const key of changed) dirtyRef.current.add(key);
          if (changed.length) scheduleSave();
        },
      ),
    );
  }, [applyServerPreferences, scheduleSave, trackReading]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    saveAgainRef.current = false;
    syncedRef.current = false;
    loadFailedRef.current = false;
    pendingUpdatesRef.current = [];
    readingRef.current = null;
    dirtyRef.current.clear();
    commit(normalizePreferences(null));
    setLoaded(false);
    if (username) load();
    return () => {
      generationRef.current += 1;
    };
  }, [username, commit, load]);

  const update = useCallback(
    (change: PreferencesUpdate) => {
      const next = applyUpdate(latestRef.current, change);
      if (syncedRef.current) {
        // A no-op (e.g. clicking the active segment) neither renders nor saves.
        const changed = changedKeys(latestRef.current, next);
        if (!changed.length) return;
        for (const key of changed) dirtyRef.current.add(key);
        commit(next);
        scheduleSave();
        return;
      }
      commit(next);
      pendingUpdatesRef.current.push(change);
      if (loadFailedRef.current) load();
    },
    [commit, scheduleSave, load],
  );

  return { prefs, loaded, update, flush: runSave };
}
