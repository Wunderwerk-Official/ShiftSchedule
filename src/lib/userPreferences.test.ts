import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserPreferences, saveUserPreferences, type UserPreferences } from "../api/client";
import { usePlanScope } from "../pages/usePlanScope";
import {
  DEFAULT_PREFERENCES,
  MAX_SAVED_VIEWS,
  normalizePreferences,
  sameViewConfig,
  useUserPreferences,
} from "./userPreferences";

vi.mock("../api/client", () => ({
  getUserPreferences: vi.fn(),
  saveUserPreferences: vi.fn(),
}));

const getMock = vi.mocked(getUserPreferences);
const saveMock = vi.mocked(saveUserPreferences);
const view = { scope: "me", range: "week", orientation: "left", colorBy: "section" } as const;
// Runs due debounce timers and settles promises (fake timers only).
const flushTimers = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });

// Fake backend (backend/preferences.py): GET returns the stored document, PUT
// stores only the top-level keys it names and returns the merged document.
let stored: UserPreferences = DEFAULT_PREFERENCES;
const mergeIntoStored = async (changes: Partial<UserPreferences>) =>
  (stored = normalizePreferences({ ...stored, ...changes }));
function serve(initial: Partial<UserPreferences> = {}) {
  stored = normalizePreferences(initial);
  getMock.mockImplementation(async () => stored);
}
/** The next PUT stays open until `finish()`; it merges at that moment. */
function holdNextSave() {
  const held = { finish: () => {} };
  saveMock.mockImplementationOnce(
    (changes) =>
      new Promise((resolve) => {
        held.finish = () => resolve(mergeIntoStored(changes));
      }),
  );
  return held;
}

