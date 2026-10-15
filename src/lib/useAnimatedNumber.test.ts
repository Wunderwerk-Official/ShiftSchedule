import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnimatedNumber } from "./useAnimatedNumber";

// Manual clock: requestAnimationFrame callbacks run only when a test advances time.
let now = 0;
let nextId = 1;
let frames = new Map<number, FrameRequestCallback>();

const advance = (ms: number) => {
  act(() => {
    now += ms;
    const due = frames;
    frames = new Map();
    due.forEach((callback) => callback(now));
  });
};

beforeEach(() => {
  now = 0;
  nextId = 1;
  frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAnimatedNumber", () => {
  it("animates to the target", () => {
    const { result, rerender } = renderHook(({ value }) => useAnimatedNumber(value), {
      initialProps: { value: 0 },
    });
    rerender({ value: 100 });
    advance(100);
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);
    advance(500);
    expect(result.current).toBe(100);
  });

  it("continues from the shown value when the target changes mid-animation", () => {
    const { result, rerender } = renderHook(({ value }) => useAnimatedNumber(value), {
      initialProps: { value: 0 },
    });
    rerender({ value: 100 });
    advance(100);
    const shown = result.current;
    expect(shown).toBeLessThan(100);

    rerender({ value: 120 });
    advance(16);
    // No jump to the old target (100) before heading to 120.
    expect(result.current).toBeGreaterThanOrEqual(shown);
    expect(result.current).toBeLessThan(shown + 15);
    advance(500);
    expect(result.current).toBe(120);
  });

  it("snaps to the target when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
    const { result, rerender } = renderHook(({ value }) => useAnimatedNumber(value), {
      initialProps: { value: 0 },
    });
    rerender({ value: 42 });
    expect(result.current).toBe(42);
  });
});
