import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserPreferences, saveUserPreferences } from "../api/client";
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
    expect(prefs.savedViews[0]).toEqual({ ...view, id: "dup", name: "First" });
    expect(prefs.savedViews.filter((v) => v.id === "dup")).toHaveLength(1);
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
    saveMock.mockImplementation(async (prefs) => prefs);
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

  it("applies updates at once and saves them debounced in one request", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
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
    expect(saveMock.mock.calls[0][0]).toMatchObject({
      myPlanRange: "month",
      orientationByRange: { day: "top", week: "top", month: "left" },
    });
  });

  it("keeps local state after a failed save and retries with the next change", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
    saveMock.mockRejectedValueOnce(new Error("500"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ teamColorBy: "person" }));
    await flushTimers();
    expect(result.current.prefs.teamColorBy).toBe("person");
    act(() => result.current.update({ clinicianId: "lh" }));
    await flushTimers();
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toMatchObject({ teamColorBy: "person", clinicianId: "lh" });
  });

  it("serializes saves: a change during a running save is saved afterwards, latest state", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
    let finishFirst!: () => void;
    saveMock.mockImplementationOnce(
      (prefs) => new Promise((resolve) => (finishFirst = () => resolve(prefs))),
    );
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "day" }));
    await flushTimers(); // first PUT starts and stays pending
    act(() => result.current.update({ myPlanRange: "month" }));
    await flushTimers(); // debounce fires while the first PUT runs → queued
    expect(saveMock).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst());
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0].myPlanRange).toBe("month");
  });

  it("never saves before a load succeeded; the next change retries the load", async () => {
    const stored = {
      ...DEFAULT_PREFERENCES,
      clinicianId: "lh",
      savedViews: [{ ...view, id: "v1", name: "My week" }],
      startViewDesktop: view,
    };
    getMock.mockRejectedValueOnce(new Error("502")).mockRejectedValueOnce(new Error("502"));
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ myPlanRange: "day" })); // retry fails again
    await flushTimers();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.current.prefs.myPlanRange).toBe("day");
    getMock.mockResolvedValueOnce(stored);
    act(() => result.current.update({ teamColorBy: "person" })); // retry succeeds
    await flushTimers();
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0]).toEqual({ ...stored, myPlanRange: "day", teamColorBy: "person" });
    expect(result.current.prefs).toEqual(saveMock.mock.calls[0][0]);
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
  });

  it("flushes a pending save on unmount", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
    const { result, unmount } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ myPlanRange: "month" }));
    unmount();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0].myPlanRange).toBe("month");
  });

  it("flushes a pending save when the page is hidden", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
    const { result } = renderHook(() => useUserPreferences("lena"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.update({ myPlanRange: "month" }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0].myPlanRange).toBe("month");
  });

  it("drops a pending save when the username changes", async () => {
    getMock.mockResolvedValue(DEFAULT_PREFERENCES);
    const { result, rerender } = renderHook(({ user }) => useUserPreferences(user), {
      initialProps: { user: "lena" as string | null },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.update({ clinicianId: "lh" }));
    rerender({ user: null });
    await flushTimers();
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.current.prefs).toEqual(DEFAULT_PREFERENCES);
  });
});
