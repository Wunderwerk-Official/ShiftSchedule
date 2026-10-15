import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Assignment } from "../../api/client";
import SolverOverlay, { type LiveSolution } from "./SolverOverlay";

// filledSlots mirrors the number of solver assignments; 10 slots required.
vi.mock("../../lib/solverStats", () => ({
  calculateSolverLiveStats: (solverAssignments: Assignment[]) => ({
    filledSlots: solverAssignments.length,
    totalRequiredSlots: 10,
    openSlots: 10 - solverAssignments.length,
    nonConsecutiveShifts: 0,
    peopleWeeksWithinHours: 0,
    totalPeopleWeeksWithTarget: 0,
    locationChanges: 0,
    totalAssignments: solverAssignments.length,
    sectionPreferenceMatches: 0,
    totalClassAssignments: 0,
    timeWindowFits: 0,
    totalAssignmentsWithTimeWindows: 0,
    onCallRestViolations: 0,
    workingHoursDeviationMinutes: 0,
    preferenceRankScore: 0,
    maxPreferenceRankScore: 0,
  }),
}));

const RANGE = { startISO: "2026-03-02", endISO: "2026-03-08" };

const assignments = (count: number): Assignment[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    rowId: "row-1",
    dateISO: "2026-03-02",
    clinicianId: `c${i}`,
  })) as Assignment[];

const solution = (num: number, count: number): LiveSolution => ({
  solution_num: num,
  time_ms: 1000 * num,
  objective: 100 - num,
  assignments: assignments(count),
});

type Props = ComponentProps<typeof SolverOverlay>;

const baseProps = (overrides: Partial<Props> = {}): Props => ({
  isVisible: true,
  elapsedMs: 1000,
  solveRange: RANGE,
  displayedRange: RANGE,
  onAbort: vi.fn(),
  onApplySolution: vi.fn(),
  liveSolutions: [],
  ...overrides,
});

const coverageWidth = () =>
  (document.querySelector(".solver-bar-fill") as HTMLElement | null)?.style.width;

const mountCalendarContainer = () => {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 800 });
  const scroll = document.createElement("div");
  scroll.className = "calendar-scroll";
  container.appendChild(scroll);
  document.body.appendChild(container);
  return container;
};

afterEach(() => {
  document.querySelectorAll(".calendar-scroll").forEach((el) => el.parentElement?.remove());
});

describe("SolverOverlay", () => {
  it("does not reuse stats of a previous run over the same range", () => {
    const { rerender } = render(
      <SolverOverlay {...baseProps({ liveSolutions: [solution(1, 9)] })} />,
    );
    expect(coverageWidth()).toBe("90%");

    // Run ends: the page hides the overlay and clears the range.
    rerender(<SolverOverlay {...baseProps({ isVisible: false, solveRange: null })} />);

    // Second run over the same range; the backend restarts at solution_num 1.
    rerender(
      <SolverOverlay
        {...baseProps({ solveRange: { ...RANGE }, liveSolutions: [solution(1, 2)] })}
      />,
    );
    expect(coverageWidth()).toBe("20%");
  });

  it("re-resolves the calendar container after the grid was remounted", () => {
    const first = mountCalendarContainer();
    const { rerender } = render(<SolverOverlay {...baseProps()} />);
    expect(first.contains(screen.getByText("Stop run"))).toBe(true);

    // Settings / layout switch: the calendar is unmounted and later remounted.
    first.remove();
    const second = mountCalendarContainer();
    rerender(<SolverOverlay {...baseProps({ elapsedMs: 1100 })} />);
    rerender(<SolverOverlay {...baseProps({ elapsedMs: 1200 })} />);

    expect(second.contains(screen.getByText("Stop run"))).toBe(true);
  });

  it("renders as a fixed overlay when no calendar is mounted", () => {
    render(<SolverOverlay {...baseProps()} />);
    const stop = screen.getByText("Stop run");
    expect(stop.closest(".fixed.inset-0")).not.toBeNull();
  });

  it("shows elapsed time with an indeterminate progressbar", () => {
    render(<SolverOverlay {...baseProps({ elapsedMs: 1000 })} />);
    const progress = screen.getByRole("progressbar", { name: "Solver progress" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveTextContent("0:01");
  });

  it("offers 'Apply best plan' only once a solution exists", () => {
    const { rerender } = render(<SolverOverlay {...baseProps()} />);
    expect(screen.queryByText("Apply best plan")).toBeNull();
    rerender(<SolverOverlay {...baseProps({ liveSolutions: [solution(1, 3)] })} />);
    expect(screen.getByText("Apply best plan")).toBeInTheDocument();
  });

  it("hides the score chart for agent runs", () => {
    const { rerender } = render(
      <SolverOverlay {...baseProps({ liveSolutions: [solution(1, 3)] })} />,
    );
    expect(screen.getByText("Time (s)")).toBeInTheDocument();
    rerender(
      <SolverOverlay
        {...baseProps({ liveSolutions: [solution(1, 3)], solverMode: "agent" })}
      />,
    );
    expect(screen.queryByText("Time (s)")).toBeNull();
  });
});
