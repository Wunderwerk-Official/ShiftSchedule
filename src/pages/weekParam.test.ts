import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toISODate } from "../lib/date";
import { readWeekParam, useWeekParam, withWeekParam } from "./weekParam";

describe("readWeekParam", () => {
  it("reads a real date", () => {
    const date = readWeekParam("?week=2026-03-23");
    expect(date && toISODate(date)).toBe("2026-03-23");
    expect(date?.getHours()).toBe(0);
  });

  it("ignores missing, malformed and rolled-over values", () => {
    expect(readWeekParam("")).toBeNull();
    expect(readWeekParam("?week=")).toBeNull();
    expect(readWeekParam("?week=next")).toBeNull();
    expect(readWeekParam("?week=2026-3-23")).toBeNull();
    expect(readWeekParam("?week=2026-02-30")).toBeNull();
    expect(readWeekParam("?week=2026-13-01")).toBeNull();
    expect(readWeekParam("?week=2026-03-23T10:00")).toBeNull();
  });
});

describe("withWeekParam", () => {
  it("sets, replaces and removes the parameter and keeps the rest of the address", () => {
    expect(withWeekParam("https://plan.example/", "2026-03-23")).toBe(
      "https://plan.example/?week=2026-03-23",
    );
    expect(withWeekParam("https://plan.example/?a=1&week=2026-03-23#x", "2026-03-30")).toBe(
      "https://plan.example/?a=1&week=2026-03-30#x",
    );
    expect(withWeekParam("https://plan.example/?a=1&week=2026-03-23", null)).toBe(
      "https://plan.example/?a=1",
    );
  });
});

describe("useWeekParam", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("replaces the history entry instead of adding one per week", () => {
    window.history.replaceState(null, "", "/");
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    const { rerender } = renderHook(({ dateISO }) => useWeekParam(dateISO), {
      initialProps: { dateISO: "2026-03-23" as string | null },
    });
    expect(window.location.search).toBe("?week=2026-03-23");
    rerender({ dateISO: "2026-03-30" });
    expect(window.location.search).toBe("?week=2026-03-30");
    rerender({ dateISO: null });
    expect(window.location.search).toBe("");
    expect(replace).toHaveBeenCalledTimes(3);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the address alone until enabled", () => {
    window.history.replaceState(null, "", "/?week=2026-12-01");
    const { rerender } = renderHook(({ enabled }) => useWeekParam("2026-11-30", enabled), {
      initialProps: { enabled: false },
    });
    expect(window.location.search).toBe("?week=2026-12-01");
    rerender({ enabled: true });
    expect(window.location.search).toBe("?week=2026-11-30");
  });
});
