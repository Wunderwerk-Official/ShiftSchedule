import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AutomatedPlanningPanel from "./AutomatedPlanningPanel";

it("says the section priority decides when not every slot can be filled (v1.84)", () => {
  render(
    <AutomatedPlanningPanel weekStartISO="2026-11-02" weekEndISO="2026-11-08" isRunning={false} progress={null}
      startedAt={null} lastRunTotalDays={null} lastRunDurationMs={null} error={null} onRun={vi.fn()}
      onResetSolver={vi.fn()} onResetAll={vi.fn()} onOpenInfo={vi.fn()} />,
  );
  expect(screen.getByText(/When not every slot can be filled, the\s+section priority order decides \(strict; on-call counts at its place\s+in that list\)/)).toBeInTheDocument();
});