describe("normalizePreferences", () => {
  it("returns a fresh copy of the defaults for garbage input", () => {
    for (const raw of [null, undefined, 42, "x", [], { version: 7 }]) {
      expect(normalizePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
    }
    expect(normalizePreferences(null)).not.toBe(DEFAULT_PREFERENCES);
  });

  it("keeps valid values and coerces invalid ones field by field", () => {
    const prefs = normalizePreferences({
      clinicianId: "  lh ",
      orientationByRange: { day: "left", week: "sideways" },
      myPlanRange: "month",
      teamColorBy: "rainbow",
      startViewDesktop: { scope: "me", range: "day" },
      startViewMobile: "today",
    });
    expect(prefs).toEqual({
      ...DEFAULT_PREFERENCES,
      clinicianId: "lh",
      orientationByRange: { day: "left", week: "top", month: "top" },
      myPlanRange: "month",
      startViewDesktop: { scope: "me", range: "day", orientation: "top", colorBy: "section" },
    });
    expect(normalizePreferences({ clinicianId: "x".repeat(201) }).clinicianId).toBeNull();
  });

  it("drops invalid saved views, dedupes ids and caps at 12", () => {
    const views = Array.from({ length: 15 }, (_, i) => ({ ...view, id: `v${i}`, name: `View ${i}` }));
    const prefs = normalizePreferences({
      savedViews: [
        { ...view, id: "dup", name: "First" },
        { ...view, id: "dup", name: "Second" },
        { ...view, id: "", name: "No id" },
        { ...view, id: "long", name: "n".repeat(61) },
        { ...view, id: "blank", name: "   " },
        ...views,
      ],
    });
    expect(prefs.savedViews).toHaveLength(MAX_SAVED_VIEWS);
    expect(prefs.savedViews[0]).toEqual({ ...view, id: "dup", name: "First", startAt: "today" });
    expect(prefs.savedViews.filter((v) => v.id === "dup")).toHaveLength(1);
  });

  it("keeps a saved view's relative start and per-device orientations", () => {
    const prefs = normalizePreferences({
      savedViews: [
        { ...view, id: "a", name: "Next", startAt: "nextShift" },
        { ...view, id: "b", name: "Odd", startAt: "2026-10-14" },
      ],
      orientationByRangeMobile: { day: "left", month: "sideways" },
      myPlanRangeMobile: "month",
    });
    expect(prefs.savedViews.map((item) => item.startAt)).toEqual(["nextShift", "today"]);
    expect(prefs.orientationByRangeMobile).toEqual({ day: "left", week: "left", month: "top" });
    expect(prefs).toMatchObject({ myPlanRangeMobile: "month", myPlanRange: "week" });
    expect(normalizePreferences({ myPlanRangeMobile: "year" }).myPlanRangeMobile).toBe("week");
  });

  it("compares views by their settings only, colorBy only for the team scope", () => {
    expect(sameViewConfig(view, { ...view, id: "a", name: "Mine" } as never)).toBe(true);
    expect(sameViewConfig(view, { ...view, range: "day" })).toBe(false);
    expect(sameViewConfig(view, { ...view, colorBy: "person" })).toBe(true);
    const team = { ...view, scope: "team" } as const;
    expect(sameViewConfig(team, { ...team, colorBy: "person" })).toBe(false);
    expect(sameViewConfig(null, null)).toBe(true);
    expect(sameViewConfig(view, null)).toBe(false);
  });
});

describe("useUserPreferences", () => {
  beforeEach(() => {
    getMock.mockReset();
    saveMock.mockReset();
    stored = DEFAULT_PREFERENCES;
    saveMock.mockImplementation(mergeIntoStored);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads once per username and normalizes the response", async () => {
    getMock.mockResolvedValue({ ...DEFAULT_PREFERENCES, clinicianId: "lh", myPlanRange: "day" });
    const { result, rerender } = renderHook(({ user }) => useUserPreferences(user), {
      initialProps: { user: "lena" },
    });
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.prefs).toMatchObject({ clinicianId: "lh", myPlanRange: "day" });
    rerender({ user: "lena" });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch without a username", () => {
    const { result } = renderHook(() => useUserPreferences(null));
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it("falls back to defaults when loading fails", async () => {
    getMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it("applies updates at once and saves only the changed keys debounced in one request", async () => {
    serve({ clinicianId: "lh" });
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "month" }));
    act(() =>
      result.current.update((prev) => ({
        ...prev,
        orientationByRange: { ...prev.orientationByRange, month: "left" },
      })),
    );
    expect(result.current.prefs.myPlanRange).toBe("month");
    expect(saveMock).not.toHaveBeenCalled();
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({
      myPlanRange: "month",
      orientationByRange: { day: "top", week: "top", month: "left" },
    });
    // Saved keys are clean: the next save sends only what changed since.
    act(() => result.current.update({ teamColorBy: "person" }));
    await flushTimers();
    expect(saveMock.mock.calls[1][0]).toEqual({ teamColorBy: "person" });
    expect(stored).toEqual({
      ...DEFAULT_PREFERENCES,
      clinicianId: "lh",
      myPlanRange: "month",
      orientationByRange: { day: "top", week: "top", month: "left" },
      teamColorBy: "person",
    });
    expect(result.current.prefs).toEqual(stored);
  });

  it("sends a cleared key as null or []", async () => {
    serve({ clinicianId: "lh", startViewMobile: view, savedViews: [{ ...view, id: "v1", name: "Mine", startAt: "today" }] });
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ clinicianId: null, startViewMobile: null, savedViews: [] }));
    await flushTimers();
    expect(saveMock.mock.calls[0][0]).toEqual({ clinicianId: null, savedViews: [], startViewMobile: null });
    expect(stored).toEqual(DEFAULT_PREFERENCES);
  });

  it("does not save an update that changes nothing", async () => {
    getMock.mockResolvedValue({ ...DEFAULT_PREFERENCES, teamColorBy: "person" });
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = result.current.prefs;
    vi.useFakeTimers();
    act(() => result.current.update({ teamColorBy: "person" }));
    act(() => result.current.update((prev) => ({ ...prev, myPlanRange: "week" })));
    await flushTimers();
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.current.prefs).toBe(before);
  });

  it("keeps local state after a failed save, does not re-read, and retries the keys with the next change", async () => {
    serve();
    saveMock.mockRejectedValueOnce(new Error("500"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ teamColorBy: "person" }));
    await flushTimers();
    expect(result.current.prefs.teamColorBy).toBe("person");
    // Unsaved keys count as pending: coming back to the tab does not re-read.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    act(() => result.current.update({ clinicianId: "lh" }));
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ clinicianId: "lh", teamColorBy: "person" });
    expect(stored).toMatchObject({ teamColorBy: "person", clinicianId: "lh" });
  });

  it("serializes saves: a change during a running save is saved afterwards, latest state", async () => {
    serve();
    const first = holdNextSave();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "day" }));
    await flushTimers(); // first PUT starts and stays pending
    act(() => result.current.update({ myPlanRange: "month" }));
    await flushTimers(); // debounce fires while the first PUT runs → queued
    expect(saveMock).toHaveBeenCalledTimes(1);
    await act(async () => first.finish());
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ myPlanRange: "month" });
    expect(result.current.prefs.myPlanRange).toBe("month");
  });

  it("adopts the merged PUT response but keeps keys changed while it ran and saves them next", async () => {
    serve();
    const first = holdNextSave();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "day", teamColorBy: "person" }));
    await flushTimers(); // PUT 1 runs
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "day", teamColorBy: "person" });
    act(() => result.current.update({ myPlanRange: "month" })); // debounce not due yet
    stored = { ...stored, clinicianId: "phone" }; // another device saved meanwhile
    await act(async () => first.finish());
    // The server's document is adopted, the newer local range is not clobbered.
    expect(result.current.prefs).toEqual({
      ...DEFAULT_PREFERENCES,
      clinicianId: "phone",
      myPlanRange: "month",
      teamColorBy: "person",
    });
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ myPlanRange: "month" });
    expect(stored).toEqual(result.current.prefs);
  });

  it("flush() sends pending changes at once and resolves only after the PUT finished", async () => {
    serve();
    const first = holdNextSave();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    // Nothing pending: resolves without a request.
    await act(() => result.current.flush());
    expect(saveMock).not.toHaveBeenCalled();

    act(() => result.current.update({ myPlanRange: "day" }));
    let done = false;
    let flushed!: Promise<void>;
    act(() => {
      flushed = result.current.flush().then(() => {
        done = true;
      });
    });
    expect(saveMock).toHaveBeenCalledTimes(1); // no debounce wait
    // A change while the PUT runs is part of the same flush.
    act(() => result.current.update({ teamColorBy: "person" }));
    let flushedAgain!: Promise<void>;
    act(() => {
      flushedAgain = result.current.flush();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(done).toBe(false);
    await act(async () => {
      first.finish();
      await flushed;
      await flushedAgain;
    });
    expect(done).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ teamColorBy: "person" });
    expect(stored).toMatchObject({ myPlanRange: "day", teamColorBy: "person" });
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(2); // no debounced save left over
  });

  it("flush() never rejects; the keys stay dirty for the next save", async () => {
    serve();
    saveMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ clinicianId: "lh" }));
    await act(() => result.current.flush());
    expect(saveMock).toHaveBeenCalledTimes(1);
    await act(() => result.current.flush());
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ clinicianId: "lh" });
  });

  it("sign-out: after flush() nothing is left to send on unmount", async () => {
    serve();
    const { result, unmount } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ myPlanRange: "month" }));
    await act(() => result.current.flush()); // handleLogout, before the token is cleared
    expect(saveMock).toHaveBeenCalledTimes(1);
    unmount(); // onLogout → the page goes away
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("never saves before a load succeeded; the next change retries the load", async () => {
    const onServer = {
      ...DEFAULT_PREFERENCES,
      clinicianId: "lh",
      savedViews: [{ ...view, id: "v1", name: "My week", startAt: "today" as const }],
      startViewDesktop: view,
    };
    serve(onServer);
    getMock.mockRejectedValueOnce(new Error("502")).mockRejectedValueOnce(new Error("502"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "day" })); // retry fails again
    await flushTimers();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.current.prefs.myPlanRange).toBe("day");
    act(() => result.current.update({ teamColorBy: "person" })); // retry succeeds
    await flushTimers();
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "day", teamColorBy: "person" });
    expect(result.current.prefs).toEqual({ ...onServer, myPlanRange: "day", teamColorBy: "person" });
    expect(stored).toEqual(result.current.prefs);
  });

  it("replays changes made before the load finished on top of the server data", async () => {
    let resolve!: (value: typeof DEFAULT_PREFERENCES) => void;
    getMock.mockReturnValue(new Promise((yes) => (resolve = yes)));
    const { result } = renderHook(() => useUserPreferences("lena"));
    act(() => result.current.update({ myPlanRange: "day" }));
    expect(result.current.prefs.myPlanRange).toBe("day");
    await act(async () => resolve({ ...DEFAULT_PREFERENCES, clinicianId: "lh" }));
    expect(result.current.prefs).toMatchObject({ clinicianId: "lh", myPlanRange: "day" });
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "day" });
  });

  it("flushes a pending save on unmount", async () => {
    serve();
    const { result, unmount } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ myPlanRange: "month" }));
    unmount();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "month" });
  });

  it("flushes a pending save when the page is hidden", async () => {
    serve();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ myPlanRange: "month" }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "month" });
  });

  it("re-reads the preferences when the tab comes back, so it edits other devices' latest data", async () => {
    serve();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const phoneView = { ...view, id: "v1", name: "Phone week", startAt: "today" as const };
    stored = { ...stored, savedViews: [phoneView], startViewMobile: view }; // saved on the phone
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result.current.prefs).toEqual(stored);
    vi.useFakeTimers();
    // Adding a view now builds on the phone's list instead of the stale one.
    const deskView = { ...view, id: "v2", name: "Desk", startAt: "today" as const };
    act(() => result.current.update((prev) => ({ ...prev, savedViews: [...prev.savedViews, deskView] })));
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ savedViews: [phoneView, deskView] });
    expect(stored).toEqual({ ...DEFAULT_PREFERENCES, savedViews: [phoneView, deskView], startViewMobile: view });
  });

  it("a re-read keeps loaded true and does not re-apply the start view", async () => {
    const startView = { scope: "me", range: "week", orientation: "top", colorBy: "section" } as const;
    serve({ startViewDesktop: startView });
    const { result } = renderHook(() => {
      const preferences = useUserPreferences("lena");
      const scope = usePlanScope({
        username: "lena",
        prefs: preferences.prefs,
        loaded: preferences.loaded,
        onUpdatePrefs: preferences.update,
        isMobile: false,
      });
      return { ...preferences, ...scope };
    });
    await waitFor(() => expect(result.current.planScope).toBe("me"));
    act(() => result.current.setPlanScope("team"));
    let resolve!: (value: UserPreferences) => void;
    getMock.mockReturnValueOnce(new Promise((yes) => (resolve = yes)));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange")); // jsdom: "visible"
    });
    expect(result.current.loaded).toBe(true);
    await act(async () => resolve({ ...stored, startViewDesktop: { ...startView, range: "day" } }));
    expect(result.current.prefs.startViewDesktop?.range).toBe("day");
    expect(result.current.planScope).toBe("team");
    expect(result.current.prefs.myPlanRange).toBe("week");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("re-reads on visibilitychange to visible, not while a save is waiting or running, and renders nothing when unchanged", async () => {
    serve();
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = result.current.prefs;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange")); // jsdom: "visible"
    });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result.current.prefs).toBe(before);
    vi.useFakeTimers();
    const save = holdNextSave();
    act(() => result.current.update({ myPlanRange: "month" }));
    await act(async () => {
      window.dispatchEvent(new Event("focus")); // save waiting
    });
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("focus")); // save running
    });
    expect(getMock).toHaveBeenCalledTimes(2);
    await act(async () => save.finish());
    await act(async () => {
      window.dispatchEvent(new Event("focus")); // idle again
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it("replays a change made during the re-read on the fresh data; a failed re-read keeps local state", async () => {
    serve();
    let resolve!: (value: UserPreferences) => void;
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    getMock
      .mockReturnValueOnce(new Promise((yes) => (resolve = yes)))
      .mockRejectedValueOnce(new Error("502"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => result.current.update({ myPlanRange: "day" }));
    expect(result.current.prefs.myPlanRange).toBe("day");
    await flushTimers();
    expect(saveMock).not.toHaveBeenCalled(); // waits for the re-read
    stored = { ...stored, clinicianId: "lh" }; // linked on another device
    await act(async () => resolve(stored));
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "day" });
    expect(result.current.prefs).toMatchObject({ clinicianId: "lh", myPlanRange: "day" });

    act(() => {
      window.dispatchEvent(new Event("focus")); // this re-read fails
    });
    act(() => result.current.update({ teamColorBy: "person" }));
    await flushTimers();
    expect(result.current.prefs).toMatchObject({ clinicianId: "lh", myPlanRange: "day", teamColorBy: "person" });
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toEqual({ teamColorBy: "person" });
    expect(stored).toEqual(result.current.prefs);
  });

  it("flush() during a re-read waits for it, then sends the change made meanwhile", async () => {
    serve();
    const { result, unmount } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    let resolve!: (value: UserPreferences) => void;
    getMock.mockReturnValueOnce(new Promise((yes) => (resolve = yes)));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => result.current.update({ myPlanRange: "day" }));
    let putsWhenFlushed: number | null = null;
    let flushed!: Promise<void>;
    act(() => {
      flushed = result.current.flush().then(() => {
        putsWhenFlushed = saveMock.mock.calls.length;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(putsWhenFlushed).toBeNull(); // still waiting for the re-read
    stored = { ...stored, clinicianId: "lh" }; // linked on another device
    await act(async () => {
      resolve(stored);
      await flushed;
    });
    expect(putsWhenFlushed).toBe(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "day" });
    expect(stored).toMatchObject({ clinicianId: "lh", myPlanRange: "day" });
    unmount(); // sign-out: nothing left to send
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("drops a pending save when the username changes; the next user's save sends only their keys", async () => {
    const mia = normalizePreferences({ clinicianId: "mk", teamColorBy: "person" });
    getMock.mockResolvedValueOnce(DEFAULT_PREFERENCES).mockResolvedValue(mia);
    const { result, rerender } = renderHook(({ user }) => useUserPreferences(user), {
      initialProps: { user: "lena" },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ clinicianId: "lh" }));
    rerender({ user: "mia" });
    await flushTimers();
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.current.prefs).toEqual(mia);
    act(() => result.current.update({ myPlanRange: "month" }));
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ myPlanRange: "month" });
  });

  it.each(["answers", "fails"] as const)(
    "ignores the previous user's PUT that %s after the username changed",
    async (outcome) => {
      const lena = normalizePreferences({ clinicianId: "lh" });
      const mia = normalizePreferences({ clinicianId: "mk", myPlanRange: "day" });
      getMock.mockResolvedValueOnce(lena).mockResolvedValue(mia);
      let held!: { resolve: (value: UserPreferences) => void; reject: (error: Error) => void };
      saveMock.mockImplementationOnce(() => new Promise((resolve, reject) => (held = { resolve, reject })));
      const { result, rerender } = renderHook(({ user }) => useUserPreferences(user), {
        initialProps: { user: "lena" },
      });
      await waitFor(() => expect(result.current.loaded).toBe(true));
      vi.useFakeTimers();
      act(() => result.current.update({ teamColorBy: "person" }));
      await flushTimers(); // lena's PUT runs
      expect(saveMock).toHaveBeenCalledTimes(1);
      rerender({ user: "mia" });
      await flushTimers(); // mia's GET answers
      expect(result.current.prefs).toEqual(mia);
      await act(async () => {
        if (outcome === "answers") held.resolve({ ...lena, teamColorBy: "person" });
        else held.reject(new Error("502"));
      });
      await flushTimers();
      // Lena's document does not land in mia's state, and nothing is resent.
      expect(result.current.prefs).toEqual(mia);
      expect(saveMock).toHaveBeenCalledTimes(1);
      // Mia's first save sends only her own change, none of lena's keys.
      act(() => result.current.update({ myPlanRange: "month" }));
      await flushTimers();
      expect(saveMock).toHaveBeenCalledTimes(2);
      expect(saveMock.mock.calls[1][0]).toEqual({ myPlanRange: "month" });
    },
  );
});

// The real client function (the hook tests above mock it).
describe("saveUserPreferences", () => {
  const values = new Map<string, string>();
  const fetchMock = vi.fn();
  const load = () => vi.importActual<typeof import("../api/client")>("../api/client");
  beforeEach(() => {
    values.clear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json(DEFAULT_PREFERENCES));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs only the keys given, with keepalive, and returns the merged document", async () => {
    values.set("authToken", "token-1");
    const { saveUserPreferences: save } = await load();
    await expect(save({ myPlanRange: "day", clinicianId: null })).resolves.toEqual(DEFAULT_PREFERENCES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/me\/preferences$/);
    expect(init).toMatchObject({ method: "PUT", keepalive: true, body: '{"myPlanRange":"day","clinicianId":null}' });
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("sends nothing without a token (signed out) or over the 32 KB server limit", async () => {
    const { saveUserPreferences: save } = await load();
    await expect(save({ myPlanRange: "day" })).rejects.toThrow("Not signed in");
    values.set("authToken", "token-1");
    await expect(save({ clinicianId: "x".repeat(33 * 1024) })).rejects.toThrow("32 KB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
