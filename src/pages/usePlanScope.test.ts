import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserPreferences } from "../api/client";
import { normalizePreferences } from "../lib/userPreferences";
import { START_VIEW_WAIT_MS, usePlanScope } from "./usePlanScope";

type Props = { prefs: UserPreferences; loaded: boolean; isMobile?: boolean };

function setup(initial: Props) {
  const onUpdatePrefs = vi.fn();
  const hook = renderHook(
    ({ prefs, loaded, isMobile = false }: Props) =>
      usePlanScope({ username: "u", prefs, loaded, onUpdatePrefs, isMobile }),
    { initialProps: initial },
  );
  return { ...hook, onUpdatePrefs };
}

const meWeekLeft = { scope: "me", range: "week", orientation: "left", colorBy: "section" } as const;

describe("usePlanScope", () => {
  it("stays on the team plan without a start view and writes nothing", () => {
    const { result, rerender, onUpdatePrefs } = setup({ prefs: normalizePreferences({}), loaded: false });
    rerender({ prefs: normalizePreferences({}), loaded: true });
    expect(result.current.planScope).toBe("team");
    expect(onUpdatePrefs).not.toHaveBeenCalled();
  });

  it("applies the desktop start view once after loading", () => {
    const loadedPrefs = normalizePreferences({ startViewDesktop: meWeekLeft });
    const { result, rerender, onUpdatePrefs } = setup({ prefs: normalizePreferences({}), loaded: false });
    expect(result.current.planScope).toBe("team");
    rerender({ prefs: loadedPrefs, loaded: true });
    expect(result.current.planScope).toBe("me");
    // Week orientation differs from the stored one → one preferences update.
    expect(onUpdatePrefs).toHaveBeenCalledTimes(1);
    const next = onUpdatePrefs.mock.calls[0][0](loadedPrefs) as UserPreferences;
    expect(next.orientationByRange.week).toBe("left");

    act(() => result.current.setPlanScope("team"));
    rerender({ prefs: normalizePreferences({ ...loadedPrefs, teamColorBy: "person" }), loaded: true });
    expect(result.current.planScope).toBe("team");
    expect(onUpdatePrefs).toHaveBeenCalledTimes(1);
  });

  it("does not write when the start view already matches the preferences", () => {
    const prefs = normalizePreferences({
      startViewDesktop: meWeekLeft,
      orientationByRange: { day: "top", week: "left", month: "top" },
    });
    const { result, onUpdatePrefs } = setup({ prefs, loaded: true });
    expect(result.current.planScope).toBe("me");
    expect(onUpdatePrefs).not.toHaveBeenCalled();
  });

  it("uses the phone start view on phones", () => {
    const prefs = normalizePreferences({
      startViewDesktop: meWeekLeft,
      startViewMobile: { scope: "team", range: "week", orientation: "top", colorBy: "section" },
    });
    const { result } = setup({ prefs, loaded: true, isMobile: true });
    expect(result.current.planScope).toBe("team");
  });

  it("keeps a scope the user chose before the preferences arrived", () => {
    const { result, rerender } = setup({ prefs: normalizePreferences({}), loaded: false });
    act(() => result.current.setPlanScope("me"));
    act(() => result.current.setPlanScope("team"));
    rerender({ prefs: normalizePreferences({ startViewDesktop: meWeekLeft }), loaded: true });
    expect(result.current.planScope).toBe("team");
  });

  describe("scopeReady", () => {
    afterEach(() => vi.useRealTimers());

    it("is false while loading and turns true together with the start scope", () => {
      // Every render: the team grid must never be ready before the start view applied.
      const renders: string[] = [];
      const { rerender } = renderHook(
        ({ prefs, loaded }: Props) => {
          const scope = usePlanScope({ username: "u", prefs, loaded, onUpdatePrefs: vi.fn(), isMobile: false });
          renders.push(`${scope.scopeReady ? "ready" : "waiting"}:${scope.planScope}`);
          return scope;
        },
        { initialProps: { prefs: normalizePreferences({}), loaded: false } },
      );
      rerender({ prefs: normalizePreferences({ startViewDesktop: meWeekLeft }), loaded: true });
      expect(renders).not.toContain("ready:team");
      expect(renders[0]).toBe("waiting:team");
      expect(renders[renders.length - 1]).toBe("ready:me");
    });

    it("turns true without a start view as soon as the preferences loaded", () => {
      const { result, rerender } = setup({ prefs: normalizePreferences({}), loaded: false });
      rerender({ prefs: normalizePreferences({}), loaded: true });
      expect(result.current).toMatchObject({ scopeReady: true, planScope: "team" });
    });

    it("gives up waiting for slow preferences and shows the team plan", () => {
      vi.useFakeTimers();
      const { result } = setup({ prefs: normalizePreferences({}), loaded: false });
      act(() => vi.advanceTimersByTime(START_VIEW_WAIT_MS - 1));
      expect(result.current.scopeReady).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current).toMatchObject({ scopeReady: true, planScope: "team" });
    });
  });
});
