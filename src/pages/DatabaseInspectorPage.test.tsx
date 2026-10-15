import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeeklyInspectionResult } from "../api/client";
import DatabaseInspectorPage from "./DatabaseInspectorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  inspectWeek: vi.fn(),
}));

import { inspectWeek } from "../api/client";

type Pending = { weekStart: string; resolve: (value: WeeklyInspectionResult) => void };

const resultFor = (weekStart: string): WeeklyInspectionResult => ({
  weekStartISO: weekStart,
  weekEndISO: weekStart,
  slots: [],
  poolAssignments: [],
  stats: { totalSlots: 0, assignedSlots: 0, openSlots: 0, poolAssignments: 0 },
});

const formatted = (dateISO: string) => {
  const [year, month, day] = dateISO.split("-");
  return `${day}.${month}.${year} - ${day}.${month}.${year}`;
};

describe("DatabaseInspectorPage", () => {
  let pending: Pending[];

  beforeEach(() => {
    pending = [];
    vi.mocked(inspectWeek).mockReset();
    vi.mocked(inspectWeek).mockImplementation(
      (weekStart: string) =>
        new Promise<WeeklyInspectionResult>((resolve) => {
          pending.push({ weekStart, resolve });
        }),
    );
  });

  it("ignores a stale response that arrives after the current week's", async () => {
    render(<DatabaseInspectorPage theme="light" onBack={() => {}} />);
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(pending).toHaveLength(2);
    const [first, second] = pending;
    expect(second.weekStart).not.toBe(first.weekStart);

    // The newer request answers first, the older one last.
    await act(async () => second.resolve(resultFor(second.weekStart)));
    await act(async () => first.resolve(resultFor(first.weekStart)));

    expect(screen.getByText(formatted(second.weekStart))).toBeTruthy();
    expect(screen.queryByText(formatted(first.weekStart))).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("navigates by whole local weeks starting on Monday", async () => {
    render(<DatabaseInspectorPage theme="light" onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    const starts = pending.map((entry) => entry.weekStart);
    // Current, +1 week, back to current, -1 week.
    expect(starts[2]).toBe(starts[0]);
    for (const iso of starts) {
      expect(new Date(`${iso}T00:00:00`).getDay()).toBe(1);
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const diffDays = (a: string, b: string) =>
      Math.round((new Date(`${a}T12:00:00`).getTime() - new Date(`${b}T12:00:00`).getTime()) / dayMs);
    expect(diffDays(starts[1], starts[0])).toBe(7);
    expect(diffDays(starts[0], starts[3])).toBe(7);
  });
});
